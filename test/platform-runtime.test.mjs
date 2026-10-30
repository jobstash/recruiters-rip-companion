import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { supportDirectory, deviceDirectory, endpoint, restrictedEnvironment, launcherScript, mcpCommand, assertPrivatePath, protectPrivatePath } from '../src/platform-runtime.cjs';
import { nativeLocations, installNative } from '../src/install-native.mjs';
import { BROWSER_IDENTITIES, nativeBrowser, nativeInvocationIdentity } from '../src/browser-identity.mjs';
import { privateDirectory } from '../src/vault.mjs';
const run = promisify(execFile);

test('storage directories agree with Electron and preserve product isolation', () => {
  assert.equal(supportDirectory({ platform: 'darwin', home: '/Users/person', env: {} }), '/Users/person/Library/Application Support');
  assert.equal(deviceDirectory({ platform: 'win32', home: 'C:\\Users\\Person', env: { APPDATA: 'D:\\Roaming Profile' } }), 'D:\\Roaming Profile\\Recruiters Companion\\device');
  assert.equal(deviceDirectory({ platform: 'win32', home: 'C:\\Users\\Person', env: {}, localOnly: true }), 'C:\\Users\\Person\\AppData\\Roaming\\Recruiters Companion\\local-device');
  assert.equal(deviceDirectory({ platform: 'linux', home: '/home/person', env: { XDG_CONFIG_HOME: '/custom/config' } }), '/custom/config/Recruiters Companion/device');
});

test('Windows pipe identities separate channels and storage identities without Unix filesystem paths', () => {
  const directory = 'C:\\Users\\Person\\AppData\\Roaming\\Recruiters Companion\\device';
  const channels = ['native', 'mcp', 'instance'].map(channel => endpoint(directory, channel, 'win32'));
  assert.equal(new Set(channels).size, 3);
  for (const pipe of channels) assert.match(pipe, /^\\\\\.\\pipe\\recruiters-companion-[a-f0-9]{32}-(native|mcp|instance)$/);
  assert.equal(endpoint(directory, 'mcp', 'win32'), endpoint(directory.toLowerCase(), 'mcp', 'win32'));
  assert.notEqual(endpoint(directory, 'mcp', 'win32'), endpoint(directory.replace('\\device', '\\local-device'), 'mcp', 'win32'));
  assert.match(endpoint('/tmp/device', 'instance', 'linux'), /^\0recruiters-companion-/);
  assert.equal(endpoint('/tmp/device', 'native', 'darwin'), '/tmp/device/native.sock');
  assert.throws(() => endpoint(directory, 'foreign', 'win32'));
  assert.equal(mcpCommand(directory, 'win32'), `${directory}\\recruiters-rip-mcp.cmd`);
});

test('subprocess environments retain OS essentials, not credentials or Node injection', () => {
  const env = { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', APPDATA: 'C:\\Profile\\Roaming', LOCALAPPDATA: 'C:\\Profile\\Local', USERPROFILE: 'C:\\Profile', TEMP: 'C:\\Temp', COMSPEC: 'C:\\Windows\\System32\\cmd.exe', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', CLAUDE_CODE_OAUTH_TOKEN: 'secret', NODE_OPTIONS: '--require evil', ELECTRON_RUN_AS_NODE: '1', HTTPS_PROXY: 'secret' };
  assert.deepEqual(restrictedEnvironment(env, 'win32'), Object.fromEntries(Object.entries(env).slice(0, 7)));
  assert.deepEqual(restrictedEnvironment({ HOME: '/home/person', PATH: '/bin', DISPLAY: ':1', XDG_CONFIG_HOME: '/config', OPENAI_API_KEY: 'secret', NODE_OPTIONS: 'evil' }, 'linux'), { HOME: '/home/person', PATH: '/bin', DISPLAY: ':1', XDG_CONFIG_HOME: '/config' });
});

for (const [channel, identity] of Object.entries(BROWSER_IDENTITIES)) test(`${channel} native identity distinguishes Firefox and Chrome and rejects foreign invocations`, () => {
  const manifest = '/private/Firefox host.json', chrome = `chrome-extension://${identity.extensionId}/`;
  assert.equal(nativeInvocationIdentity(identity, [chrome]), chrome);
  assert.equal(nativeInvocationIdentity(identity, [chrome, '--parent-window=123'], { platform: 'win32' }), chrome);
  assert.equal(nativeInvocationIdentity(identity, [manifest, identity.firefoxExtensionId], { firefoxManifest: manifest }), identity.firefoxExtensionId);
  assert.equal(nativeBrowser(identity, chrome), 'chrome');
  assert.equal(nativeBrowser(identity, identity.firefoxExtensionId), 'firefox');
  const other = channel === 'production' ? BROWSER_IDENTITIES.local : BROWSER_IDENTITIES.production;
  for (const args of [[`chrome-extension://${other.extensionId}/`], [chrome, 'extra'], [chrome, '--parent-window=not-a-number'], ['/other/manifest', identity.firefoxExtensionId], [manifest, other.firefoxExtensionId], [identity.firefoxExtensionId], [manifest, identity.firefoxExtensionId, 'extra']])
    assert.throws(() => nativeInvocationIdentity(identity, args, { platform: 'win32', firefoxManifest: manifest }));
  assert.equal(nativeBrowser(identity, other.firefoxExtensionId), null);
});

