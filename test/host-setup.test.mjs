import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, cp, rename, readdir, open, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addClaudeCodeServer, addClaudeDesktopServer, addedHosts, agentSetupPrompt, claudeExtensionInstalled, discoverHost, findHostCli, findChatGptCli, hostEnvironment,
  installChatGptPlugin, installClaudeSkill, liveSessions, mcpInvocation, mcpServerToml, refreshInstalledHostSkills, settleRestartNotices } from '../src/host-setup.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'recruiters-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function swapAfterHandleStat(t, filename, replacement) {
  const replacementHandle = await open(replacement, 'r');
  t.after(() => replacementHandle.close());
  const replacementInfo = await replacementHandle.stat(), replacementBytes = await replacementHandle.readFile();
  const probe = await open(filename, 'r');
  const selected = await probe.stat(), prototype = Object.getPrototypeOf(probe);
  const selectedBytes = await probe.readFile();
  await probe.close();
  const original = prototype.stat;
  let swapped = false;
  t.mock.method(prototype, 'stat', async function (...args) {
    const info = await original.apply(this, args);
    if (!swapped && info.dev === selected.dev && info.ino === selected.ino) {
      // Windows cannot replace an open destination, but can move its name aside.
      // Keep the retained inode outside either compared tree until fixture cleanup.
      const retained = `${replacement}.retained`;
      await rename(filename, retained);
      try { await rename(replacement, filename); }
      catch (error) { await rename(retained, filename); throw error; }
      const current = await open(filename, 'r');
      try {
        const installed = await original.call(current), retainedInfo = await original.call(this);
        assert.ok(installed.dev !== selected.dev || installed.ino !== selected.ino, 'pathname must identify the replacement');
        assert.deepEqual([installed.dev, installed.ino], [replacementInfo.dev, replacementInfo.ino], 'pathname must identify the prepared replacement file');
        assert.deepEqual([retainedInfo.dev, retainedInfo.ino], [selected.dev, selected.ino], 'production descriptor must retain the original file');
        assert.deepEqual(await current.readFile(), replacementBytes);
        // Positional reads leave the production descriptor's read offset untouched.
        const bytes = Buffer.alloc(selectedBytes.length);
        assert.equal((await this.read(bytes, 0, bytes.length, 0)).bytesRead, bytes.length);
        assert.deepEqual(bytes, selectedBytes);
      } finally { await current.close(); }
      swapped = true;
    }
    return info;
  });
  return () => swapped;
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

test('Linux desktop quoted executables preserve escapes and reject an unterminated escape-heavy command', { timeout: 10000 }, async t => {
  const root = await temporary(t), entry = path.join(root, 'applications', 'claude.desktop');
  await mkdir(path.dirname(entry));
  const binary = '/opt/Claude "quoted" \\ résumé/claude';
  const encoded = binary.replace(/["\\`$]/g, '\\$&');
  const options = { platform: 'linux', home: root, env: { XDG_DATA_HOME: root, XDG_DATA_DIRS: root, DISPLAY: ':0' },
    run: async () => ({ stdout: 'claude.desktop\n' }), canExecute: async file => file === binary };
  await writeFile(entry, `[Desktop Entry]\nType=Application\nTryExec="${encoded}"\n`);
  assert.equal((await discoverHost('claude', options)).mode, 'desktop');
  await writeFile(entry, `[Desktop Entry]\nType=Application\nExec="${'\\!'.repeat(4096)}\n`);
  // A child deadline also bounds a regression that blocks the JavaScript event loop.
  const script = `
    import assert from 'node:assert/strict';
    import { discoverHost } from ${JSON.stringify(new URL('../src/host-setup.mjs', import.meta.url).href)};
    const info = await discoverHost('claude', {
      platform: 'linux', home: ${JSON.stringify(root)}, env: ${JSON.stringify(options.env)},
      run: async () => ({ stdout: 'claude.desktop\\n' }), canExecute: async () => false,
    });
    assert.equal(info.available, false);
  `;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000 });
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

test('Windows TOML preserves literal batch path in an env value, not shell code', () => {
  const command = "C:\\Users\\A & B\\résumé 100% !\\mcp.cmd";
  const toml = mcpServerToml('recruiters-rip', command, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } });
  assert.ok(toml.includes('command = "C:\\\\Windows\\\\System32\\\\cmd.exe"'));
  assert.ok(toml.includes('[mcp_servers.recruiters-rip.env]'));
  assert.ok(toml.includes(`RECRUITERS_RIP_MCP_COMMAND = ${JSON.stringify(`"${command}"`)}\n`));
});

test('Claude Code Set up replaces only its own user-scoped entry through the official CLI', async () => {
  const calls = [];
  const cli = { command: '/synthetic/node', args: ['/synthetic/claude/cli.js'] };
  const runCommand = async (command, args, options) => {
    calls.push([command, args, options.env.OPENAI_API_KEY]);
    if (args.includes('remove')) throw new Error('No user-scoped MCP server named recruiters-rip');
    return { stdout: '' };
  };
  assert.deepEqual(await addClaudeCodeServer({ cli, command: '/profile/recruiters mcp', platform: 'linux', env: { PATH: '/usr/bin', OPENAI_API_KEY: 'secret' }, runCommand }), { changed: true });
  assert.deepEqual(calls, [
    ['/synthetic/node', ['/synthetic/claude/cli.js', 'mcp', 'remove', '--scope', 'user', 'recruiters-rip'], undefined],
    ['/synthetic/node', ['/synthetic/claude/cli.js', 'mcp', 'add-json', '--scope', 'user', 'recruiters-rip', JSON.stringify({ type: 'stdio', command: '/profile/recruiters mcp', args: [] })], undefined],
  ]);
  await assert.rejects(addClaudeCodeServer({ cli, command: '/x', localOnly: true, platform: 'linux', env: {}, runCommand: async (_c, args) => { calls.push(args); throw new Error('old CLI'); } }),
    { code: 'HOST_INSTALL_FAILED' });
  assert.equal(calls.at(-1).at(-2), 'recruiters-rip-local');
});

test('an app counts as added only when its own config names an enabled recruiters.rip entry', async () => {
  const home = '/home/synthetic';
  const check = (files, options = {}) => addedHosts({ home, platform: 'darwin', env: {}, ...options,
    read: async file => { if (!Object.hasOwn(files, file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files[file]; },
    list: async directory => { const prefix = `${directory}/`; const entries = Object.keys(files).filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length).split('/')[0]); if (!entries.length) throw new Error('missing'); return entries; } });
  const codexConfig = `${home}/.codex/config.toml`, desktopConfig = `${home}/Library/Application Support/Claude/claude_desktop_config.json`;
  assert.deepEqual(await check({}), { codex: false, claude: false });
  assert.deepEqual(await check({ [codexConfig]: '[plugins."recruiters-rip@recruiters-rip"]\nenabled = true\n\n[plugins."other@x"]\nenabled = false\n' }), { codex: true, claude: false });
  assert.deepEqual(await check({ [codexConfig]: '[plugins."recruiters-rip@recruiters-rip"]\nenabled = false\n' }), { codex: false, claude: false });
  assert.deepEqual(await check({ [codexConfig]: '[mcp_servers.recruiters-rip]\ncommand = "/x"\n' }), { codex: true, claude: false });
  assert.deepEqual(await check({ '/codex-home/config.toml': '[mcp_servers.recruiters-rip]\ncommand = "/x"\n' }, { env: { CODEX_HOME: '/codex-home' } }), { codex: true, claude: false });
  // A workspace-scoped server (written by Companion 3.12.14 and earlier) is not loaded without approval, so it never counts.
  assert.deepEqual(await check({ '/profile/host-integration/application-workspace/.codex/config.toml': '[mcp_servers.recruiters-rip-applications]\ncommand = "/x"\n',
    '/profile/host-integration/application-workspace/.mcp.json': JSON.stringify({ mcpServers: { 'recruiters-rip-applications': { command: '/x' } } }) }), { codex: false, claude: false });
  assert.deepEqual(await check({ [desktopConfig]: JSON.stringify({ mcpServers: { 'recruiters-rip': { command: '/x' } } }) }), { codex: false, claude: true });
  assert.deepEqual(await check({ [`${home}/.claude.json`]: JSON.stringify({ mcpServers: { 'recruiters-rip': { command: '/x' } } }) }), { codex: false, claude: true });
  // A Claude Desktop extension serves only Claude's Chat, not the Code tab that Continue in Claude opens.
  const extension = `${home}/Library/Application Support/Claude/Claude Extensions/local.mcpb.recruiters.recruiters-rip/manifest.json`;
  assert.deepEqual(await check({ [extension]: '{}' }), { codex: false, claude: false });
  const listing = directory => { const prefix = `${directory}/`; const entries = [extension].filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length).split('/')[0]); if (!entries.length) throw new Error('missing'); return entries; };
  assert.equal(await claudeExtensionInstalled({ home, platform: 'darwin', env: {}, list: async directory => listing(directory) }), true);
  assert.equal(await claudeExtensionInstalled({ home, platform: 'darwin', env: {}, list: async () => { throw new Error('missing'); } }), false);
  assert.deepEqual(await check({ [desktopConfig]: '{not json', [`${home}/.claude.json`]: JSON.stringify({ mcpServers: { other: {} }, projects: {} }) }), { codex: false, claude: false });
  // Windows and Linux read each app's documented config location.
  assert.deepEqual(await check({ 'C:\\Users\\Zoë\\AppData\\Roaming\\Claude\\claude_desktop_config.json': JSON.stringify({ mcpServers: { 'recruiters-rip': {} } }) },
    { platform: 'win32', home: 'C:\\Users\\Zoë', env: { APPDATA: 'C:\\Users\\Zoë\\AppData\\Roaming' } }), { codex: false, claude: true });
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

for (const selected of ['source', 'target']) test(`Claude skill comparison reads the inspected ${selected} handle after a path replacement`, async t => {
  const root = await temporary(t), source = path.join(root, 'source'), home = path.join(root, 'home');
  await mkdir(source);
  await writeFile(path.join(source, 'SKILL.md'), 'selected bytes\n');
  const options = { source, home, env: {} };
  await installClaudeSkill(options);
  const target = path.join(home, '.claude', 'skills', 'recruiters-rip');
  const filename = path.join(selected === 'source' ? source : target, 'SKILL.md');
  const replacement = path.join(root, 'replacement');
  await writeFile(replacement, 'replacement bytes\n');
  const swapped = await swapAfterHandleStat(t, filename, replacement);
  assert.equal(await installClaudeSkill(options), false);
  assert.equal(swapped(), true);
  assert.equal(await installClaudeSkill(options), true);
  assert.equal(await readFile(path.join(target, 'SKILL.md'), 'utf8'), selected === 'source' ? 'replacement bytes\n' : 'selected bytes\n');
});

test('Claude skill comparison replaces linked installed files without touching their targets', { skip: process.platform === 'win32' }, async t => {
  const root = await temporary(t), source = path.join(root, 'source'), home = path.join(root, 'home');
  await mkdir(source);
  await writeFile(path.join(source, 'SKILL.md'), 'current skill\n');
  const options = { source, home, env: {} };
  await installClaudeSkill(options);
  const target = path.join(home, '.claude', 'skills', 'recruiters-rip', 'SKILL.md'), outside = path.join(root, 'outside');
  await writeFile(outside, 'current skill\n');
  await rm(target);
  await symlink(outside, target);
  assert.equal(await installClaudeSkill(options), true);
  assert.equal(await readFile(target, 'utf8'), 'current skill\n');
  assert.equal(await readFile(outside, 'utf8'), 'current skill\n');
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

async function refreshFixture(t, { localOnly = false } = {}) {
  const root = await temporary(t), home = path.join(root, 'home'), directory = path.join(root, 'device');
  const env = { HOME: home, CODEX_HOME: path.join(root, 'custom-codex'), CLAUDE_CONFIG_DIR: path.join(root, 'custom-claude') };
  const generated = path.join(root, 'src', 'generated', 'recruiters-rip-plugin');
  const skill = path.join(generated, 'skills', 'recruiters-rip');
  const claude = path.join(env.CLAUDE_CONFIG_DIR, 'skills', 'recruiters-rip');
  const name = localOnly ? 'recruiters-rip-local' : 'recruiters-rip';
  const cache = path.join(env.CODEX_HOME, 'plugins', 'cache', name, 'recruiters-rip');
  const personal = path.join(home, '.agents', 'skills', 'recruiters-rip');
  const config = path.join(env.CODEX_HOME, 'config.toml'), calls = [];
  await mkdir(path.join(generated, '.codex-plugin'), { recursive: true });
  await mkdir(path.join(skill, 'resources'), { recursive: true });
  await mkdir(env.CODEX_HOME, { recursive: true });
  await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true });
  await writeFile(path.join(generated, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'recruiters-rip', version: '1.0.0', skills: './skills/' }));
  await writeFile(path.join(skill, 'SKILL.md'), 'Current skill\n');
  await writeFile(path.join(skill, 'resources', 'guide.txt'), 'Current resource\n');
  const command = path.join(directory, 'recruiters-rip-mcp');
  const options = { directory, root, home, env, localOnly, command, claudeSource: skill,
    findCli: async () => ({ command: '/synthetic/codex', args: [] }),
    runCommand: async (_command, args, options) => {
      calls.push({ args, options });
      if (args[1] === 'marketplace') return { stdout: JSON.stringify({ marketplaceName: name }) };
      assert.deepEqual(args, ['plugin', 'add', `recruiters-rip@${name}`, '--json']);
      const plugin = path.join(directory, 'host-integration', 'plugins', 'recruiters-rip');
      const manifest = JSON.parse(await readFile(path.join(plugin, '.codex-plugin', 'plugin.json'), 'utf8'));
      const installedPath = path.join(cache, manifest.version);
      // Model the observed host CLI: re-add replaces even the same-version cache,
      // and a newer install removes the earlier version directory.
      await rm(cache, { recursive: true, force: true });
      await mkdir(cache, { recursive: true });
      await cp(plugin, installedPath, { recursive: true });
      return { stdout: JSON.stringify({ pluginId: `recruiters-rip@${name}`, installedPath }) };
    } };
  return { ...options, options, generated, skill, claude, cache, personal, config, calls, name,
    refresh: overrides => refreshInstalledHostSkills({ ...options, ...overrides }),
    registerClaude: () => writeFile(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'),
      JSON.stringify({ mcpServers: { [name]: { command }, other: { command: '/other' } }, permissions: { keep: true } })),
    registerCodex: (enabled = true) => writeFile(config,
      `approval_policy = "on-request"\nsandbox_mode = "read-only"\n[plugins."recruiters-rip@${name}"]\nenabled = ${enabled}\n[plugins."other@elsewhere"]\nenabled = false\n[mcp_servers.other]\ncommand = "/other"\n`) };
}

