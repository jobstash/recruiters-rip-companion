import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVault } from '../src/vault.mjs';
import { mutateCareer, replayCareer, readCareer } from '../src/mcp/state.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'recruiters-career-vault-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32); let rejectWrite = false;
  const encryption = {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test-encrypted-store',
    encryptString(value) { if (rejectWrite) throw new Error('Encrypted storage unavailable'); const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce); const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]); },
    decryptString(value) { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8'); },
  };
  const vault = createVault(encryption, directory); await vault.open();
  return { vault, directory, reopen: () => createVault(encryption, directory), rejectWrites: value => { rejectWrite = value; } };
}
const publicKey = state => createPublicKey({ key: Buffer.from(state.publicKey, 'base64url'), format: 'der', type: 'spki' });

test('identity reset isolates old private career data while keeping encrypted recoverable archives', async t => {
  const { vault, reopen, directory } = await fixture(t);
  await vault.update(state => { state.pairing = { origin: 'https://recruiters.rip', account: { id: 'old-owner', label: 'Old account' } }; state.career.profile.name = 'Private candidate sentinel'; state.career.sources.one = { text: 'Original source sentinel' }; state.userPaused = true; });
  const old = vault.get(), result = await vault.resetIdentity();
  const reopened = reopen(); await reopened.open(); const current = reopened.get();
  assert.notEqual(current.deviceId, old.deviceId); assert.equal(result.remoteDeviceRevoked, false);
  const challenge = Buffer.from('new identity');
  assert.equal(verify(null, challenge, publicKey(current), sign(null, challenge, current.privateKey)), true);
  assert.equal(verify(null, challenge, publicKey(old), sign(null, challenge, current.privateKey)), false);
  assert.equal(current.pairing, null); assert.equal(current.career.profile.name, null); assert.deepEqual(current.career.sources, {});
  assert.deepEqual(current.identityArchives[old.deviceId].career, old.career);
  assert.equal(current.identityArchives[old.deviceId].privateKey, undefined);
  assert.equal((await readFile(path.join(directory, 'vault.bin'))).includes(Buffer.from('Private candidate sentinel')), false);
});


test('failed encrypted commit preserves previous career revision and identity after reopen', async t => {
  const { vault, reopen, rejectWrites } = await fixture(t); const before = vault.get();
  rejectWrites(true); await assert.rejects(vault.resetIdentity()); rejectWrites(false);
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
