import { access, cp, mkdir, writeFile, rm, readFile, readdir, rename, stat, lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { privateDirectory } from './vault.mjs';
import { fail } from './mcp/state.mjs';
import platformRuntime from './platform-runtime.cjs';

const exec = promisify(execFile);
const paths = platform => platform === 'win32' ? path.win32 : path.posix;
const executable = async (filename, platform) => {
  try { await access(filename, platform === 'win32' ? constants.F_OK : constants.X_OK); return (await stat(filename)).isFile(); } catch { return false; }
};

export function hostEnvironment(env = process.env) {
  const keys = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'TMP', 'TEMP', 'TMPDIR', 'USER', 'LOGNAME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'DISPLAY', 'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_DATA_DIRS', 'DBUS_SESSION_BUS_ADDRESS',
    'LANG', 'LC_ALL', 'TERM', 'SHELL', 'CLAUDE_CODE_GIT_BASH_PATH'];
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value && keys.some(allowed => allowed.toLowerCase() === key.toLowerCase())));
}

export function mcpInvocation(command, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) return { command, args: [] };
  // Expand a fixed environment name once, with delayed expansion disabled.
  // A literal % or ! in the value is never reparsed as command syntax.
  if (/["\r\n\0]/.test(command)) fail('INVALID_INPUT', 'The Windows tool launcher path cannot contain quotes or control characters.');
  return { command: path.win32.join(env.SystemRoot || env.SYSTEMROOT || env.WINDIR || 'C:\\Windows', 'System32', 'cmd.exe'),
    args: ['/d', '/v:off', '/s', '/c', '%RECRUITERS_RIP_MCP_COMMAND%'], env: { RECRUITERS_RIP_MCP_COMMAND: `"${command}"` } };
}

export function mcpServerToml(name, command, options) {
  const invocation = mcpInvocation(command, options);
  return `[mcp_servers.${name}]\ncommand = ${JSON.stringify(invocation.command)}\nargs = ${JSON.stringify(invocation.args)}\n`
    + (invocation.env ? `\n[mcp_servers.${name}.env]\n${Object.entries(invocation.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`).join('')}` : '');
}

/** The MCP server name Set up registers for Claude (Desktop config or Claude Code user scope). The Codex plugin always bundles it as recruiters-rip. */
export const mcpServerName = localOnly => localOnly ? 'recruiters-rip-local' : 'recruiters-rip';
const quoteSh = value => `'${String(value).replaceAll("'", "'\\''")}'`;

// Pasted into any coding agent. Commands follow https://developers.openai.com/codex/mcp,
// https://code.claude.com/docs/en/mcp and https://modelcontextprotocol.io/docs/develop/connect-local-servers.
// Windows gets config-file entries only: its launcher runs through cmd.exe, which shell one-liners would re-quote.
export function agentSetupPrompt(command, { localOnly = false, container = null, platform = process.platform, env = process.env } = {}) {
  if (container) return containerSetupPrompt(command, { localOnly, container });
  const name = mcpServerName(localOnly), invocation = mcpInvocation(command, { platform, env }), windows = platform === 'win32';
  const entry = `"${name}": ${JSON.stringify(invocation)}`;
  const desktopConfig = platform === 'darwin' ? '~/Library/Application Support/Claude/claude_desktop_config.json'
    : windows ? '%APPDATA%\\Claude\\claude_desktop_config.json' : '~/.config/Claude/claude_desktop_config.json';
  return [
    'Set up the recruiters.rip MCP server on this computer.',
    '',
    windows ? `It is a local stdio server named ${name}, started by this entry:` : `It is a local stdio server named ${name}. Its command is this file, with no arguments:`,
    windows ? JSON.stringify(invocation) : command,
    '',
    'Add it to each of these apps that is installed here. Do not remove or change any other MCP server.',
    '',
    'Codex (the CLI, IDE extension and ChatGPT desktop share this setup):',
    ...(windows ? ['Add this to %USERPROFILE%\\.codex\\config.toml:']
      : [`codex mcp add ${name} -- ${quoteSh(command)}`, 'If the codex command is not available, add this to ~/.codex/config.toml instead:']),
    mcpServerToml(name, command, { platform, env }).trimEnd(),
    '',
    'Claude Code:',
    ...(windows ? ['Add this entry inside the top-level "mcpServers" object in %USERPROFILE%\\.claude.json:', entry]
      : [`claude mcp add --scope user ${name} -- ${quoteSh(command)}`]),
    '',
    `Claude Desktop: add this entry inside "mcpServers" in ${desktopConfig}. Create the file if it does not exist.`,
    entry,
    '',
    `Any other agent, such as Cursor: add the same command as a stdio MCP server named ${name}.`,
    '',
    `Then fully quit and reopen each app you changed, and check it works there by calling the ${name} tool career_profile_read.`,
  ].join('\n');
}

// Companion in a container: the AI app runs on the host and starts the launcher inside the container through `docker exec`.
// The host's operating system is unknown from in there, so every config location is named.
function containerSetupPrompt(command, { localOnly, container }) {
  const name = mcpServerName(localOnly), args = ['exec', '-i', container, command];
  const line = ['docker', ...args.map(value => /^[A-Za-z0-9_./-]+$/.test(value) ? value : quoteSh(value))].join(' ');
  return [
    'Set up the recruiters.rip MCP server on this computer.',
    '',
    `It is a local stdio server named ${name}. It runs inside the Docker container ${container} on this computer and is started with:`,
    line,
    '',
    'Add it to each of these apps that is installed here. Do not remove or change any other MCP server.',
    '',
    'Codex (the CLI, IDE extension and ChatGPT desktop share this setup):',
    `codex mcp add ${name} -- ${line}`,
    'If the codex command is not available, add this to ~/.codex/config.toml instead (%USERPROFILE%\\.codex\\config.toml on Windows):',
    `[mcp_servers.${name}]\ncommand = "docker"\nargs = ${JSON.stringify(args)}`,
    '',
    'Claude Code:',
    `claude mcp add --scope user ${name} -- ${line}`,
    '',
    'Claude Desktop: add this entry inside "mcpServers" in claude_desktop_config.json. Create the file if it does not exist. It is in ~/Library/Application Support/Claude on macOS, %APPDATA%\\Claude on Windows and ~/.config/Claude on Linux.',
    `"${name}": ${JSON.stringify({ command: 'docker', args })}`,
    '',
    `Any other agent, such as Cursor: add the same command as a stdio MCP server named ${name}.`,
    '',
    'If an app cannot find docker, use the full path printed by: command -v docker',
    '',
    `Then fully quit and reopen each app you changed, and check it works there by calling the ${name} tool career_profile_read. If it cannot connect, check the container is running: docker ps --filter name=${container}`,
  ].join('\n');
}

const tableEnabled = (toml, table) => {
  const lines = toml.split(/\r?\n/), start = lines.findIndex(line => line.trim() === `[${table}]`);
  if (start < 0) return false;
  const body = lines.slice(start + 1), end = body.findIndex(line => line.trim().startsWith('['));
  return !(end < 0 ? body : body.slice(0, end)).some(line => /^\s*enabled\s*=\s*false\b/.test(line));
};

const claudeDesktopDirectory = (platform, env, home) => {
  const p = paths(platform);
  return platform === 'darwin' ? p.join(home, 'Library', 'Application Support', 'Claude')
    : platform === 'win32' ? p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'Claude') : p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'Claude');
};

/** Whether Codex / Claude have a recruiters.rip MCP entry that Continue in Codex / Claude can use, read from their own config
 *  files. Unreadable means not found. A Claude Desktop extension serves only Claude's Chat, not the Code tab Continue opens. */
export async function addedHosts({ localOnly = false, platform = process.platform, env = process.env, home = homedir(),
  read = filename => readFile(filename, 'utf8') } = {}) {
  const p = paths(platform), name = mcpServerName(localOnly);
  const text = async filename => { try { return await read(filename); } catch { return ''; } };
  const servers = async filename => { try { const value = JSON.parse(await read(filename))?.mcpServers; return value && typeof value === 'object' ? value : {}; } catch { return {}; } };
  const codexConfig = await text(p.join(env.CODEX_HOME || p.join(home, '.codex'), 'config.toml'));
  const codex = [`plugins."recruiters-rip@${name}"`, `mcp_servers.${name}`, `mcp_servers."${name}"`].some(table => tableEnabled(codexConfig, table));
  const claudeFiles = [p.join(claudeDesktopDirectory(platform, env, home), 'claude_desktop_config.json'), p.join(home, '.claude.json'), ...(env.CLAUDE_CONFIG_DIR ? [p.join(env.CLAUDE_CONFIG_DIR, '.claude.json')] : [])];
  const claude = (await Promise.all(claudeFiles.map(servers))).some(value => Object.hasOwn(value, name));
  return { codex, claude };
}

/** An older Companion installed recruiters.rip as a Claude Desktop extension; it now duplicates the config entry in Chat. */
export async function claudeExtensionInstalled({ localOnly = false, platform = process.platform, env = process.env, home = homedir(), list = readdir } = {}) {
  const name = mcpServerName(localOnly);
  try { return (await list(paths(platform).join(claudeDesktopDirectory(platform, env, home), 'Claude Extensions'))).some(entry => entry === name || entry.endsWith(`.${name}`)); }
  catch { return false; }
}

/** Claude Desktop starts the servers named in claude_desktop_config.json for Chat and for local Code tab sessions, and reads the
 *  file only at launch. Merge recruiters.rip in, keep every other key and server, and never rewrite a file that does not parse. */
export async function addClaudeDesktopServer({ command, localOnly = false, platform = process.platform, env = process.env, home = homedir() }) {
  const p = paths(platform), directory = claudeDesktopDirectory(platform, env, home), filename = p.join(directory, 'claude_desktop_config.json');
  let previous = null, config = {};
  try { previous = await readFile(filename, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') fail('HOST_INSTALL_FAILED', 'Companion couldn’t read Claude’s settings file, so it left it unchanged. Use Copy prompt below instead.'); }
  if (previous?.trim()) {
    try { config = JSON.parse(previous); } catch { config = null; }
    if (!config || typeof config !== 'object' || Array.isArray(config) ||
        (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))))
      fail('HOST_INSTALL_FAILED', 'Claude’s settings file (claude_desktop_config.json) isn’t valid JSON, so Companion left it unchanged. Fix that file, then choose Set up again.');
  }
  const next = JSON.stringify({ ...config, mcpServers: { ...config.mcpServers, [mcpServerName(localOnly)]: mcpInvocation(command, { platform, env }) } }, null, 2) + '\n';
  if (previous !== null && JSON.stringify(JSON.parse(next)) === JSON.stringify(config)) return { changed: false };
  await mkdir(directory, { recursive: true });
  // The previous file stays beside it, so a user can always get back what Claude had before.
  if (previous !== null) await writeFile(p.join(directory, 'claude_desktop_config.before-recruiters-rip.json'), previous);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, next, { flag: 'wx' }); await rename(temporary, filename); }
  finally { await rm(temporary, { force: true }); }
  return { changed: true };
}

/** Claude Code in a terminal (no Claude Desktop) loads user-scoped servers in every folder, with no project approval. Its own CLI
 *  writes ~/.claude.json, which the running app also rewrites; recruiters.rip replaces only its own named entry. */
export async function addClaudeCodeServer({ cli, command, localOnly = false, platform = process.platform, env = process.env, runCommand = exec }) {
  const name = mcpServerName(localOnly);
  const run = args => runCommand(cli.command, [...cli.args, 'mcp', ...args], { env: hostEnvironment(env), timeout: 60000, maxBuffer: 1024 * 1024 });
  try { await run(['remove', '--scope', 'user', name]); } catch { /* absent */ }
  try { await run(['add-json', '--scope', 'user', name, JSON.stringify({ type: 'stdio', ...mcpInvocation(command, { platform, env }) })]); }
  catch { fail('HOST_INSTALL_FAILED', 'Claude Code could not add recruiters.rip. Update Claude Code, or use Copy prompt below instead.'); }
  return { changed: true };
}

async function exists(filename) {
  try { await lstat(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Compare bytes from the same regular file we inspected, never a replacement link.
async function readTreeFile(filename, selected) {
  let handle;
  try {
    selected ||= await lstat(filename);
    if (!selected.isFile()) return null;
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== selected.dev || current.ino !== selected.ino) return null;
    return await handle.readFile();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ELOOP') return null;
    throw error;
  } finally { await handle?.close(); }
}

async function sameTree(source, target, extraFiles = {}) {
  const sourceInfo = await lstat(source);
  let targetInfo;
  try { targetInfo = await lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (sourceInfo.isFile()) {
    if (!targetInfo.isFile()) return false;
    const original = await readTreeFile(source, sourceInfo), installed = await readTreeFile(target, targetInfo);
    return original !== null && installed !== null && original.equals(installed);
  }
  if (!sourceInfo.isDirectory()) throw new Error('A bundled host skill contains an unsupported file.');
  if (!targetInfo.isDirectory()) return false;
  const names = [...new Set([...(await readdir(source)), ...Object.keys(extraFiles)])].sort(), installed = (await readdir(target)).sort();
  if (names.length !== installed.length || names.some((name, index) => name !== installed[index])) return false;
  for (const name of names) {
    if (Object.hasOwn(extraFiles, name)) {
      const filename = path.join(target, name);
      const content = await readTreeFile(filename);
      if (content === null || content.toString('utf8') !== extraFiles[name]) return false;
    } else if (!await sameTree(path.join(source, name), path.join(target, name))) return false;
  }
  return true;
}

// Keep the old tree until the staged copy is complete, and restore it if the swap fails.
// Renaming a nonempty directory over another is not portable (notably on Windows).
async function replaceTree(source, target, { moveDirectory = rename, extraFiles = {} } = {}) {
  if (await sameTree(source, target, extraFiles)) return false;
  const temporary = `${target}.${randomUUID()}.tmp`, backup = `${target}.${randomUUID()}.previous`;
  let moved = false, installed = false;
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, temporary, { recursive: true });
    for (const [name, content] of Object.entries(extraFiles)) {
      await writeFile(path.join(temporary, name), content, { mode: 0o600 });
      platformRuntime.protectPrivatePath(path.join(temporary, name));
    }
    if (await exists(target)) { await moveDirectory(target, backup); moved = true; }
    try { await moveDirectory(temporary, target); installed = true; }
    catch (error) { if (moved) await moveDirectory(backup, target); throw error; }
  } finally {
    await rm(temporary, { recursive: true, force: true });
    if (installed && moved) await rm(backup, { recursive: true, force: true });
  }
  return true;
}

/** Claude Code and Claude Desktop's Code tab read this personal skill on new sessions.
 * Replace only the product-owned tree; identical content leaves the installed copy untouched. */
export async function installClaudeSkill({ source, platform = process.platform, env = process.env, home = homedir(), onlyIfPresent = false, moveDirectory = rename }) {
  const p = paths(platform), target = p.join(env.CLAUDE_CONFIG_DIR || p.join(home, '.claude'), 'skills', 'recruiters-rip');
  if (onlyIfPresent && !await exists(target)) return false;
  return replaceTree(source, target, { moveDirectory });
}

/** Which Continue target each live MCP session can serve, from the clientInfo name it declared. Continue in Claude opens Claude
 *  Code (Desktop's Code tab or the terminal app), so only Claude Code sessions make Claude "In use now"; Claude's Chat and Cowork
 *  sessions are named as Claude chat. */
export function liveSessions(names = []) {
  const live = { codex: false, claude: false }, other = new Set();
  for (const name of names) {
    if (!name) continue;
    if (/^claude-code\b/i.test(name)) live.claude = true;
    else if (/codex|chatgpt|openai/i.test(name)) live.codex = true;
    else if (/^claude-ai\b|^local-agent-mode-/i.test(name)) other.add('Claude chat');
    else other.add(name);
  }
  return { live, other: [...other] };
}

/** After Set up, an app loads recruiters.rip only once it restarts. The notice stays until that app opens a new session. */
export function settleRestartNotices(pending, previousCounts, names = []) {
  const counts = { codex: 0, claude: 0 };
  for (const name of names) for (const [host, live] of Object.entries(liveSessions([name]).live)) if (live) counts[host]++;
  const next = Object.fromEntries(Object.keys(counts).map(host => [host, Boolean(pending[host]) && counts[host] <= (previousCounts[host] ?? 0)]));
  return { pending: next, counts };
}

export async function findHostCli(host, { platform = process.platform, env = process.env, home = homedir(), canExecute = executable,
  fileExists = async filename => { try { await access(filename); return true; } catch { return false; } } } = {}) {
  const p = paths(platform);
  const name = host === 'codex' ? 'codex' : 'claude';
  const directories = [
    ...(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(value => p.isAbsolute(value)),
    p.join(home, '.local', 'bin'), p.join(home, '.npm-global', 'bin'),
    ...(platform === 'win32' ? [env.APPDATA && p.join(env.APPDATA, 'npm'), env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links')]
      : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']),
  ].filter(Boolean);
  const candidates = platform === 'darwin' && host === 'codex'
    ? ['/Applications', p.join(home, 'Applications')].flatMap(base => ['ChatGPT.app', 'Codex.app'].flatMap(app =>
      [p.join(base, app, 'Contents/Resources/codex-cli/bin/codex'), p.join(base, app, 'Contents/Resources/codex')])) : [];
  candidates.push(...directories.flatMap(base => platform === 'win32' ? [p.join(base, `${name}.exe`), p.join(base, `${name}.cmd`)] : [p.join(base, name)]));
  for (const candidate of [...new Set(candidates)]) {
    if (!await canExecute(candidate, platform)) continue;
    if (!/\.cmd$/i.test(candidate)) return { command: candidate, args: [] };
    // Resolve official npm entrypoints instead of passing a batch shim or user
    // arguments through cmd.exe. Never execute arbitrary shim contents.
    const base = p.dirname(candidate);
    const entry = p.join(base, 'node_modules', host === 'codex' ? '@openai/codex/bin/codex.js' : '@anthropic-ai/claude-code/cli.js');
    if (!await fileExists(entry)) continue;
    for (const node of [p.join(base, 'node.exe'), ...directories.map(directory => p.join(directory, 'node.exe'))]) {
      if (await canExecute(node, platform)) return { command: node, args: [entry] };
    }
  }
  return null;
}

export async function findChatGptCli(options = {}) {
  const cli = await findHostCli('codex', options);
  if (cli) return cli;
  fail('HOST_UNAVAILABLE', 'Install ChatGPT desktop or the official Codex CLI and sign in before installing the Recruiters.rip plugin. Ordinary ChatGPT chats do not use local MCP tools.');
}

export async function discoverHost(host, options = {}) {
  const { platform = process.platform, env = process.env, home = homedir(), run = exec, canExecute = executable, protocolAvailable } = options;
  const p = paths(platform), scheme = host === 'codex' ? 'codex' : 'claude';
  let desktop = false;
  if (protocolAvailable) {
    try { desktop = await protocolAvailable(scheme) === true; } catch {}
    if (desktop) return { available: true, mode: 'desktop', label: host === 'claude' ? 'Claude Desktop' : 'ChatGPT desktop (Codex)', reason: null };
  }
  if (platform === 'darwin') {
    const apps = host === 'claude' ? ['Claude.app'] : ['ChatGPT.app', 'Codex.app'];
    for (const base of ['/Applications', p.join(home, 'Applications')]) {
      for (const app of apps) {
        try { await access(p.join(base, app, 'Contents', 'Info.plist')); desktop = true; } catch {}
      }
    }
  } else if (platform === 'win32') {
    const reg = p.join(env.SystemRoot || env.SYSTEMROOT || env.WINDIR || 'C:\\Windows', 'System32', 'reg.exe');
    for (const key of [`HKCU\\Software\\Classes\\${scheme}`, `HKCR\\${scheme}`]) {
      try {
        await run(reg, ['query', key, '/v', 'URL Protocol'], { env: hostEnvironment(env), timeout: 5000 });
        const result = await run(reg, ['query', `${key}\\shell\\open\\command`, '/ve'], { env: hostEnvironment(env), timeout: 5000 });
        const value = result.stdout.match(/REG_(?:EXPAND_)?SZ\s+(.+)/)?.[1]?.trim();
        const file = value?.match(/^"([^"]+\.exe)"/i)?.[1] || value?.match(/^(.+?\.exe)(?:\s|$)/i)?.[1];
        const expanded = file?.replace(/%([^%]+)%/g, (_, name) => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || `%${name}%`);
        if (expanded && await canExecute(expanded, platform)) { desktop = true; break; }
      } catch {}
    }
  } else if (platform === 'linux') {
    try {
      const result = await run('xdg-mime', ['query', 'default', `x-scheme-handler/${scheme}`], { env: hostEnvironment(env), timeout: 5000 });
      const id = result.stdout.trim();
      if (/^[\w.-]+\.desktop$/.test(id) && (env.DISPLAY || env.WAYLAND_DISPLAY)) {
        const roots = [env.XDG_DATA_HOME || p.join(home, '.local/share'), ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')];
        for (const root of roots) {
          try {
            const entry = await readFile(p.join(root, 'applications', id), 'utf8');
            const section = entry.split(/^\[Desktop Entry\]\s*$/m)[1]?.split(/^\[/m)[0] || '';
            const commandLine = section.match(/^TryExec=(.+)$/m)?.[1] || section.match(/^Exec=(.+)$/m)?.[1];
            const binary = commandLine?.match(/^"((?:\\.|[^"\\])*)"/)?.[1]?.replace(/\\(["\\`$])/g, '$1') || commandLine?.match(/^([^\s]+)/)?.[1];
            const present = binary && (p.isAbsolute(binary) ? await canExecute(binary, platform) : await findHostCommand(binary, { platform, env, canExecute }));
            if (/^Type=Application\s*$/m.test(section) && present && !/^Hidden=true\s*$/m.test(section)) desktop = true;
          } catch {}
        }
      }
    } catch {}
  }
  const desktopLabel = host === 'claude' ? 'Claude Desktop' : 'ChatGPT desktop (Codex)';
  if (desktop) return { available: true, mode: 'desktop', label: desktopLabel, reason: null };
  const cli = await findHostCli(host, { ...options, platform, env, home, canExecute });
  let terminal = null;
  if (cli) {
    if (platform === 'darwin') terminal = { command: '/usr/bin/open', args: ['-a', 'Terminal'] };
    else if (platform === 'win32') {
      const command = p.join(env.SystemRoot || env.SYSTEMROOT || env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      if (await canExecute(command, platform)) terminal = { command, args: [] };
    } else if (platform === 'linux' && (env.DISPLAY || env.WAYLAND_DISPLAY)) {
      for (const [name, args] of [['x-terminal-emulator', ['-e']], ['gnome-terminal', ['--']], ['konsole', ['-e']], ['xfce4-terminal', ['-x']], ['xterm', ['-e']]]) {
        const found = await findHostCommand(name, { platform, env, canExecute });
        if (found) { terminal = { command: found, args }; break; }
      }
    }
  }
  return { available: Boolean(cli && terminal), mode: cli && terminal ? 'cli' : null,
    label: host === 'claude' ? 'Claude Code' : 'Codex CLI',
    reason: cli && terminal ? null : cli ? 'An interactive desktop terminal is required.' : `Install ${desktopLabel} or the official ${host === 'claude' ? 'Claude Code' : 'Codex'} CLI and sign in.`,
    ...(cli && terminal ? { cli, terminal } : {}) };
}

