import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrescanCredentials } from '../src/prescan/credentials.mjs';

const apiKey = 'sk-test-local-credential-1234567890';
function fixture() {
  let state = { career: { profile: { name: 'Candidate' } } }, changes = 0;
  const store = { get: () => structuredClone(state), async update(change) { const next = structuredClone(state); await change(next); state = next; } };
  const credentials = createPrescanCredentials({ store, onChange: async () => { changes++; } });
  return { store, credentials, changes: () => changes };
}

test('save/read/remove keep key at root and only expose a secret-free descriptor', async () => {
  const { store, credentials, changes } = fixture();
  assert.deepEqual(credentials.publicState(), { provider: 'openai', model: 'gpt-6-luna', configured: false, credentialVersion: 0, inputUsdPerMillion: 0.1,
    providers: [{ id: 'openai', label: 'OpenAI Decisions', model: 'gpt-6-luna', inputUsdPerMillion: 0.1 }] });
  assert.throws(() => credentials.read('openai'), { code: 'PRESCAN_KEY_REQUIRED' });
  const career = store.get().career;
  const saved = await credentials.save({ provider: 'openai', apiKey });
  assert.equal(saved.configured, true); assert.equal(saved.credentialVersion, 1);
  assert.deepEqual(Object.keys(saved).sort(), ['configured', 'credentialVersion', 'inputUsdPerMillion', 'model', 'provider', 'providers']);
  assert.deepEqual(credentials.read('openai'), { apiKey, credentialVersion: 1 });
  assert.equal(store.get().prescanCredentials.openai.apiKey, apiKey);
  assert.ok(Number.isFinite(Date.parse(store.get().prescanCredentials.openai.updatedAt)));
  assert.deepEqual(store.get().career, career);
  assert.equal(JSON.stringify(saved).includes('1234567890'), false);
  saved.providers[0].label = 'Changed by caller';
  assert.equal(credentials.publicState().providers[0].label, 'OpenAI Decisions');
  await credentials.save({ provider: 'openai', apiKey: `${apiKey}-replacement` });
  assert.equal(credentials.publicState().credentialVersion, 2);
  const removed = await credentials.remove({ provider: 'openai' });
  assert.equal(removed.configured, false); assert.equal(removed.credentialVersion, 3);
  assert.equal(JSON.stringify(store.get()).includes('sk-'), false);
  assert.throws(() => credentials.read('openai'), { code: 'PRESCAN_KEY_REQUIRED' });
  assert.equal(changes(), 3);
});

test('keys require plain API format without whitespace, controls, JWTs or caller endpoints', async () => {
  const { store, credentials, changes } = fixture();
  for (const key of [null, 42, '', 'sk-short', 'eyJ.fake.jwt', `Bearer ${apiKey}`, ` ${apiKey}`, `${apiKey}\n`, `${apiKey}\r`, `${apiKey}\t`, `${apiKey}\0`, 'sk-' + 'a'.repeat(501)]) {
    await assert.rejects(credentials.save({ provider: 'openai', apiKey: key }), { code: 'PRESCAN_INVALID_KEY' });
  }
  for (const provider of ['jev', '__proto__', undefined]) {
    await assert.rejects(credentials.save({ provider, apiKey }), { code: 'PRESCAN_UNSUPPORTED_PROVIDER' });
    assert.throws(() => credentials.read(provider), { code: 'PRESCAN_UNSUPPORTED_PROVIDER' });
  }
  await assert.rejects(credentials.save({ provider: 'openai', apiKey, endpoint: 'https://evil.invalid' }), { code: 'PRESCAN_INVALID_INPUT' });
  assert.equal(store.get().prescanCredentials, undefined); assert.equal(changes(), 0);
});

test('failed credential persistence does not notify or claim configured state', async () => {
  let changed = false;
  const credentials = createPrescanCredentials({ store: { get: () => ({}), async update() { throw new Error('Storage unavailable'); } }, onChange: () => { changed = true; } });
  await assert.rejects(credentials.save({ provider: 'openai', apiKey }));
  assert.equal(changed, false); assert.equal(credentials.publicState().configured, false);
});
