// CI-only: launch a real packaged app using disposable profile and vault paths.
// No pairing, inference, or user-data fixtures are used.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_IDENTITIES } from '../src/browser-identity.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true') {
  throw new Error('Packaged smoke may run only in a disposable GitHub Actions runner, never against a local user session.');
}
if (process.platform === 'linux' && process.getuid() === 0) throw new Error('Run the packaged Linux smoke as a non-root user with the Chromium sandbox enabled.');
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const scratch = await realpath(await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), 'recruiters-package-smoke-')));
const home = path.join(scratch, 'home');
const userData = path.join(home, ...(process.platform === 'darwin' ? ['Library', 'Application Support']
  : process.platform === 'win32' ? ['AppData', 'Roaming'] : ['.config']), 'Recruiters Companion');
const temporary = path.join(scratch, 'tmp');
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CACHE_HOME: path.join(home, '.cache'),
  XDG_RUNTIME_DIR: path.join(scratch, 'runtime'), TMPDIR: temporary, TMP: temporary, TEMP: temporary };
for (const key of Object.keys(env)) {
  if (/^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH|OPENAI_API_KEY|ANTHROPIC_API_KEY|RECRUITERS_COMPANION_DEV|APPIMAGE|APPDIR|APPIMAGE_EXTRACT_AND_RUN)$/i.test(key)) delete env[key];
}
if (process.platform === 'win32') {
  env.HOMEDRIVE = path.parse(home).root.replace(/[\\/]$/, '');
  env.HOMEPATH = home.slice(env.HOMEDRIVE.length);
}
if (process.platform === 'linux') env.APPIMAGE_EXTRACT_AND_RUN = '1';
const execute = promisify(execFile);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let child, browser, page, launchError, exit, browserUrl, logs = '';
const append = bytes => {
  logs = (logs + bytes.toString()).slice(-512 * 1024);
  browserUrl ||= /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/.exec(logs)?.[1];
};
function alive() {
  if (launchError) throw launchError;
  if (exit) throw new Error(`Packaged app exited before smoke completed (${exit.code ?? exit.signal}).`);
}
async function until(work, timeout, description) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    alive();
    const result = await work();
    if (result) return result;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}
