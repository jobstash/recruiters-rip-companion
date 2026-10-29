import { access, writeFile, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { privateDirectory } from './vault.mjs';
import { fail } from './mcp/state.mjs';
import { discoverHost, hostEnvironment, mcpInvocation } from './host-setup.mjs';
import platformRuntime from './platform-runtime.cjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hosts = ['claude', 'codex'];
const labels = { claude: 'Claude Desktop', codex: 'ChatGPT desktop (Codex)' };
export const REVIEW_PROMPT = 'Use the recruiters.rip skill to review the jobs queued for you and show me the best matches.';
// Keep application tools distinct from an existing user-scoped registration,
// which may point to another Companion identity and override the project name.
const applicationConnection = 'recruiters-rip-applications';
const validPath = (value, platform) => typeof value === 'string' && (platform === 'win32' ? path.win32 : path).isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
const quoteSh = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const quotePowerShell = value => `'${String(value).replaceAll("'", "''")}'`;
const quoteWindowsArgument = value => `"${String(value).replace(/(\\*)"/g, (_, slashes) => slashes.repeat(2) + '\\"').replace(/\\+$/, slashes => slashes.repeat(2))}"`;

function startTerminal(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, detached: true, stdio: 'ignore', shell: false, windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

// An interactive CLI's positional prompt is submitted when the CLI starts.
// Keep it behind an explicit Enter in the visible terminal, never start it in
// the background or replace a failed native link with an inference request.
export function terminalLaunch({ host, descriptor, workspace, prompt, platform }) {
  const args = [...descriptor.cli.args, ...(host === 'codex' ? ['--cd', workspace] : []), '--', prompt];
  if (platform === 'win32') {
    // ProcessStartInfo avoids Windows PowerShell 5.1's lossy native argument
    // passing (notably the JSON quotes in the exact preparation request).
    const commandLine = args.map(quoteWindowsArgument).join(' ');
    const source = `$ErrorActionPreference = 'Stop'\r\nSet-Location -LiteralPath ${quotePowerShell(workspace)}\r\nWrite-Host ${quotePowerShell(prompt)}\r\n$answer = Read-Host 'Press Enter to send this request, or type cancel to close'\r\nif ($answer -ne '') { exit }\r\n$start = New-Object System.Diagnostics.ProcessStartInfo\r\n$start.FileName = ${quotePowerShell(descriptor.cli.command)}\r\n$start.Arguments = ${quotePowerShell(commandLine)}\r\n$start.WorkingDirectory = ${quotePowerShell(workspace)}\r\n$start.UseShellExecute = $false\r\n$child = [System.Diagnostics.Process]::Start($start)\r\n$child.WaitForExit()\r\n`;
    return { command: descriptor.terminal.command, args: ['-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')] };
  }
  const source = `#!/bin/sh\n${platform === 'darwin' ? '/bin/rm -f -- "$0"\n' : ''}cd ${quoteSh(workspace)} || exit 1\nprintf '%s\\n' ${quoteSh(prompt)}\nprintf '%s' 'Press Enter to send this request, or type cancel to close: '\nIFS= read -r answer || exit 1\n[ -z "$answer" ] || exit 0\nexec ${[descriptor.cli.command, ...args].map(quoteSh).join(' ')}\n`;
  return { command: descriptor.terminal.command, args: descriptor.terminal.args, source };
}

async function replaceConfig(filename, content) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    platformRuntime.protectPrivatePath(temporary);
    // Replace only our generated file; never follow an existing file symlink.
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

// Both documented desktop links prefill only; normal host trust/send prompts
// remain in charge. CLI arguments: Codex --cd PATH [PROMPT], Claude [PROMPT].
// https://developers.openai.com/codex/app/commands
// https://code.claude.com/docs/en/cli-reference
export function createApplicationLauncher({ directory, command, openExternal, hostAvailable,
  platform = process.platform, env = process.env, discover = discoverHost, launchTerminal = startTerminal, protocolAvailable }) {
  if (!validPath(directory, platform) || !validPath(command, platform) || typeof openExternal !== 'function'
    || (hostAvailable !== undefined && typeof hostAvailable !== 'function') || typeof discover !== 'function' || typeof launchTerminal !== 'function')
    fail('INVALID_INPUT', 'Application launching needs a local workspace, Companion tool command and native link opener.');
  const p = platform === 'win32' ? path.win32 : path;
  const workspace = p.join(directory, 'application-workspace');
  const describe = async host => hostAvailable
    ? { available: await hostAvailable(host) === true, mode: 'desktop', label: labels[host], reason: null }
    : discover(host, { platform, env, protocolAvailable });

  async function configure(host) {
    try { await access(command, platform === 'win32' ? constants.F_OK : constants.X_OK); }
    catch { fail('HOST_SETUP_REQUIRED', 'The Companion tool launcher is unavailable. Restart Companion and try preparing this application again.'); }
    try {
      await privateDirectory(directory);
      await privateDirectory(workspace);
      if (host === 'claude') {
        await replaceConfig(path.join(workspace, '.mcp.json'), JSON.stringify({
          mcpServers: { [applicationConnection]: mcpInvocation(command, { platform, env }) },
        }, null, 2) + '\n');
      } else {
        await privateDirectory(p.join(workspace, '.codex'));
        // Generated workspace only: no user-level host config is overwritten.
        await replaceConfig(p.join(workspace, '.codex', 'config.toml'), applicationMcpToml(command, { platform, env }));
      }
    } catch {
      fail('HOST_SETUP_FAILED', 'Companion could not configure its application workspace. Check local storage permissions and try again.');
    }
  }

  return {
    async available() {
      const values = await Promise.all(hosts.map(describe));
      return Object.fromEntries(hosts.map((host, index) => [host, values[index].available === true]));
    },
    async info() {
      const values = await Promise.all(hosts.map(async host => {
        const { available, label, mode, reason } = await describe(host);
        return [host, { available, label, mode, reason }];
      }));
      return Object.fromEntries(values);
    },
    async connect(host) {
      if (!hosts.includes(host)) fail('INVALID_INPUT', 'Choose Claude or Codex.');
      const descriptor = await describe(host);
      if (!descriptor.available) fail('HOST_UNAVAILABLE', descriptor.reason || `Install ${labels[host]} or its official CLI.`);
      await configure(host);
      return { installed: true, surface: descriptor.label,
        conversationRequired: `Use Continue in ${host === 'claude' ? 'Claude' : 'Codex'} in Companion to open its connected workspace.` };
    },
    async open(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => key !== 'host' && key !== 'preparationId')
        || !hosts.includes(input.host) || typeof input.preparationId !== 'string' || input.preparationId.length !== 36 || !uuid.test(input.preparationId))
        fail('INVALID_INPUT', 'Choose Claude or Codex and provide the application preparation UUID.');
      const { host, preparationId } = input;
      const descriptor = await describe(host);
      if (!descriptor.available)
        fail('HOST_UNAVAILABLE', `Install ${labels[host]} or its official CLI and an interactive terminal, sign in, then try again. ${descriptor.reason || ''}`.trim());
      await configure(host);
      const prompt = `Call career_application_preparation_read with {"preparationId":"${preparationId}"} using only the ${applicationConnection} MCP connection for this workspace. Follow its instructions to prepare and save this application's CV, cover letter and written answers. Use the original job description and saved career evidence; do not invent facts. Leave submission to me. If that connection or its tools are unavailable, ask me to approve the workspace and enable ${applicationConnection}; do not use another Companion connection or substitute guessed content.`;
      try { await launch(host, descriptor, prompt); }
      catch { fail('HOST_LAUNCH_FAILED', `Could not open ${descriptor.label}. Open it once and sign in, then try again. Your preparation request is saved; no prompt was sent by Companion.`); }
      return { opened: true, host, requiresSend: true, mode: descriptor.mode };
    },
    /** Open a new host conversation prefilled with the job-review prompt. The user still sends it. */
    async review(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'host') || !hosts.includes(input.host))
        fail('INVALID_INPUT', 'Choose Claude or Codex.');
      const { host } = input;
      const descriptor = await describe(host);
      if (!descriptor.available)
        fail('HOST_UNAVAILABLE', `Install ${labels[host]} or its official CLI and an interactive terminal, sign in, then try again, or copy the prompt instead.`);
      await configure(host);
      const prompt = `${REVIEW_PROMPT} If the skill is unavailable, use the ${applicationConnection} MCP connection for this workspace and its career_match_jobs tool.`;
      try { await launch(host, descriptor, prompt); }
      catch { fail('HOST_LAUNCH_FAILED', `Could not open ${descriptor.label}. Open it once and sign in, then try again, or copy the prompt instead.`); }
      return { opened: true, host, requiresSend: true, mode: descriptor.mode };
    },
  };
  async function launch(host, descriptor, prompt) {
    if (descriptor.mode === 'desktop') return openExternal(hostUrl(host, prompt).href);
    const invocation = terminalLaunch({ host, descriptor, workspace, prompt, platform });
    let args = invocation.args;
    if (invocation.source) {
      if (platform === 'darwin') {
        const script = p.join(workspace, `launch-${randomUUID()}.command`);
        await writeFile(script, invocation.source, { mode: 0o700, flag: 'wx' });
        platformRuntime.protectPrivatePath(script, { mode: 0o700 });
        args = [...args, script];
      } else args = [...args, '/bin/sh', '-c', invocation.source];
    }
    await launchTerminal(invocation.command, args, { cwd: workspace, env: hostEnvironment(env) });
  }
  function hostUrl(host, prompt) {
    const url = new URL(host === 'claude' ? 'claude://code/new' : 'codex://threads/new');
    url.searchParams.set(host === 'claude' ? 'q' : 'prompt', prompt);
    url.searchParams.set(host === 'claude' ? 'folder' : 'path', workspace);
    if (host === 'codex') url.searchParams.set('mode', 'codex');
    return url;
  }
}

export function applicationMcpToml(command, options) {
  const invocation = mcpInvocation(command, options);
  return `[mcp_servers.${applicationConnection}]\ncommand = ${JSON.stringify(invocation.command)}\nargs = ${JSON.stringify(invocation.args)}\n`
    + (invocation.env ? `\n[mcp_servers.${applicationConnection}.env]\n${Object.entries(invocation.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`).join('')}` : '');
}