async function findHostCommand(name, { platform, env, canExecute }) {
  for (const directory of (env.PATH || '').split(':').filter(directory => path.posix.isAbsolute(directory))) {
    const command = path.posix.join(directory, name);
    if (await canExecute(command, platform)) return command;
  }
  return null;
}

const pluginSource = root => path.join(root, 'src', 'generated', 'recruiters-rip-plugin');
const pluginFiles = (command, platform, env) => ({
  '.mcp.json': JSON.stringify({ mcpServers: { 'recruiters-rip': mcpInvocation(command, { platform, env }) } }, null, 2) + '\n',
});

async function preparePlugin({ directory, root, localOnly, command, platform, env, moveDirectory = rename }) {
  const marketplace = mcpServerName(localOnly), integration = path.join(directory, 'host-integration');
  const plugin = path.join(integration, 'plugins', 'recruiters-rip');
  await privateDirectory(integration);
  const changed = await replaceTree(pluginSource(root), plugin, { extraFiles: pluginFiles(command, platform, env), moveDirectory });
  const filename = path.join(integration, '.agents', 'plugins', 'marketplace.json');
  const content = JSON.stringify({
    name: marketplace, interface: { displayName: 'Recruiters.rip' },
    plugins: [{ name: 'recruiters-rip', source: { source: 'local', path: './plugins/recruiters-rip' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
  }, null, 2) + '\n';
  if (!await exists(filename) || await readFile(filename, 'utf8') !== content) {
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      platformRuntime.protectPrivatePath(temporary);
      await rename(temporary, filename);
    } finally { await rm(temporary, { force: true }); }
  }
  return { changed, marketplace, integration, plugin };
}

export async function installChatGptPlugin({ directory, root, localOnly, command, platform = process.platform, env = process.env, findCli = findChatGptCli, runCommand = exec }) {
  const cli = await findCli({ platform, env });
  const run = args => runCommand(cli.command, [...cli.args, ...args], { cwd: root, env: hostEnvironment(env), timeout: 60000, maxBuffer: 1024 * 1024 });
  // Probe only help, never a prompt: old CLIs must fail before writing a plugin.
  try {
    const help = await run(['plugin', '--help']);
    if (!/\badd\b/.test(help.stdout) || !/\bmarketplace\b/.test(help.stdout)) throw new Error('Unsupported plugin CLI');
  } catch { fail('HOST_INSTALL_FAILED', 'Update ChatGPT desktop or Codex CLI to a version with plugin add and plugin marketplace support.'); }
  const { marketplace, integration } = await preparePlugin({ directory, root, localOnly, command, platform, env });
  try {
    await run(['plugin', 'marketplace', 'add', integration, '--json']);
    const installation = await run(['plugin', 'add', `recruiters-rip@${marketplace}`, '--json']);
    JSON.parse(installation.stdout);
    // Replace only product-owned standalone registrations with the bundled MCP.
    // Unrelated user-owned servers with these names remain intact.
    for (const name of ['recruiters', 'recruiters-rip']) {
      let previous;
      try { previous = JSON.parse((await run(['mcp', 'get', name, '--json'])).stdout); } catch {}
      if ([path.join(directory, 'recruiters-mcp'), command].includes(previous?.transport?.command)) await run(['mcp', 'remove', name]);
    }
    const result = { installed: true, plugin: `recruiters-rip@${marketplace}`, name: 'Recruiters.rip', surface: 'ChatGPT desktop / Codex CLI',
      conversationRequired: 'Start a new local Codex task with the Recruiters.rip plugin. Ordinary ChatGPT chats do not inherit this local MCP connection.' };
    return result;
  } catch {
    fail('HOST_INSTALL_FAILED', 'Codex could not install the Recruiters.rip local plugin. Check the local plugin marketplace in ChatGPT desktop or Codex CLI. No provider credentials are required.');
  }
}

/** Verify installed host skills on every boot, including the first boot of a new app.
 * Host settings are not rewritten here; only an enabled Codex plugin uses the host's
 * install command to refresh its versioned cache. Existing conversations may retain old prompts. */
export async function refreshInstalledHostSkills({ directory, root, localOnly = false, command, claudeSource,
  platform = process.platform, env = process.env, home = homedir(), findCli = findChatGptCli, runCommand = exec,
  moveDirectory = rename } = {}) {
  const updated = { claude: false, codex: false }, errors = [], p = paths(platform);
  const source = claudeSource || p.join(pluginSource(root), 'skills', 'recruiters-rip');
  const attempt = async (host, refresh) => {
    try { updated[host] = await refresh(); }
    catch {
      errors.push({ host, message: `${host === 'claude' ? 'Claude' : 'Codex'} skill refresh failed. Companion will retry on its next launch. Check that the app’s settings and skill folders are writable${host === 'codex' ? ' and that Codex supports local plugins' : ''}.` });
    }
  };
  await attempt('claude', async () => {
    const configured = await addedHosts({ localOnly, platform, env, home });
    const target = p.join(env.CLAUDE_CONFIG_DIR || p.join(home, '.claude'), 'skills', 'recruiters-rip');
    if (!configured.claude && (localOnly || !await exists(target))) return false;
    return installClaudeSkill({ source, platform, env, home, moveDirectory });
  });
  await attempt('codex', async () => {
    const codexHome = env.CODEX_HOME || p.join(home, '.codex'), name = mcpServerName(localOnly);
    const configPath = p.join(codexHome, 'config.toml');
    const config = await exists(configPath) ? await readFile(configPath, 'utf8') : '';
    const pluginTable = `plugins."recruiters-rip@${name}"`;
    const registered = config.split(/\r?\n/).some(line => line.trim() === `[${pluginTable}]`);
    const enabled = tableEnabled(config, pluginTable);
    const standalone = [`mcp_servers.${name}`, `mcp_servers."${name}"`].some(table => tableEnabled(config, table));
    const cache = p.join(codexHome, 'plugins', 'cache', name, 'recruiters-rip');
    const versions = await exists(cache) ? (await readdir(cache, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(entry.name)).map(entry => p.join(cache, entry.name)) : [];
    let changed = false;
    const bundled = pluginSource(root), extraFiles = pluginFiles(command, platform, env);
    let current;
    if (enabled || (registered && !versions.length)) {
      const manifest = JSON.parse(await readFile(p.join(bundled, '.codex-plugin', 'plugin.json'), 'utf8'));
      if (manifest.name !== 'recruiters-rip' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version)) throw new Error('Invalid bundled plugin manifest.');
      current = p.join(cache, manifest.version);
    }
    if (enabled) {
      let stale = !versions.includes(current);
      for (const version of versions) if (!await sameTree(bundled, version, extraFiles)) stale = true;
      const prepared = await preparePlugin({ directory, root, localOnly, command, platform, env, moveDirectory });
      if (stale || prepared.changed) {
        const cli = await findCli({ platform, env, home });
        const run = args => runCommand(cli.command, [...cli.args, ...args],
          { cwd: root, env: hostEnvironment(env), timeout: 60000, maxBuffer: 1024 * 1024 });
        await run(['plugin', 'marketplace', 'add', prepared.integration, '--json']);
        const installation = JSON.parse((await run(['plugin', 'add', `recruiters-rip@${name}`, '--json'])).stdout);
        // Source files alone are insufficient: Codex reads the installed versioned copy.
        if (await realpath(installation.installedPath) !== await realpath(current) || !await sameTree(bundled, current, extraFiles)) throw new Error('Codex did not refresh its installed plugin cache.');
        changed = true;
      }
    } else {
      // `plugin add` enables disabled plugins. Refresh only their skill, keeping the
      // cached version/manifest and every auth, permission and enabled setting intact.
      for (const version of versions) {
        if (await replaceTree(source, p.join(version, 'skills', 'recruiters-rip'), { moveDirectory })) changed = true;
      }
      if (registered && !versions.length) changed = await replaceTree(bundled, current, { extraFiles, moveDirectory });
    }
    const personal = p.join(home, '.agents', 'skills', 'recruiters-rip');
    const legacy = p.join(codexHome, 'skills', 'recruiters-rip');
    const legacyPresent = await exists(legacy);
    for (const target of [personal, legacy]) {
      const present = await exists(target);
      if ((target === personal && standalone && !registered && !legacyPresent) || (present && (!localOnly || standalone || registered))) {
        if (await replaceTree(source, target, { moveDirectory })) changed = true;
      }
    }
    return changed;
  });
  return { updated, errors };
}
