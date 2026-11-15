import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createScopedAccess } from '../src/mcp/scope.mjs';
import { createMcpServer } from '../src/mcp/server.mjs';
import { startMcpBroker } from '../src/mcp/broker.mjs';
import { connectAuthenticated } from '../src/platform-runtime.cjs';
import { createUpdateWorkGate, UPDATE_QUIET_WINDOW } from '../src/update-scheduler.mjs';
import { fail } from '../src/mcp/state.mjs';

const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Main lifecycle section: ${start}`);
  return source.slice(first, last);
}
function fixture() {
  let state = { deviceId: 'synthetic-device', pairing: { origin: 'https://example.test', account: { id: 'first-owner' } }, career: {}, value: 0 };
  let queue = Promise.resolve(), time = UPDATE_QUIET_WINDOW;
  const calls = [], powerMonitor = new EventEmitter();
  const vault = {
    get: () => structuredClone(state),
    select: project => structuredClone(project(state)),
    async open() { calls.push('open'); },
    update(change, { beforeCommit } = {}) {
      const pending = queue.then(async () => {
        const next = structuredClone(state);
        await change(next); beforeCommit?.(); state = next;
      });
      queue = pending.catch(() => {}); return pending;
    },
  };
  const context = vm.createContext({
    vault, randomUUID, fail, powerMonitor, locked: false, sleeping: false, quitDraining: false, updateInstalling: false,
    restoringBackup: false, initializing: undefined, vaultOpened: true, sessionEpoch: 0, failure: '',
    workGate: createUpdateWorkGate({ now: () => time }),
    browserForms: { cancelAll() { calls.push('cancel-forms'); } },
    backups: { cancel() { calls.push('cancel-backup'); } },
    jobsCatalogue: { reset() { calls.push('reset-jobs'); }, async load() { calls.push('load-jobs'); } },
    mcpBridge: { disconnect() { calls.push('disconnect'); } },
    pendingApproval: { finish() { calls.push('cancel-approval'); } },
    pairingReturn: { close() { calls.push('close-pairing'); } },
    updateScheduler: { async resume() { calls.push('resume-updates'); } },
    emit() { calls.push('emit'); }, localOnly: false, upgradeCareer: career => career,
    createDeviceClient: () => ({}), createDocumentFiles: () => ({}), directory: '/synthetic', forgetRevokedPairing() {},
    packageMetadata: { version: 'test' }, browserExtensions: {}, reviewHostInfo: {}, reviewHosts: {},
    decisionCredentialStatus: () => ({ configured: false }),
  });
  vm.runInContext(section('const identityKey =', 'function assertWorkAllowed()') +
    section('function assertWorkAllowed()', 'async function mutation(') +
    section('function assertStorageAvailable()', 'function safeFailure(') +
    section('function status()', 'function setup()') +
    section('function loadJobs(', 'const backups =') +
    section('function observePowerEvents()', 'function object(') +
    '\nobservePowerEvents(); globalThis.store = store;', context);
  const scoped = () => createScopedAccess(context.store, { assertAvailable: context.assertAvailable, epoch: () => context.sessionEpoch });
  return { context, calls, scoped, powerMonitor, advance: amount => { time += amount; } };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// These are the exact Electron event hooks; emitting them never accesses a user profile.
test('an authenticated MCP session reads and saves across lock, unlock, suspend and resume', { timeout: process.platform === 'win32' ? 300000 : 30000 }, async t => {
  const f = fixture(), access = f.scoped(), directory = await mkdtemp(path.join(os.tmpdir(), 'recruiters-power-session-'));
  let connection, socketDirectory, sessions = 0;
  const broker = await startMcpBroker({ directory, createServer: () => {
    sessions++;
    return createMcpServer({ assertAvailable: access.assertAvailable, listResources: () => [], readResource: () => {}, tools: [{
      name: 'synthetic_value', description: 'Read or save synthetic lifecycle data.',
      inputSchema: { type: 'object', properties: { value: { type: 'integer' } }, additionalProperties: false },
      async invoke({ value }) { if (value !== undefined) await access.store.update(state => { state.value = value; }); return { value: access.store.get().value }; },
    }] });
  } });
  t.after(async () => {
    connection?.destroy(); broker.close(); await rm(directory, { recursive: true, force: true });
    if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
  });
  const config = JSON.parse(await readFile(path.join(directory, 'mcp-bridge.json'), 'utf8'));
  if (process.platform !== 'win32' && path.dirname(config.socket) !== await realpath(directory)) socketDirectory = path.dirname(config.socket);
  connection = await connectAuthenticated(config.socket, config.token, 'mcp');
  let input = '', sequence = 0;
  const pending = new Map();
  connection.on('data', chunk => {
    input += chunk.toString();
    for (;;) {
      const end = input.indexOf('\n'); if (end < 0) break;
      const message = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
      const waiting = pending.get(message.id);
      if (waiting) { pending.delete(message.id); waiting.resolve(message); }
    }
  });
  connection.on('error', error => { for (const waiting of pending.values()) waiting.reject(error); });
  connection.on('close', () => { for (const waiting of pending.values()) waiting.reject(new Error('Session disconnected')); });
  connection.resume();
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    connection.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const initialized = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'synthetic-lifecycle', version: '1' } });
  assert.ok(initialized.result);
  connection.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  for (const [index, event] of ['lock-screen', 'suspend', 'unlock-screen', 'resume', 'lock-screen', 'unlock-screen'].entries()) {
    f.powerMonitor.emit(event);
    assert.equal(f.context.status().execution.state, 'ready', event);
    const saved = await request('tools/call', { name: 'synthetic_value', arguments: { value: index + 1 } });
    assert.equal(saved.result.isError, undefined, event);
    assert.equal(JSON.parse(saved.result.content[0].text).value, index + 1, event);
    const read = await request('tools/call', { name: 'synthetic_value', arguments: {} });
    assert.equal(JSON.parse(read.result.content[0].text).value, index + 1, event);
  }
  assert.equal(sessions, 1); assert.equal(f.context.sessionEpoch, 0); assert.equal(connection.destroyed, false);
  assert.deepEqual(f.calls, ['emit', 'resume-updates', 'load-jobs']);
  await f.context.store.update(state => { state.pairing.account.id = 'replacement-owner'; });
  const rejected = await request('tools/call', { name: 'synthetic_value', arguments: { value: 99 } });
  assert.equal(JSON.parse(rejected.result.content[0].text).error.code, 'IDENTITY_CHANGED');
  assert.equal(f.context.store.get().value, 6);
});

test('accepted writes survive OS power events without cancellation or a new storage session', async () => {
  const f = fixture(), access = f.scoped(), started = deferred(), finish = deferred();
  const pending = access.store.update(async state => { state.value = 7; started.resolve(); await finish.promise; });
  await started.promise;
  for (const event of ['lock-screen', 'suspend', 'resume', 'unlock-screen']) f.powerMonitor.emit(event);
  finish.resolve(); await pending;
  assert.equal(access.store.get().value, 7); assert.equal(f.context.sessionEpoch, 0);
  assert.ok(!f.calls.some(call => /cancel|reset|disconnect|close|open/.test(call)));
});

test('suspend only pauses catalogue scheduling and resume renews update quiet time', async () => {
  const f = fixture(); f.advance(UPDATE_QUIET_WINDOW);
  assert.equal(f.context.workGate.quiet(), true);
  f.powerMonitor.emit('suspend'); f.context.loadJobs();
  await Promise.resolve(); assert.deepEqual(f.calls, []);
  assert.doesNotThrow(() => f.scoped().store.get());
  f.powerMonitor.emit('resume'); await Promise.resolve();
  assert.equal(f.context.sleeping, false); assert.equal(f.context.workGate.quiet(), false);
  assert.deepEqual(f.calls, ['emit', 'resume-updates', 'load-jobs']);
});

test('storage-open failure remains closed through every power event and does not retry on resume', async () => {
  const f = fixture(); f.context.locked = true; f.context.vaultOpened = false;
  f.context.vault.open = async () => { f.calls.push('failed-open'); throw new Error('Synthetic storage failure'); };
  await assert.rejects(f.context.initialize(), /Synthetic storage failure/);
  for (const event of ['lock-screen', 'unlock-screen', 'suspend', 'resume']) {
    f.powerMonitor.emit(event);
    assert.throws(() => f.scoped().store.get(), { code: 'LOCAL_LOCKED' });
  }
  assert.equal(f.context.locked, true); assert.equal(f.context.vaultOpened, false);
  assert.equal(f.calls.filter(call => call === 'failed-open').length, 1);
});

test('startup is not gated by OS suspend and explicit update/shutdown admission stays closed', async () => {
  const f = fixture(); f.context.locked = true; f.context.vaultOpened = false;
  f.powerMonitor.emit('suspend'); await f.context.initialize();
  assert.equal(f.context.locked, false); assert.equal(f.context.vaultOpened, true);
  for (const field of ['updateInstalling', 'quitDraining']) {
    f.context[field] = true;
    assert.throws(() => f.context.assertWorkAllowed(), { code: 'LOCAL_BUSY' });
    f.context[field] = false;
  }
});

test('real account, origin, device and profile replacement still invalidate old scoped access', async () => {
  for (const replace of [state => { state.pairing.account.id = 'other-owner'; }, state => { state.pairing.origin = 'https://other.test'; }, state => { state.deviceId = 'other-device'; }]) {
    const f = fixture(), old = f.scoped(); old.store.get();
    await f.context.store.update(replace);
    assert.throws(() => old.store.get(), { code: 'IDENTITY_CHANGED' });
    assert.throws(() => old.store.update(state => { state.value = 99; }), { code: 'IDENTITY_CHANGED' });
    assert.equal(f.context.store.get().value, 0);
  }
  const f = fixture(), old = f.scoped(); old.store.get(); f.context.sessionEpoch++;
  assert.throws(() => old.store.get(), { code: 'IDENTITY_CHANGED' });
});
