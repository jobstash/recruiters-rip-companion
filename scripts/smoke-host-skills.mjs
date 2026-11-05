// Real Electron + Codex CLI integration smoke. All host/profile writes stay in disposable directories.
// Run after build:runtime: node scripts/smoke-host-skills.mjs [--codex=/absolute/path/to/codex]
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { findHostCli, mcpInvocation } from '../src/host-setup.mjs';
import runtime from '../src/platform-runtime.cjs';

assert.ok(['darwin', 'linux'].includes(process.platform), 'This smoke requires macOS or a Linux desktop.');
assert.notEqual(process.getuid?.(), 0, 'Permission-failure smoke must not run as root.');
const root = fileURLToPath(new URL('..', import.meta.url));
const electron = createRequire(import.meta.url)('electron');
const cli = process.argv.find(arg => arg.startsWith('--codex='))?.slice(8) || (await findHostCli('codex'))?.command;
assert.ok(cli && path.isAbsolute(cli), 'Install the real Codex CLI or pass --codex=/absolute/path.');
const evidence = await realpath(await mkdtemp(path.join(tmpdir(), 'recruiters-host-skill-evidence-')));
const scratch = path.join(evidence, 'fixture'), home = path.join(scratch, 'home'), userData = path.join(scratch, 'user-data');
const directory = path.join(userData, 'device'), integration = path.join(directory, 'host-integration');
const plugin = path.join(integration, 'plugins', 'recruiters-rip');
const source = path.join(root, 'src', 'generated', 'recruiters-rip-plugin');
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CACHE_HOME: path.join(home, '.cache'),
  CODEX_HOME: path.join(home, 'codex-custom'), CLAUDE_CONFIG_DIR: path.join(home, 'claude-custom'),
  TMPDIR: path.join(scratch, 'tmp'), TMP: path.join(scratch, 'tmp'), TEMP: path.join(scratch, 'tmp'),
  PATH: `${path.dirname(cli)}${path.delimiter}${process.env.PATH || ''}` };
