// Native CI only: real public-wrapper code, local Git clones, frozen dependency
// installs, builds, Electron startup and managed-source update handoff. The tag
// is not public yet: two explicitly local-candidate commits are the release
// transport fixture. No confirmation is ever written by this harness.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createVault } from '../src/vault.mjs';
import { BROWSER_IDENTITIES } from '../src/browser-identity.mjs';
import { connectAuthenticated, endpoint } from '../src/platform-runtime.cjs';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('Source smoke requires a disposable GitHub-hosted runner.');
if (!((process.platform === 'darwin' && process.arch === 'arm64') || (['win32', 'linux'].includes(process.platform) && process.arch === 'x64'))) throw new Error('Unsupported source-smoke platform; not a passing or skipped gate.');
if (process.platform === 'linux' && process.getuid() === 0) throw new Error('Source smoke requires non-root Chromium sandboxing.');
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);
assert.ok([major, minor, patch].every(Number.isSafeInteger));
const baselineVersion = patch > 0 ? `${major}.${minor}.${patch - 1}` : minor > 0 ? `${major}.${minor - 1}.99` : major > 0 ? `${major - 1}.99.99` : null;
assert.ok(baselineVersion, 'A stable candidate newer than 0.0.0 is required.');
// GitHub's Windows RUNNER_TEMP is on a shared work drive; do not weaken the
// installer's trusted-ancestor checks to accommodate a replaceable CI fixture.
const scratchBase = process.platform === 'win32' ? tmpdir() : process.env.RUNNER_TEMP || tmpdir();
const scratch = await realpath(await mkdtemp(path.join(scratchBase, 'recruiters-source-smoke-')));
const home = path.join(scratch, 'home'), managedRoot = path.join(scratch, 'managed');
const defaultUserData = path.join(home, ...(process.platform === 'darwin' ? ['Library', 'Application Support'] : process.platform === 'win32' ? ['AppData', 'Roaming'] : ['.config']), 'Recruiters Companion');
const userData = path.join(scratch, 'profiles', 'selected');
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_RUNTIME_DIR: path.join(scratch, 'runtime'), TMPDIR: path.join(scratch, 'tmp'), TMP: path.join(scratch, 'tmp'), TEMP: path.join(scratch, 'tmp') };
// A pwsh -> Node -> powershell.exe chain otherwise passes PS7's incompatible
// module search path to Windows PowerShell; each child must build its own path.
for (const key of Object.keys(env)) if (/^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH|PSMODULEPATH|OPENAI_API_KEY|ANTHROPIC_API_KEY|RECRUITERS_COMPANION_DEV|APPIMAGE|APPDIR|APPIMAGE_EXTRACT_AND_RUN)$/i.test(key)) delete env[key];
if (process.platform === 'win32') { env.HOMEDRIVE = path.parse(home).root.replace(/[\\/]$/, ''); env.HOMEPATH = home.slice(env.HOMEDRIVE.length); }
const execute = promisify(execFile), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const reportFile = path.join(root, 'dist', 'source-update-smoke.json');
const report = { result: 'failed', platform: process.platform, arch: process.arch, from: baselineVersion, to: pkg.version,
  fixture: 'explicit local-candidate Git commits; baseline changes package version only, target is the exact checked-out candidate commit; no unpublished tag presented as public', scenarios: [] };
