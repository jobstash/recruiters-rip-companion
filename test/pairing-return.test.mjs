import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startPairingReturn } from '../src/pairing-return.mjs';

const payload = Buffer.from(JSON.stringify({ productOrigin: 'http://127.0.0.1:3001', pairing: { deviceId: 'synthetic-device', account: { id: 'synthetic-account', label: 'Synthetic account' } } })).toString('base64url');
function post(connection, { body = { state: connection.companionState, payload }, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(connection.companionReturn, { method: 'POST', headers: {
      Origin: new URL(connection.companionReturn).origin, 'Content-Type': 'application/json', ...headers,
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

test('browser return waits for native approval, hides local data, and cannot be replayed while pending or complete', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers(), approval = Promise.withResolvers();
  let approvals = 0;
  const connection = await startPairingReturn({ onPair: async () => {
    approvals++; entered.resolve(); await approval.promise;
    return { privateCareerData: 'synthetic-private-source', apiKey: 'synthetic-private-key' };
  } });
  t.after(() => { approval.resolve(); connection.close(); });
  const landing = await fetch(connection.companionReturn);
  assert.equal(landing.status, 200);
  assert.equal(approvals, 0, 'Opening a page alone cannot request or approve a connection');
  let completed = false;
  const pending = post(connection).then(result => { completed = true; return result; });
  await entered.promise;
  assert.equal(completed, false, 'The browser must not claim success before native approval and activation finish');
  assert.equal((await post(connection)).status, 403);
  assert.equal(approvals, 1);
  approval.resolve();
  assert.deepEqual(await pending, { status: 200, body: { ok: true } });
  assert.equal((await post(connection)).status, 403);
  assert.equal(approvals, 1);
});

test('foreign origins, rebound hosts, missing or incorrect state, malformed payloads and oversized bodies cannot request native approval', { timeout: 5000 }, async t => {
  let approvals = 0;
  const connection = await startPairingReturn({ onPair: async () => { approvals++; } });
  t.after(() => connection.close());
  const wrongState = (connection.companionState[0] === 'A' ? 'B' : 'A') + connection.companionState.slice(1);
  for (const headers of [{ Origin: 'https://attacker.test' }, { Origin: '' }, { Host: 'attacker.test' }, { 'Content-Type': 'text/plain' }]) {
    assert.equal((await post(connection, { headers })).status, 403);
  }
  assert.equal((await post(connection, { body: { state: wrongState, payload } })).status, 403);
  for (const body of [{ payload }, { state: connection.companionState, payload: '<script>' }, { state: connection.companionState, payload: 'bm90LWpzb24' }, 'not JSON']) {
    assert.equal((await post(connection, { body })).status, 400);
  }
  assert.equal((await post(connection, { body: 'x'.repeat(13 * 1024) })).status, 413);
  assert.equal(approvals, 0);
  assert.deepEqual(await post(connection), { status: 200, body: { ok: true } }, 'Rejected unauthenticated traffic must not consume the real connection');
});

test('cancelled or rejected pairing never reports success or exposes the local error and requires a fresh connection', { timeout: 5000 }, async t => {
  let approvals = 0;
  const connection = await startPairingReturn({ onPair: async () => { approvals++; throw new Error('synthetic private activation detail'); } });
  t.after(() => connection.close());
  assert.deepEqual(await post(connection), { status: 409, body: { ok: false } });
  assert.equal((await post(connection)).status, 403);
  assert.equal(approvals, 1);
});