test('Codex generated MCP comparison reads the inspected handle after a path replacement', async t => {
  const fixture = await refreshFixture(t);
  await fixture.registerCodex();
  assert.deepEqual((await fixture.refresh()).errors, []);
  const filename = path.join(fixture.directory, 'host-integration', 'plugins', 'recruiters-rip', '.mcp.json');
  const selected = await readFile(filename, 'utf8'), replacement = path.join(fixture.root, 'replacement.json');
  await writeFile(replacement, '{"replacement":true}');
  const swapped = await swapAfterHandleStat(t, filename, replacement);
  const calls = fixture.calls.length;
  assert.deepEqual((await fixture.refresh()).errors, []);
  assert.equal(swapped(), true);
  assert.equal(fixture.calls.length, calls);
  assert.deepEqual((await fixture.refresh()).errors, []);
  assert.equal(await readFile(filename, 'utf8'), selected);
  assert.ok(fixture.calls.length > calls);
});

test('boot skips unconfigured hosts without creating settings or skills', async t => {
  const fixture = await refreshFixture(t);
  assert.deepEqual(await fixture.refresh(), { updated: { claude: false, codex: false }, errors: [] });
  for (const filename of [fixture.claude, fixture.cache, fixture.personal, fixture.config, fixture.directory])
    await assert.rejects(stat(filename), { code: 'ENOENT' });
  assert.equal(fixture.calls.length, 0);
});

