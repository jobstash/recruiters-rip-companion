import { access, cp, lstat, mkdir, writeFile, rm, readFile, readdir, realpath, rename, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
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

const serverName = localOnly => localOnly ? 'recruiters-rip-local' : 'recruiters-rip';
const quoteSh = value => `'${String(value).replaceAll("'", "'\\''")}'`;

// Pasted into any coding agent. Commands follow https://developers.openai.com/codex/mcp,
// https://code.claude.com/docs/en/mcp and https://modelcontextprotocol.io/docs/develop/connect-local-servers.
// Windows gets config-file entries only: its launcher runs through cmd.exe, which shell one-liners would re-quote.
export function agentSetupPrompt(command, { localOnly = false, platform = process.platform, env = process.env } = {}) {
  const name = serverName(localOnly), invocation = mcpInvocation(command, { platform, env }), windows = platform === 'win32';
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

const tableEnabled = (toml, table) => {
  const lines = toml.split(/\r?\n/), start = lines.findIndex(line => line.trim() === `[${table}]`);
  if (start < 0) return false;
  const body = lines.slice(start + 1), end = body.findIndex(line => line.trim().startsWith('['));
  return !(end < 0 ? body : body.slice(0, end)).some(line => /^\s*enabled\s*=\s*false\b/.test(line));
};

/** Whether Codex / Claude have a recruiters.rip MCP entry they load, read from their own config files. Unreadable means not found. */
export async function addedHosts({ workspace, localOnly = false, platform = process.platform, env = process.env, home = homedir(),
  read = filename => readFile(filename, 'utf8'), list = readdir } = {}) {
  const p = paths(platform), name = serverName(localOnly), workspaceName = 'recruiters-rip-applications';
  const text = async filename => { try { return await read(filename); } catch { return ''; } };
  const servers = async filename => { try { const value = JSON.parse(await read(filename))?.mcpServers; return value && typeof value === 'object' ? value : {}; } catch { return {}; } };
  const codexConfig = await text(p.join(env.CODEX_HOME || p.join(home, '.codex'), 'config.toml'));
  const codex = [`plugins."recruiters-rip@${name}"`, `mcp_servers.${name}`, `mcp_servers."${name}"`].some(table => tableEnabled(codexConfig, table))
    || tableEnabled(await text(p.join(workspace, '.codex', 'config.toml')), `mcp_servers.${workspaceName}`);
  const desktop = platform === 'darwin' ? p.join(home, 'Library', 'Application Support', 'Claude')
    : platform === 'win32' ? p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'Claude') : p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'Claude');
  let extensions = [];
  try { extensions = await list(p.join(desktop, 'Claude Extensions')); } catch {}
  const claudeFiles = [p.join(desktop, 'claude_desktop_config.json'), p.join(home, '.claude.json'), ...(env.CLAUDE_CONFIG_DIR ? [p.join(env.CLAUDE_CONFIG_DIR, '.claude.json')] : [])];
  const claude = extensions.some(entry => entry === name || entry.endsWith(`.${name}`))
    || (await Promise.all(claudeFiles.map(servers))).some(value => Object.hasOwn(value, name))
    || Object.hasOwn(await servers(p.join(workspace, '.mcp.json')), workspaceName);
  return { codex, claude };
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
            const binary = commandLine?.match(/^"((?:\\.|[^"])*)"/)?.[1]?.replace(/\\(["\\`$])/g, '$1') || commandLine?.match(/^([^\s]+)/)?.[1];
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

export async function prepareClaudePackage({ template, directory, localOnly, version }) {
  const profileDirectory = await realpath(directory);
  platformRuntime.assertPrivatePath(profileDirectory, { directory: true });
  if (path.basename(profileDirectory) !== (localOnly ? 'local-device' : 'device')) fail('HOST_INSTALL_FAILED', 'Open the selected Companion profile before setting up Claude.');
  const info = await lstat(template);
  if (!info.isFile() || info.size > 32 * 1024 * 1024) fail('HOST_INSTALL_FAILED', 'The bundled Claude extension is unavailable. Reinstall the complete companion.');
  const archive = new AdmZip(await readFile(template));
  const entries = archive.getEntries(), names = new Set();
  let unpackedBytes = 0;
  if (entries.length > 256) fail('HOST_INSTALL_FAILED', 'The bundled Claude extension is invalid.');
  for (const item of entries) {
    const name = item.entryName.toLowerCase();
    unpackedBytes += item.header.size;
    if (names.has(name) || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '..' || part === '.') ||
        (item.header.attr >>> 16 & 0o170000) === 0o120000 || unpackedBytes > 64 * 1024 * 1024)
      fail('HOST_INSTALL_FAILED', 'The bundled Claude extension is invalid.');
    names.add(name);
  }
  for (const filename of ['server/index.cjs', 'platform-runtime.cjs'])
    if (!archive.getEntry(filename) || archive.getEntry(filename).isDirectory) fail('HOST_INSTALL_FAILED', 'The bundled Claude extension is incomplete.');
  const entry = archive.getEntry('manifest.json');
  if (!entry || entry.isDirectory || entry.header.size > 64 * 1024) fail('HOST_INSTALL_FAILED', 'The bundled Claude extension is invalid.');
  const manifest = JSON.parse(archive.readAsText(entry));
  const name = localOnly ? 'recruiters-rip-local' : 'recruiters-rip';
  if (manifest.manifest_version !== '0.3' || manifest.name !== name || manifest.version !== version || manifest.server?.type !== 'node' || manifest.server.entry_point !== 'server/index.cjs')
    fail('HOST_INSTALL_FAILED', 'The bundled Claude extension does not match this companion.');
  // Public bundles contain a selector, never a user's path. The installed copy
  // is private and bound to the profile from which Setup was explicitly chosen.
  manifest.server.mcp_config = { command: 'node', args: ['${__dirname}/server/index.cjs', `--directory=${profileDirectory}`, ...(localOnly ? ['--local-product'] : [])] };
  delete manifest.user_config;
  archive.updateFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  const integration = path.join(profileDirectory, 'host-integration');
  await privateDirectory(integration);
  const destination = path.join(integration, `${name}.mcpb`), temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, archive.toBuffer(), { mode: 0o600, flag: 'wx' });
    platformRuntime.protectPrivatePath(temporary);
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
  return destination;
}

export async function installChatGptPlugin({ directory, root, localOnly, command, platform = process.platform, env = process.env, findCli = findChatGptCli, runCommand = exec }) {
  const cli = await findCli({ platform, env });
  const run = args => runCommand(cli.command, [...cli.args, ...args], { cwd: root, env: hostEnvironment(env), timeout: 60000, maxBuffer: 1024 * 1024 });
  // Probe only help, never a prompt: old CLIs must fail before writing a plugin.
  try {
    const help = await run(['plugin', '--help']);
    if (!/\badd\b/.test(help.stdout) || !/\bmarketplace\b/.test(help.stdout)) throw new Error('Unsupported plugin CLI');
  } catch { fail('HOST_INSTALL_FAILED', 'Update ChatGPT desktop or Codex CLI to a version with plugin add and plugin marketplace support.'); }
  const marketplace = localOnly ? 'recruiters-rip-local' : 'recruiters-rip';
  const integration = path.join(directory, 'host-integration');
  const plugin = path.join(integration, 'plugins', 'recruiters-rip');
  await privateDirectory(integration);
  await mkdir(path.join(integration, '.agents', 'plugins'), { recursive: true, mode: 0o700 });
  // This desktop runtime uses its native plugin manifest for bundled STDIO MCP.
  // Remove only our earlier generated portable manifests, not user host settings.
  for (const name of ['plugin.json', 'mcp.json']) await rm(path.join(plugin, name), { force: true });
  await cp(path.join(root, 'src', 'generated', 'recruiters-rip-plugin'), plugin, { recursive: true });
  // Installation-specific paths are emitted here, never guessed by the model or
  // embedded in the distributed plugin. No provider secret is passed to the CLI.
  await writeFile(path.join(plugin, '.mcp.json'), JSON.stringify({
    mcpServers: { 'recruiters-rip': mcpInvocation(command, { platform, env }) },
  }, null, 2) + '\n', { mode: 0o600 });
  platformRuntime.protectPrivatePath(path.join(plugin, '.mcp.json'));
  await writeFile(path.join(integration, '.agents/plugins/marketplace.json'), JSON.stringify({
    name: marketplace, interface: { displayName: 'Recruiters.rip' },
    plugins: [{ name: 'recruiters-rip', source: { source: 'local', path: './plugins/recruiters-rip' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
  }, null, 2) + '\n', { mode: 0o600 });
  platformRuntime.protectPrivatePath(path.join(integration, '.agents/plugins/marketplace.json'));
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
