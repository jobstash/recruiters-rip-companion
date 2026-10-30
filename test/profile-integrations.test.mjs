import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import AdmZip from 'adm-zip';
import { privateDirectory } from '../src/vault.mjs';
import { installNative } from '../src/install-native.mjs';
import { installChatGptPlugin, mcpInvocation, prepareClaudePackage } from '../src/host-setup.mjs';
import { BROWSER_IDENTITIES } from '../src/browser-identity.mjs';
import { deviceDirectory, endpoint, launcherScript, mcpCommand, prepareBridgeRuntime, protectPrivatePath } from '../src/platform-runtime.cjs';

const source = fileURLToPath(new URL('../src/', import.meta.url));
const mainSource = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// This process is an isolated transport fixture, not an Electron/native-install
// smoke substitute. It uses the real mutual-authentication implementation and
// serves only a synthetic profile marker; native CI separately launches the app.
const companionFixture = `
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { endpoint, createAuthenticationChallenge, verifyAuthenticationProof, protectPrivatePath } = require('./src/platform-runtime.cjs');
const selected = process.argv.find(value => value.startsWith('--user-data-dir='));
if (!selected) process.exit(2);
const userData = fs.realpathSync(selected.slice('--user-data-dir='.length));
const directory = path.join(userData, 'device');
const profile = JSON.parse(fs.readFileSync(path.join(userData, 'profile.json'), 'utf8'));
fs.writeFileSync(path.join(userData, 'fixture-process.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
const peers = new Set(), servers = [];
function frame(channel, value) {
  const body = Buffer.from(JSON.stringify(value));
  if (channel === 'mcp') return Buffer.concat([body, Buffer.from('\\n')]);
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
(async () => {
  for (const channel of ['mcp', 'native']) {
    const address = endpoint(directory, channel), token = (channel === 'mcp' ? 'a' : 'b').repeat(64);
    if (process.platform !== 'win32') {
      fs.mkdirSync(path.dirname(address), { recursive: true, mode: 0o700 });
      protectPrivatePath(path.dirname(address), { directory: true });
      try { fs.unlinkSync(address); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const server = net.createServer(socket => {
      peers.add(socket); socket.on('close', () => peers.delete(socket)); socket.on('error', () => {});
      let input = Buffer.alloc(0), challenge, authenticated = false;
      socket.on('data', bytes => {
        input = Buffer.concat([input, bytes]);
        for (;;) {
          let body;
          if (channel === 'mcp') {
            const end = input.indexOf(10); if (end < 0) break;
            body = input.subarray(0, end); input = input.subarray(end + 1);
          } else {
            if (input.length < 4 || input.length < input.readUInt32LE(0) + 4) break;
            const size = input.readUInt32LE(0); body = input.subarray(4, size + 4); input = input.subarray(size + 4);
          }
          const message = JSON.parse(body.toString());
          if (!challenge) { challenge = createAuthenticationChallenge(token, channel, message); socket.write(frame(channel, challenge.message)); continue; }
          if (!authenticated) {
            if (!verifyAuthenticationProof(token, 'client', channel, challenge, message.authProof)) { socket.destroy(); return; }
            authenticated = true; continue;
          }
          const result = { profile: profile.id, userData, pid: process.pid, background: process.argv.includes('--bridge') || process.argv.includes('--mcp-background') };
          socket.write(frame(channel, channel === 'mcp' ? { jsonrpc: '2.0', id: message.id, result } : { version: 1, id: message.id, ok: true, result }));
        }
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
    servers.push(server);
    if (process.platform !== 'win32') fs.chmodSync(address, 0o600);
    const filename = path.join(directory, channel === 'mcp' ? 'mcp-bridge.json' : 'bridge.json');
    fs.writeFileSync(filename, JSON.stringify({ socket: address, token }), { mode: 0o600 }); protectPrivatePath(filename);
  }
})().catch(() => process.exit(3));
process.on('SIGTERM', () => { for (const peer of peers) peer.destroy(); for (const server of servers) server.close(); process.exit(0); });
`;

