import { access, cp, mkdir, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { privateDirectory } from './vault.mjs';
import { fail } from './mcp/state.mjs';

const exec = promisify(execFile);
export async function findChatGptCli() {
  for (const candidate of [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex',
  ]) {
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  fail('HOST_UNAVAILABLE', 'Install ChatGPT desktop before installing the Recruiters.rip local plugin. This integration uses local Work/Codex tasks, not ordinary ChatGPT chats.');
}
export async function installChatGptPlugin({ directory, root, localOnly, command }) {
  const cli = await findChatGptCli();
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
    mcpServers: { 'recruiters-rip': { command, args: [] } },
  }, null, 2) + '\n', { mode: 0o600 });
  await writeFile(path.join(integration, '.agents/plugins/marketplace.json'), JSON.stringify({
    name: marketplace, interface: { displayName: 'Recruiters.rip' },
    plugins: [{ name: 'recruiters-rip', source: { source: 'local', path: './plugins/recruiters-rip' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
  }, null, 2) + '\n', { mode: 0o600 });
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'CODEX_HOME'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const run = args => exec(cli, args, { cwd: integration, env, timeout: 60000, maxBuffer: 1024 * 1024 });
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
    const result = { installed: true, plugin: `recruiters-rip@${marketplace}`, name: 'Recruiters.rip', surface: 'ChatGPT desktop local Work/Codex',
      conversationRequired: 'Start a new local Work/Codex task with the Recruiters.rip plugin. Ordinary ChatGPT chats do not inherit this local MCP connection.' };
    return result;
  } catch {
    fail('HOST_INSTALL_FAILED', 'ChatGPT could not install the Recruiters.rip local plugin. Open ChatGPT desktop plugin settings and check the local marketplace. No provider credentials are required.');
  }
}