const connections = [];
const sourceExecutables = new Set();
let launcher, initialPid, restartedPid, logs = '', journal, inspectorUrl, browserUrl;
const append = bytes => {
  logs = (logs + bytes.toString()).slice(-1024 * 1024);
  inspectorUrl ||= /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(logs)?.[1];
  browserUrl ||= /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/.exec(logs)?.[1];
};
async function command(file, args, options = {}) {
  try { const result = await execute(file, args, { env, cwd: scratch, timeout: 20 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, ...options }); append(result.stdout); append(result.stderr); return result.stdout.trim(); }
  catch (error) { append(error.stdout || ''); append(error.stderr || ''); throw error; }
}
async function until(work, timeout, description) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await work(); if (value) return value; await delay(250); }
  throw new Error(`Timed out waiting for ${description}.`);
}
async function rendererEndpoint() {
  try {
    const response = await fetch(`http://127.0.0.1:${new URL(browserUrl).port}/json/list`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    return (await response.json()).find(item => item.webSocketDebuggerUrl && item.type === 'page' && item.url.startsWith('file:'))?.webSocketDebuggerUrl;
  } catch (error) { if (error instanceof TypeError || error.name === 'TimeoutError') return null; throw error; }
}
async function connect(url) {
  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'ws:'); assert.equal(parsed.hostname, '127.0.0.1');
  const socket = new WebSocket(url), pending = new Map(); let sequence = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), request = pending.get(message.id); if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  socket.addEventListener('close', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Source inspector closed.')); } pending.clear(); });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Source inspector timed out.')), 10000); socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true }); socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Source inspector failed.')); }, { once: true }); });
  const connection = { close: () => socket.close(), detachMain() {
    // This is terminal: inspector.close() may disconnect before replying.
    // Actual process exit and app-written update confirmation prove handoff;
    // a WebSocket close-frame acknowledgement is not a runtime requirement.
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: ++sequence, method: 'Runtime.evaluate',
      params: { expression: "setImmediate(() => process.getBuiltinModule('inspector').close())" } }));
    socket.close();
  }, send(expression) { return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Source operation timed out.')); }, 25 * 60 * 1000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  }); } }; connections.push(connection); return connection;
}
async function evaluate(connection, expression) {
  const response = await connection.send(expression);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result?.value;
}
async function stop(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
  if (process.platform === 'win32') await execute(path.join(env.SYSTEMROOT || env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F']).catch(() => {});
  else { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
}
async function transition() {
  try {
    const active = JSON.parse(await readFile(path.join(managedRoot, 'transition.json'), 'utf8'));
    assert.match(active.id, /^[a-f0-9]{32}$/);
    return JSON.parse(await readFile(path.join(managedRoot, 'transitions', active.id, 'journal.json'), 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function trackSource(sourceRoot) {
  const executable = path.join(sourceRoot, 'node_modules', 'electron', 'dist', ...(process.platform === 'darwin' ? ['Electron.app', 'Contents', 'MacOS', 'Electron'] : [process.platform === 'win32' ? 'electron.exe' : 'electron']));
  // These files must already exist after build and before any app launch.
  // Invoking Electron's lazy CLI here would conceal a missing runtime install.
  const electronRoot = path.join(sourceRoot, 'node_modules', 'electron');
  const runtime = JSON.parse(await readFile(path.join(electronRoot, 'package.json'), 'utf8'));
  assert.equal(runtime.version, pkg.devDependencies.electron, 'The built source must contain the exact pinned Electron package.');
  assert.equal((await readFile(path.join(electronRoot, 'dist', 'version'), 'utf8')).trim().replace(/^v/, ''), runtime.version);
  const binary = await stat(executable);
  assert.ok(binary.isFile() && binary.size > 0, 'The native Electron executable must exist before launching.');
  sourceExecutables.add(executable); sourceExecutables.add(await realpath(executable));
}
async function macSourceProcessDetails() {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,stat=,comm=', '-ww'], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line))
    .filter(match => match && sourceExecutables.has(match[4]))
    .map(match => ({ pid: Number(match[1]), parentPid: Number(match[2]), state: match[3], executable: match[4] }));
}
async function sourceProcesses() {
  if (!sourceExecutables.size) return [];
  if (process.platform === 'win32') {
    const paths = [...sourceExecutables].map(value => `'${value.replaceAll("'", "''")}'`).join(',');
    const script = `$paths=@(${paths}); @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -in $paths } | ForEach-Object { [int]$_.ProcessId }) | ConvertTo-Json -Compress`;
    const result = await command(path.join(env.SYSTEMROOT || env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
    const ids = result ? JSON.parse(result) : []; return Array.isArray(ids) ? ids : [ids];
  }
  if (process.platform === 'linux') {
    const ids = [];
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try { if (sourceExecutables.has(await realpath(`/proc/${name}/exe`))) ids.push(Number(name)); }
      catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
    }
    return ids;
  }
  // Zombies have exited and cannot hold an installation lease or serve a
  // profile. Waiting for their unrelated parent to reap them is not app exit.
  return (await macSourceProcessDetails()).filter(info => !info.state.startsWith('Z')).map(info => info.pid);
}
async function requestMacQuit(pid) {
  const owned = (await macSourceProcessDetails()).find(info => info.pid === pid && !info.state.startsWith('Z'));
  if (!owned) return 'already-exited';
  const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  const script = [
    'use framework "AppKit"',
    `set targetApp to current application's NSRunningApplication's runningApplicationWithProcessIdentifier:${pid}`,
    'if targetApp is missing value then return "not-application"',
    "set executableURL to targetApp's executableURL()",
    "set executablePath to executableURL's |path|() as text",
    `set expectedPaths to {${[...sourceExecutables].map(quote).join(',')}}`,
    'if expectedPaths does not contain executablePath then error "Owned executable changed before Quit"',
    "set requested to (targetApp's terminate()) as boolean",
    'if requested then return "quit-requested"',
    'return "quit-refused"',
  ].join('\n');
  const { stdout, stderr } = await execute('/usr/bin/osascript', ['-e', script], { env, cwd: scratch, timeout: 10000, maxBuffer: 8192 });
  append(stderr);
  const result = stdout.trim();
  if (result === 'not-application') {
    // Run-as-Node bridge helpers are not AppKit applications. Only those
    // exact owned helper PIDs may use SIGTERM; never substitute it for Quit.
    if (pid === restartedPid && (await sourceProcesses()).includes(pid)) throw new Error('The owned main process was not recognized as an AppKit application.');
    if ((await sourceProcesses()).includes(pid)) await stop(pid);
    return 'owned-node-helper-signalled';
  }
  assert.equal(result, 'quit-requested', 'The owned Mac application refused its ordinary Quit request.');
  return result;
}
async function captureQuitAdmission() {
  // Failure-only read of the existing authenticated service. Never invoke a
  // launcher here: doing so could restart the app and destroy shutdown evidence.
  let socket;
  const pending = new Map();
  try {
    const device = path.join(userData, 'device');
    const config = JSON.parse(await readFile(path.join(device, 'mcp-bridge.json'), 'utf8'));
    assert.equal(config.socket, endpoint(device, 'mcp'));
    socket = await connectAuthenticated(config.socket, config.token, 'mcp', { timeout: 2000 });
    let input = '';
    const fail = error => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear(); };
    socket.on('error', fail); socket.on('close', () => fail(new Error('Existing MCP service closed.')));
    socket.on('data', chunk => {
      try {
        input += chunk.toString('utf8');
        if (Buffer.byteLength(input) > 128 * 1024) throw new Error('Quit probe response exceeded its bound.');
        for (;;) {
          const end = input.indexOf('\n'); if (end < 0) break;
          const reply = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
          const request = pending.get(reply.id);
          if (request) { pending.delete(reply.id); clearTimeout(request.timer); request.resolve(reply); }
        }
      } catch (error) { fail(error); }
    });
    socket.resume();
    const request = (id, method, params) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Existing MCP service did not answer the quit probe.')); }, 2000);
      pending.set(id, { resolve, reject, timer });
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const initialized = await request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'source-quit-diagnostic', version: '1.0.0' } });
    if (initialized.error) return { authenticated: true, initializationError: initialized.error };
    socket.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const reply = await request(2, 'tools/call', { name: 'career_profile_read', arguments: {} });
    if (reply.error) return { authenticated: true, protocolError: reply.error };
    const detail = JSON.parse(reply.result?.content?.find(item => item.type === 'text')?.text);
    if (reply.result.isError) return { authenticated: true, profileRead: 'rejected', error: detail.error };
    if (!detail?.profile) return { authenticated: true, profileRead: 'invalid-response' };
    return { authenticated: true, profileRead: 'succeeded', version: initialized.result?.serverInfo?.version };
  } catch (error) { return { probeError: error.code || error.message.slice(0, 512) }; }
  finally { socket?.destroy(); for (const request of pending.values()) clearTimeout(request.timer); }
}

async function closeSelectedApp() {
  for (const connection of connections) connection.close();
  let sample;
  if (process.platform === 'darwin') {
    sample = { method: 'NSRunningApplication.terminate', before: await macSourceProcessDetails(), requests: [] };
    (report.macSourceShutdowns ??= []).push(sample);
  }
  try {
    for (const pid of await sourceProcesses()) {
      if (sample) sample.requests.push({ pid, outcome: await requestMacQuit(pid) });
      else await stop(pid);
    }
    await until(async () => (await sourceProcesses()).length === 0, 15000, 'owned source processes to exit before background relaunch');
  }
  catch (error) {
    if (sample) sample.existingServiceAfterQuit = await captureQuitAdmission();
    throw error;
  }
  finally { if (sample) sample.after = await macSourceProcessDetails(); }
}
async function bridgeSession(executable, args, native, action) {
  const options = { env, cwd: scratch, stdio: ['pipe', 'pipe', 'pipe'] };
  let child;
  if (process.platform === 'win32') {
    const values = [executable, ...args];
    if (values.some(value => /["%!\r\n]/.test(value))) throw new Error('Unsafe generated Windows bridge argument.');
    child = spawn(path.join(env.SYSTEMROOT || env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/s', '/c', `"${values.map(value => `"${value}"`).join(' ')}"`], { ...options, windowsVerbatimArguments: true, windowsHide: true });
  } else child = spawn(executable, args, options);
  const pending = new Map(); let input = Buffer.alloc(0), failure, exited = false;
  const fail = error => { failure ||= error; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  child.stderr.on('data', append); child.once('error', fail);
  child.once('exit', code => { exited = true; if (pending.size) fail(new Error(`Generated bridge exited before replying (${code}).`)); });
  child.stdin.on('error', fail);
  child.stdout.on('data', chunk => {
    try {
      input = Buffer.concat([input, chunk]);
      if (input.length > 16 * 1024 * 1024) throw new Error('Generated bridge exceeded its frame bound.');
      for (;;) {
        const length = native ? input.length >= 4 ? input.readUInt32LE(0) : -1 : input.indexOf(10);
        if (length > (native ? 1024 * 1024 : 16 * 1024 * 1024)) throw new Error('Invalid generated bridge frame size.');
        if (length < 0 || (native && input.length < length + 4)) break;
        const message = JSON.parse(input.subarray(native ? 4 : 0, native ? length + 4 : length).toString('utf8'));
        input = input.subarray(native ? length + 4 : length + 1);
        const item = pending.get(message.id);
        if (item) { pending.delete(message.id); clearTimeout(item.timer); item.resolve(message); }
      }
    } catch (error) { fail(error); }
  });
  const send = message => {
    const bytes = Buffer.from(JSON.stringify(message) + (native ? '' : '\n'));
    if (native) { const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); child.stdin.write(Buffer.concat([header, bytes])); }
    else child.stdin.write(bytes);
  };
  const request = message => new Promise((resolve, reject) => {
    if (failure || exited) { reject(failure || new Error('Generated bridge already exited.')); return; }
    const timer = setTimeout(() => { pending.delete(message.id); reject(new Error('Generated bridge response timed out.')); }, 60000);
    pending.set(message.id, { resolve, reject, timer }); send(message);
  });
  try { return await action(request, send); }
  finally { child.stdin.end(); for (let count = 0; !exited && count < 20; count++) await delay(100); if (!exited) child.kill('SIGTERM'); fail(new Error('Generated bridge session closed.')); }
}
async function assertMcpProfile(commandPath, name, version) {
  assert.ok(commandPath.startsWith(`${path.join(userData, 'device')}${path.sep}`));
  const launch = JSON.parse(await readFile(path.join(userData, 'device', 'mcp-launch.json'), 'utf8'));
  assert.equal(launch.directory, path.join(userData, 'device')); assert.equal(launch.userData, userData);
  assert.deepEqual(launch.args.filter(value => value.startsWith('--user-data-dir=')), [`--user-data-dir=${userData}`]);
  return bridgeSession(commandPath, [], false, async (request, send) => {
    const initialized = await request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'source-profile-smoke', version: '1.0.0' } } });
    assert.equal(initialized.error, undefined);
    assert.equal(initialized.result?.serverInfo?.version, version);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    let sequence = 1;
    const profile = await until(async () => {
      const reply = await request({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name: 'career_profile_read', arguments: {} } });
      assert.equal(reply.error, undefined);
      const text = reply.result?.content?.find(item => item.type === 'text')?.text;
      const value = JSON.parse(text);
      if (reply.result?.isError && value.error?.code === 'LOCAL_LOCKED') return null;
      assert.notEqual(reply.result?.isError, true);
      return value;
    }, 60000, 'selected-profile MCP core readiness');
    assert.equal(profile.profile.name, name, 'Generated MCP must reach the selected profile, never the synthetic default.');
  });
}
async function assertBrowserProfile(device, browser, deviceId, version) {
  const config = JSON.parse(await readFile(path.join(device, 'native-config.json'), 'utf8'));
  assert.equal(config.directory, device);
  assert.equal(config.userData, userData);
  const manifest = JSON.parse(await readFile(config.firefoxManifest, 'utf8'));
  assert.ok(manifest.path.startsWith(`${device}${path.sep}`));
  const args = browser === 'firefox' ? [config.firefoxManifest, BROWSER_IDENTITIES.production.firefoxExtensionId] : [`chrome-extension://${BROWSER_IDENTITIES.production.extensionId}/`];
  return bridgeSession(manifest.path, args, true, async request => {
    let sequence = 0;
    const status = await until(async () => {
      const reply = await request({ version: 1, id: `source-status-${++sequence}`, op: 'status', payload: {} });
      assert.equal(reply.ok, true);
      return reply.result?.installed && typeof reply.result.deviceId === 'string' ? reply.result : null;
    }, 60000, 'selected-profile native status');
    assert.equal(status.deviceId, deviceId, 'Generated browser host must reach the selected profile, never the synthetic default.');
    assert.equal(status.paired, false);
    assert.equal(status.companionVersion, version);
  });
}
async function observeBackgroundStartup(previousPid) {
  const confirmed = await until(async () => {
    const current = await transition();
    return current?.status === 'confirmed' && Number.isSafeInteger(current.launchedPid) && current.launchedPid !== previousPid ? current : null;
  }, 120000, 'real selected-profile background startup confirmation');
  process.kill(confirmed.launchedPid, 0);
  assert.equal(confirmed.userData, userData);
  restartedPid = confirmed.launchedPid;
}
try {
  for (const directory of [home, userData, env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_RUNTIME_DIR, env.TMP]) await mkdir(directory, { recursive: true, mode: 0o700 });
  const candidateCommit = await command('git', ['rev-parse', 'HEAD'], { cwd: root });
  assert.match(candidateCommit, /^[a-f0-9]{40}$/);
  const candidate = path.join(scratch, 'candidate-checkout'), baseline = path.join(scratch, 'baseline-checkout');
  await command('git', ['clone', '--no-hardlinks', '--no-local', root, candidate]);
  await command('git', ['checkout', '--detach', candidateCommit], { cwd: candidate });
  assert.equal(await command('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: candidate }), '');
  await command('git', ['clone', '--no-hardlinks', '--no-local', candidate, baseline]);
  const baselinePackage = path.join(baseline, 'package.json'), metadata = JSON.parse(await readFile(baselinePackage, 'utf8'));
  assert.equal(metadata.version, pkg.version); metadata.version = baselineVersion;
  await writeFile(baselinePackage, JSON.stringify(metadata, null, 2) + '\n');
  await command('git', ['add', '--', 'package.json'], { cwd: baseline });
  await command('git', ['-c', 'user.name=Native source smoke', '-c', 'user.email=source-smoke@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic earlier source version for native update smoke'], { cwd: baseline });
  const baselineCommit = await command('git', ['rev-parse', 'HEAD'], { cwd: baseline });
  assert.equal(await command('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: baseline }), '');
  report.commits = { baseline: baselineCommit, candidate: candidateCommit };
  const device = path.join(userData, 'device'), vault = createVault(device);
  await vault.open(); await vault.update(state => { state.label = 'Synthetic source upgrade'; state.career.profile.name = 'Synthetic Source Candidate'; state.career.profile.email = 'source-smoke@example.invalid'; });
  const saved = vault.get(), document = path.join(device, 'synthetic-source-document.txt');
  await writeFile(document, 'Synthetic saved source-install document.\n', { mode: 0o600 });
  const defaultDevice = path.join(defaultUserData, 'device'), defaultVault = createVault(defaultDevice);
  await defaultVault.open(); await defaultVault.update(value => { value.label = 'Synthetic default profile - must remain unused'; value.career.profile.name = 'Different Synthetic Default Candidate'; });
  assert.notEqual(defaultVault.get().deviceId, saved.deviceId);
  const defaultBytes = await readFile(path.join(defaultDevice, 'vault.json'));
  const defaultEntries = (await readdir(defaultDevice)).sort();
  if (process.platform === 'win32') {
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const bootstrap = async (shell, checkout, commit, destination, profile) => {
      const script = `& ([ScriptBlock]::Create([IO.File]::ReadAllText(${quote(path.join(checkout, 'scripts', 'install-source.ps1'))}))) -Root ${quote(destination)} -Checkout ${quote(checkout)} -Commit ${quote(commit)} -Profile ${quote(profile)} -NoLaunch`;
      assert.deepEqual((await readdir(env.TEMP)).filter(name => name.startsWith('recruiters-source-')), []);
      let finished = false, failure;
      const execution = command(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')])
        .then(() => { finished = true; }, error => { finished = true; failure = error; });
      try {
        // Observe the real shared bootstrap branch while its real build runs.
        // A local-checkout early return before ACL setup must fail this gate.
        const temporary = await until(async () => {
          if (failure) throw failure;
          if (finished) throw new Error('Bootstrap exited without observable shared private-directory setup.');
          const entries = (await readdir(env.TEMP, { withFileTypes: true })).filter(entry => entry.name.startsWith('recruiters-source-'));
          assert.ok(entries.length <= 1, 'Only this bootstrap may own its temporary directory.');
          return entries[0]?.isDirectory() ? path.join(env.TEMP, entries[0].name) : null;
        }, 60000, 'real shared PowerShell bootstrap private directory');
        const verifyAcl = `$ErrorActionPreference='Stop';Import-Module ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Security','Microsoft.PowerShell.Security.psd1')) -ErrorAction Stop;$acl=Get-Acl -LiteralPath ${quote(temporary)};$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544');$private=$acl.AreAccessRulesProtected;$own=$false;foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.AccessControlType -eq 'Allow'){if($rule.IdentityReference.Value -notin $allowed){$private=$false};if($rule.IdentityReference.Value -eq $sid.Value){$own=$true}}};if($private -and $own){'private'}else{'pending'}`;
        await until(async () => {
          if (failure) throw failure;
          if (finished) throw new Error('Bootstrap completed before its private ACL could be verified.');
          return await command(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(verifyAcl, 'utf16le').toString('base64')]) === 'private';
        }, 60000, 'actual owner-restricted bootstrap ACL in this PowerShell edition');
        await execution;
        if (failure) throw failure;
      } finally { await execution; }
      assert.deepEqual((await readdir(env.TEMP)).filter(name => name.startsWith('recruiters-source-')), [], 'Shared private bootstrap temporary directory must be cleaned.');
    };
    const windowsPowerShell = path.join(env.SYSTEMROOT || env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    assert.match(await command(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']), /^5\.1\./);
    await bootstrap(windowsPowerShell, baseline, baselineCommit, managedRoot, userData);
    report.scenarios.push('windows-powershell-5.1-real-shared-private-bootstrap-setup-clone-and-build');
    const candidates = (await command(path.join(env.SYSTEMROOT || env.SystemRoot, 'System32', 'where.exe'), ['pwsh.exe'])).split(/\r?\n/).filter(Boolean);
    assert.ok(candidates.length && path.isAbsolute(candidates[0]), 'PowerShell 7 must be available; missing coverage is not a passing gate.');
    const pwsh = await realpath(candidates[0]);
    assert.equal(await command(pwsh, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major']), '7');
    const pwshRoot = path.join(scratch, 'managed-pwsh7'), pwshProfile = path.join(scratch, 'pwsh7-profile');
    await mkdir(pwshProfile, { mode: 0o700 });
    await bootstrap(pwsh, candidate, candidateCommit, pwshRoot, pwshProfile);
    const pwshCurrent = JSON.parse(await readFile(path.join(pwshRoot, 'current.json'), 'utf8'));
    assert.equal(pwshCurrent.version, pkg.version); assert.equal(pwshCurrent.userData, pwshProfile);
    assert.ok(pwshCurrent.sourceRoot.startsWith(`${pwshRoot}${path.sep}`));
    assert.equal(await command('git', ['rev-parse', 'HEAD'], { cwd: pwshCurrent.sourceRoot }), candidateCommit);
    const built = await import(pathToFileURL(path.join(pwshCurrent.sourceRoot, 'scripts', 'install-source.mjs')).href);
    await built.validateSourceBuild(pwshCurrent.sourceRoot, pkg.version);
    await trackSource(pwshCurrent.sourceRoot);
    report.scenarios.push('powershell-7-real-shared-private-bootstrap-setup-clone-and-build');
  } else await command('/bin/sh', [path.join(baseline, 'scripts', 'install-source.sh'), '--root', managedRoot, '--checkout', baseline, '--commit', baselineCommit, '--profile', userData, '--no-launch']);
  const first = JSON.parse(await readFile(path.join(managedRoot, 'current.json'), 'utf8'));
  assert.equal(first.version, baselineVersion); assert.ok(first.sourceRoot.startsWith(`${managedRoot}${path.sep}`));
  assert.equal(JSON.parse(await readFile(path.join(first.sourceRoot, 'package.json'), 'utf8')).version, baselineVersion);
  await trackSource(first.sourceRoot);
  report.scenarios.push('public-wrapper-code-real-clean-clone-frozen-dependency-install-and-build');
  const starter = path.join(managedRoot, process.platform === 'win32' ? 'launch.cmd' : 'launch');
  await realpath(starter);
  const diagnosticArgs = ['--remote-debugging-port=0', '--inspect=127.0.0.1:0'];
  if (process.platform === 'win32') {
    if (/["%!\r\n]/.test(starter)) throw new Error('Unsafe Windows starter fixture path.');
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const argumentsLine = `/d /s /c ""${starter}" ${diagnosticArgs.map(value => `"${value}"`).join(' ')}"`;
    // Keep the process-only Restricted policy. Start cmd.exe natively with
    // inherited handles so Electron diagnostics are not rewritten as CLIXML.
    const script = `$ErrorActionPreference='Stop';if((Get-ExecutionPolicy -Scope Process) -ne 'Restricted' -or (Get-ExecutionPolicy) -ne 'Restricted'){throw 'The starter gate requires Restricted execution policy'};$start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=[IO.Path]::Combine($env:SystemRoot,'System32','cmd.exe');$start.Arguments=${quote(argumentsLine)};$start.UseShellExecute=$false;$child=[Diagnostics.Process]::Start($start);$child.WaitForExit();exit $child.ExitCode`;
    launcher = spawn(path.join(env.SYSTEMROOT || env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env, cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] });
  } else launcher = spawn(starter, diagnosticArgs, { env, cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] });
  launcher.stdout.on('data', append); launcher.stderr.on('data', append);
  let launchError; launcher.once('error', error => { launchError = error; });
  await until(() => { if (launchError) throw launchError; return inspectorUrl && browserUrl; }, 120000, 'managed launcher real Electron startup');
  const main = await connect(inspectorUrl), renderer = await connect(await until(rendererEndpoint, 60000, 'managed source settings renderer'));
  const state = await until(async () => {
    let value; try { value = await evaluate(renderer, 'typeof window.companion === "object" ? window.companion.invoke("state") : null'); }
    catch (error) { if (error.message === 'Execution context was destroyed.') return null; throw error; }
    if (value?.ok === false || value?.result?.failure) throw new Error(value?.error?.message || value.result.failure);
    return ['ready', 'needs_connection'].includes(value?.result?.execution?.state) && value?.result?.updates?.automaticSupported === true ? value.result : null;
  }, 120000, 'managed source core readiness and validated automatic-update receipt');
  assert.equal(state.paired, false); assert.equal(state.deviceId, saved.deviceId); assert.equal(state.decisionApiConfigured, false);
  assert.equal(state.updates?.installationKind, 'source', 'Real lifecycle must recognize the managed source receipt.');
  assert.equal(state.updates?.automaticSupported, true);
  assert.equal(state.updates?.sourceProvenance, 'local-candidate');
  assert.equal(state.updates?.sourceCommit, baselineCommit);
  initialPid = await evaluate(main, 'process.pid');
  assert.equal(await evaluate(main, "process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.getVersion()"), baselineVersion);
  const initialProof = await until(async () => {
    try { return JSON.parse(await readFile(path.join(managedRoot, 'initial-ready.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }, 60000, 'app-written managed source bootstrap readiness');
  assert.equal(initialProof.id, first.bootstrapId); assert.equal(initialProof.sourceRoot, first.sourceRoot);
  assert.equal(initialProof.version, baselineVersion); assert.equal(initialProof.pid, initialPid); assert.equal(initialProof.userData, userData);
  assert.ok(state.setup?.command);
  await assertMcpProfile(state.setup.command, saved.career.profile.name, baselineVersion);
  await assertBrowserProfile(device, 'chrome', saved.deviceId, baselineVersion);
  await assertBrowserProfile(device, 'firefox', saved.deviceId, baselineVersion);
  report.scenarios.push('nondefault-profile-generated-mcp-and-chrome-firefox-native-hosts-while-running');
  report.scenarios.push('generated-managed-launcher-real-source-startup');
  if (process.platform === 'win32') report.scenarios.push('generated-cmd-starter-under-process-only-restricted-powershell-policy');
  const release = { version: pkg.version, commit: candidateCommit, checkout: candidate, provenance: 'local-candidate', tag: `v${pkg.version}`, releaseUrl: 'https://github.com/jobstash/recruiters-rip-companion/releases' };
  const localEdit = path.join(first.sourceRoot, 'synthetic-local-source-edit.txt');
  await writeFile(localEdit, 'Synthetic untracked work must not be discarded.\n', { flag: 'wx', mode: 0o600 });
  const initial = await evaluate(main, `(async () => {
    const vm = process.getBuiltinModule('vm');
    // Inspector evaluation has no import hook. Use Node's real ESM loader,
    // including top-level await in the standalone source-installer dependency.
    const loadModule = vm.compileFunction('return import(specifier)', ['specifier'], { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
    const { createSourceUpdateController } = await loadModule(${JSON.stringify(pathToFileURL(path.join(first.sourceRoot, 'src', 'source-updates.mjs')).href)});
    const electron = process.getBuiltinModule('module').createRequire(process.execPath)('electron');
    const scheduling = await loadModule(${JSON.stringify(pathToFileURL(path.join(first.sourceRoot, 'src', 'update-scheduler.mjs')).href)});
    globalThis.__sourceIdle = false; globalThis.__sourceClock = 0; globalThis.__sourceAdmissions = 0;
    globalThis.__sourceDenyOnce = true; globalThis.__sourceAttempts = 0;
    globalThis.__sourceGate = scheduling.createUpdateWorkGate({ now: () => __sourceClock });
    globalThis.__sourceClock = scheduling.UPDATE_QUIET_WINDOW + 1;
    const acquireInstallAdmission = async ({ automatic }) => {
      if (!automatic || !__sourceIdle || !__sourceGate.quiet()) return null;
      const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path');
      const pointer = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(managedRoot, 'transition.json'))}, 'utf8'));
      const staged = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(managedRoot)}, 'transitions', pointer.id, 'journal.json'), 'utf8'));
      if (staged.status !== 'prepared' || staged.id !== pointer.id) throw new Error('Source final admission ran before real transition preparation.');
      __sourceAttempts++;
      if (__sourceDenyOnce) { __sourceDenyOnce = false; return null; }
      if (!__sourceGate.close()) return null;
      await __sourceGate.drain(); __sourceAdmissions++;
      return { valid: () => __sourceIdle && __sourceGate.quiet() && __sourceGate.state().closed, release: () => __sourceGate.reopen() };
    };
    globalThis.__sourceSmoke = createSourceUpdateController({ version: ${JSON.stringify(baselineVersion)}, sourceRoot: ${JSON.stringify(first.sourceRoot)}, directory: ${JSON.stringify(path.join(userData, 'updates'))}, resolveRelease: async () => (${JSON.stringify(release)}), acquireInstallAdmission, quit: () => setTimeout(() => electron.app.quit(), 500) });
    globalThis.__sourceScheduler = scheduling.createUpdateScheduler({
      updates: __sourceSmoke, preferences: scheduling.createUpdatePreferences(${JSON.stringify(path.join(userData, 'updates'))}),
      install: options => __sourceSmoke.install(options),
      canInstall: () => __sourceIdle && __sourceGate.quiet() && __sourceGate.state().active === 0,
      now: () => __sourceClock,
    });
    await __sourceSmoke.initialize(); return __sourceSmoke.state();
  })()`);
  assert.equal(initial.automaticSupported, false, 'Local source modifications must pause automatic replacement.');
  const refused = await evaluate(main, '(async () => { await __sourceSmoke.check(); try { await __sourceSmoke.download(); return null; } catch (error) { return error.code; } })()');
  assert.equal(refused, 'SOURCE_MODIFIED');
  assert.equal(await readFile(localEdit, 'utf8'), 'Synthetic untracked work must not be discarded.\n');
  assert.equal(await transition(), null);
  assert.equal(JSON.parse(await readFile(path.join(managedRoot, 'current.json'), 'utf8')).sourceRoot, first.sourceRoot);
  await rm(localEdit);
  report.scenarios.push('local-source-edit-pauses-update-without-discarding-work');
  const pending = await evaluate(main, '(async () => { await __sourceSmoke.initialize(); await __sourceScheduler.start(); return { update: __sourceSmoke.state(), automation: __sourceScheduler.state(), admissions: __sourceAdmissions }; })()');
  assert.equal(pending.update.status, 'downloaded'); assert.equal(pending.update.automaticSupported, true);
  assert.equal(pending.automation.waitingForIdle, true); assert.equal(pending.admissions, 0);
  assert.equal(await transition(), null, 'Built candidate must wait without changing the running source pointer.');
  const stagedVersions = (await readdir(path.join(managedRoot, 'versions'))).filter(name => name.startsWith(`${pkg.version}-${candidateCommit.slice(0, 12)}-`));
  assert.equal(stagedVersions.length, 1, 'The scheduler must build exactly one candidate before handoff.');
  const stagedSource = path.join(managedRoot, 'versions', stagedVersions[0], 'source');
  await trackSource(stagedSource);
  report.scenarios.push('pinned-electron-dist-version-and-native-executable-exist-before-source-app-launches');
  report.scenarios.push('candidate-real-git-clone-frozen-install-and-build-outside-running-tree');
  const deferred = await evaluate(main, '(async () => { __sourceIdle = true; await __sourceScheduler.resume(); return { update: __sourceSmoke.state(), admissions: __sourceAdmissions, attempts: __sourceAttempts, closed: __sourceGate.state().closed }; })()');
  assert.equal(deferred.update.status, 'downloaded'); assert.equal(deferred.admissions, 0); assert.equal(deferred.attempts, 1); assert.equal(deferred.closed, false);
  assert.equal((await transition())?.status, 'cancelled');
  assert.equal(JSON.parse(await readFile(path.join(managedRoot, 'current.json'), 'utf8')).sourceRoot, first.sourceRoot);
  process.kill(initialPid, 0);
  report.scenarios.push('real-source-helper-ready-admission-refusal-retains-running-version-and-built-candidate');
  const admitted = await evaluate(main, '(async () => { await __sourceScheduler.resume(); return { update: __sourceSmoke.state(), admissions: __sourceAdmissions, attempts: __sourceAttempts, closed: __sourceGate.state().closed }; })()');
  assert.equal(admitted.update.status, 'installing', 'Manual/source instructions cannot pass a managed transition.');
  assert.equal(admitted.admissions, 1); assert.equal(admitted.attempts, 2); assert.equal(admitted.closed, true);
  report.scenarios.push('real-source-scheduler-build-idle-wait-and-final-work-gate-admission-with-synthetic-idle-input');
  main.detachMain(); renderer.close();
  journal = await until(async () => {
    const value = await transition();
    if (['failed', 'rolled-back', 'unconfirmed'].includes(value?.status)) throw new Error(`Managed source update failed: ${JSON.stringify(value)}`);
    return value?.status === 'confirmed' ? value : null;
  }, 240000, 'real managed-source new-version startup confirmation');
  assert.equal(journal.version, pkg.version); restartedPid = journal.launchedPid;
  assert.equal(journal.userData, userData);
  const proof = JSON.parse(await readFile(path.join(path.dirname(journal.journal), 'confirmed.json'), 'utf8'));
  assert.equal(proof.id, journal.id); assert.equal(proof.version, pkg.version);
  assert.ok(Number.isSafeInteger(restartedPid) && restartedPid > 1 && restartedPid !== initialPid); process.kill(restartedPid, 0);
  assert.equal((await sourceProcesses()).includes(initialPid), false, 'The original source process must exit, regardless of WebSocket close-frame behavior.');
  const next = JSON.parse(await readFile(path.join(managedRoot, 'current.json'), 'utf8'));
  assert.equal(next.version, pkg.version); assert.notEqual(next.sourceRoot, first.sourceRoot);
  assert.equal(next.sourceRoot, stagedSource);
  assert.equal(await command('git', ['rev-parse', 'HEAD'], { cwd: next.sourceRoot }), candidateCommit);
  assert.equal((await stat(first.sourceRoot)).isDirectory(), true, 'Previous managed source must remain available for rollback.');
  const after = JSON.parse(await readFile(path.join(device, 'vault.json'), 'utf8'));
  assert.equal(after.deviceId, saved.deviceId); assert.equal(after.publicKey, saved.publicKey); assert.equal(after.privateKey, saved.privateKey);
  assert.equal(after.label, saved.label); assert.deepEqual(after.career.profile, saved.career.profile); assert.equal(after.pairing, null);
  assert.equal(await readFile(document, 'utf8'), 'Synthetic saved source-install document.\n');
  report.scenarios.push('real-managed-source-handoff-new-process-startup-confirmation-and-retained-previous-tree', 'synthetic-source-profile-identity-and-document-preserved');
  await assertMcpProfile(state.setup.command, saved.career.profile.name, pkg.version);
  await assertBrowserProfile(device, 'chrome', saved.deviceId, pkg.version);
  await assertBrowserProfile(device, 'firefox', saved.deviceId, pkg.version);
  for (const browser of ['chrome', 'firefox']) {
    const previousPid = restartedPid;
    await closeSelectedApp();
    await assertBrowserProfile(device, browser, saved.deviceId, pkg.version);
    await observeBackgroundStartup(previousPid);
    report.scenarios.push(`updated-nondefault-profile-${browser}-host-background-relaunch`);
  }
  const previousPid = restartedPid;
  await closeSelectedApp();
  await assertMcpProfile(state.setup.command, saved.career.profile.name, pkg.version);
  await observeBackgroundStartup(previousPid);
  await assertBrowserProfile(device, 'chrome', saved.deviceId, pkg.version);
  report.scenarios.push('updated-nondefault-profile-generated-stdio-mcp-background-relaunch');
  assert.deepEqual(await readFile(path.join(defaultDevice, 'vault.json')), defaultBytes, 'The distinct synthetic default profile must not be modified.');
  assert.deepEqual((await readdir(defaultDevice)).sort(), defaultEntries, 'No integration may initialize the distinct synthetic default profile.');
  const finalProfile = JSON.parse(await readFile(path.join(device, 'vault.json'), 'utf8'));
  assert.equal(finalProfile.deviceId, saved.deviceId); assert.deepEqual(finalProfile.career.profile, saved.career.profile);
  report.result = 'passed'; report.receipt = { status: journal.status, version: journal.version };
  report.notExercised = ['published candidate tag resolution and public bootstrap HTTP transport before publication', 'source startup-failure rollback is not exercised by this smoke', 'live inference, accounts or payments'];
  console.log(JSON.stringify(report));
} catch (error) { report.error = error.message; console.error(logs); throw error; }
finally {
  await mkdir(path.dirname(reportFile), { recursive: true }); await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  for (const connection of connections) connection.close();
  journal ||= await transition().catch(() => null);
  if (process.platform === 'darwin') {
    for (const pid of await sourceProcesses()) await requestMacQuit(pid).catch(error => append(`Owned Mac cleanup: ${error.message}\n`));
  } else {
    await stop(restartedPid || journal?.launchedPid); await stop(initialPid);
    for (const pid of await sourceProcesses()) await stop(pid);
  }
  await stop(launcher?.pid);
  if (process.platform === 'linux') for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try { if ((await readFile(`/proc/${name}/environ`, 'utf8')).split('\0').includes(`HOME=${home}`)) await stop(Number(name)); }
    catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
  }
  await delay(1000); await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
