// CI-only native integration. Pinned binaries are disposable physical replacement
// fixtures, not a supported old-version installation or compatibility contract.
// Their loopback inspector loads the candidate's packaged updater; only release
// transport is supplied locally. Real package bytes pass production verification,
// handoff/replacement/restart and the candidate application's ready confirmation.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createVault } from '../src/vault.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true') throw new Error('Native update smoke requires a disposable GitHub Actions runner.');
if (process.argv.length !== 2) throw new Error('Usage: node scripts/smoke-update.mjs');
const targets = {
  darwin: { arch: 'arm64', output: 'adhoc', suffix: 'mac-arm64.zip', size: 151567922, digest: '7df2569d570216dcfe669770e2533f09f72a39e7c40d918f11cae7aa915b0aae' },
  win32: { arch: 'x64', output: 'windows', suffix: 'win-x64.exe', size: 123803745, digest: 'bc07962c1be10633588aef75965951168f91b09d139df29f10a69096c716cb18' },
  linux: { arch: 'x64', output: 'linux', suffix: 'linux-x64.AppImage', size: 169187702, digest: '1d85f359d88579afe9060a136fc66fc0c990c55bfdc4d5e434782f9574f927a1' },
};
const target = targets[process.platform];
if (!target || target.arch !== process.arch) throw new Error('Unsupported native smoke target; not a passing or skipped upgrade.');
if (process.platform === 'linux' && process.getuid() === 0) throw new Error('AppImage upgrade smoke requires a non-root Chromium sandbox.');
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const reportFile = path.join(root, 'dist', 'update-smoke.json');
const scratchBase = process.platform === 'win32' ? tmpdir() : process.env.RUNNER_TEMP || tmpdir();
const scratch = await realpath(await mkdtemp(path.join(scratchBase, 'recruiters-update-smoke-')));
const home = path.join(scratch, 'home');
const userData = path.join(home, ...(process.platform === 'darwin' ? ['Library', 'Application Support'] : process.platform === 'win32' ? ['AppData', 'Roaming'] : ['.config']), 'Recruiters Companion');
const updates = path.join(userData, 'updates');
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CACHE_HOME: path.join(home, '.cache'),
  XDG_RUNTIME_DIR: path.join(scratch, 'runtime'), TMPDIR: path.join(scratch, 'tmp'), TMP: path.join(scratch, 'tmp'), TEMP: path.join(scratch, 'tmp') };
for (const key of Object.keys(env)) if (/^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH|OPENAI_API_KEY|ANTHROPIC_API_KEY|RECRUITERS_COMPANION_DEV|APPIMAGE|APPDIR|APPIMAGE_EXTRACT_AND_RUN)$/i.test(key)) delete env[key];
if (process.platform === 'win32') { env.HOMEDRIVE = path.parse(home).root.replace(/[\\/]$/, ''); env.HOMEPATH = home.slice(env.HOMEDRIVE.length); }
const execute = promisify(execFile), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { result: 'failed', platform: process.platform, arch: process.arch, fixtureVersion: '3.10.0', candidateVersion: pkg.version,
  baseline: { kind: 'pinned-physical-fixture', officialRelease: 'v3.10.0', sha256: target.digest }, candidateTransport: 'local fixture of real built artifact through production fetchImpl',
  bootstrap: 'current packaged updater loaded into disposable physical fixture through CI-only loopback inspector; no old-version compatibility claim', scenarios: [] };
let child, main, renderer, executable, appPath, log = '', inspectorUrl, browserUrl, exit, launchError, receipt, restartedPid;
const connections = [];
const append = chunk => {
  log = (log + chunk.toString()).slice(-512 * 1024);
  inspectorUrl ||= /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(log)?.[1];
  browserUrl ||= /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/.exec(log)?.[1];
};
async function until(work, timeout, description, requireOld = false) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (requireOld && (exit || launchError)) throw launchError || new Error(`Old installation exited unexpectedly: ${JSON.stringify(exit)}`);
    const value = await work();
    if (value) return value;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}