test('boot repairs registered missing host skills and refreshes actual cache and nested resources', async t => {
  const fixture = await refreshFixture(t);
  await fixture.registerClaude();
  await fixture.registerCodex();
  const configBefore = await readFile(fixture.config, 'utf8');
  const claudeConfig = path.join(fixture.env.CLAUDE_CONFIG_DIR, '.claude.json');
  const claudeBefore = await readFile(claudeConfig, 'utf8');
  assert.deepEqual(await fixture.refresh(), { updated: { claude: true, codex: true }, errors: [] });
  const cached = path.join(fixture.cache, '1.0.0', 'skills', 'recruiters-rip');
  for (const target of [fixture.claude, cached]) {
    assert.equal(await readFile(path.join(target, 'SKILL.md'), 'utf8'), 'Current skill\n');
    await mkdir(path.join(target, 'resources', 'obsolete'), { recursive: true });
    await writeFile(path.join(target, 'resources', 'obsolete', 'old.txt'), 'Remove me');
  }
  await writeFile(path.join(fixture.skill, 'SKILL.md'), 'Changed without a version bump\n');
  assert.deepEqual(await fixture.refresh(), { updated: { claude: true, codex: true }, errors: [] });
  for (const target of [fixture.claude, cached]) {
    assert.equal(await readFile(path.join(target, 'SKILL.md'), 'utf8'), 'Changed without a version bump\n');
    assert.equal(await readFile(path.join(target, 'resources', 'guide.txt'), 'utf8'), 'Current resource\n');
    await assert.rejects(stat(path.join(target, 'resources', 'obsolete')), { code: 'ENOENT' });
  }
  assert.equal(await readFile(fixture.config, 'utf8'), configBefore);
  assert.equal(await readFile(claudeConfig, 'utf8'), claudeBefore);
  await assert.rejects(stat(fixture.personal), { code: 'ENOENT' });
  const callsBefore = fixture.calls.length, modifiedBefore = (await stat(path.join(fixture.claude, 'SKILL.md'))).mtimeMs;
  assert.deepEqual(await fixture.refresh(), { updated: { claude: false, codex: false }, errors: [] });
  assert.equal(fixture.calls.length, callsBefore);
  assert.equal((await stat(path.join(fixture.claude, 'SKILL.md'))).mtimeMs, modifiedBefore);
  // A damaged loaded cache is detected even when Companion's source copy is current.
  await rm(path.join(cached, 'SKILL.md'));
  assert.deepEqual((await fixture.refresh()).updated, { claude: false, codex: true });
  assert.equal(await readFile(path.join(cached, 'SKILL.md'), 'utf8'), 'Changed without a version bump\n');
});

