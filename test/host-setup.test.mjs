import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addClaudeDesktopServer, addedHosts, agentSetupPrompt, claudeExtensionInstalled, discoverHost, findHostCli, findChatGptCli, hostEnvironment,
  installChatGptPlugin, installClaudeSkill, liveSessions, mcpInvocation, settleRestartNotices } from '../src/host-setup.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'recruiters-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

for (const host of ['codex', 'claude']) test(`${host} discovers a Linux CLI and terminal without running inference`, async () => {
  const programs = new Set([`/home/synthetic/.local/bin/${host}`, '/usr/bin/gnome-terminal']);
  const calls = [];
  const info = await discoverHost(host, { platform: 'linux', home: '/home/synthetic', env: { PATH: '/usr/bin', DISPLAY: ':0' },
    canExecute: async file => programs.has(file), run: async (...args) => { calls.push(args); return { stdout: '' }; } });
  assert.equal(info.available, true);
  assert.equal(info.mode, 'cli');
  assert.equal(info.reason, null);
  assert.equal(info.cli.command, `/home/synthetic/.local/bin/${host}`);
  assert.deepEqual(info.terminal, { command: '/usr/bin/gnome-terminal', args: ['--'] });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['xdg-mime', ['query', 'default', `x-scheme-handler/${host === 'codex' ? 'codex' : 'claude'}`]]);
});

test('a CLI without a desktop terminal reports the actual blocker', async () => {
  const result = await discoverHost('codex', { platform: 'linux', env: { PATH: '/synthetic/bin' }, home: '/synthetic',
    canExecute: async file => file === '/synthetic/bin/codex', run: async () => ({ stdout: '' }) });
  assert.equal(result.available, false);
  assert.equal(result.mode, null);
  assert.match(result.reason, /terminal/);
});

test('unavailable Codex has no guessed or downloaded fallback', async () => {
  await assert.rejects(findChatGptCli({ platform: 'linux', env: {}, home: '/synthetic', canExecute: async () => false }), { code: 'HOST_UNAVAILABLE' });
});

test('Windows native CLI discovery respects platform PATH and per-user installation paths', async () => {
  const home = 'C:\\Users\\Zoë & Team';
  const file = path.win32.join(home, '.local', 'bin', 'claude.exe');
  assert.deepEqual(await findHostCli('claude', { platform: 'win32', home, env: { Path: 'C:\\Program Files\\Tools;relative' },
    canExecute: async candidate => candidate === file }), { command: file, args: [] });
});

test('Windows npm batch shims resolve to the official Node entrypoint without a shell', async () => {
  const directory = 'C:\\Users\\Zoë & Team\\AppData\\Roaming\\npm';
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const entry = path.win32.join(directory, 'node_modules', '@openai/codex/bin/codex.js');
  const cli = await findHostCli('codex', { platform: 'win32', home: 'C:\\Users\\Zoë & Team',
    env: { APPDATA: 'C:\\Users\\Zoë & Team\\AppData\\Roaming', PATH: 'C:\\Program Files\\nodejs' },
    canExecute: async file => [node, path.win32.join(directory, 'codex.cmd')].includes(file), fileExists: async file => file === entry });
  assert.deepEqual(cli, { command: node, args: [entry] });
  assert.equal(await findHostCli('codex', { platform: 'win32', home: 'C:\\synthetic', env: { PATH: directory },
    canExecute: async file => file.endsWith('.cmd'), fileExists: async () => false }), null);
});

test('Windows desktop detection requires a registered URL protocol and installed executable', async () => {
  const calls = [];
  const executable = 'C:\\Users\\Zoë\\AppData\\Local\\Claude\\Claude.exe';
  const options = { platform: 'win32', home: 'C:\\Users\\Zoë', env: { SystemRoot: 'C:\\Windows' },
    canExecute: async file => file === executable,
    run: async (command, args) => { calls.push({ command, args }); return { stdout: args.includes('/ve') ? `    (Default)    REG_SZ    "${executable}" "%1"\r\n` : 'URL Protocol REG_SZ' }; } };
  const info = await discoverHost('claude', options);
  assert.equal(info.mode, 'desktop');
  assert.equal(info.label, 'Claude Desktop');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, 'C:\\Windows\\System32\\reg.exe');
  const missing = await discoverHost('claude', { ...options, canExecute: async () => false });
  assert.equal(missing.available, false);
});

