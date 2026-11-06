import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, realpath } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startMcpBroker } from '../src/mcp/broker.mjs';
import { connectAuthenticated } from '../src/platform-runtime.cjs';
import { once } from 'node:events';

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

test('MCP broker bounds queued messages while session setup is pending', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'recruiters-broker-queue-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reports = [];
  let release;
  const connecting = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const broker = await startMcpBroker({ directory, onConnections: clients => reports.push(clients),
    createServer: () => ({ async connect() { await connecting; }, async close() {} }) });
  t.after(() => broker.close());
  const config = JSON.parse(await readFile(path.join(directory, 'mcp-bridge.json'), 'utf8'));
  const socket = await connectAuthenticated(config.socket, config.token, 'mcp');
  t.after(() => socket.destroy());
  const closed = once(socket, 'close');
  socket.resume();
  socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`.repeat(65));
  await closed;
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reports, [], 'a disconnected session must not be registered after setup completes');
});

test('MCP broker closes connections that have not authenticated', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'recruiters-broker-close-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const broker = await startMcpBroker({ directory, createServer: () => assert.fail('Unauthenticated connection') });
  t.after(() => broker.close());
  const config = JSON.parse(await readFile(path.join(directory, 'mcp-bridge.json'), 'utf8'));
  const socket = net.connect(config.socket);
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const closed = once(socket, 'close');
  broker.disconnect();
  await closed;
});

test('MCP broker bounds total queued bytes rather than only individual frames', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'recruiters-broker-bytes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let release;
  const connecting = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const broker = await startMcpBroker({ directory,
    createServer: () => ({ async connect() { await connecting; }, async close() {} }) });
  t.after(() => broker.close());
  const config = JSON.parse(await readFile(path.join(directory, 'mcp-bridge.json'), 'utf8'));
  const socket = await connectAuthenticated(config.socket, config.token, 'mcp');
  t.after(() => socket.destroy());
  socket.on('error', error => assert.ok(['ECONNRESET', 'EPIPE'].includes(error.code)));
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.resume();
  const frame = `${JSON.stringify({ jsonrpc: '2.0', method: 'fixture', params: 'x'.repeat(1024 * 1024) })}\n`;
  for (let index = 0; index < 17 && !socket.destroyed; index++) {
    socket.write(frame);
    await new Promise(resolve => setImmediate(resolve));
  }
  await closed;
});