test('boot follows current packaged/source plugin version rather than an older installation', async t => {
  const fixture = await refreshFixture(t);
  await fixture.registerCodex();
  await fixture.refresh();
  const nextRoot = path.join(fixture.root, 'next-app.asar.unpacked');
  const nextPlugin = path.join(nextRoot, 'src', 'generated', 'recruiters-rip-plugin');
  await cp(fixture.generated, nextPlugin, { recursive: true });
  await writeFile(path.join(nextPlugin, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'recruiters-rip', version: '2.0.0', skills: './skills/' }));
  await writeFile(path.join(nextPlugin, 'skills', 'recruiters-rip', 'SKILL.md'), 'New installed app\n');
  assert.deepEqual(await fixture.refresh({ root: nextRoot, claudeSource: path.join(nextPlugin, 'skills', 'recruiters-rip') }),
    { updated: { claude: false, codex: true }, errors: [] });
  assert.equal(await readFile(path.join(fixture.cache, '2.0.0', 'skills', 'recruiters-rip', 'SKILL.md'), 'utf8'), 'New installed app\n');
  await assert.rejects(stat(path.join(fixture.cache, '1.0.0')), { code: 'ENOENT' });
});

test('disabled Codex plugins refresh cached skills without touching versions, settings or the CLI', async t => {
  const fixture = await refreshFixture(t);
  await fixture.registerCodex();
  await fixture.refresh();
  await fixture.registerCodex(false);
  const configBefore = await readFile(fixture.config, 'utf8');
  const manifest = path.join(fixture.cache, '1.0.0', '.codex-plugin', 'plugin.json');
  const manifestBefore = await readFile(manifest, 'utf8'), callsBefore = fixture.calls.length;
  await writeFile(path.join(fixture.generated, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'recruiters-rip', version: '2.0.0' }));
  await writeFile(path.join(fixture.skill, 'SKILL.md'), 'Updated while disabled\n');
  assert.deepEqual(await fixture.refresh(), { updated: { claude: false, codex: true }, errors: [] });
  assert.equal(await readFile(path.join(fixture.cache, '1.0.0', 'skills', 'recruiters-rip', 'SKILL.md'), 'utf8'), 'Updated while disabled\n');
  assert.equal(await readFile(manifest, 'utf8'), manifestBefore);
  assert.equal(await readFile(fixture.config, 'utf8'), configBefore);
  assert.equal(fixture.calls.length, callsBefore);
  assert.deepEqual((await fixture.refresh()).updated, { claude: false, codex: false });
});