function exchange(invocation, env, channel) {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { env: { ...env, ...invocation.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = Buffer.alloc(0), errors = '', settled = false;
    const timer = setTimeout(() => finish(new Error(`Synthetic ${channel} transport timeout: ${errors}`)), 20_000);
    function finish(error, result) {
      if (settled) return; settled = true; clearTimeout(timer);
      child.stdin.destroy(); child.kill(); error ? reject(error) : resolve(result);
    }
    child.once('error', finish);
    child.once('exit', code => finish(new Error(`Synthetic ${channel} client exited ${code}: ${errors}`)));
    child.stderr.on('data', bytes => { errors += bytes.toString(); });
    child.stdout.on('data', bytes => {
      output = Buffer.concat([output, bytes]);
      try {
        if (channel === 'mcp') {
          const end = output.indexOf(10); if (end >= 0) finish(null, JSON.parse(output.subarray(0, end).toString()).result);
        } else if (output.length >= 4 && output.length >= output.readUInt32LE(0) + 4) {
          finish(null, JSON.parse(output.subarray(4, output.readUInt32LE(0) + 4).toString()).result);
        }
      } catch (error) { finish(error); }
    });
    child.stdin.on('error', () => {});
    const request = Buffer.from(JSON.stringify(channel === 'mcp' ? { jsonrpc: '2.0', id: 1, method: 'synthetic/profile' } : { version: 1, id: 'profile', op: 'status', payload: {} }));
    if (channel === 'mcp') child.stdin.write(Buffer.concat([request, Buffer.from('\n')]));
    else { const header = Buffer.alloc(4); header.writeUInt32LE(request.length); child.stdin.write(Buffer.concat([header, request])); }
  });
}

async function stopOwned(pid, userData) {
  const marker = path.join(userData, 'fixture-process.json');
  const proof = JSON.parse(await readFile(marker, 'utf8'));
  assert.equal(proof.pid, pid);
  try { process.kill(pid, 'SIGTERM'); }
  catch (error) { if (error.code === 'ESRCH') { await rm(marker, { force: true }); return; } throw error; }
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') { await rm(marker, { force: true }); return; } throw error; }
    await delay(20);
  }
  throw new Error('Synthetic companion did not exit');
}

async function generateConnections({ directory, appRoot, env, home }) {
  const context = vm.createContext({ directory, packageMetadata: { version: '3.12.0' }, process: { execPath: process.execPath },
    app: { isPackaged: false, getAppPath: () => appRoot }, localOnly: false,
    privateDirectory, realpath, path, prepareBridgeRuntime, writeFile, protectPrivatePath, launcherScript,
    setup: () => ({ command: mcpCommand(directory) }), unlink: async file => rm(file), browserRegistrations: {}, browserConnection: 'pending', browserExtensions: {},
    installNative: options => installNative({ ...options, env, home, run: async () => ({ stdout: '' }) }),
    refreshBrowserExtension: async () => { throw new Error('Browser folder generation is outside this transport fixture'); },
  });
  vm.runInContext(mainSource.slice(mainSource.indexOf('async function installConnections()'), mainSource.indexOf('async function refreshBrowserExtension(')), context);
  await context.installConnections();
}

