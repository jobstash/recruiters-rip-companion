import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, sign, verify } from 'node:crypto';
import { mkdtemp, rm, readFile, chmod, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVault } from '../src/vault.mjs';
import { CAREER_SCHEMA, createCareerState, mutateCareer, replayCareer, readCareer, upgradeCareer } from '../src/mcp/state.mjs';
import { createPrescanCredentials } from '../src/prescan/credentials.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'recruiters-career-vault-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vault = createVault(directory); await vault.open();
  return { vault, directory, reopen: () => createVault(directory) };
}
const publicKey = state => createPublicKey({ key: Buffer.from(state.publicKey, 'base64url'), format: 'der', type: 'spki' });

test('identity reset isolates old private career data while keeping recoverable archives', async t => {
  const { vault, reopen, directory } = await fixture(t);
  await vault.update(state => { state.pairing = { origin: 'https://recruiters.rip', account: { id: 'old-owner', label: 'Old account' } }; state.career.profile.name = 'Private candidate sentinel'; state.career.sources.one = { text: 'Original source sentinel' }; });
  const old = vault.get(), result = await vault.resetIdentity();
  const reopened = reopen(); await reopened.open(); const current = reopened.get();
  assert.notEqual(current.deviceId, old.deviceId); assert.equal(result.remoteDeviceRevoked, false);
  const challenge = Buffer.from('new identity');
  assert.equal(verify(null, challenge, publicKey(current), sign(null, challenge, current.privateKey)), true);
  assert.equal(verify(null, challenge, publicKey(old), sign(null, challenge, current.privateKey)), false);
  assert.equal(current.pairing, null); assert.equal(current.career.profile.name, null); assert.deepEqual(current.career.sources, {});
  assert.deepEqual(current.identityArchives[old.deviceId].career, old.career);
  assert.equal(current.identityArchives[old.deviceId].privateKey, undefined);
  assert.equal((await stat(path.join(directory, 'vault.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});

test('pre-scan keys persist only in root state and are never archived on reset', async t => {
  const { vault, reopen, directory } = await fixture(t);
  const credentials = createPrescanCredentials({ store: vault });
  const apiKey = 'sk-test-vault-credential-sentinel-1234567890';
  const beforeCareer = vault.get().career;
  const saved = await credentials.save({ provider: 'openai', apiKey });
  assert.equal(saved.configured, true);
  assert.equal(saved.credentialVersion, 1);
  assert.equal(JSON.stringify(saved).includes(apiKey), false);
  assert.equal(JSON.stringify(saved).includes('sentinel'), false);
  assert.deepEqual(vault.get().career, beforeCareer);
  assert.equal(JSON.stringify(vault.get().career).includes(apiKey), false);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'vault.json'), 'utf8')).prescanCredentials.openai.apiKey, apiKey);
  const reopened = reopen(); await reopened.open();
  assert.deepEqual(createPrescanCredentials({ store: reopened }).read('openai'), { apiKey, credentialVersion: 1 });
  const oldId = reopened.get().deviceId;
  await reopened.resetIdentity();
  assert.equal(reopened.get().prescanCredentials, undefined);
  assert.equal(reopened.get().identityArchives[oldId].prescanCredentials, undefined);
  assert.equal(JSON.stringify(reopened.get()).includes(apiKey), false);
  const afterReset = reopen(); await afterReset.open();
  assert.equal(createPrescanCredentials({ store: afterReset }).publicState().configured, false);
  assert.throws(() => createPrescanCredentials({ store: afterReset }).read('openai'), { code: 'PRESCAN_KEY_REQUIRED' });
});

test('a v1 career opens as v2 keeping only CV sources and profile', async t => {
  const { vault, reopen } = await fixture(t);
  const profile = { ...createCareerState().profile, name: 'Synthetic candidate', headline: 'Platform engineer', preferences: { salaryMinimum: 90000 } };
  const sources = { one: { purpose: 'cv', name: 'CV', text: 'Synthetic CV text', archived: false } };
  await vault.update(state => {
    state.career = { version: 1, revision: 7, evidenceRevision: 3, rankingVersion: 5, profile, sources,
      facts: { f: { id: 'f', kind: 'note', subject: 'Team size', answer: 'Eight' } }, interviews: { i: { id: 'i' } },
      applications: { a: { id: 'a', job: { title: 'Engineer', company: 'Acme' } } }, matching: { scores: { 'node:1': { overall: 80 } } },
      prescan: { runs: {} }, receipts: { r: { operation: 'career_facts_save' } } };
  });
  const legacy = reopen(); await legacy.open();
  await legacy.update(state => { state.career = upgradeCareer(state.career); });
  const reopened = reopen(); await reopened.open(); const { career } = reopened.get();
  assert.equal(career.version, CAREER_SCHEMA);
  assert.deepEqual(career, { ...createCareerState(), profile, sources, evidenceRevision: 4, rankingVersion: 6 });
  assert.equal(upgradeCareer(career), career);
});

test('failed commit preserves previous career revision and identity after reopen', async t => {
  const { vault, reopen, directory } = await fixture(t); const before = vault.get();
  await chmod(directory, 0o500);
  try { await assert.rejects(vault.resetIdentity()); } finally { await chmod(directory, 0o700); }
  assert.deepEqual(vault.get(), before); const reopened = reopen(); await reopened.open(); assert.deepEqual(reopened.get(), before);
});

test('mutations preserve immutable replay receipts and reject conflicting identities and revisions', async t => {
  const { vault } = await fixture(t);
  const input = { requestId: '10000000-0000-4000-8000-000000000001', revision: 0, name: 'First name' };
  const first = await mutateCareer(vault, input, 'set-name', input, career => { career.profile.name = input.name; return { profile: career.profile }; });
  first.profile.name = 'Caller mutation';
  const next = { requestId: '10000000-0000-4000-8000-000000000002', revision: 1, name: 'Corrected name' };
  await mutateCareer(vault, next, 'set-name', next, career => { career.profile.name = next.name; return { profile: career.profile }; });
  assert.equal(replayCareer(vault, input, 'set-name', input).profile.name, 'First name');
  assert.equal(readCareer(vault).profile.name, 'Corrected name');
  assert.throws(() => replayCareer(vault, input, 'set-name', { ...input, name: 'Different' }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(mutateCareer(vault, { ...next, requestId: '10000000-0000-4000-8000-000000000003' }, 'set-name', {}, () => ({})), { code: 'REVISION_CONFLICT' });
});

test('concurrent writes cannot both commit against the same career revision', async t => {
  const { vault } = await fixture(t);
  const results = await Promise.allSettled([1, 2].map(i => { const input = { requestId: `10000000-0000-4000-8000-00000000000${i}`, revision: 0 }; return mutateCareer(vault, input, 'save', input, career => { career.profile.name = String(i); return { name: String(i) }; }); }));
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.find(value => value.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  assert.equal(readCareer(vault).revision, 1);
});

test('flush waits for accepted writes without changing career data or identity', async t => {
  const { vault, directory } = await fixture(t);
  const before = vault.get();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = vault.update(async state => { await gate; state.career.profile.name = 'Saved before exit'; });
  let finished = false;
  const flushed = vault.flush().then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  release();
  await flushed; await pending;
  const saved = JSON.parse(await readFile(path.join(directory, 'vault.json'), 'utf8'));
  assert.equal(saved.career.profile.name, 'Saved before exit');
  assert.equal(saved.career.revision, before.career.revision);
  assert.equal(saved.deviceId, before.deviceId);
});

test('a revoked pairing is forgotten, then the identity is replaced while career data and exports stay', async t => {
  const { mkdir, writeFile, readFile: read } = await import('node:fs/promises');
  const { vault, directory, reopen } = await fixture(t);
  await vault.update(state => { state.pairing = { origin: 'https://recruiters.rip', account: { id: '602677', label: 'Synthetic account' } }; state.career.sources.one = { text: 'Kept source sentinel' }; });
  const old = vault.get();
  const exports = path.join(directory, 'career-files', old.deviceId, 'exports');
  await mkdir(exports, { recursive: true, mode: 0o700 }); await writeFile(path.join(exports, 'a.pdf'), 'pdf sentinel');

  await vault.forgetPairing();
  assert.equal(vault.get().pairing, null);
  assert.deepEqual(vault.get().reconnectAccount, { id: '602677', label: 'Synthetic account' });
  assert.equal(vault.get().deviceId, old.deviceId);

  const { previousDeviceId, deviceId } = await vault.rotateIdentity();
  const reopened = reopen(); await reopened.open(); const current = reopened.get();
  assert.equal(previousDeviceId, old.deviceId); assert.equal(current.deviceId, deviceId); assert.notEqual(deviceId, old.deviceId);
  assert.notEqual(current.privateKey, old.privateKey); assert.notEqual(current.publicKey, old.publicKey);
  assert.equal(current.pairing, null);
  assert.deepEqual(current.reconnectAccount, { id: '602677', label: 'Synthetic account' });
  assert.equal(current.career.sources.one.text, 'Kept source sentinel');
  assert.equal(await read(path.join(directory, 'career-files', deviceId, 'exports', 'a.pdf'), 'utf8'), 'pdf sentinel');
});

test('a 3.4 keychain vault is imported once with its identity, pairing and career', async t => {
  const { writeFile, readdir } = await import('node:fs/promises');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'recruiters-legacy-vault-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacy = { version: 2, deviceId: '11111111-1111-4111-8111-111111111111', publicKey: 'legacy-public', privateKey: 'legacy-private', label: 'Old Mac',
    pairing: { origin: 'https://recruiters.rip', account: { id: '7', label: 'Synthetic' } }, userPaused: false,
    career: { version: 1, revision: 113, evidenceRevision: 22, profile: { headline: 'Synthetic headline' }, sources: { s: { text: 'cv' } }, facts: {}, applications: {}, receipts: {} }, identityArchives: {} };
  await writeFile(path.join(directory, 'vault.bin'), `enc:${JSON.stringify(legacy)}`);
  const decryptLegacy = bytes => { const text = bytes.toString('utf8'); assert.ok(text.startsWith('enc:')); return text.slice(4); };

  await createVault(directory).open();
  const vault = createVault(directory, { decryptLegacy }); await vault.open();
  const state = vault.get();
  assert.equal(state.deviceId, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(state.pairing, legacy.pairing);
  assert.equal(state.career.revision, 113);
  assert.equal(state.career.profile.headline, 'Synthetic headline');
  assert.equal('userPaused' in state, false);
  assert.deepEqual((await readdir(directory)).sort(), ['vault.bin.imported', 'vault.json']);
  assert.equal((await stat(path.join(directory, 'vault.json'))).mode & 0o777, 0o600);

  const again = createVault(directory, { decryptLegacy: () => assert.fail('Imported twice') }); await again.open();
  assert.equal(again.get().deviceId, '11111111-1111-4111-8111-111111111111');
});

test('a used vault is never replaced by a 3.4 vault, and an unreadable 3.4 vault keeps everything', async t => {
  const { writeFile, readdir } = await import('node:fs/promises');
  const { vault, directory } = await fixture(t);
  await vault.update(state => { state.career.sources.one = { text: 'Current source sentinel' }; });
  await writeFile(path.join(directory, 'vault.bin'), 'enc:{}');
  const kept = createVault(directory, { decryptLegacy: () => assert.fail('Used vault was replaced') }); await kept.open();
  assert.equal(kept.get().career.sources.one.text, 'Current source sentinel');
  assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('vault.')).sort(), ['vault.bin.superseded', 'vault.json']);

  const fresh = await mkdtemp(path.join(os.tmpdir(), 'recruiters-legacy-locked-'));
  t.after(() => rm(fresh, { recursive: true, force: true }));
  await writeFile(path.join(fresh, 'vault.bin'), 'encrypted');
  await assert.rejects(createVault(fresh, { decryptLegacy: () => { throw new Error('keychain denied'); } }).open(),
    error => error.code === 'LEGACY_VAULT_LOCKED' && /Allow keychain access/.test(error.message));
  assert.deepEqual(await readdir(fresh), ['vault.bin']);
});
