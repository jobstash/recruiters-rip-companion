import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, stat, symlink, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApplicationLauncher, terminalLaunch, preparationPrompt } from '../src/application-launcher.mjs';
import { spawn } from 'node:child_process';

const preparationId = '019a057a-9da1-7c39-8db7-173951f9eb20';
const anotherId = '019a057a-9da1-7c39-8db7-173951f9eb21';

async function harness(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'recruiters-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'Companion & tools #1 + résumé');
  const opened = [], checked = [];
  const launcher = createApplicationLauncher({ directory,
    openExternal: async url => { opened.push(url); },
    hostAvailable: async host => { checked.push(host); return true; }, ...overrides });
  const workspaces = path.join(directory, 'application-workspaces');
  return { launcher, directory, root, opened, checked, workspaces };
}

function assertWorkspace(workspace, workspaces, id) {
  assert.equal(path.dirname(workspace), workspaces);
  assert.match(path.basename(workspace), new RegExp(`^${id ? `preparation-${id.toLowerCase()}` : 'review'}-[A-Za-z0-9]{6}$`));
}

for (const host of ['claude', 'codex']) test(`${host} opens only an encoded, request-specific composer that uses the installed recruiters-rip connection`, async t => {
  const { launcher, opened, workspaces, directory } = await harness(t);
  assert.deepEqual(await launcher.open({ host, preparationId }), { opened: true, host, requiresSend: true, mode: 'desktop' });
  assert.equal(opened.length, 1);
  const link = new URL(opened[0]);
  assert.equal(link.protocol, host === 'claude' ? 'claude:' : 'codex:');
  assert.equal(link.hostname, host === 'claude' ? 'code' : 'threads');
  assert.equal(link.pathname, '/new');
  const workspace = link.searchParams.get(host === 'claude' ? 'folder' : 'path');
  assertWorkspace(workspace, workspaces, preparationId);
  const prompt = link.searchParams.get(host === 'claude' ? 'q' : 'prompt');
  assert.equal(prompt, preparationPrompt({ host, mode: 'desktop', preparationId }));
  assert.ok(prompt.startsWith(`Use the recruiters.rip tools (MCP server recruiters-rip) to call career_application_preparation_read with {"preparationId":"${preparationId}"}`));
  assert.match(prompt, host === 'claude' ? /Set up for Claude in Recruiters Companion Settings → AI apps, then quit Claude completely and reopen it/
    : /Set up for Codex in Recruiters Companion Settings → AI apps, then restart Codex/);
  assert.doesNotMatch(prompt, /recruiters-rip-applications|using only|approve|another Companion connection/);
  assert.equal(prompt.includes(directory), false);
  assert.equal(link.hash, '');
  assert.deepEqual([...link.searchParams.keys()].sort(), host === 'claude' ? ['folder', 'q'] : ['mode', 'path', 'prompt']);
  assert.equal(link.searchParams.get('mode'), host === 'codex' ? 'codex' : null);
  // The session's tools come from the host's own Set up: the workspace carries no project MCP server to approve.
  assert.deepEqual(await readdir(workspace), []);
  if (process.platform !== 'win32') assert.equal((await stat(workspace)).mode & 0o777, 0o700);
  await launcher.open({ host, preparationId: anotherId });
  assert.equal(opened.length, 2);
  const secondPrompt = new URL(opened[1]).searchParams.get(host === 'claude' ? 'q' : 'prompt');
  assert.equal(secondPrompt, prompt.replace(preparationId, anotherId));
  assertWorkspace(new URL(opened[1]).searchParams.get(host === 'claude' ? 'folder' : 'path'), workspaces, anotherId);
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
  const options = { directory: '/tmp/application-test', openExternal: async () => {} };
  for (const change of [{ directory: '../outside' }, { directory: '/tmp/hidden\0dir' }, { openExternal: undefined }, { hostAvailable: null }])
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

test('local-product Claude names its own server; Codex keeps the plugin name; CLI restart guidance matches Settings', () => {
  assert.match(preparationPrompt({ host: 'claude', mode: 'desktop', preparationId, localOnly: true }), /\(MCP server recruiters-rip-local\)/);
  assert.match(preparationPrompt({ host: 'codex', mode: 'desktop', preparationId, localOnly: true }), /\(MCP server recruiters-rip\)/);
  assert.match(preparationPrompt({ host: 'claude', mode: 'cli', preparationId }), /then start a new Claude Code session and send this request again/);
});

test('native link rejection does not return opened or send a fallback prompt', async t => {
  let attempts = 0;
  const { launcher } = await harness(t, { openExternal: async () => { attempts++; throw new Error('private OS detail'); } });
  await assert.rejects(launcher.open({ host: 'codex', preparationId }), error =>
    error.code === 'HOST_LAUNCH_FAILED' && /no prompt was sent/.test(error.message) && !error.message.includes('private OS detail'));
  assert.equal(attempts, 1);
});

test('the old shared workspace is left untouched and never used by new launches', async t => {
  const { launcher, directory, workspaces, opened } = await harness(t);
  const legacy = path.join(directory, 'application-workspace');
  await mkdir(path.join(legacy, '.codex'), { recursive: true });
  await writeFile(path.join(legacy, '.codex', 'config.toml'), 'existing session config');
  await writeFile(path.join(legacy, '.mcp.json'), 'existing session MCP config');
  await writeFile(path.join(legacy, 'scratch.txt'), 'another session is working here');
  await launcher.open({ host: 'claude', preparationId });
  const workspace = new URL(opened[0]).searchParams.get('folder');
  assertWorkspace(workspace, workspaces, preparationId);
  assert.deepEqual(await readdir(workspace), []);
  assert.equal(await readFile(path.join(legacy, '.codex', 'config.toml'), 'utf8'), 'existing session config');
  assert.equal(await readFile(path.join(legacy, '.mcp.json'), 'utf8'), 'existing session MCP config');
  assert.equal(await readFile(path.join(legacy, 'scratch.txt'), 'utf8'), 'another session is working here');
});

for (const target of ['directory', 'workspaces']) test(`a symlinked ${target} fails before opening without touching its target`, async t => {
  const fixture = await harness(t);
  const { launcher, root, opened } = fixture;
  const outside = path.join(root, 'unrelated');
  await mkdir(outside);
  await writeFile(path.join(outside, 'keep.txt'), 'unrelated session');
  await mkdir(path.dirname(fixture[target]), { recursive: true });
  await symlink(outside, fixture[target], process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(launcher.open({ host: 'codex', preparationId }), { code: 'HOST_SETUP_FAILED' });
  await assert.rejects(launcher.review({ host: 'claude' }), { code: 'HOST_SETUP_FAILED' });
  assert.deepEqual(opened, []);
  assert.deepEqual(await readdir(outside), ['keep.txt']);
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'unrelated session');
});

test('a pre-existing preparation symlink is neither followed nor removed by a new launch', async t => {
  const { launcher, root, opened, workspaces } = await harness(t);
  const outside = path.join(root, 'unrelated');
  const previous = path.join(workspaces, `preparation-${preparationId}`);
  await mkdir(outside);
  await writeFile(path.join(outside, 'scratch.txt'), 'another session');
  await mkdir(workspaces, { recursive: true });
  await symlink(outside, previous, process.platform === 'win32' ? 'junction' : 'dir');
  await launcher.open({ host: 'codex', preparationId });
  const workspace = new URL(opened[0]).searchParams.get('path');
  assertWorkspace(workspace, workspaces, preparationId);
  assert.notEqual(workspace, previous);
  assert.deepEqual(await readdir(workspace), []);
  assert.equal(await realpath(previous), await realpath(outside));
  assert.deepEqual(await readdir(outside), ['scratch.txt']);
  assert.equal(await readFile(path.join(outside, 'scratch.txt'), 'utf8'), 'another session');
});

for (const host of ['claude', 'codex']) test(`${host} concurrent desktop preparations and reviews receive isolated private folders`, async t => {
  const { launcher, opened, workspaces } = await harness(t);
  await Promise.all([
    launcher.open({ host, preparationId }),
    launcher.open({ host, preparationId: anotherId }),
    launcher.review({ host }),
    launcher.review({ host }),
  ]);
  const links = opened.map(url => new URL(url));
  const folders = links.map(link => link.searchParams.get(host === 'claude' ? 'folder' : 'path'));
  assert.equal(new Set(folders).size, 4);
  for (const link of links) {
    const folder = link.searchParams.get(host === 'claude' ? 'folder' : 'path');
    const prompt = link.searchParams.get(host === 'claude' ? 'q' : 'prompt');
    const id = [preparationId, anotherId].find(id => prompt.includes(id));
    assertWorkspace(folder, workspaces, id);
    assert.deepEqual(await readdir(folder), []);
    if (process.platform !== 'win32') assert.equal((await stat(folder)).mode & 0o777, 0o700);
    await writeFile(path.join(folder, 'scratch.txt'), prompt);
  }
  for (const link of links) {
    const folder = link.searchParams.get(host === 'claude' ? 'folder' : 'path');
    assert.equal(await readFile(path.join(folder, 'scratch.txt'), 'utf8'), link.searchParams.get(host === 'claude' ? 'q' : 'prompt'));
  }
});

test('reopening the same preparation creates fresh scratch space across hosts, UUID casing and launcher instances', async t => {
  const { launcher, directory, opened, workspaces } = await harness(t);
  await launcher.open({ host: 'claude', preparationId });
  const original = new URL(opened[0]).searchParams.get('folder');
  await writeFile(path.join(original, 'scratch.txt'), 'unfinished draft');
  const reopened = createApplicationLauncher({ directory, hostAvailable: async () => true, openExternal: async url => opened.push(url) });
  await Promise.all([
    launcher.open({ host: 'claude', preparationId: preparationId.toUpperCase() }),
    reopened.open({ host: 'codex', preparationId }),
  ]);
  assert.equal(opened.length, 3);
  const folders = opened.map(value => {
    const link = new URL(value);
    assert.ok(link.searchParams.get(link.protocol === 'claude:' ? 'q' : 'prompt').toLowerCase().includes(preparationId));
    return link.searchParams.get(link.protocol === 'claude:' ? 'folder' : 'path');
  });
  assert.equal(new Set(folders).size, 3);
  for (const folder of folders) assertWorkspace(folder, workspaces, preparationId);
  for (const folder of folders.slice(1)) assert.deepEqual(await readdir(folder), []);
  assert.equal(await readFile(path.join(original, 'scratch.txt'), 'utf8'), 'unfinished draft');
});

for (const host of ['claude', 'codex']) test(`${host} CLI opens a visible terminal without submitting or trying another host`, async t => {
  const calls = [];
  const descriptor = { available: true, label: host === 'claude' ? 'Claude Code' : 'Codex CLI', mode: 'cli', reason: null,
    cli: { command: '/synthetic/bin/official cli', args: [] }, terminal: { command: '/synthetic/bin/terminal', args: ['--'] } };
  const { launcher, opened, workspaces } = await harness(t, { platform: 'linux', hostAvailable: undefined,
    discover: async () => descriptor, launchTerminal: async (...args) => calls.push(args) });
  assert.deepEqual(await launcher.open({ host, preparationId }), { opened: true, host, requiresSend: true, mode: 'cli' });
  assert.deepEqual(opened, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], descriptor.terminal.command);
  assert.deepEqual(calls[0][1].slice(0, 3), ['--', '/bin/sh', '-c']);
  const script = calls[0][1][3];
  const workspace = calls[0][2].cwd;
  assertWorkspace(workspace, workspaces, preparationId);
  assert.ok(script.includes(preparationId));
  assert.ok(script.includes(workspace));
  assert.ok(script.indexOf('read -r answer') < script.indexOf('\nexec '));
  assert.equal(script.includes('--dangerously'), false);
  assert.deepEqual(await readdir(workspace), []);
  assert.deepEqual((await launcher.info())[host], { available: true, label: descriptor.label, mode: 'cli', reason: null });
});

for (const host of ['claude', 'codex']) test(`${host} concurrent CLI launches execute with their own scratch files, cwd and arguments`, async t => {
  const calls = [];
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const platform = process.platform === 'win32' ? 'win32' : 'linux';
  const descriptor = { available: true, mode: 'cli', label: 'Synthetic CLI',
    cli: { command: process.execPath, args: [] },
    terminal: platform === 'win32'
      ? { command: path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') }
      : { command: 'synthetic-terminal', args: [] } };
  const { launcher, root, workspaces, opened } = await harness(t, { platform, hostAvailable: undefined,
    discover: async () => descriptor,
    launchTerminal: async (command, args, options) => {
      calls.push({ command, args, options });
      if (calls.length === 5) release();
      await ready;
      // Replace only the visible terminal with a pipe; execute the generated launcher and a synthetic CLI.
      await new Promise((resolve, reject) => {
        const child = platform === 'win32'
          ? spawn(command, args.filter(arg => arg !== '-NoExit'), { ...options, stdio: ['pipe', 'ignore', 'pipe'] })
          : spawn(args[0], args.slice(1), { ...options, stdio: ['pipe', 'ignore', 'pipe'] });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Synthetic terminal exited ${code}`)));
        child.stdin.end('\n');
      });
    } });
  const capture = path.join(root, 'synthetic-cli.cjs');
  await writeFile(capture, `require('node:fs').writeFileSync('scratch.json', JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));`);
  descriptor.cli.args.push(capture);
  await Promise.all([
    launcher.open({ host, preparationId }),
    launcher.open({ host, preparationId: anotherId }),
    launcher.open({ host, preparationId }),
    launcher.review({ host }),
    launcher.review({ host }),
  ]);
  assert.deepEqual(opened, []);
  assert.equal(calls.length, 5);
  assert.equal(new Set(calls.map(call => call.options.cwd)).size, 5);
  for (const { options } of calls) {
    const { cwd } = options;
    assert.equal(path.dirname(cwd), workspaces);
    const recorded = JSON.parse(await readFile(path.join(cwd, 'scratch.json'), 'utf8'));
    assert.equal(await realpath(recorded.cwd), await realpath(cwd));
    const prompt = recorded.args.at(-1);
    assert.deepEqual(recorded.args, [...(host === 'codex' ? ['--cd', cwd] : []), '--', prompt]);
    const id = [preparationId, anotherId].find(id => prompt.includes(id));
    assertWorkspace(cwd, workspaces, id);
    if (id) {
      assert.equal(prompt, preparationPrompt({ host, mode: 'cli', preparationId: id }));
    } else {
      assert.match(prompt, /review the jobs queued for you/);
    }
  }
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
  await assert.rejects(readFile(result), { code: 'ENOENT' });
  await run('\n');
  assert.deepEqual(JSON.parse(await readFile(result, 'utf8')), { args: ['--cd', workspace, '--', prompt], cwd: await realpath(workspace) });
});

test('concurrent macOS CLI launches keep private self-removing scripts in their own workspaces', async t => {
  const calls = [];
  const descriptor = { available: true, mode: 'cli', label: 'Claude Code', reason: null,
    cli: { command: '/synthetic/claude', args: [] }, terminal: { command: '/usr/bin/open', args: ['-a', 'Terminal'] } };
  const { launcher, workspaces } = await harness(t, { platform: 'darwin', hostAvailable: undefined, discover: async () => descriptor,
    launchTerminal: async (...args) => calls.push(args) });
  assert.equal((await launcher.available()).claude, true);
  assert.deepEqual(calls, []);
  await Promise.all([
    launcher.open({ host: 'claude', preparationId }),
    launcher.open({ host: 'claude', preparationId: anotherId }),
    launcher.review({ host: 'claude' }),
    launcher.review({ host: 'claude' }),
  ]);
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls.map(call => call[2].cwd)).size, 4);
  for (const [command, args, options] of calls) {
    assert.equal(command, '/usr/bin/open');
    assert.deepEqual(args.slice(0, 2), ['-a', 'Terminal']);
    const filename = args[2];
    assert.match(filename, /launch-[\w-]+\.command$/);
    assert.equal(path.dirname(filename), options.cwd);
    assert.equal(path.dirname(options.cwd), workspaces);
    const source = await readFile(filename, 'utf8');
    assert.ok(source.includes('/bin/rm -f -- "$0"'));
    assert.ok(source.includes(`cd '${options.cwd}' || exit 1`));
    const id = [preparationId, anotherId].find(id => source.includes(id));
    assertWorkspace(options.cwd, workspaces, id);
    if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777, 0o700);
  }
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
  await assert.rejects(readFile(result), { code: 'ENOENT' });
  await run('\n');
  assert.deepEqual(JSON.parse(await readFile(result, 'utf8')), { args: ['--cd', workspace, '--', prompt], cwd: workspace });
});

test('a manual host is never opened: the request is returned for the user to paste', async t => {
  const launched = [];
  const { launcher, opened, checked, workspaces } = await harness(t, { manual: true, launchTerminal: async (...args) => { launched.push(args); },
    discover: async () => assert.fail('A container cannot look for apps on the host') });
  assert.deepEqual(await launcher.info(), { claude: { available: true, label: 'Claude', mode: 'manual', reason: null }, codex: { available: true, label: 'Codex', mode: 'manual', reason: null } });
  const prepared = await launcher.open({ host: 'claude', preparationId });
  assert.deepEqual({ ...prepared, prompt: undefined }, { opened: false, host: 'claude', requiresSend: true, mode: 'manual', prompt: undefined });
  assert.equal(prepared.prompt, preparationPrompt({ host: 'claude', mode: 'manual', preparationId }));
  // The fallback names what exists in a container: the setup prompt, not a Set up button.
  assert.match(prepared.prompt, /add recruiters\.rip with the setup prompt in Recruiters Companion Settings → AI apps, then start a new session/);
  assert.doesNotMatch(prepared.prompt, /choose Set up/);
  const review = await launcher.review({ host: 'codex' });
  assert.equal(review.mode, 'manual'); assert.match(review.prompt, /review the jobs queued for you/);
  assert.deepEqual([opened, launched, checked], [[], [], []]);
  await assert.rejects(stat(workspaces), { code: 'ENOENT' }, 'No host workspace is prepared for an app that cannot be opened');
});