test('two generated profile integrations stay selected while running and after closed-app background relaunch', { timeout: 240000 }, async t => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'rr-profile-integration-')));
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'Roaming'), XDG_CONFIG_HOME: path.join(home, 'config') };
  const profiles = [path.join(home, 'profiles', 'first selected'), path.join(home, 'profiles', 'second selected')];
  const owned = new Map(), sockets = new Set();
  t.after(async () => {
    for (const profile of profiles) {
      try {
        const { pid } = JSON.parse(await readFile(path.join(profile, 'fixture-process.json'), 'utf8'));
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) owned.set(pid, profile);
      } catch { /* A rejected startup may never have created its fixture receipt. */ }
    }
    for (const [pid, profile] of owned) await stopOwned(pid, profile).catch(() => {});
    for (const socket of sockets) await rm(path.dirname(socket), { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });
  const appRoot = path.join(home, 'source-app');
  await mkdir(path.join(appRoot, 'src', 'generated'), { recursive: true });
  for (const file of ['native-host.cjs', 'platform-runtime.cjs', 'browser-identity.mjs']) await copyFile(path.join(source, file), path.join(appRoot, 'src', file));
  await copyFile(path.join(source, 'mcp', 'local-runner.cjs'), path.join(appRoot, 'src', 'generated', 'mcp-host.cjs'));
  await writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ main: 'synthetic-companion.cjs' }));
  await writeFile(path.join(appRoot, 'synthetic-companion.cjs'), companionFixture);
  await mkdir(path.join(appRoot, 'src', 'generated', 'recruiters-rip-plugin', '.codex-plugin'), { recursive: true });
  await writeFile(path.join(appRoot, 'src', 'generated', 'recruiters-rip-plugin', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'recruiters-rip' }));
  const template = path.join(appRoot, 'src', 'generated', 'recruiters-rip.mcpb'), archive = new AdmZip();
  archive.addFile('manifest.json', Buffer.from(JSON.stringify({ manifest_version: '0.3', name: 'recruiters-rip', version: '3.12.0',
    server: { type: 'node', entry_point: 'server/index.cjs', mcp_config: { command: 'node', args: ['${__dirname}/server/index.cjs', '--directory=${user_config.companion_directory}'] } },
    user_config: { companion_directory: { type: 'directory', required: true } } })));
  archive.addFile('server/index.cjs', await readFile(path.join(source, 'mcp', 'local-runner.cjs')));
  archive.addFile('platform-runtime.cjs', await readFile(path.join(source, 'platform-runtime.cjs')));
  await writeFile(template, archive.toBuffer());
  const originalTemplate = await readFile(template);
  const defaultDirectory = deviceDirectory({ home, env }), defaultProfile = path.dirname(defaultDirectory);
  await privateDirectory(defaultDirectory);
  await writeFile(path.join(defaultProfile, 'profile.json'), JSON.stringify({ id: 'not-selected-default' }));
  const defaultBefore = await readdir(defaultDirectory);

  for (let index = 0; index < profiles.length; index++) {
    const userData = profiles[index], directory = path.join(userData, 'device'), expected = `selected-${index}`;
    await privateDirectory(directory);
    await writeFile(path.join(userData, 'profile.json'), JSON.stringify({ id: expected }));
    for (const channel of ['mcp', 'native']) {
      const address = endpoint(directory, channel);
      if (process.platform !== 'win32' && path.dirname(address) !== directory) sockets.add(address);
    }
    await generateConnections({ directory, appRoot, env, home });
    const launch = JSON.parse(await readFile(path.join(directory, 'mcp-launch.json'), 'utf8'));
    assert.equal(launch.directory, directory); assert.equal(launch.userData, userData);
    assert.ok(launch.args.includes(`--user-data-dir=${userData}`));
    const configured = await prepareClaudePackage({ template, directory, localOnly: false, version: '3.12.0' });
    const installed = new AdmZip(configured), manifest = JSON.parse(installed.readAsText('manifest.json'));
    assert.equal(manifest.user_config, undefined);
    const extracted = path.join(userData, 'synthetic-claude-bundle');
    await mkdir(path.join(extracted, 'server'), { recursive: true });
    // Copy only these two known fixture members; never extract archive paths.
    await writeFile(path.join(extracted, 'server', 'index.cjs'), installed.readFile('server/index.cjs'));
    await writeFile(path.join(extracted, 'platform-runtime.cjs'), installed.readFile('platform-runtime.cjs'));
    await installChatGptPlugin({ directory, root: appRoot, localOnly: false, command: mcpCommand(directory), env,
      findCli: async () => ({ command: 'synthetic-codex', args: [] }),
      runCommand: async (_command, args) => ({ stdout: args.includes('--help') ? 'add marketplace' : '{}' }) });
    const codex = JSON.parse(await readFile(path.join(directory, 'host-integration', 'plugins', 'recruiters-rip', '.mcp.json'), 'utf8')).mcpServers['recruiters-rip'];
    const native = JSON.parse(await readFile(path.join(directory, 'native-config.json'), 'utf8'));
    assert.equal(native.userData, userData);
    const invocations = [
      ['private-mcp', 'mcp', mcpInvocation(mcpCommand(directory), { env })],
      ['codex-plugin', 'mcp', codex],
      ['claude-bundle', 'mcp', { command: process.execPath, args: manifest.server.mcp_config.args.map(value => value.replace('${__dirname}', extracted)) }],
      ['chrome-host', 'native', { command: process.execPath, args: [path.join(appRoot, 'src', 'native-host.cjs'), path.join(directory, 'native-config.json'), `chrome-extension://${BROWSER_IDENTITIES.production.extensionId}/`] }],
      ['firefox-host', 'native', { command: process.execPath, args: [path.join(appRoot, 'src', 'native-host.cjs'), path.join(directory, 'native-config.json'), native.firefoxManifest, BROWSER_IDENTITIES.production.firefoxExtensionId] }],
    ];
    let runningPid;
    for (const [name, channel, invocation] of invocations) {
      const restarted = await exchange(invocation, env, channel);
      owned.set(restarted.pid, userData); runningPid = restarted.pid;
      assert.equal(restarted.profile, expected, name); assert.equal(restarted.userData, userData, name);
      assert.equal(restarted.background, true, name);
      const running = await exchange(invocation, env, channel);
      assert.equal(running.pid, runningPid, name); assert.equal(running.profile, expected, name);
      await stopOwned(runningPid, userData); owned.delete(runningPid);
    }
  }
  assert.deepEqual(await readdir(defaultDirectory), defaultBefore);
  assert.deepEqual(JSON.parse(await readFile(path.join(defaultProfile, 'profile.json'), 'utf8')), { id: 'not-selected-default' });
  assert.deepEqual(await readFile(template), originalTemplate, 'private setup must not embed paths into the distributable bundle');
});

