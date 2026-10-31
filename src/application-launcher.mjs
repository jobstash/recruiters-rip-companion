import { rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { privateDirectory } from './vault.mjs';
import { fail } from './mcp/state.mjs';
import { discoverHost, hostEnvironment, mcpServerName } from './host-setup.mjs';
import platformRuntime from './platform-runtime.cjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hosts = ['claude', 'codex'];
const labels = { claude: 'Claude Desktop', codex: 'ChatGPT desktop (Codex)' };
export const REVIEW_PROMPT = 'Use the recruiters.rip skill to review the jobs queued for you and show me the best matches.';
// What the user does when the host session has no recruiters.rip tools: the same restart Settings asks for after Set up.
const restartAfterSetup = (host, mode) => host === 'codex' ? 'restart Codex'
  : mode === 'cli' ? 'start a new Claude Code session' : 'quit Claude completely and reopen it';

/** The handoff uses the connection Set up installed for this host: the Codex plugin bundles recruiters-rip and Claude gets the
 *  user-level entry. Both load in every folder, so the request needs no workspace approval. */
export function preparationPrompt({ host, mode, preparationId, localOnly = false }) {
  const server = host === 'codex' ? 'recruiters-rip' : mcpServerName(localOnly);
  return `Use the recruiters.rip tools (MCP server ${server}) to call career_application_preparation_read with {"preparationId":"${preparationId}"}, then follow its instructions to prepare and save this application's tailored CV, concise job-specific introduction as its cover letter, both PDFs and an answer for every form question my saved evidence supports, written answers and Yes/No choices alike. Use the original job description and saved career evidence; do not invent facts. Leave submission to me. If no recruiters.rip tools are available here, tell me to choose Set up for ${host === 'codex' ? 'Codex' : 'Claude'} in Recruiters Companion Settings → AI apps, then ${restartAfterSetup(host, mode)} and send this request again; do not substitute guessed content.`;
}
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

// Companion 3.12.14 and earlier wrote a workspace-scoped MCP server here. Claude asks the user to approve such a project server
// before loading it, so the leftover would only add an approval prompt beside the installed connection.
const legacyWorkspaceConfig = ['.mcp.json', '.codex'];

// Both documented desktop links prefill only; normal host trust/send prompts
// remain in charge. CLI arguments: Codex --cd PATH [PROMPT], Claude [PROMPT].
// https://developers.openai.com/codex/app/commands
// https://code.claude.com/docs/en/cli-reference
export function createApplicationLauncher({ directory, localOnly = false, openExternal, hostAvailable,
  platform = process.platform, env = process.env, discover = discoverHost, launchTerminal = startTerminal, protocolAvailable }) {
  if (!validPath(directory, platform) || typeof openExternal !== 'function'
    || (hostAvailable !== undefined && typeof hostAvailable !== 'function') || typeof discover !== 'function' || typeof launchTerminal !== 'function')
    fail('INVALID_INPUT', 'Application launching needs a local workspace and native link opener.');
  const p = platform === 'win32' ? path.win32 : path;
  const workspace = p.join(directory, 'application-workspace');
  const describe = async host => hostAvailable
    ? { available: await hostAvailable(host) === true, mode: 'desktop', label: labels[host], reason: null }
    : discover(host, { platform, env, protocolAvailable });

  // The host session opens in this private, empty folder; its tools come from the host's own Set up.
  async function prepareWorkspace() {
    try {
      await privateDirectory(directory);
      await privateDirectory(workspace);
      for (const name of legacyWorkspaceConfig) await rm(p.join(workspace, name), { recursive: true, force: true });
    } catch {
      fail('HOST_SETUP_FAILED', 'Companion could not prepare its application workspace. Check local storage permissions and try again.');
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
    async open(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => key !== 'host' && key !== 'preparationId')
        || !hosts.includes(input.host) || typeof input.preparationId !== 'string' || input.preparationId.length !== 36 || !uuid.test(input.preparationId))
        fail('INVALID_INPUT', 'Choose Claude or Codex and provide the application preparation UUID.');
      const { host, preparationId } = input;
      const descriptor = await describe(host);
      if (!descriptor.available)
        fail('HOST_UNAVAILABLE', `Install ${labels[host]} or its official CLI and an interactive terminal, sign in, then try again. ${descriptor.reason || ''}`.trim());
      await prepareWorkspace();
      const prompt = preparationPrompt({ host, mode: descriptor.mode, preparationId, localOnly });
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
      await prepareWorkspace();
      const prompt = `${REVIEW_PROMPT} If the skill is unavailable, use the recruiters.rip MCP tools, starting with career_match_jobs.`;
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