async function connect(url) {
  const address = new URL(url);
  if (address.protocol !== 'ws:' || address.hostname !== '127.0.0.1') throw new Error('Inspector connection must remain on loopback.');
  const socket = new WebSocket(url), pending = new Map();
  let sequence = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  socket.addEventListener('close', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Inspector closed.')); } pending.clear(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Inspector connection timed out.')), 10000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Inspector connection failed.')); }, { once: true });
  });
  const connection = { close: () => socket.close(), send(method, params) { return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out.`)); }, 15 * 60 * 1000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  }); } };
  connections.push(connection); return connection;
}
async function evaluate(connection, expression) {
  const response = await connection.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(`Packaged evaluation failed: ${response.exceptionDetails.exception?.description || response.exceptionDetails.text}`);
  return response.result?.value;
}
async function digest(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
async function downloadBaseline(file) {
  const name = `recruiters-rip-companion-3.10.0-${target.suffix}`;
  // This immutable test fixture already pins its official tag, size and digest.
  // Do not spend unauthenticated API quota rediscovering the same asset.
  let url = `https://github.com/jobstash/recruiters-rip-companion/releases/download/v3.10.0/${name}`;
  try {
    const cached = await lstat(file);
    assert.equal(cached.isFile() && !cached.isSymbolicLink(), true); assert.equal(cached.size, target.size);
    assert.equal(await digest(file), target.digest);
    return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10 * 60 * 1000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      const next = new URL(location, url);
      if (next.protocol !== 'https:' || next.username || next.password || next.port || !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname)) throw new Error('Baseline download left approved GitHub release hosting.');
      url = next.href; continue;
    }
    if (!response.ok) throw new Error(`Baseline download failed: ${response.status}`);
    const handle = await open(file, 'wx', 0o700), hash = createHash('sha256');
    let bytes = 0;
    try { for await (const chunk of response.body) { bytes += chunk.length; if (bytes > target.size) throw new Error('Baseline download exceeded pinned size.'); hash.update(chunk); await handle.writeFile(chunk); } }
    finally { await handle.close(); }
    assert.equal(bytes, target.size); assert.equal(hash.digest('hex'), target.digest); return;
  }
  throw new Error('Baseline download exceeded redirect bound.');
}
async function install(file, destination) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  if (process.platform === 'darwin') {
    await execute('/usr/bin/ditto', ['-x', '-k', file, destination], { env, timeout: 180000 });
    return { appPath: path.join(destination, `${pkg.build.productName}.app`), executable: path.join(destination, `${pkg.build.productName}.app`, 'Contents', 'MacOS', pkg.build.productName), asar: path.join(destination, `${pkg.build.productName}.app`, 'Contents', 'Resources', 'app.asar') };
  }
  if (process.platform === 'win32') {
    if (/\s/.test(destination)) throw new Error('Disposable NSIS destination must not contain whitespace.');
    await execute(file, ['/S', '/currentuser', `/D=${destination}`], { env, timeout: 180000, windowsVerbatimArguments: true });
    return { appPath: destination, executable: path.join(destination, `${pkg.build.productName}.exe`), asar: path.join(destination, 'resources', 'app.asar') };
  }
  const installed = path.join(destination, 'Recruiters.rip-Companion.AppImage');
  await copyFile(file, installed, constants.COPYFILE_EXCL); await chmod(installed, 0o700);
  return { appPath: installed, executable: installed };
}
async function readReceipt() {
  try {
    const active = JSON.parse(await readFile(path.join(updates, 'active.json'), 'utf8'));
    assert.match(active.id, /^[a-f0-9]{32}$/);
    return JSON.parse(await readFile(path.join(updates, `install-${active.id}`, 'journal.json'), 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function stop(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
  if (process.platform === 'win32') await execute(path.join(env.SYSTEMROOT || env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F']).catch(() => {});
  else { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
}

try {
  for (const directory of [home, userData, updates, env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_RUNTIME_DIR, env.TMP]) await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'linux') {
    assert.equal((await stat('/dev/fuse')).isCharacterDevice(), true); await access('/dev/fuse', constants.R_OK | constants.W_OK);
  }
  const candidateName = `recruiters-rip-companion-${pkg.version}-${target.suffix}`;
  const candidateFile = path.join(root, 'dist', target.output, candidateName);
  const candidateSize = (await lstat(candidateFile)).size, candidateDigest = await digest(candidateFile);
  const checksums = await readFile(path.join(root, 'dist', target.output, 'SHA256SUMS.txt'), 'utf8');
  assert.equal(checksums.split(/\r?\n/).filter(line => line === `${candidateDigest}  ${candidateName}`).length, 1);
  // Do not register a second Windows installation: NSIS has one per-user app
  // identity. Bootstrap from electron-builder's exact packaged app.asar payload;
  // the real candidate NSIS must install those same bytes during the upgrade.
  const candidate = process.platform === 'win32'
    ? { asar: path.join(root, 'dist', 'windows', 'win-unpacked', 'resources', 'app.asar') }
    : await install(candidateFile, path.join(scratch, 'candidate'));
  if (process.platform === 'linux') {
    await execute(candidate.executable, ['--appimage-extract'], { cwd: path.join(scratch, 'candidate'), env, timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
    candidate.asar = path.join(scratch, 'candidate', 'squashfs-root', 'resources', 'app.asar');
  }
  const baselineFile = path.join(await realpath(scratchBase), `recruiters-update-baseline-${target.digest}.${target.suffix.split('.').pop()}`);
  await downloadBaseline(baselineFile);
  report.scenarios.push('official-3.10-artifact-pinned-size-and-sha256');
  ({ executable, appPath } = await install(baselineFile, path.join(scratch, 'installed')));
  executable = await realpath(executable); appPath = await realpath(appPath);
  const device = path.join(userData, 'device'), vault = createVault(device);
  await vault.open(); await vault.update(state => {
    state.label = 'Synthetic native update smoke';
    state.career.profile.name = 'Synthetic Upgrade Candidate'; state.career.profile.email = 'upgrade-smoke@example.invalid';
    state.career.profile.skills = ['Synthetic test skill'];
  });
  const saved = vault.get();
  const exportFile = path.join(device, 'synthetic-saved-document.txt'), exportBytes = 'Synthetic saved document. No user data.\n';
  await writeFile(exportFile, exportBytes, { mode: 0o600 });
  child = spawn(executable, [`--user-data-dir=${userData}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--inspect=127.0.0.1:0'], { env, cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  child.stdout.on('data', append); child.stderr.on('data', append);
  child.once('error', error => { launchError = error; }); child.once('exit', (code, signal) => { exit = { code, signal }; });
  await until(() => inspectorUrl && browserUrl, 120000, 'old installed app inspector', true);
  main = await connect(inspectorUrl);
  const browserAddress = new URL(browserUrl);
  const page = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${browserAddress.port}/json/list`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    return (await response.json()).find(item => item.type === 'page' && item.url.startsWith('file:') && item.webSocketDebuggerUrl);
  }, 30000, 'old settings renderer', true);
  renderer = await connect(page.webSocketDebuggerUrl);
  const state = await until(async () => {
    let value;
    try { value = await evaluate(renderer, 'typeof window.companion === "object" ? window.companion.invoke("state") : null'); }
    catch (error) { if (error.message === 'Execution context was destroyed.') return null; throw error; }
    if (value?.ok === false) throw new Error(`Old app state failed: ${value.error?.message}`);
    if (value?.result?.failure) throw new Error(value.result.failure);
    return ['ready', 'needs_connection'].includes(value?.result?.execution?.state) ? value.result : null;
  }, 120000, 'old app ready with synthetic saved data', true);
  assert.equal(state.paired, false); assert.equal(state.decisionApiConfigured, false); assert.equal(state.deviceId, saved.deviceId);
  assert.equal(await evaluate(main, "process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.getVersion()"), '3.10.0');
  report.scenarios.push('native-old-install-startup-and-synthetic-profile');
  if (process.platform === 'win32') {
    // Exercise the built NSIS refusal, not a mocked helper error. A still-running
    // app must never be killed by the installer (including another installation).
    const before = await digest(path.join(appPath, 'resources', 'app.asar'));
    await assert.rejects(execute(candidateFile, ['/S', '/currentuser', `/D=${appPath}`],
      { env, timeout: 60000, windowsVerbatimArguments: true }), error => error.code === 2);
    assert.equal(exit, undefined, 'NSIS must not terminate the old application.');
    assert.equal(await digest(path.join(appPath, 'resources', 'app.asar')), before);
    report.scenarios.push('native-nsis-refuses-running-app-without-kill-or-replacement');
  }
  const releaseUrl = `https://github.com/jobstash/recruiters-rip-companion/releases/download/v${pkg.version}/${candidateName}`;
  const metadata = { tag_name: `v${pkg.version}`, html_url: `https://github.com/jobstash/recruiters-rip-companion/releases/tag/v${pkg.version}`, draft: false, prerelease: false, published_at: new Date().toISOString(), assets: [{ name: candidateName, size: candidateSize, state: 'uploaded', digest: `sha256:${candidateDigest}`, browser_download_url: releaseUrl }] };
  const setup = `async () => {
    const vm = process.getBuiltinModule('vm');
    // Inspector evaluation needs an explicit loader, including for the
    // candidate engine's source-backend dependency with top-level await.
    const loadModule = vm.compileFunction('return import(specifier)', ['specifier'], { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
    const { createUpdateController } = await loadModule(${JSON.stringify(pathToFileURL(path.join(candidate.asar, 'src', 'updates.mjs')).href)});
    const fs = process.getBuiltinModule('fs');
    const { Readable, Transform } = process.getBuiltinModule('stream');
    const electron = process.getBuiltinModule('module').createRequire(process.execPath)('electron');
    globalThis.__updateSmokeCorrupt = false;
    const fetchImpl = async url => {
      if (url === 'https://api.github.com/repos/jobstash/recruiters-rip-companion/releases/latest') return new Response(JSON.stringify(${JSON.stringify(metadata)}));
      if (url !== ${JSON.stringify(releaseUrl)}) throw new Error('Unexpected update request: ' + url);
      let first = true;
      const body = fs.createReadStream(${JSON.stringify(candidateFile)}).pipe(new Transform({ transform(chunk, encoding, callback) {
        if (first && globalThis.__updateSmokeCorrupt) { chunk[0] ^= 255; } first = false; callback(null, chunk);
      } }));
      return new Response(Readable.toWeb(body), { headers: { 'content-length': ${JSON.stringify(String(candidateSize))} } });
    };
    const options = { version: '3.10.0', directory: ${JSON.stringify(updates)}, appPath: ${JSON.stringify(appPath)}, packaged: true, fetchImpl, quit: () => setTimeout(() => electron.app.quit(), 500) };
    let unsupportedError = null;
    const scheduling = await loadModule(${JSON.stringify(pathToFileURL(path.join(candidate.asar, 'src', 'update-scheduler.mjs')).href)});
    globalThis.__updateSmokeIdle = false; globalThis.__updateSmokeClock = 0; globalThis.__updateSmokeAdmissions = 0;
    globalThis.__updateSmokeDenyOnce = true; globalThis.__updateSmokeAttempts = 0; globalThis.__updateSmokeReady = [];
    globalThis.__updateSmokeGate = scheduling.createUpdateWorkGate({ now: () => __updateSmokeClock });
    globalThis.__updateSmokeClock = scheduling.UPDATE_QUIET_WINDOW + 1;
    options.acquireInstallAdmission = async ({ automatic }) => {
      if (!automatic || !__updateSmokeIdle || !__updateSmokeGate.quiet()) return null;
      const path = process.getBuiltinModule('path');
      const active = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(updates, 'active.json'))}, 'utf8'));
      const work = path.join(${JSON.stringify(updates)}, 'install-' + active.id);
      const staged = JSON.parse(fs.readFileSync(path.join(work, 'journal.json'), 'utf8'));
      if (staged.id !== active.id || staged.status !== 'staged') throw new Error('Final admission ran before a staged native receipt.');
      if (process.platform !== 'darwin' && fs.readFileSync(path.join(work, 'ready'), 'utf8') !== active.id) throw new Error('Final admission ran before the native helper was ready.');
      __updateSmokeReady.push(staged.id); __updateSmokeAttempts++;
      if (__updateSmokeDenyOnce) { __updateSmokeDenyOnce = false; return null; }
      if (!__updateSmokeGate.close()) return null;
      await __updateSmokeGate.drain(); __updateSmokeAdmissions++;
      return { valid: () => __updateSmokeIdle && __updateSmokeGate.quiet() && __updateSmokeGate.state().closed, release: () => __updateSmokeGate.reopen() };
    };
    globalThis.__updateSmokeScheduling = scheduling;
    const source = createUpdateController({ ...options, packaged: false, appPath: null, directory: ${JSON.stringify(path.join(userData, 'source-updates'))} });
    await source.initialize();
    const unsupported = createUpdateController({ ...options, arch: 'unsupported', directory: ${JSON.stringify(path.join(userData, 'unsupported-updates'))} });
    await unsupported.initialize();
    try { await unsupported.check(); } catch (error) { unsupportedError = error.code; }
    globalThis.__updateSmoke = createUpdateController(options);
    await globalThis.__updateSmoke.initialize();
    globalThis.__updateSmokeScheduler = __updateSmokeScheduling.createUpdateScheduler({
      updates: __updateSmoke, preferences: __updateSmokeScheduling.createUpdatePreferences(${JSON.stringify(updates)}),
      install: async options => {
        globalThis.__updateSmokeInstallFailure = null;
        try { return await __updateSmoke.install(options); }
        catch (error) {
          globalThis.__updateSmokeInstallFailure = { name: error?.name, code: error?.code,
            message: String(error?.message || error).slice(0, 2048), stack: String(error?.stack || '').slice(0, 8192),
            cause: error?.cause?.message ? String(error.cause.message).slice(0, 2048) : undefined };
          throw error;
        }
      },
      canInstall: () => __updateSmokeIdle && __updateSmokeGate.quiet() && __updateSmokeGate.state().active === 0,
      now: () => __updateSmokeClock,
    });
    return { native: globalThis.__updateSmoke.state(), source: source.state(), unsupported: unsupported.state(), unsupportedError };
  }`;
  const initial = await evaluate(main, `(${setup})()`);
  {
    if (process.platform === 'darwin' && !initial.native.automaticSupported) {
      // Failure-only CI evidence. Keep native validation intact; do not expose
      // these fixture paths or bounded native stderr through product update UI.
      report.macEligibility = await evaluate(main, `(async () => {
        const fs = process.getBuiltinModule('fs/promises'), path = process.getBuiltinModule('path');
        const require = process.getBuiltinModule('module').createRequire(process.execPath);
        const native = require(${JSON.stringify(path.join(candidate.asar, 'src', 'update-install.cjs'))});
        const env = native.launchEnvironment();
        const describe = async file => {
          try { const info = await fs.lstat(file); return { path: file, realpath: await fs.realpath(file), directory: info.isDirectory(), file: info.isFile(), symlink: info.isSymbolicLink(), mode: info.mode & 511, uid: info.uid }; }
          catch (error) { return { path: file, code: error.code, message: error.message.slice(0, 1024) }; }
        };
        const run = (binary, args) => new Promise(resolve => process.getBuiltinModule('child_process').execFile(binary, args,
          { env, timeout: 5000, maxBuffer: 8192 }, (error, stdout, stderr) => resolve({ binary, args, code: error?.code ?? 0, signal: error?.signal, stdout: String(stdout).slice(0, 4096), stderr: String(stderr).slice(0, 4096) })));
        const target = ${JSON.stringify(appPath)}, info = path.join(target, 'Contents', 'Info.plist');
        const checks = [];
        for (const key of ['CFBundleIdentifier', 'CFBundleShortVersionString', 'CFBundleExecutable']) checks.push(await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', info]));
        checks.push(await run('/usr/bin/lipo', ['-verify_arch', 'arm64', process.execPath]));
        checks.push(await run('/usr/bin/xcode-select', ['-p']));
        let header;
        try { const file = await fs.open(process.execPath, 'r'); try { const bytes = Buffer.alloc(32); const read = await file.read(bytes, 0, bytes.length, 0); header = bytes.subarray(0, read.bytesRead).toString('hex'); } finally { await file.close(); } }
        catch (error) { header = { code: error.code, message: error.message.slice(0, 1024) }; }
        return { platform: process.platform, arch: process.arch, packaged: require('electron').app.isPackaged,
          target: await describe(target), parent: await describe(path.dirname(target)), executable: await describe(process.execPath), plist: await describe(info),
          environment: { PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR, DEVELOPER_DIR: env.DEVELOPER_DIR }, header, checks };
      })()`).catch(error => ({ diagnosticFailure: error.message.slice(0, 2048) }));
    }
    assert.equal(initial.native.automaticSupported, true, initial.native.automaticReason || 'Native automatic update must be supported, never a manual fallback pass.');
    assert.equal(initial.source.automaticSupported, false);
    assert.equal(initial.unsupported.automaticSupported, false); assert.equal(initial.unsupportedError, 'UNSUPPORTED_PLATFORM');
    assert.equal((await readdir(path.join(userData, 'source-updates'))).some(name => /^download-|^install-/.test(name)), false);
    assert.equal((await readdir(path.join(userData, 'unsupported-updates'))).some(name => /^download-|^install-/.test(name)), false);
    report.scenarios.push('source-and-unsupported-targets-not-automatic-no-replacement');
  }
  const failed = await evaluate(main, `(async () => {
    await __updateSmoke.check(); __updateSmokeCorrupt = true;
    try { await __updateSmoke.download(); return { incorrectlySucceeded: true }; }
    catch (error) { return { code: error.code, state: __updateSmoke.state() }; }
    finally { __updateSmokeCorrupt = false; }
  })()`);
  assert.equal(failed.code, 'CHECKSUM_MISMATCH'); assert.equal(failed.state.status, 'error'); assert.equal(await readReceipt(), null);
  assert.equal(await evaluate(main, "process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.getVersion()"), '3.10.0');
  assert.equal((await readdir(updates)).some(name => name.endsWith('.partial') || /^download-/.test(name)), false);
  report.scenarios.push('corrupted-download-rejected-old-app-still-running-no-handoff');
  let installing;
  {
    const pending = await evaluate(main, '(async () => { await __updateSmokeScheduler.start(); return { update: __updateSmoke.state(), automation: __updateSmokeScheduler.state(), admissions: __updateSmokeAdmissions }; })()');
    assert.equal(pending.update.status, 'downloaded'); assert.equal(pending.automation.waitingForIdle, true); assert.equal(pending.admissions, 0);
    assert.equal(await readReceipt(), null, 'Scheduler must retain its download without handing off before idle.');
    const deferred = await evaluate(main, '(async () => { __updateSmokeIdle = true; await __updateSmokeScheduler.resume(); return { update: __updateSmoke.state(), attempts: __updateSmokeAttempts, admissions: __updateSmokeAdmissions, closed: __updateSmokeGate.state().closed, ready: __updateSmokeReady, installFailure: globalThis.__updateSmokeInstallFailure }; })()');
    report.deferredUpdate = deferred.update;
    report.deferredInstallFailure = deferred.installFailure;
    report.deferredAdmission = { attempts: deferred.attempts, admissions: deferred.admissions, closed: deferred.closed, ready: deferred.ready };
    assert.equal(deferred.update.status, 'downloaded', JSON.stringify({ update: deferred.update, installFailure: deferred.installFailure })); assert.equal(deferred.attempts, 1); assert.equal(deferred.admissions, 0); assert.equal(deferred.closed, false);
    assert.equal(await readReceipt(), null, 'Refused final admission must remove the uncommitted native receipt.');
    assert.equal(exit, undefined, 'Refused final admission must not quit the old app.');
    const retained = (await readdir(updates)).filter(name => /^download-/.test(name));
    assert.equal(retained.length, 1); assert.equal(await digest(path.join(updates, retained[0])), candidateDigest);
    report.scenarios.push('native-staging-helper-ready-final-admission-refusal-retains-verified-download-and-running-app');
    const admitted = await evaluate(main, '(async () => { await __updateSmokeScheduler.resume(); return { update: __updateSmoke.state(), attempts: __updateSmokeAttempts, admissions: __updateSmokeAdmissions, closed: __updateSmokeGate.state().closed, ready: __updateSmokeReady, installFailure: globalThis.__updateSmokeInstallFailure }; })()');
    report.admittedUpdate = admitted.update;
    report.admittedInstallFailure = admitted.installFailure;
    report.admittedAdmission = { attempts: admitted.attempts, admissions: admitted.admissions, closed: admitted.closed, ready: admitted.ready };
    assert.equal(admitted.attempts, 2); assert.equal(new Set(admitted.ready).size, 2);
    assert.equal(admitted.admissions, 1); assert.equal(admitted.closed, true); installing = admitted.update;
    report.scenarios.push('real-scheduler-download-idle-wait-final-work-gate-admission-native-handoff-with-synthetic-idle-input');
  }
  assert.equal(installing.status, 'installing', 'A manual handoff is not an installed-upgrade pass.');
  main.close(); renderer.close();
  await until(() => exit, 30000, 'old application exit for native handoff');
  receipt = await until(async () => {
    const value = await readReceipt();
    if (['failed', 'rolled-back', 'unconfirmed'].includes(value?.status)) throw new Error(`Native upgrade did not confirm: ${JSON.stringify(value)}`);
    return value?.status === 'confirmed' ? value : null;
  }, 240000, 'new native application ready confirmation');
  assert.equal(receipt.version, pkg.version); assert.equal(receipt.previousVersion, '3.10.0'); assert.equal(receipt.target, appPath);
  const confirmation = JSON.parse(await readFile(path.join(path.dirname(receipt.journal), 'confirmed.json'), 'utf8'));
  assert.equal(confirmation.id, receipt.id); assert.equal(confirmation.version, pkg.version);
  restartedPid = receipt.launchedPid;
  assert.ok(Number.isSafeInteger(restartedPid) && restartedPid > 1 && restartedPid !== child.pid, 'A distinct native restarted process must be observed.');
  process.kill(restartedPid, 0);
  if (process.platform === 'linux') assert.equal(await digest(appPath), candidateDigest, 'Actual installed AppImage must be replaced with the verified candidate bytes.');
  else {
    const installedAsar = process.platform === 'darwin' ? path.join(appPath, 'Contents', 'Resources', 'app.asar') : path.join(appPath, 'resources', 'app.asar');
    assert.equal(await digest(installedAsar), await digest(candidate.asar), 'Actual installed package must be the built candidate, not merely a launched installer.');
  }
  report.scenarios.push('real-native-handoff-replacement-relaunch-ready-confirmation');
  const after = JSON.parse(await readFile(path.join(device, 'vault.json'), 'utf8'));
  assert.equal(after.deviceId, saved.deviceId); assert.equal(after.publicKey, saved.publicKey); assert.equal(after.privateKey, saved.privateKey);
  assert.equal(after.label, saved.label); assert.deepEqual(after.career.profile, saved.career.profile); assert.equal(after.pairing, null);
  assert.equal(await readFile(exportFile, 'utf8'), exportBytes);
  report.scenarios.push('saved-synthetic-profile-identity-and-document-preserved');
  report.result = 'passed'; report.receipt = { status: receipt.status, version: receipt.version, previousVersion: receipt.previousVersion };
  report.notExercised = ['real candidate GitHub publication/download before publication', 'OS permission prompts or signing/notarization', 'native startup-failure rollback (covered separately by helper regressions)', 'old-version updater compatibility (not supported or required)'];
  console.log(JSON.stringify(report));
} catch (error) { report.error = error.message; console.error(log); throw error; }
finally {
  await mkdir(path.dirname(reportFile), { recursive: true }); await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  for (const connection of connections) connection.close();
  receipt ||= await readReceipt().catch(() => null);
  await stop(restartedPid || receipt?.launchedPid); await stop(child?.pid);
  if (process.platform === 'linux') {
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      try { if ((await readFile(`/proc/${name}/environ`, 'utf8')).split('\0').includes(`HOME=${home}`)) await stop(Number(name)); }
      catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
    }
  }
  await delay(1000);
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
