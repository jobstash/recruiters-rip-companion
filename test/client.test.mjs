import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createDeviceClient } from '../src/client.mjs';

test('local and production clients refuse cross-environment stored origins before network access', async t => {
  const original = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('Network access forbidden in this boundary test'); };
  t.after(() => { globalThis.fetch = original; });
  const { privateKey } = generateKeyPairSync('ed25519');
  for (const [localOnly, origin] of [[true, 'https://recruiters.rip'], [false, 'http://127.0.0.1:3001'], [true, 'http://localhost:3001'], [false, 'https://attacker.test']]) {
    const store = { get: () => ({ deviceId: randomUUID(), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), pairing: { origin } }) };
    await assert.rejects(createDeviceClient(store, localOnly).request('POST', '/device/platform', { operation: 'status', args: {} }), /Pair this computer/);
  }
  assert.equal(networkCalls, 0);
});

test('retired provider and arbitrary signed requests never reach device credentials or the network', async () => {
  const client = createDeviceClient({ get: () => assert.fail('Rejected operation read the private identity') }, true);
  for (const route of ['/device/connections', '/device/claim', '/device/voice/sessions', '/device/platform/../../admin', 'https://attacker.test'])
    await assert.rejects(client.request('POST', route, {}), /Device operation is unavailable/);
});

test('production transfer limits reject oversized requests before sending and oversized feed responses', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const { privateKey } = generateKeyPairSync('ed25519');
  const state = { deviceId: randomUUID(), privateKey, pairing: { origin: 'https://recruiters.rip' } };
  const client = createDeviceClient({ get: () => state }, false);
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; return new Response(Buffer.alloc(8 * 1024 * 1024 + 1, 32)); };
  await assert.rejects(client.request('POST', '/device/platform', { operation: 'job_read', args: { id: 'x'.repeat(16 * 1024) } }), /16 KiB/);
  assert.equal(networkCalls, 0);
  await assert.rejects(client.request('POST', '/device/platform', { operation: 'status', args: {} }), /8 MiB/);
  assert.equal(networkCalls, 1);
});