for (const key of Object.keys(env)) if (/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH|OPENAI_API_KEY|ANTHROPIC_API_KEY|RECRUITERS_COMPANION_DEV|APPIMAGE|APPDIR)$/i.test(key)) delete env[key];
const execute = promisify(execFile), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const skillRelative = path.join('skills', 'recruiters-rip', 'SKILL.md');
const claudeSkillDirectory = path.join(env.CLAUDE_CONFIG_DIR, 'skills', 'recruiters-rip');
const claudeSkill = path.join(claudeSkillDirectory, 'SKILL.md');
let child, inspector, page, logs = '', browserUrl, inspectorUrl, exit;
const append = bytes => {
  logs = (logs + bytes.toString()).slice(-512 * 1024);
  browserUrl ||= /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/.exec(logs)?.[1];
  inspectorUrl ||= /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(logs)?.[1];
};
async function until(work, description, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (exit) throw new Error(`Electron exited (${JSON.stringify(exit)}): ${logs}`);
    const result = await work();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}: ${logs}`);
}
async function connect(url) {
  const socket = new WebSocket(url), pending = new Map();
  let sequence = 0;
  socket.addEventListener('message', event => {
    const reply = JSON.parse(event.data), request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id); clearTimeout(request.timer);
    reply.error ? request.reject(new Error(reply.error.message)) : request.resolve(reply.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Inspector connection failed.')), { once: true });
  });
  return { close: () => socket.close(), send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  } };
}
async function evaluate(connection, expression) {
  const result = await connection.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function boot() {
  logs = ''; browserUrl = inspectorUrl = exit = null;
  child = spawn(electron, [root, `--user-data-dir=${userData}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--inspect=127.0.0.1:0'],
    { env, cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.on('data', append); child.stderr.on('data', append);
  child.once('error', error => { exit = { error: error.message }; });
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  await until(() => browserUrl && inspectorUrl, 'Electron inspectors');
  inspector = await connect(inspectorUrl);
  const target = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${new URL(browserUrl).port}/json/list`);
    return (await response.json()).find(value => value.type === 'page' && value.url.startsWith('file:'));
  }, 'settings renderer');
  page = await connect(target.webSocketDebuggerUrl);
  const state = await until(async () => {
    let result;
    try { result = await evaluate(page, 'typeof window.companion === "object" ? window.companion.invoke("state") : null'); }
    catch (error) { if (/context was destroyed|Cannot find context/.test(error.message)) return null; throw error; }
    if (result?.ok === false) throw new Error(result.error.message);
    return ['ready', 'needs_connection'].includes(result?.result?.execution?.state) ? result.result : null;
  }, 'unlocked startup');
  assert.equal(state.failure, '');
  assert.equal(state.paired, false);
  assert.equal(state.decisionApiConfigured, false);
  assert.ok(state.setup.command.startsWith(scratch + path.sep));
  assert.ok(await stat(path.join(directory, 'mcp-launch.json')));
  return state;
}
async function stop() {
  if (!child) return;
  if (!exit && inspector) {
    await evaluate(inspector, "process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.quit()");
    page?.close(); inspector.close(); page = inspector = null;
    const deadline = Date.now() + 10000;
    while (!exit && Date.now() < deadline) await delay(100);
  }
  page?.close(); inspector?.close(); page = inspector = null;
  if (!exit) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await exited;
  }
  child = null;
}
async function screenshot(name) {
  await evaluate(page, 'window.openCompanionSettings("chat-app-settings")');
  await evaluate(page, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const image = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path.join(evidence, `${name}.png`), Buffer.from(image.data, 'base64'));
}
const report = [];
try {
  for (const dir of [home, userData, directory, env.CODEX_HOME, env.CLAUDE_CONFIG_DIR, env.TMPDIR, env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME]) await mkdir(dir, { recursive: true, mode: 0o700 });
  await cp(source, plugin, { recursive: true });
  await writeFile(path.join(plugin, skillRelative), 'stale synthetic Codex skill\n');
  await writeFile(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { 'recruiters-rip': mcpInvocation(runtime.mcpCommand(directory)) } }, null, 2) + '\n');
  await mkdir(path.join(integration, '.agents', 'plugins'), { recursive: true });
  await writeFile(path.join(integration, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'recruiters-rip', interface: { displayName: 'Recruiters.rip' }, plugins: [{ name: 'recruiters-rip', source: { source: 'local', path: './plugins/recruiters-rip' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] }));
  const codexConfig = path.join(env.CODEX_HOME, 'config.toml');
  await writeFile(codexConfig, 'model = "synthetic-smoke-model"\napproval_policy = "never"\n\n[mcp_servers.unrelated]\ncommand = "/synthetic/keep-me"\n');
  // Seed a real native plugin cache, without using Companion's manual Set up operation.
  for (const args of [['plugin', 'marketplace', 'add', integration, '--json'], ['plugin', 'add', 'recruiters-rip@recruiters-rip', '--json']]) await execute(cli, args, { env, cwd: scratch, timeout: 60000 });
  const manifest = JSON.parse(await readFile(path.join(plugin, '.codex-plugin', 'plugin.json'), 'utf8'));
  const cachedSkill = path.join(env.CODEX_HOME, 'plugins', 'cache', 'recruiters-rip', 'recruiters-rip', manifest.version, skillRelative);
  assert.equal(await readFile(cachedSkill, 'utf8'), 'stale synthetic Codex skill\n');
  const claudeConfig = path.join(env.CLAUDE_CONFIG_DIR, '.claude.json');
  await writeFile(claudeConfig, JSON.stringify({ theme: 'dark', mcpServers: { 'recruiters-rip': { command: runtime.mcpCommand(directory) }, unrelated: { command: '/synthetic/keep-me' } } }));
  await mkdir(claudeSkillDirectory, { recursive: true });
  await writeFile(claudeSkill, 'stale synthetic Claude skill\n');
  const expected = await readFile(path.join(source, skillRelative), 'utf8');
  const savedConfig = { codex: await readFile(codexConfig, 'utf8'), claude: await readFile(claudeConfig, 'utf8') };
  const unchangedSettings = async () => {
    assert.equal(await readFile(codexConfig, 'utf8'), savedConfig.codex);
    assert.equal(await readFile(claudeConfig, 'utf8'), savedConfig.claude);
  };
  let state = await boot();
  assert.deepEqual(state.review.errors, []);
  assert.deepEqual(state.review.restart, { codex: true, claude: true });
  for (const file of [claudeSkill, cachedSkill, path.join(plugin, skillRelative)]) assert.equal(await readFile(file, 'utf8'), expected);
  await unchangedSettings(); await screenshot('refreshed');
  report.push({ boot: 'stale', execution: state.execution.state, refreshed: state.review.restart });
  await stop();
  const timestamps = await Promise.all([claudeSkill, cachedSkill, path.join(plugin, skillRelative)].map(async file => (await stat(file)).mtimeMs));
  state = await boot();
  assert.deepEqual(state.review.errors, []);
  assert.deepEqual(state.review.restart, { codex: false, claude: false });
  assert.deepEqual(await Promise.all([claudeSkill, cachedSkill, path.join(plugin, skillRelative)].map(async file => (await stat(file)).mtimeMs)), timestamps);
  await unchangedSettings(); report.push({ boot: 'unchanged', execution: state.execution.state, unchangedMtimes: true }); await stop();
  await writeFile(claudeSkill, 'stale blocked Claude skill\n');
  await chmod(path.dirname(claudeSkillDirectory), 0o500);
  await writeFile(cachedSkill, 'stale independent Codex skill\n');
  state = await boot();
  assert.equal(state.review.errors.length, 1); assert.equal(state.review.errors[0].host, 'claude');
  assert.equal(state.review.restart.codex, true);
  assert.equal(await readFile(cachedSkill, 'utf8'), expected);
  assert.equal(await readFile(claudeSkill, 'utf8'), 'stale blocked Claude skill\n');
  const jobs = await evaluate(page, 'window.companion.invoke("career-list", { kind: "jobs" })');
  assert.equal(jobs.ok, true, 'Host refresh failure must not lock career access.');
  await unchangedSettings(); await screenshot('independent-failure');
  report.push({ boot: 'claude-failure', execution: state.execution.state, errors: state.review.errors, jobsAccessible: jobs.ok }); await stop();
  await chmod(path.dirname(claudeSkillDirectory), 0o700);
  state = await boot();
  assert.deepEqual(state.review.errors, []); assert.equal(state.review.restart.claude, true); assert.equal(state.review.restart.codex, false);
  assert.equal(await readFile(claudeSkill, 'utf8'), expected); await unchangedSettings();
  report.push({ boot: 'recovered', execution: state.execution.state, refreshed: state.review.restart });
  await stop();
  console.log(JSON.stringify({ hostSkillSmoke: 'passed', platform: process.platform, realElectron: true, realCodexCli: cli, manualSetupInvoked: false, report, screenshots: evidence,
    limits: 'Source Electron build, synthetic unpaired profile; no real AI conversation, authentication, packaged upgrade or Windows execution. Existing conversations are not tested for prompt reload.' }, null, 2));
} catch (error) {
  console.error(logs); throw error;
} finally {
  await stop();
  await chmod(path.dirname(claudeSkillDirectory), 0o700).catch(() => {});
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