test('Linux desktop support requires a real MIME handler and executable', async t => {
  const root = await temporary(t);
  await mkdir(path.join(root, 'applications'));
  // The MIME entry models Linux even when its fixture file lives on Windows.
  const binary = '/opt/Claude résumé/claude';
  await writeFile(path.join(root, 'applications', 'claude.desktop'), `[Desktop Entry]\nType=Application\nName=Claude\nNoDisplay=true\nExec="${binary}" %u\n`);
  const options = { platform: 'linux', home: root, env: { XDG_DATA_HOME: root, XDG_DATA_DIRS: root, DISPLAY: ':0' },
    run: async () => ({ stdout: 'claude.desktop\n' }), canExecute: async file => file === binary };
  assert.equal((await discoverHost('claude', options)).mode, 'desktop');
  assert.equal((await discoverHost('claude', { ...options, canExecute: async () => false })).available, false);
});

test('MCP batch invocation keeps Unicode, shell metacharacters and percent signs in data', () => {
  const command = 'C:\\Users\\Zoë & 100% !\\mcp.cmd';
  const invocation = mcpInvocation(command, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } });
  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(invocation.args, ['/d', '/v:off', '/s', '/c', '%RECRUITERS_RIP_MCP_COMMAND%']);
  assert.deepEqual(invocation.env, { RECRUITERS_RIP_MCP_COMMAND: `"${command}"` });
  assert.throws(() => mcpInvocation('C:\\bad" & other.cmd', { platform: 'win32' }), { code: 'INVALID_INPUT' });
  assert.deepEqual(mcpInvocation('/home/Zoë & Team/mcp', { platform: 'linux' }), { command: '/home/Zoë & Team/mcp', args: [] });
});

test('an app counts as added only when its own config names an enabled recruiters.rip entry', async () => {
  const home = '/home/synthetic', workspace = '/profile/host-integration/application-workspace';
  const check = (files, options = {}) => addedHosts({ workspace, home, platform: 'darwin', env: {}, ...options,
    read: async file => { if (!Object.hasOwn(files, file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files[file]; },
    list: async directory => { const prefix = `${directory}/`; const entries = Object.keys(files).filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length).split('/')[0]); if (!entries.length) throw new Error('missing'); return entries; } });
  const codexConfig = `${home}/.codex/config.toml`, desktopConfig = `${home}/Library/Application Support/Claude/claude_desktop_config.json`;
  assert.deepEqual(await check({}), { codex: false, claude: false });
  assert.deepEqual(await check({ [codexConfig]: '[plugins."recruiters-rip@recruiters-rip"]\nenabled = true\n\n[plugins."other@x"]\nenabled = false\n' }), { codex: true, claude: false });
  assert.deepEqual(await check({ [codexConfig]: '[plugins."recruiters-rip@recruiters-rip"]\nenabled = false\n' }), { codex: false, claude: false });
  assert.deepEqual(await check({ [codexConfig]: '[mcp_servers.recruiters-rip]\ncommand = "/x"\n' }), { codex: true, claude: false });
  assert.deepEqual(await check({ '/codex-home/config.toml': '[mcp_servers.recruiters-rip]\ncommand = "/x"\n' }, { env: { CODEX_HOME: '/codex-home' } }), { codex: true, claude: false });
  assert.deepEqual(await check({ [`${workspace}/.codex/config.toml`]: '[mcp_servers.recruiters-rip-applications]\ncommand = "/x"\n' }), { codex: true, claude: false });
  assert.deepEqual(await check({ [desktopConfig]: JSON.stringify({ mcpServers: { 'recruiters-rip': { command: '/x' } } }) }), { codex: false, claude: true });
  assert.deepEqual(await check({ [`${home}/.claude.json`]: JSON.stringify({ mcpServers: { 'recruiters-rip': { command: '/x' } } }) }), { codex: false, claude: true });
  assert.deepEqual(await check({ [`${workspace}/.mcp.json`]: JSON.stringify({ mcpServers: { 'recruiters-rip-applications': { command: '/x' } } }) }), { codex: false, claude: true });
  // A Claude Desktop extension serves only Claude's Chat, not the Code tab that Continue in Claude opens.
  const extension = `${home}/Library/Application Support/Claude/Claude Extensions/local.mcpb.recruiters.recruiters-rip/manifest.json`;
  assert.deepEqual(await check({ [extension]: '{}' }), { codex: false, claude: false });
  const listing = directory => { const prefix = `${directory}/`; const entries = [extension].filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length).split('/')[0]); if (!entries.length) throw new Error('missing'); return entries; };
  assert.equal(await claudeExtensionInstalled({ home, platform: 'darwin', env: {}, list: async directory => listing(directory) }), true);
  assert.equal(await claudeExtensionInstalled({ home, platform: 'darwin', env: {}, list: async () => { throw new Error('missing'); } }), false);
  assert.deepEqual(await check({ [desktopConfig]: '{not json', [`${home}/.claude.json`]: JSON.stringify({ mcpServers: { other: {} }, projects: {} }) }), { codex: false, claude: false });
  // Windows and Linux read each app's documented config location.
  assert.deepEqual(await check({ 'C:\\Users\\Zoë\\AppData\\Roaming\\Claude\\claude_desktop_config.json': JSON.stringify({ mcpServers: { 'recruiters-rip': {} } }) },
    { platform: 'win32', home: 'C:\\Users\\Zoë', workspace: 'C:\\profile\\workspace', env: { APPDATA: 'C:\\Users\\Zoë\\AppData\\Roaming' } }), { codex: false, claude: true });
  assert.deepEqual(await check({ [`${home}/.config/Claude/claude_desktop_config.json`]: JSON.stringify({ mcpServers: { 'recruiters-rip': {} } }) }, { platform: 'linux' }), { codex: false, claude: true });
  // The local product only counts its own entries.
  const production = { [codexConfig]: '[plugins."recruiters-rip@recruiters-rip"]\n', [desktopConfig]: JSON.stringify({ mcpServers: { 'recruiters-rip': {} } }) };
  assert.deepEqual(await check(production, { localOnly: true }), { codex: false, claude: false });
  assert.deepEqual(await check({ [codexConfig]: '[plugins."recruiters-rip@recruiters-rip-local"]\n', [desktopConfig]: JSON.stringify({ mcpServers: { 'recruiters-rip-local': {} } }) }, { localOnly: true }), { codex: true, claude: true });
});

