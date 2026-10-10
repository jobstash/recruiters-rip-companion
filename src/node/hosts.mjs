import { access, cp, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exec, npm } from './system.mjs';
import { cleanEnvironment, root } from './paths.mjs';
import { privateDirectory } from '../vault.mjs';
export async function findCodex(base) {
  const candidates = [path.join(base, 'ai', 'node_modules', '@openai/codex/bin/codex.js'), 'codex', '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', '/Applications/ChatGPT.app/Contents/Resources/codex'];
  for (const candidate of candidates) {
    try { const command = candidate.endsWith('.js') ? process.execPath : candidate, prefix = candidate.endsWith('.js') ? [candidate] : []; await exec(command, [...prefix, '--version'], { env: cleanEnvironment(), timeout: 10000 }); return { command, prefix }; } catch {}
  }
  return null;
}
export async function codexStatus(host, execute = exec) {
  try { const { stdout, stderr } = await execute(host.command, [...host.prefix, 'login', 'status'], { env: cleanEnvironment(), timeout: 15000 }); return /ChatGPT/i.test(stdout + stderr) ? 'signed_in' : 'subscription_required'; }
  catch { return 'sign_in_required'; }
}
export async function mergeClaudeConfig(filename, transport) {
  let config = {};
  try { config = JSON.parse(await readFile(filename, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('Claude settings could not be read. Repair its JSON before installing this connection.'); }
  if (!config || Array.isArray(config) || typeof config !== 'object' || (config.mcpServers && (typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)))) throw new Error('Claude settings are not a settings object.');
  const old = config.mcpServers?.['recruiters-rip'];
  if (old && !JSON.stringify(old).includes('Recruiters Companion') && !JSON.stringify(old).includes('recruiters-node') && JSON.stringify(old) !== JSON.stringify(transport)) throw new Error('A different MCP server already uses the name recruiters-rip. Rename that entry in Claude settings first.');
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  if (await access(filename).then(() => true, () => false)) await cp(filename, `${filename}.recruiters-backup-${Date.now()}`, { errorOnExist: true, force: false });
  config.mcpServers = { ...config.mcpServers, 'recruiters-rip': transport };
  const temp = `${filename}.recruiters.tmp`; await writeFile(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temp, filename);
}
export async function installHost(kind, paths, { notify = () => {}, home = os.homedir(), discover = findCodex, execute = exec, install = npm } = {}) {
  const transport = { command: process.execPath, args: [path.join(root, 'bin/recruiters.mjs'), 'mcp', ...(paths.localOnly ? ['--local-product'] : [])] };
  if (kind === 'codex') {
    let host = await discover(paths.base);
    if (!host) { notify('Installing Codex…'); await privateDirectory(path.join(paths.base, 'ai')); await install(['install', '--no-audit', '--no-fund', '@openai/codex'], { cwd: path.join(paths.base, 'ai'), stdio: ['ignore', 'ignore', 'pipe'] }); host = await discover(paths.base); }
    if (!host) throw new Error('Codex did not finish installing. Check that npm can reach registry.npmjs.org.');
    const run = args => execute(host.command, [...host.prefix, ...args], { env: cleanEnvironment(), timeout: 60000 });
    let previous;
    try { previous = JSON.parse((await run(['mcp', 'get', 'recruiters-rip', '--json'])).stdout); } catch {}
    if (previous && !JSON.stringify(previous).includes('Recruiters Companion') && !JSON.stringify(previous).includes('recruiters-node')) throw new Error('A different MCP server already uses recruiters-rip. Rename it in Codex settings first.');
    await run(['mcp', 'add', 'recruiters-rip', '--', transport.command, ...transport.args]);
    const skill = path.join(home, '.agents', 'skills', 'recruiters-rip');
    // Back up the named skill before replacing; never alter other skills.
    if (await access(skill).then(() => true, () => false)) await cp(skill, `${skill}.backup-${Date.now()}`, { recursive: true });
    await mkdir(path.dirname(skill), { recursive: true }); await cp(path.join(root, 'skills/recruiters-rip'), skill, { recursive: true });
    const registered = JSON.parse((await run(['mcp', 'get', 'recruiters-rip', '--json'])).stdout);
    if (registered.transport?.command !== transport.command || JSON.stringify(registered.transport?.args) !== JSON.stringify(transport.args)) throw new Error('Codex did not retain the MCP settings. Check its settings file permissions.');
    return { kind, installed: true, auth: await codexStatus(host, execute), host, message: 'Skill and local tools installed. Start a new Codex conversation and ask “Use Recruiters.rip”.' };
  }
  if (kind === 'claude') {
    if (!['darwin','win32'].includes(process.platform)) throw new Error('Claude Desktop is supported on macOS and Windows. Choose Codex on Linux.');
    const directory = process.platform === 'darwin' ? path.join(home, 'Library/Application Support/Claude') : path.join(process.env.APPDATA, 'Claude');
    await mergeClaudeConfig(path.join(directory, 'claude_desktop_config.json'), transport);
    // Claude Desktop receives the full conversation instructions through MCP.
    // A portable skill copy is available for hosts supporting skill folders.
    await cp(path.join(root, 'skills/recruiters-rip'), path.join(paths.directory, 'skills/recruiters-rip'), { recursive: true });
    return { kind, installed: true, auth: 'sign_in_in_claude', message: 'Local tools installed. Quit and reopen Claude, enable Recruiters.rip, and use your Claude subscription. The career instructions are included in the tool connection.' };
  }
  throw new Error('Choose Codex or Claude Desktop.');
}
