import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, stat, symlink, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApplicationLauncher, terminalLaunch, applicationMcpToml } from '../src/application-launcher.mjs';
import { spawn } from 'node:child_process';

const preparationId = '019a057a-9da1-7c39-8db7-173951f9eb20';
const anotherId = '019a057a-9da1-7c39-8db7-173951f9eb21';

async function harness(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'recruiters-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'Companion & tools #1 + résumé');
  const command = path.join(root, process.platform === 'win32' ? 'MCP launcher & +.command' : 'MCP "launcher" & +.command');
  await writeFile(command, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const opened = [], checked = [];
  const launcher = createApplicationLauncher({ directory, command,
    openExternal: async url => { opened.push(url); },
    hostAvailable: async host => { checked.push(host); return true; }, ...overrides });
  return { launcher, directory, command, root, opened, checked, workspace: path.join(directory, 'application-workspace') };
}

for (const host of ['claude', 'codex']) test(`${host} opens only an encoded, request-specific composer with scoped Companion tools`, async t => {
  const { launcher, opened, workspace, command, directory } = await harness(t);
  assert.deepEqual(await launcher.open({ host, preparationId }), { opened: true, host, requiresSend: true, mode: 'desktop' });
  assert.equal(opened.length, 1);
  const link = new URL(opened[0]);
  assert.equal(link.protocol, host === 'claude' ? 'claude:' : 'codex:');
  assert.equal(link.hostname, host === 'claude' ? 'code' : 'threads');
  assert.equal(link.pathname, '/new');
  assert.equal(link.searchParams.get(host === 'claude' ? 'folder' : 'path'), workspace);
  const prompt = link.searchParams.get(host === 'claude' ? 'q' : 'prompt');
  assert.match(prompt, /career_application_preparation_read/);
  assert.match(prompt, /using only the recruiters-rip-applications MCP connection for this workspace/);
  assert.match(prompt, /do not use another Companion connection/);
  assert.ok(prompt.includes(`{"preparationId":"${preparationId}"}`));
  assert.equal(prompt.includes(command), false);
  assert.equal(prompt.includes(directory), false);
  assert.equal(link.hash, '');
  assert.deepEqual([...link.searchParams.keys()].sort(), host === 'claude' ? ['folder', 'q'] : ['mode', 'path', 'prompt']);
  assert.equal(link.searchParams.get('mode'), host === 'codex' ? 'codex' : null);
  if (host === 'claude') {
    const config = JSON.parse(await readFile(path.join(workspace, '.mcp.json'), 'utf8'));
    assert.deepEqual(config, { mcpServers: { 'recruiters-rip-applications': { command, args: [] } } });
    if (process.platform !== 'win32') assert.equal((await stat(path.join(workspace, '.mcp.json'))).mode & 0o777, 0o600);
  } else {
    const config = await readFile(path.join(workspace, '.codex', 'config.toml'), 'utf8');
    assert.equal(config, `[mcp_servers.recruiters-rip-applications]\ncommand = ${JSON.stringify(command)}\nargs = []\n`);
    if (process.platform !== 'win32') assert.equal((await stat(path.join(workspace, '.codex', 'config.toml'))).mode & 0o777, 0o600);
  }
  if (process.platform !== 'win32') assert.equal((await stat(workspace)).mode & 0o777, 0o700);
  await launcher.open({ host, preparationId: anotherId });
  assert.equal(opened.length, 2);
  const secondPrompt = new URL(opened[1]).searchParams.get(host === 'claude' ? 'q' : 'prompt');
  assert.equal(secondPrompt, prompt.replace(preparationId, anotherId));
});

test('availability probes hosts without opening, configuring, or claiming inference', async t => {
  const { launcher, opened, directory, checked } = await harness(t);
  assert.deepEqual(await launcher.available(), { claude: true, codex: true });
  assert.deepEqual(checked, ['claude', 'codex']);
  assert.deepEqual(opened, []);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('invalid host, UUID and extra private context are rejected before native access', async t => {
  const { launcher, opened, checked, directory } = await harness(t);
  for (const input of [undefined, null, [], {}, { host: 'browser', preparationId },
    { host: 'claude', preparationId: '../request' }, { host: 'claude', preparationId: 12 },
    { host: 'codex', preparationId: `${preparationId}&prompt=send` },
    { host: 'codex', preparationId: `${preparationId}\n` },
    { host: 'codex', preparationId: '00000000-0000-0000-0000-000000000000' },
    { host: 'claude', preparationId, prompt: 'private CV' },
    { host: 'codex', preparationId, command: '/bin/sh' },
    { host: 'claude', preparationId, directory: '/Users/person' }]) {
    await assert.rejects(launcher.open(input), { code: 'INVALID_INPUT' });
  }
  assert.deepEqual(opened, []);
  assert.deepEqual(checked, []);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('launcher configuration requires absolute local paths and native dependencies', () => {
  const options = { directory: '/tmp/application-test', command: '/tmp/mcp-test', openExternal: async () => {} };
  for (const change of [{ directory: '../outside' }, { command: 'mcp --send' }, { command: '/tmp/mcp\nextra' },
    { directory: '/tmp/hidden\0dir' }, { openExternal: undefined }, { hostAvailable: null }])
    assert.throws(() => createApplicationLauncher({ ...options, ...change }), { code: 'INVALID_INPUT' });
});

test('missing hosts fail actionably without creating configs or opening another host', async t => {
  const { launcher, opened, directory } = await harness(t, { hostAvailable: async host => host === 'claude' });
  assert.deepEqual(await launcher.available(), { claude: true, codex: false });
  await assert.rejects(launcher.open({ host: 'codex', preparationId }), error =>
    error.code === 'HOST_UNAVAILABLE' && /Install ChatGPT desktop/.test(error.message));
  assert.deepEqual(opened, []);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('a missing MCP executable cannot produce an opened result', async t => {
  const { launcher, command, opened } = await harness(t);
  await rm(command);
  await assert.rejects(launcher.open({ host: 'claude', preparationId }), { code: 'HOST_SETUP_REQUIRED' });
  assert.deepEqual(opened, []);
});

test('native link rejection does not return opened or send a fallback prompt', async t => {
  let attempts = 0;
  const { launcher } = await harness(t, { openExternal: async () => { attempts++; throw new Error('private OS detail'); } });
  await assert.rejects(launcher.open({ host: 'codex', preparationId }), error =>
    error.code === 'HOST_LAUNCH_FAILED' && /no prompt was sent/.test(error.message) && !error.message.includes('private OS detail'));
  assert.equal(attempts, 1);
});

test('scoped config never follows file symlinks or modifies unrelated host settings', { skip: process.platform === 'win32' }, async t => {
  const { launcher, workspace, root } = await harness(t);
  const userConfig = path.join(root, 'unrelated-config.json');
  await writeFile(userConfig, '{"keep":"user settings"}\n');
  await mkdir(workspace, { recursive: true });
  await symlink(userConfig, path.join(workspace, '.mcp.json'));
  await launcher.open({ host: 'claude', preparationId });
  assert.equal(await readFile(userConfig, 'utf8'), '{"keep":"user settings"}\n');
  assert.deepEqual(await readdir(workspace), ['.mcp.json']);
});

test('symlinked workspace and Codex config directories fail before opening', async t => {
  for (const target of ['workspace', 'codex']) {
    const { launcher, workspace, directory, root, opened } = await harness(t);
    const outside = path.join(root, 'unrelated');
    await mkdir(outside);
    await mkdir(directory, { recursive: true });
    if (target === 'workspace') await symlink(outside, workspace, process.platform === 'win32' ? 'junction' : 'dir');
    else { await mkdir(workspace); await symlink(outside, path.join(workspace, '.codex'), process.platform === 'win32' ? 'junction' : 'dir'); }
    await assert.rejects(launcher.open({ host: 'codex', preparationId }), { code: 'HOST_SETUP_FAILED' });
    assert.deepEqual(opened, []);
    assert.deepEqual(await readdir(outside), []);
  }
});

for (const host of ['claude', 'codex']) test(`${host} CLI opens a visible terminal without submitting or trying another host`, async t => {
  const calls = [];
  const descriptor = { available: true, label: host === 'claude' ? 'Claude Code' : 'Codex CLI', mode: 'cli', reason: null,
    cli: { command: '/synthetic/bin/official cli', args: [] }, terminal: { command: '/synthetic/bin/terminal', args: ['--'] } };
  const { launcher, opened, workspace } = await harness(t, { platform: 'linux', hostAvailable: undefined,
    discover: async () => descriptor, launchTerminal: async (...args) => calls.push(args) });
  assert.deepEqual(await launcher.open({ host, preparationId }), { opened: true, host, requiresSend: true, mode: 'cli' });
  assert.deepEqual(opened, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], descriptor.terminal.command);
  assert.deepEqual(calls[0][1].slice(0, 3), ['--', '/bin/sh', '-c']);
  const script = calls[0][1][3];
  assert.ok(script.includes(preparationId));
  assert.ok(script.includes(workspace));
  assert.ok(script.indexOf('read -r answer') < script.indexOf('\nexec '));
  assert.equal(script.includes('--dangerously'), false);
  assert.equal(calls[0][2].cwd, workspace);
  assert.deepEqual((await launcher.info())[host], { available: true, label: descriptor.label, mode: 'cli', reason: null });
});

test('terminal failure never invokes another terminal, link or model', async t => {
  let attempts = 0;
  const { launcher, opened } = await harness(t, { platform: 'linux', hostAvailable: undefined,
    discover: async () => ({ available: true, mode: 'cli', label: 'Codex CLI', cli: { command: '/not-executed', args: [] },
      terminal: { command: '/missing-terminal', args: ['-e'] } }),
    launchTerminal: async () => { attempts++; throw new Error('No terminal'); } });
  await assert.rejects(launcher.open({ host: 'codex', preparationId }), { code: 'HOST_LAUNCH_FAILED' });
  assert.equal(attempts, 1);
  assert.deepEqual(opened, []);
});

test('CLI setup configures only the connected workspace without launching', async t => {
  const { launcher, opened, workspace } = await harness(t);
  const result = await launcher.connect('claude');
  assert.equal(result.installed, true);
  assert.match(result.conversationRequired, /connected workspace/);
  assert.ok(JSON.parse(await readFile(path.join(workspace, '.mcp.json'), 'utf8')).mcpServers['recruiters-rip-applications']);
  assert.deepEqual(opened, []);
});

test('Windows terminal uses encoded PowerShell literals and exact workspace and prompt', () => {
  const workspace = "C:\\Users\\A & B\\résumé's $home";
  const prompt = 'Prepare "this" & $(not-code) %PATH% !value!\nDo not submit.';
  const invocation = terminalLaunch({ host: 'codex', platform: 'win32', workspace, prompt,
    descriptor: { cli: { command: 'C:\\Program Files\\node.exe', args: ["C:\\A's\\codex.js"] }, terminal: { command: 'powershell.exe' } } });
  assert.deepEqual(invocation.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand']);
  const script = Buffer.from(invocation.args[4], 'base64').toString('utf16le');
  assert.ok(script.includes("Set-Location -LiteralPath 'C:\\Users\\A & B\\résumé''s $home'"));
  assert.ok(script.includes(`'${prompt}'`));
  assert.ok(script.includes(`"--cd" "C:\\Users\\A & B\\résumé''s $home" "--"`));
  assert.ok(script.includes('Prepare \\"this\\" & $(not-code) %PATH% !value!'));
  assert.ok(script.includes('$start.UseShellExecute = $false'));
  assert.ok(script.indexOf('Read-Host') < script.indexOf('[System.Diagnostics.Process]::Start'));
  assert.equal(script.includes('-ExecutionPolicy'), false);
});

test('Windows TOML preserves literal batch path in an env value, not shell code', () => {
  const command = "C:\\Users\\A & B\\résumé 100% !\\mcp.cmd";
  const toml = applicationMcpToml(command, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } });
  assert.ok(toml.includes('command = "C:\\\\Windows\\\\System32\\\\cmd.exe"'));
  assert.ok(toml.includes('[mcp_servers.recruiters-rip-applications.env]'));
  assert.ok(toml.includes(`RECRUITERS_RIP_MCP_COMMAND = ${JSON.stringify(`"${command}"`)}\n`));
});

test('POSIX terminal waits for confirmation and preserves prompt/workspace as literal arguments', { skip: process.platform === 'win32' }, async t => {
  const { root } = await harness(t);
  const workspace = path.join(root, "workspace ' & résumé");
  const capture = path.join(root, 'synthetic-cli.cjs'), result = path.join(root, 'arguments.json');
  await mkdir(workspace);
  await writeFile(capture, `require('node:fs').writeFileSync(${JSON.stringify(result)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));`);
  const prompt = 'A "quoted" résumé; $(touch NEVER) & literal \'quote\'\nnext line';
  const invocation = terminalLaunch({ host: 'codex', platform: 'linux', workspace, prompt,
    descriptor: { cli: { command: process.execPath, args: [capture] }, terminal: { command: 'synthetic-terminal', args: [] } } });
  const run = input => new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', invocation.source], { stdio: ['pipe', 'ignore', 'pipe'] });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Synthetic terminal exited ${code}`)));
    child.stdin.end(input);
  });
  await run('cancel\n');
  await assert.rejects(stat(result), { code: 'ENOENT' });
  await run('\n');
  assert.deepEqual(JSON.parse(await readFile(result, 'utf8')), { args: ['--cd', workspace, '--', prompt], cwd: await realpath(workspace) });
});

test('macOS CLI terminal scripts are private, self-removing and never launched during discovery', async t => {
  const calls = [];
  const descriptor = { available: true, mode: 'cli', label: 'Claude Code', reason: null,
    cli: { command: '/synthetic/claude', args: [] }, terminal: { command: '/usr/bin/open', args: ['-a', 'Terminal'] } };
  const { launcher } = await harness(t, { platform: 'darwin', hostAvailable: undefined, discover: async () => descriptor,
    launchTerminal: async (...args) => calls.push(args) });
  assert.equal((await launcher.available()).claude, true);
  assert.deepEqual(calls, []);
  await launcher.review({ host: 'claude' });
  assert.equal(calls[0][0], '/usr/bin/open');
  assert.deepEqual(calls[0][1].slice(0, 2), ['-a', 'Terminal']);
  const filename = calls[0][1][2];
  assert.match(filename, /launch-[\w-]+\.command$/);
  assert.ok((await readFile(filename, 'utf8')).includes('/bin/rm -f -- "$0"'));
  if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777, 0o700);
});

test('Windows terminal preserves native argv after explicit Enter without invoking a real host', { skip: process.platform !== 'win32' }, async t => {
  const { root } = await harness(t);
  const workspace = path.join(root, "workspace & résumé's"), result = path.join(root, 'arguments.json');
  const capture = path.join(root, 'synthetic-cli.cjs');
  await mkdir(workspace);
  await writeFile(capture, `require('node:fs').writeFileSync(${JSON.stringify(result)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));`);
  const prompt = `Read {"preparationId":"${preparationId}"} & $env:PATH %PATH% !literal! C:\\last\\`;
  const invocation = terminalLaunch({ host: 'codex', platform: 'win32', workspace, prompt,
    descriptor: { cli: { command: process.execPath, args: [capture] },
      terminal: { command: path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') } } });
  const run = input => new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args.filter(arg => arg !== '-NoExit'), { stdio: ['pipe', 'ignore', 'pipe'] });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Synthetic terminal exited ${code}`)));
    child.stdin.end(input);
  });
  await run('cancel\n');
  await assert.rejects(stat(result), { code: 'ENOENT' });
  await run('\n');
  assert.deepEqual(JSON.parse(await readFile(result, 'utf8')), { args: ['--cd', workspace, '--', prompt], cwd: workspace });
});