test('missing, unselected and cross-bound profile configurations never fall back to the default profile', { timeout: 30000 }, async t => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'rr-profile-rejection-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'Roaming'), XDG_CONFIG_HOME: path.join(home, 'config') };
  const selected = path.join(home, 'selected', 'device'); await privateDirectory(selected);
  const defaultDirectory = deviceDirectory({ home, env }); await privateDirectory(defaultDirectory);
  await writeFile(path.join(defaultDirectory, 'sentinel.json'), '{"unselected":true}');
  const probe = path.join(home, 'unexpected-launch.cjs'), spawned = path.join(home, 'unexpected-launch.json');
  await writeFile(probe, `require('node:fs').writeFileSync(${JSON.stringify(spawned)}, 'true');`);
  await writeFile(path.join(defaultDirectory, 'mcp-launch.json'), JSON.stringify({ executable: process.execPath, args: [probe, `--user-data-dir=${path.dirname(defaultDirectory)}`],
    directory: defaultDirectory, userData: path.dirname(defaultDirectory), localOnly: false }), { mode: 0o600 });
  await writeFile(path.join(selected, 'mcp-launch.json'), JSON.stringify({ executable: process.execPath, args: [`--user-data-dir=${path.dirname(defaultDirectory)}`],
    directory: selected, userData: path.dirname(defaultDirectory), localOnly: false }), { mode: 0o600 });
  const runner = path.join(source, 'mcp', 'local-runner.cjs');
  for (const args of [[], ['--directory=relative'], [`--directory=${path.join(home, 'missing', 'device')}`], [`--directory=${selected}`]]) {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [runner, ...args], { env, stdio: 'ignore' });
      child.once('error', reject); child.once('exit', resolve);
    });
    assert.equal(code, 1);
  }
  for (const userData of [undefined, path.dirname(defaultDirectory)]) {
    const config = path.join(selected, 'native-config.json');
    await writeFile(config, JSON.stringify({ executable: process.execPath, appPath: probe, directory: selected, userData, packaged: false, localOnly: false }), { mode: 0o600 });
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(source, 'native-host.cjs'), config, `chrome-extension://${BROWSER_IDENTITIES.production.extensionId}/`], { env, stdio: 'ignore' });
      child.once('error', reject); child.once('exit', resolve);
    });
    assert.equal(code, 1);
  }
  await assert.rejects(readFile(spawned), { code: 'ENOENT' });
  assert.deepEqual((await readdir(defaultDirectory)).sort(), ['mcp-launch.json', 'sentinel.json']);
});

test('profile aliases resolve to the same transport and process-exclusion identity', async t => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'rr-profile-alias-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const profile = path.join(home, 'profile'), directory = path.join(profile, 'device');
  await privateDirectory(directory);
  const alias = path.join(home, 'alias');
  await symlink(profile, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const channel of ['native', 'mcp', 'instance'])
    assert.equal(endpoint(path.join(alias, 'device'), channel), endpoint(directory, channel));
});

test('private Claude packages reject mismatched or oversized bundled manifests', async t => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'rr-profile-package-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = path.join(home, 'device'); await privateDirectory(directory);
  const template = path.join(home, 'bundled.mcpb');
  for (const manifest of [
    JSON.stringify({ manifest_version: '0.3', name: 'foreign', version: '3.12.0', server: { type: 'node', entry_point: 'server/index.cjs' } }),
    ' '.repeat(64 * 1024 + 1),
  ]) {
    const archive = new AdmZip();
    archive.addFile('manifest.json', Buffer.from(manifest));
    archive.addFile('server/index.cjs', Buffer.from('/* synthetic bundle member */'));
    archive.addFile('platform-runtime.cjs', Buffer.from('/* synthetic bundle member */'));
    await writeFile(template, archive.toBuffer());
    await assert.rejects(prepareClaudePackage({ template, directory, localOnly: false, version: '3.12.0' }), { code: 'HOST_INSTALL_FAILED' });
    assert.deepEqual(await readdir(directory), []);
  }
});