test('standalone Codex MCP gains a personal skill without converting its setup to a plugin', async t => {
  const fixture = await refreshFixture(t);
  await writeFile(fixture.config, '[mcp_servers.recruiters-rip]\ncommand = "/keep-this-command"\n');
  const previous = await readFile(fixture.config, 'utf8');
  assert.deepEqual(await fixture.refresh(), { updated: { claude: false, codex: true }, errors: [] });
  assert.equal(await readFile(path.join(fixture.personal, 'SKILL.md'), 'utf8'), 'Current skill\n');
  assert.equal(await readFile(fixture.config, 'utf8'), previous);
  assert.equal(fixture.calls.length, 0);
  await assert.rejects(stat(fixture.cache), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(fixture.env.CODEX_HOME, 'skills')), { code: 'ENOENT' });
});

test('local boot does not take over production registrations or shared personal skills', async t => {
  const fixture = await refreshFixture(t, { localOnly: true });
  await writeFile(fixture.config, '[plugins."recruiters-rip@recruiters-rip"]\nenabled = true\n');
  await writeFile(path.join(fixture.env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ mcpServers: { 'recruiters-rip': {} } }));
  for (const target of [fixture.claude, fixture.personal]) {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'SKILL.md'), 'Production skill\n');
  }
  assert.deepEqual(await fixture.refresh(), { updated: { claude: false, codex: false }, errors: [] });
  for (const target of [fixture.claude, fixture.personal]) assert.equal(await readFile(path.join(target, 'SKILL.md'), 'utf8'), 'Production skill\n');
  assert.equal(fixture.calls.length, 0);
  await fixture.registerClaude();
  await fixture.registerCodex();
  assert.deepEqual(await fixture.refresh(), { updated: { claude: true, codex: true }, errors: [] });
  assert.equal(await readFile(path.join(fixture.cache, '1.0.0', 'skills', 'recruiters-rip', 'SKILL.md'), 'utf8'), 'Current skill\n');
  assert.equal(fixture.calls.at(-1).args[2], 'recruiters-rip@recruiters-rip-local');
});

