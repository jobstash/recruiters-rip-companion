import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startMcpBroker } from '../src/mcp/broker.mjs';

test('open MCP sessions are reported with the client name from initialize', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'recruiters-broker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reports = [];
  let changed = () => {};
  const broker = await startMcpBroker({ directory, onConnections: clients => { reports.push(clients); changed(); },
    createServer: () => ({ async connect() {}, async close() {} }) });
  t.after(() => broker.close());
  const next = () => new Promise(resolve => { changed = resolve; });
  const { socket, token } = JSON.parse(await readFile(path.join(directory, 'mcp-bridge.json'), 'utf8'));
  const open = async () => { const connection = net.connect(socket); await new Promise(resolve => connection.once('connect', resolve)); return connection; };

  const claude = await open();
  let reported = next(); claude.write(`${JSON.stringify({ auth: token })}\n`); await reported;
  reported = next(); claude.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-ai\u0007', version: '1' } } })}\n`); await reported;
  const codex = await open();
  reported = next(); codex.write(`${JSON.stringify({ auth: token })}\n${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-mcp-client' } } })}\n`); await reported; await next();
  reported = next(); claude.destroy(); await reported;
  const intruder = await open(); intruder.write(`${JSON.stringify({ auth: 'wrong' })}\n`);
  await new Promise(resolve => intruder.once('close', resolve));

  assert.deepEqual(reports, [[''], ['claude-ai'], ['claude-ai', ''], ['claude-ai', 'codex-mcp-client'], ['codex-mcp-client']]);
});
