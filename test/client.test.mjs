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

test('rejected device requests report the platform status and reason', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const { privateKey } = generateKeyPairSync('ed25519');
  const client = createDeviceClient({ get: () => ({ deviceId: randomUUID(), privateKey, pairing: { origin: 'https://recruiters.rip' } }) }, false);
  const cases = [
    [403, { statusCode: 403, message: 'Device is no longer paired', error: 'Forbidden' }, 'DEVICE_UNAUTHORIZED', 'Check your membership and account connection. Platform (403): Device is no longer paired'],
    [400, { error: 'Invalid device input.' }, 'DEVICE_REQUEST_FAILED', 'The product could not accept this device operation. Platform (400): Invalid device input.'],
    [500, 'not json', 'DEVICE_REQUEST_FAILED', 'The product could not accept this device operation. Platform (500).'],
    [400, { error: `bad\u0007${'x'.repeat(400)}` }, 'DEVICE_REQUEST_FAILED', `The product could not accept this device operation. Platform (400): bad ${'x'.repeat(196)}`],
  ];
  for (const [status, body, code, message] of cases) {
    globalThis.fetch = async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    await assert.rejects(client.request('POST', '/device/platform', { operation: 'status', args: {} }), error => {
      assert.equal(error.code, code); assert.equal(error.status, status); assert.equal(error.message, message); return true;
    });
  }
});

test('only a platform report that this device is unpaired triggers recovery', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const { privateKey } = generateKeyPairSync('ed25519');
  let unpaired = 0;
  const client = createDeviceClient({ get: () => ({ deviceId: randomUUID(), privateKey, pairing: { origin: 'https://recruiters.rip' } }) }, false, { onUnpaired: async () => { unpaired++; } });
  const reply = (status, message) => { globalThis.fetch = async () => new Response(JSON.stringify({ statusCode: status, message }), { status }); };
  for (const [status, message, path, expected] of [
    [403, 'Device is not active', '/device/platform', 1], [403, 'Device is no longer paired', '/device/heartbeat', 2],
    [403, 'An active paid membership is required', '/device/platform', 2], [403, 'Device request expired', '/device/platform', 2],
    [403, 'Device is not active', '/device/activate', 2], [400, 'Device is not active', '/device/platform', 2],
  ]) {
    reply(status, message);
    await assert.rejects(client.request('POST', path, {}), { code: status === 403 ? 'DEVICE_UNAUTHORIZED' : 'DEVICE_REQUEST_FAILED' });
    assert.equal(unpaired, expected, `${status} ${message} ${path}`);
  }
});