test('a failed Claude directory swap restores the old skill and never prevents Codex refresh', async t => {
  const fixture = await refreshFixture(t);
  await fixture.registerClaude();
  await fixture.registerCodex();
  await mkdir(fixture.claude, { recursive: true });
  await writeFile(path.join(fixture.claude, 'SKILL.md'), 'Retained skill\n');
  const result = await fixture.refresh({ moveDirectory: async (from, to) => {
    if (from.endsWith('.tmp') && to === fixture.claude) throw Object.assign(new Error('Synthetic locked folder'), { code: 'EACCES' });
    await rename(from, to);
  } });
  assert.deepEqual(result.updated, { claude: false, codex: true });
  assert.deepEqual(result.errors.map(error => error.host), ['claude']);
  assert.equal(await readFile(path.join(fixture.claude, 'SKILL.md'), 'utf8'), 'Retained skill\n');
  assert.deepEqual(await readdir(path.dirname(fixture.claude)), ['recruiters-rip']);
  assert.deepEqual(await fixture.refresh(), { updated: { claude: true, codex: false }, errors: [] });
});

test('failed Codex refresh keeps old loaded files, retries next boot and does not block Claude', async t => {
  const fixture = await refreshFixture(t);
  await fixture.registerClaude();
  await fixture.registerCodex();
  await fixture.refresh();
  await writeFile(path.join(fixture.skill, 'SKILL.md'), 'Next skill\n');
  const configBefore = await readFile(fixture.config, 'utf8');
  const failed = await fixture.refresh({ runCommand: async () => { throw new Error('Synthetic unavailable CLI'); } });
  assert.deepEqual(failed.updated, { claude: true, codex: false });
  assert.deepEqual(failed.errors.map(error => error.host), ['codex']);
  assert.equal(await readFile(path.join(fixture.cache, '1.0.0', 'skills', 'recruiters-rip', 'SKILL.md'), 'utf8'), 'Current skill\n');
  assert.equal(await readFile(fixture.config, 'utf8'), configBefore);
  assert.deepEqual(await fixture.refresh(), { updated: { claude: false, codex: true }, errors: [] });
  assert.equal(await readFile(path.join(fixture.cache, '1.0.0', 'skills', 'recruiters-rip', 'SKILL.md'), 'utf8'), 'Next skill\n');
});

