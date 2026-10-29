import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, realpath } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startMcpBroker } from '../src/mcp/broker.mjs';
import { connectAuthenticated } from '../src/platform-runtime.cjs';

test('open MCP sessions are reported with the client name from initialize', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'recruiters-broker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reports = [];
  let changed = () => {};
  const broker = await startMcpBroker({ directory, onConnections: clients => { reports.push(clients); changed(); },
    createServer: () => ({ async connect() {}, async close() {} }) });
  t.after(() => broker.close());
  const next = () => new Promise(resolve => { changed = resolve; });
  const { socket, token } = JSON.parse(await readFile(path.join(directory, 'mcp-bridge.json'), 'utf8'));
  if (process.platform !== 'win32' && path.dirname(socket) !== await realpath(directory)) t.after(() => rm(path.dirname(socket), { recursive: true, force: true }));
  const open = async () => { const connection = await connectAuthenticated(socket, token, 'mcp'); connection.resume(); return connection; };

  let reported = next();
  const claude = await open(); await reported;
  reported = next(); claude.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-ai\u0007', version: '1' } } })}\n`); await reported;
  reported = next(); const codex = await open(); await reported;
  reported = next(); codex.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-mcp-client' } } })}\n`); await reported;
  reported = next(); claude.destroy(); await reported;
  const intruder = net.connect(socket); intruder.write(`${JSON.stringify({ auth: 'wrong' })}\n`);
  await new Promise(resolve => intruder.once('close', resolve));

  assert.deepEqual(reports, [[''], ['claude-ai'], ['claude-ai', ''], ['claude-ai', 'codex-mcp-client'], ['codex-mcp-client']]);
});
