import { access, writeFile, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { privateDirectory } from './vault.mjs';
import { fail } from './mcp/state.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hosts = ['claude', 'codex'];
const labels = { claude: 'Claude Desktop', codex: 'ChatGPT desktop (Codex)' };
export const REVIEW_PROMPT = 'Use the recruiters.rip skill to review the jobs queued for you and show me the best matches.';
// Keep application tools distinct from an existing user-scoped registration,
// which may point to another Companion identity and override the project name.
const applicationConnection = 'recruiters-rip-applications';
const validPath = value => typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);

async function installed(host) {
  if (process.platform !== 'darwin') return false;
  const app = host === 'claude' ? 'Claude.app' : 'ChatGPT.app';
  for (const directory of ['/Applications', path.join(homedir(), 'Applications')]) {
    try { await access(path.join(directory, app, 'Contents', 'Info.plist')); return true; } catch {}
  }
  return false;
}

async function replaceConfig(filename, content) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    // Replace only our generated file; never follow an existing file symlink.
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

// Claude documents an inert composer prefill and a folder-confirmation prompt:
// https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link
// Installed ChatGPT app.asar: bootstrap-CTpobVUg.js q7/Z7/Q7 parse
// codex://threads/new with prompt, path and mode; main-B6ZOwXa3.js rXe
// passes prefillPrompt to navigation, and app-primary-15d1279f1ff0.js uses
// it as composer defaultText, not a submitted turn. No CLI inference is run.
export function createApplicationLauncher({ directory, command, openExternal, hostAvailable = installed }) {
  if (!validPath(directory) || !validPath(command) || typeof openExternal !== 'function' || typeof hostAvailable !== 'function')
    fail('INVALID_INPUT', 'Application launching needs a local workspace, Companion tool command and native link opener.');
  const workspace = path.join(directory, 'application-workspace');

  async function configure(host) {
    try { await access(command, constants.X_OK); }
    catch { fail('HOST_SETUP_REQUIRED', 'The Companion tool launcher is unavailable. Restart Companion and try preparing this application again.'); }
    try {
      await privateDirectory(directory);
      await privateDirectory(workspace);
      if (host === 'claude') {
        await replaceConfig(path.join(workspace, '.mcp.json'), JSON.stringify({
          mcpServers: { [applicationConnection]: { command, args: [] } },
        }, null, 2) + '\n');
      } else {
        await privateDirectory(path.join(workspace, '.codex'));
        // Project-scoped MCP is shared by the Codex app/CLI, after normal trust:
        // https://developers.openai.com/codex/mcp/
        await replaceConfig(path.join(workspace, '.codex', 'config.toml'),
          `[mcp_servers.${applicationConnection}]\ncommand = ${JSON.stringify(command)}\nargs = []\n`);
      }
    } catch {
      fail('HOST_SETUP_FAILED', 'Companion could not configure its application workspace. Check local storage permissions and try again.');
    }
  }

  return {
    async available() {
      const values = await Promise.all(hosts.map(host => hostAvailable(host)));
      return Object.fromEntries(hosts.map((host, index) => [host, values[index] === true]));
    },
    async open(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => key !== 'host' && key !== 'preparationId')
        || !hosts.includes(input.host) || typeof input.preparationId !== 'string' || input.preparationId.length !== 36 || !uuid.test(input.preparationId))
        fail('INVALID_INPUT', 'Choose Claude or Codex and provide the application preparation UUID.');
      const { host, preparationId } = input;
      if (await hostAvailable(host) !== true)
        fail('HOST_UNAVAILABLE', `Install ${labels[host]} on this Mac, sign in, then try again, or choose another installed host.`);
      await configure(host);
      const prompt = `Call career_application_preparation_read with {"preparationId":"${preparationId}"} using only the ${applicationConnection} MCP connection for this workspace. Follow its instructions to prepare and save this application's CV, cover letter and written answers. Use the original job description and saved career evidence; do not invent facts. Leave submission to me. If that connection or its tools are unavailable, ask me to approve the workspace and enable ${applicationConnection}; do not use another Companion connection or substitute guessed content.`;
      const url = hostUrl(host, prompt);
      try { await openExternal(url.href); }
      catch { fail('HOST_LAUNCH_FAILED', `Could not open ${labels[host]}. Open it once and sign in, then try again. Your preparation request is saved; no prompt was sent by Companion.`); }
      return { opened: true, host, requiresSend: true };
    },
    /** Open a new host conversation prefilled with the job-review prompt. The user still sends it. */
    async review(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'host') || !hosts.includes(input.host))
        fail('INVALID_INPUT', 'Choose Claude or Codex.');
      const { host } = input;
      if (await hostAvailable(host) !== true)
        fail('HOST_UNAVAILABLE', `Install ${labels[host]} on this Mac, sign in, then try again, or copy the prompt instead.`);
      await configure(host);
      const prompt = `${REVIEW_PROMPT} If the skill is unavailable, use the ${applicationConnection} MCP connection for this workspace and its career_match_jobs tool.`;
      try { await openExternal(hostUrl(host, prompt).href); }
      catch { fail('HOST_LAUNCH_FAILED', `Could not open ${labels[host]}. Open it once and sign in, then try again, or copy the prompt instead.`); }
      return { opened: true, host, requiresSend: true };
    },
  };
  function hostUrl(host, prompt) {
    const url = new URL(host === 'claude' ? 'claude://code/new' : 'codex://threads/new');
    url.searchParams.set(host === 'claude' ? 'q' : 'prompt', prompt);
    url.searchParams.set(host === 'claude' ? 'folder' : 'path', workspace);
    if (host === 'codex') url.searchParams.set('mode', 'codex');
    return url;
  }
}