test('Claude Desktop Set up merges recruiters.rip into its config, keeps everything else and never rewrites an unreadable file', async t => {
  const home = await temporary(t), env = { APPDATA: path.join(home, 'Roaming'), XDG_CONFIG_HOME: path.join(home, 'config') };
  const directory = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude')
    : process.platform === 'win32' ? path.join(env.APPDATA, 'Claude') : path.join(env.XDG_CONFIG_HOME, 'Claude');
  const config = path.join(directory, 'claude_desktop_config.json'), command = path.join(home, 'device', 'recruiters-rip-mcp');
  const add = () => addClaudeDesktopServer({ command, home, env });
  // No file yet: Companion creates one with only its entry.
  assert.deepEqual(await add(), { changed: true });
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), { mcpServers: { 'recruiters-rip': { command, args: [] } } });
  // Other settings and servers stay; the previous file is kept beside it; a repeat Set up changes nothing.
  const previous = JSON.stringify({ globalShortcut: 'Alt+Space', mcpServers: { other: { command: '/other', args: ['-x'] } } });
  await writeFile(config, previous);
  assert.deepEqual(await add(), { changed: true });
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')),
    { globalShortcut: 'Alt+Space', mcpServers: { other: { command: '/other', args: ['-x'] }, 'recruiters-rip': { command, args: [] } } });
  assert.equal(await readFile(path.join(directory, 'claude_desktop_config.before-recruiters-rip.json'), 'utf8'), previous);
  assert.deepEqual(await add(), { changed: false });
  // A file that does not parse, or whose servers are not an object, is left byte-for-byte unchanged.
  for (const broken of ['{"mcpServers": {', JSON.stringify({ mcpServers: [] }), '[]']) {
    await writeFile(config, broken);
    await assert.rejects(add(), { code: 'HOST_INSTALL_FAILED', message: /isn’t valid JSON, so Companion left it unchanged/ });
    assert.equal(await readFile(config, 'utf8'), broken);
  }
});