async function connect(url) {
  const address = new URL(url);
  if (address.protocol !== 'ws:' || address.hostname !== '127.0.0.1') throw new Error('CDP must use loopback only.');
  const socket = new WebSocket(url), pending = new Map();
  let sequence = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP connection closed.')); }
    pending.clear();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connection timed out.')); }, 10000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed.')); }, { once: true });
  });
  return { close: () => socket.close(), send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out.`)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  } };
}

async function isolatedLinuxProcesses() {
  const matches = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const entries = (await readFile(`/proc/${name}/environ`, 'utf8')).split('\0');
      if (entries.includes(`HOME=${home}`)) matches.push(Number(name));
    } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
  }
  return matches;
}
async function stopIsolatedLinuxProcesses() {
  for (const pid of await isolatedLinuxProcesses()) {
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await delay(500);
  for (const pid of await isolatedLinuxProcesses()) {
    try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const deadline = Date.now() + 5000;
  while ((await isolatedLinuxProcesses()).length && Date.now() < deadline) await delay(100);
  assert.deepEqual(await isolatedLinuxProcesses(), [], 'Disposable AppImage processes did not exit.');
}
async function exchange(executable, args, request, native) {
  const helper = spawn(executable, args, { env, cwd: scratch, stdio: ['pipe', 'pipe', 'pipe'] });
  const bytes = Buffer.from(JSON.stringify(request) + (native ? '' : '\n'));
  const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
  let input = Buffer.alloc(0);
  helper.stderr.on('data', append);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Packaged bridge response timed out.')), 60000);
      const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
      helper.once('error', error => finish(error));
      helper.once('exit', code => finish(new Error(`Packaged bridge exited before responding (${code}).`)));
      helper.stdout.on('data', chunk => {
        try {
          input = Buffer.concat([input, chunk]);
          if (input.length > 1024 * 1024) throw new Error('Packaged bridge response exceeded its bound.');
          for (;;) {
            const length = native ? input.length >= 4 ? input.readUInt32LE(0) : -1 : input.indexOf(10);
            if (length < 0 || (native && input.length < length + 4)) break;
            const value = JSON.parse(input.subarray(native ? 4 : 0, native ? length + 4 : length).toString('utf8'));
            input = input.subarray(native ? length + 4 : length + 1);
            if (value.id === request.id) finish(null, value);
          }
        } catch (error) { finish(error); }
      });
      helper.stdin.on('error', error => finish(error));
      helper.stdin.write(native ? Buffer.concat([header, bytes]) : bytes);
    });
  } finally {
    helper.stdin.end();
    if (helper.exitCode === null) helper.kill('SIGTERM');
  }
}

try {
  for (const directory of [home, userData, temporary, env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_RUNTIME_DIR]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  let executable;
  if (process.platform === 'darwin') {
    executable = path.join(root, 'dist', 'adhoc', 'mac-arm64', `${pkg.build.productName}.app`, 'Contents', 'MacOS', pkg.build.productName);
  } else if (process.platform === 'win32') {
    const installer = path.join(root, 'dist', 'windows', `recruiters-rip-companion-${pkg.version}-win-x64.exe`);
    const installDirectory = path.join(scratch, 'installed');
    // NSIS /D is its final argument and is deliberately not quoted. GitHub's
    // RUNNER_TEMP has no spaces; reject a different layout rather than misparse.
    if (/\s/.test(installDirectory)) throw new Error('The disposable NSIS installation directory must not contain whitespace.');
    await execute(installer, ['/S', `/D=${installDirectory}`], { env, timeout: 180000, windowsVerbatimArguments: true });
    executable = path.join(installDirectory, `${pkg.build.productName}.exe`);
  } else if (process.platform === 'linux') {
    executable = path.join(root, 'dist', 'linux', `recruiters-rip-companion-${pkg.version}-linux-x64.AppImage`);
  } else throw new Error('Unsupported packaged smoke platform.');
  await realpath(executable);
  child = spawn(executable, [`--user-data-dir=${userData}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
    { env, cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  child.stdout.on('data', append); child.stderr.on('data', append);
  child.once('error', error => { launchError = error; });
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  await until(() => browserUrl, 120000, 'packaged Electron CDP endpoint');
  browser = await connect(browserUrl);
  const address = new URL(browserUrl);
  const target = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${address.port}/json/list`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    return (await response.json()).find(item => item.type === 'page' && item.url.startsWith('file:') && item.webSocketDebuggerUrl);
  }, 30000, 'packaged settings renderer');
  page = await connect(target.webSocketDebuggerUrl);
  const state = await until(async () => {
    const result = await page.send('Runtime.evaluate', { expression: 'typeof window.companion === "object" ? window.companion.invoke("state") : null', awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`Settings state IPC failed: ${result.exceptionDetails.text}`);
    const response = result.result?.value;
    if (response?.ok === false) throw new Error(`Settings state IPC failed: ${response.error?.message || 'unknown error'}`);
    const value = response?.result;
    if (value?.failure) throw new Error(`Packaged initialization failed: ${value.failure}`);
    if (!['ready', 'needs_connection'].includes(value?.execution?.state)) return null;
    if (!value.browserIntegration?.registered?.chrome || !value.browserIntegration?.registered?.firefox) return null;
    return value;
  }, 120000, 'unlocked app and Chrome/Firefox native registrations');
  assert.equal(state.installed, true);
  assert.equal(state.paired, false, 'A synthetic vault must not contain a pairing.');
  assert.equal(state.decisionApiConfigured, false, 'A synthetic vault must not contain inference credentials.');
  assert.equal(state.failure, '');
  assert.ok(state.setup?.command?.startsWith(`${scratch}${path.sep}`), 'MCP launcher escaped the disposable profile.');
  assert.ok((await readdir(path.dirname(state.setup.command))).includes('native-config.json'));
  await browser.send('Browser.close').catch(() => {});
  const deadline = Date.now() + 10000;
  while (!exit && Date.now() < deadline) await delay(100);
  if (!exit) throw new Error('Packaged application did not close after the smoke.');
  if (process.platform === 'linux') {
    await stopIsolatedLinuxProcesses();
    const device = path.dirname(state.setup.command);
    const config = JSON.parse(await readFile(path.join(device, 'native-config.json'), 'utf8'));
    assert.equal(config.executable, await realpath(executable), 'Native launch must retain the stable AppImage, not its transient mount.');
    assert.ok(config.appPath.startsWith(`${device}${path.sep}`), 'The standalone bridge must persist inside the disposable private profile.');
    const manifest = JSON.parse(await readFile(config.firefoxManifest, 'utf8'));
    for (const args of [[`chrome-extension://${BROWSER_IDENTITIES.production.extensionId}/`], [config.firefoxManifest, BROWSER_IDENTITIES.production.firefoxExtensionId]]) {
      const reply = await exchange(manifest.path, args, { version: 1, id: 'smoke-status', op: 'status', payload: {} }, true);
      assert.equal(reply.ok, true);
      assert.equal(reply.result.installed, true);
      assert.equal(reply.result.paired, false);
      await stopIsolatedLinuxProcesses();
    }
    const reply = await exchange(state.setup.command, [], { jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'packaged-ci-smoke', version: '1.0.0' } } }, false);
    assert.equal(reply.error, undefined);
    assert.equal(typeof reply.result?.serverInfo?.name, 'string');
    await stopIsolatedLinuxProcesses();
  }
  console.log(JSON.stringify({ packagedSmoke: 'passed', platform: process.platform, version: pkg.version,
    installedFrom: process.platform === 'win32' ? 'NSIS' : process.platform === 'linux' ? 'AppImage' : 'app bundle',
    execution: state.execution.state, browserRegistrations: state.browserIntegration.registered,
    isolatedProfile: true, ...(process.platform === 'linux' ? { postQuitNativeChrome: true, postQuitNativeFirefox: true, postQuitMcpInitialize: true } : {}) }));
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  page?.close(); browser?.close();
  if (child?.pid) {
    if (process.platform === 'win32') {
      if (!exit) await execute(path.join(process.env.SYSTEMROOT || process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F']).catch(() => {});
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  if (process.platform === 'linux') await stopIsolatedLinuxProcesses();
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