test('registered disabled plugin with a missing cache is repaired without enabling it', async t => {
  const fixture = await refreshFixture(t);
  await fixture.registerCodex(false);
  const before = await readFile(fixture.config, 'utf8');
  assert.deepEqual(await fixture.refresh(), { updated: { claude: false, codex: true }, errors: [] });
  assert.equal(await readFile(path.join(fixture.cache, '1.0.0', 'skills', 'recruiters-rip', 'SKILL.md'), 'utf8'), 'Current skill\n');
  assert.equal(await readFile(fixture.config, 'utf8'), before);
  assert.equal(fixture.calls.length, 0);
});

test('existing personal skill copies refresh without requiring registrations or creating duplicates', async t => {
  const fixture = await refreshFixture(t), legacy = path.join(fixture.env.CODEX_HOME, 'skills', 'recruiters-rip');
  for (const target of [fixture.claude, legacy]) {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'SKILL.md'), 'Old installed skill\n');
  }
  assert.deepEqual(await fixture.refresh(), { updated: { claude: true, codex: true }, errors: [] });
  await writeFile(fixture.config, '[mcp_servers.recruiters-rip]\ncommand = "/keep-this-command"\n');
  assert.deepEqual(await fixture.refresh(), { updated: { claude: false, codex: false }, errors: [] });
  for (const target of [fixture.claude, legacy]) assert.equal(await readFile(path.join(target, 'SKILL.md'), 'utf8'), 'Current skill\n');
  await assert.rejects(stat(fixture.personal), { code: 'ENOENT' });
  assert.equal(fixture.calls.length, 0);
});