test('the Claude skill installs into ~/.claude/skills and refreshes only an installed copy', async t => {
  const root = await temporary(t), source = path.join(root, 'plugin', 'skills', 'recruiters-rip'), home = path.join(root, 'home');
  await mkdir(path.join(source, 'agents'), { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: recruiters-rip\n---\nv1\n');
  await writeFile(path.join(source, 'agents', 'openai.yaml'), 'v1\n');
  const target = path.join(home, '.claude', 'skills', 'recruiters-rip');
  assert.equal(await installClaudeSkill({ source, home, env: {}, onlyIfPresent: true }), false);
  await assert.rejects(stat(target), { code: 'ENOENT' });
  assert.equal(await installClaudeSkill({ source, home, env: {} }), true);
  assert.equal(await readFile(path.join(target, 'SKILL.md'), 'utf8'), '---\nname: recruiters-rip\n---\nv1\n');
  // A Companion update replaces the whole folder, dropping files the new skill no longer has.
  await writeFile(path.join(target, 'stale.md'), 'old');
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: recruiters-rip\n---\nv2\n');
  assert.equal(await installClaudeSkill({ source, home, env: {}, onlyIfPresent: true }), true);
  assert.equal(await readFile(path.join(target, 'SKILL.md'), 'utf8'), '---\nname: recruiters-rip\n---\nv2\n');
  await assert.rejects(stat(path.join(target, 'stale.md')), { code: 'ENOENT' });
  // CLAUDE_CONFIG_DIR moves Claude Code's personal folder.
  assert.equal(await installClaudeSkill({ source, home, env: { CLAUDE_CONFIG_DIR: path.join(root, 'claude-config') } }), true);
  assert.ok((await stat(path.join(root, 'claude-config', 'skills', 'recruiters-rip', 'SKILL.md'))).isFile());
});

test('only Claude Code sessions make Claude “In use now”; Claude chat and Cowork sessions are named instead', () => {
  assert.deepEqual(liveSessions(['claude-code', 'codex-mcp-client']), { live: { codex: true, claude: true }, other: [] });
  assert.deepEqual(liveSessions(['claude-ai', 'local-agent-mode-recruiters-rip', '']), { live: { codex: false, claude: false }, other: ['Claude chat'] });
  assert.deepEqual(liveSessions(['cursor-vscode']), { live: { codex: false, claude: false }, other: ['cursor-vscode'] });
});

test('the restart notice after Set up stays until that app opens a new session', () => {
  // Set up while Claude Code already has a session: that old session does not clear the notice.
  let state = settleRestartNotices({ codex: false, claude: true }, { codex: 0, claude: 1 }, ['claude-code']);
  assert.deepEqual(state.pending, { codex: false, claude: true });
  // Claude's chat reconnecting after a restart is not the Code session Continue opens.
  state = settleRestartNotices(state.pending, state.counts, ['claude-code', 'claude-ai']);
  assert.equal(state.pending.claude, true);
  // The old session ends, then a new one starts: the notice clears.
  state = settleRestartNotices(state.pending, state.counts, ['claude-ai']);
  assert.equal(state.pending.claude, true);
  state = settleRestartNotices(state.pending, state.counts, ['claude-ai', 'claude-code']);
  assert.deepEqual(state.pending, { codex: false, claude: false });
  // Codex follows the same rule.
  state = settleRestartNotices({ codex: true, claude: false }, { codex: 0, claude: 0 }, ['codex-mcp-client']);
  assert.deepEqual(state.pending, { codex: false, claude: false });
});

test('the agent setup prompt names exact commands and files with this computer’s launcher', () => {
  const command = "/Users/Zoë/Library/Application Support/Recruiters Companion/device/it's-mcp";
  const prompt = agentSetupPrompt(command, { platform: 'darwin' });
  assert.ok(prompt.includes(`codex mcp add recruiters-rip -- '/Users/Zoë/Library/Application Support/Recruiters Companion/device/it'\\''s-mcp'`));
  assert.ok(prompt.includes(`claude mcp add --scope user recruiters-rip -- '/Users/Zoë/Library/Application Support/Recruiters Companion/device/it'\\''s-mcp'`));
  assert.ok(prompt.includes(`[mcp_servers.recruiters-rip]\ncommand = ${JSON.stringify(command)}\nargs = []`));
  assert.ok(prompt.includes('~/Library/Application Support/Claude/claude_desktop_config.json'));
  assert.deepEqual(JSON.parse(`{${prompt.split('\n').find(line => line.startsWith('"recruiters-rip": '))}}`), { 'recruiters-rip': { command, args: [] } });
  assert.ok(prompt.includes('career_profile_read'));
  assert.ok(agentSetupPrompt('/home/z/mcp', { platform: 'linux' }).includes('~/.config/Claude/claude_desktop_config.json'));
  assert.ok(agentSetupPrompt('/home/z/mcp', { platform: 'linux', localOnly: true }).includes("codex mcp add recruiters-rip-local -- '/home/z/mcp'"));
  // Windows runs the .cmd launcher through cmd.exe, so the prompt gives config entries rather than shell one-liners.
  const windowsCommand = 'C:\\Users\\Zoë\\AppData\\Roaming\\Recruiters Companion\\device\\recruiters-rip-mcp.cmd', env = { SystemRoot: 'C:\\Windows' };
  const windows = agentSetupPrompt(windowsCommand, { platform: 'win32', env });
  assert.equal(/codex mcp add|claude mcp add/.test(windows), false);
  assert.ok(windows.includes('%APPDATA%\\Claude\\claude_desktop_config.json'));
  assert.ok(windows.includes('%USERPROFILE%\\.codex\\config.toml'));
  assert.ok(windows.includes('%USERPROFILE%\\.claude.json'));
  assert.deepEqual(JSON.parse(`{${windows.split('\n').find(line => line.startsWith('"recruiters-rip": '))}}`)['recruiters-rip'], mcpInvocation(windowsCommand, { platform: 'win32', env }));
});

test('host subprocesses receive OS/session paths but never inherited provider keys or Node injection', () => {
  assert.deepEqual(hostEnvironment({ Path: 'C:\\Tools', SystemRoot: 'C:\\Windows', HOME: '/synthetic', DISPLAY: ':0',
    OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', NODE_OPTIONS: '--require inject.js', ELECTRON_RUN_AS_NODE: '1' }),
  { Path: 'C:\\Tools', SystemRoot: 'C:\\Windows', HOME: '/synthetic', DISPLAY: ':0' });
});

for (const localOnly of [false, true]) test(`Codex plugin installation preserves unrelated registrations (${localOnly ? 'local' : 'production'})`, async t => {
  const root = await temporary(t), directory = path.join(root, 'Career résumé & tools');
  const generated = path.join(root, 'src', 'generated', 'recruiters-rip-plugin');
  await mkdir(generated, { recursive: true });
  await writeFile(path.join(generated, 'plugin.json'), '{"name":"synthetic"}\n');
  await mkdir(directory);
  const command = path.join(directory, 'recruiters-rip-mcp');
  const calls = [];
  const result = await installChatGptPlugin({ directory, root, command, localOnly, platform: 'linux',
    env: { PATH: '/synthetic/bin', HOME: root, OPENAI_API_KEY: 'do-not-pass' },
    findCli: async () => ({ command: '/synthetic/codex', args: [] }),
    runCommand: async (file, args, options) => {
      calls.push({ file, args, options });
      if (args.includes('--help')) return { stdout: 'Commands: add marketplace remove list' };
      if (args[0] === 'mcp') return { stdout: JSON.stringify({ transport: { command: '/unrelated/user-server' } }) };
      return { stdout: '{"installed":true}' };
    } });
  assert.equal(result.installed, true);
  assert.equal(result.plugin, `recruiters-rip@recruiters-rip${localOnly ? '-local' : ''}`);
  assert.deepEqual(calls[0].args, ['plugin', '--help']);
  assert.deepEqual(calls[1].args, ['plugin', 'marketplace', 'add', path.join(directory, 'host-integration'), '--json']);
  assert.equal(calls.some(call => call.args.includes('remove')), false);
  assert.equal(calls.some(call => call.options.env.OPENAI_API_KEY), false);
  const config = JSON.parse(await readFile(path.join(directory, 'host-integration/plugins/recruiters-rip/.mcp.json'), 'utf8'));
  assert.deepEqual(config.mcpServers['recruiters-rip'], { command, args: [] });
});

test('an older CLI fails on help before installation or generated config changes', async t => {
  const root = await temporary(t), directory = path.join(root, 'new-config');
  const calls = [];
  await assert.rejects(installChatGptPlugin({ directory, root, command: path.join(root, 'mcp'),
    findCli: async () => ({ command: '/synthetic/codex', args: [] }),
    runCommand: async (file, args) => { calls.push(args); return { stdout: 'Unknown command plugin' }; } }), { code: 'HOST_INSTALL_FAILED' });
  assert.deepEqual(calls, [['plugin', '--help']]);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('native registered Store handlers are discovered without guessing an executable path', async () => {
  const schemes = [];
  const info = await discoverHost('codex', { platform: 'win32', env: {}, home: 'C:\\synthetic',
    protocolAvailable: async scheme => { schemes.push(scheme); return true; },
    run: async () => { throw new Error('Registry fallback must not run'); } });
  assert.equal(info.mode, 'desktop');
  assert.deepEqual(schemes, ['codex']);
});

test('Windows batch MCP launcher executes literal special-character paths without shell injection', { skip: process.platform !== 'win32' }, async t => {
  const root = await temporary(t);
  const folder = path.join(root, 'Zoë & %PATH% !literal!');
  await mkdir(folder);
  const command = path.join(folder, 'mcp.cmd');
  const output = path.join(root, 'result.txt');
  await writeFile(command, '@echo off\r\nsetlocal DisableDelayedExpansion\r\necho literal-launch>"%SYNTHETIC_OUTPUT%"\r\n');
  const invocation = mcpInvocation(command);
  await promisify(execFile)(invocation.command, invocation.args, { env: { ...process.env, ...invocation.env, SYNTHETIC_OUTPUT: output }, timeout: 10000 });
  assert.equal((await readFile(output, 'utf8')).trim(), 'literal-launch');
});