test('native registrations use per-user browser locations and actual allowlist type', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rr-native-locations-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identity = BROWSER_IDENTITIES.production;
  const windows = nativeLocations({ directory: 'C:\\Private', identity, platform: 'win32', home: 'C:\\User', env: {} });
  assert.equal(windows.length, 5);
  assert.deepEqual(windows.map(value => value.registry), ['Google\\Chrome', 'Chromium', 'Microsoft\\Edge', 'BraveSoftware\\Brave-Browser', 'Mozilla'].map(browser => `HKCU\\Software\\${browser}\\NativeMessagingHosts\\${identity.nativeHost}`));
  const linux = nativeLocations({ directory, identity, platform: 'linux', home: '/home/test', env: { XDG_CONFIG_HOME: '/config' } });
  assert.equal(linux[0].manifest, `/config/google-chrome/NativeMessagingHosts/${identity.nativeHost}.json`);
  assert.equal(linux[4].manifest, `/home/test/.mozilla/native-messaging-hosts/${identity.nativeHost}.json`);
  const mac = nativeLocations({ directory, identity, platform: 'darwin', home: '/Users/test', env: {} });
  assert.equal(mac[4].manifest, `/Users/test/Library/Application Support/Mozilla/NativeMessagingHosts/${identity.nativeHost}.json`);
  if (process.platform === 'win32') return; // Actual registry writes are never a unit-test side effect.
  const result = await installNative({ executable: process.execPath, appPath: directory, directory: path.join(directory, 'device'), packaged: false, home: directory, platform: 'linux', env: { XDG_CONFIG_HOME: path.join(directory, 'config') } });
  assert.deepEqual(result.browsers, { chrome: true, firefox: true });
  for (const location of nativeLocations({ directory: path.join(directory, 'device'), identity, platform: 'linux', home: directory, env: { XDG_CONFIG_HOME: path.join(directory, 'config') } })) {
    const manifest = JSON.parse(await readFile(location.manifest, 'utf8'));
    if (location.browser === 'firefox') { assert.deepEqual(manifest.allowed_extensions, [identity.firefoxExtensionId]); assert.equal(manifest.allowed_origins, undefined); }
    else { assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${identity.extensionId}/`]); assert.equal(manifest.allowed_extensions, undefined); }
  }
});

test('generated native launcher forwards browser arguments with spaces and drops inherited secrets', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rr launcher & spaces-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'capture args.cjs');
  await writeFile(script, `process.stdout.write(JSON.stringify({args:process.argv.slice(2),secret:process.env.OPENAI_API_KEY??null,nodeOptions:process.env.NODE_OPTIONS??null,mode:process.env.ELECTRON_RUN_AS_NODE,systemRoot:process.env.SYSTEMROOT??process.env.SystemRoot??null}));`);
  const launcher = path.join(directory, process.platform === 'win32' ? 'native.bat' : 'native');
  await writeFile(launcher, launcherScript({ executable: process.execPath, script, args: ['fixed path with spaces'], forwardArgs: true }), { mode: 0o700 });
  const args = ['manifest path with spaces', BROWSER_IDENTITIES.production.firefoxExtensionId];
  const invocation = process.platform === 'win32' ? [process.env.ComSpec || process.env.COMSPEC, ['/d', '/v:off', '/s', '/c', `""${launcher}" ${args.map(value => `"${value}"`).join(' ')}"`]] : [launcher, args];
  const { stdout } = await run(...invocation, { env: { ...process.env, OPENAI_API_KEY: 'synthetic-secret', NODE_OPTIONS: '--require nonexistent-secret-hook' }, windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' });
  const proof = JSON.parse(stdout);
  assert.deepEqual(proof.args, ['fixed path with spaces', ...args]);
  assert.equal(proof.secret, null); assert.equal(proof.nodeOptions, null); assert.equal(proof.mode, '1');
  if (process.platform === 'win32') assert.ok(proof.systemRoot);
});

test('private storage uses OS permissions and rejects exposed files', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rr-private-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await privateDirectory(directory);
  assertPrivatePath(directory, { directory: true });
  const file = path.join(directory, 'private.json');
  await writeFile(file, '{}', { mode: 0o600 });
  protectPrivatePath(file); assertPrivatePath(file);
  if (process.platform === 'win32') {
    const root = process.env.SYSTEMROOT || process.env.SystemRoot;
    await run(path.win32.join(root, 'System32', 'icacls.exe'), [file, '/grant', '*S-1-1-0:R'], { windowsHide: true });
  } else await chmod(file, 0o644);
  assert.throws(() => assertPrivatePath(file));
});

test('Windows ACL subprocess closes unused input and retains diagnostic output without credentials', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rr-acl-process-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  protectPrivatePath(directory, { platform: 'win32', directory: true,
    env: { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Profile', OPENAI_API_KEY: 'synthetic-secret' },
    run(executable, args, options) {
      calls++;
      assert.equal(executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      assert.ok(args.includes('-NonInteractive'));
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      assert.equal(options.env.OPENAI_API_KEY, undefined);
      assert.equal(options.env.SystemRoot, 'C:\\Windows');
    },
  });
  assert.equal(calls, 1);
});

test('POSIX launchers do not turn absent temporary-directory variables into empty values', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rr-unset-environment-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'environment.cjs'), launcher = path.join(directory, 'launcher');
  await writeFile(script, "process.stdout.write(JSON.stringify({tmp:process.env.TMPDIR??null,home:process.env.HOME}));");
  await writeFile(launcher, launcherScript({ executable: process.execPath, script, platform: 'linux' }), { mode: 0o700 });
  for (const temporary of [undefined, '', '/tmp/space and $literal']) {
    const env = { ...process.env, HOME: directory }; delete env.TMPDIR;
    if (temporary !== undefined) env.TMPDIR = temporary;
    const { stdout } = await run(launcher, [], { env });
    assert.deepEqual(JSON.parse(stdout), { tmp: temporary || null, home: directory });
    assert.equal(restrictedEnvironment(env, 'linux').TMPDIR, temporary || undefined);
  }
});
