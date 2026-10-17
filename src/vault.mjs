import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { CAREER_SCHEMA, createCareerState } from './mcp/state.mjs';

export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error('Local storage is unavailable.');
  await chmod(directory, 0o700);
}
function identity() {
  const pair = generateKeyPairSync('ed25519');
  return { deviceId: randomUUID(), publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'), privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
/** Plain JSON in a private (0700) directory, file mode 0600: no OS keychain or at-rest encryption. */
export function createVault(directory) {
  const filename = path.join(directory, 'vault.json');
  let state, writes = Promise.resolve();
  async function persist(value) {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > 128 * 1024 * 1024) throw Object.assign(new Error('Local career storage is full. Export a backup before adding more documents.'), { code: 'STORAGE_LIMIT' });
    const temp = `${filename}.${randomUUID()}.tmp`;
    try { await writeFile(temp, json, { mode: 0o600, flag: 'wx' }); await rename(temp, filename); }
    finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return {
    async open() {
      await privateDirectory(directory); await writes;
      let loaded;
      try {
        const info = await lstat(filename);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 130 * 1024 * 1024 || (process.getuid && info.uid !== process.getuid())) throw new Error('Invalid local storage.');
        loaded = JSON.parse(await readFile(filename, 'utf8'));
        if (loaded.version !== 2 || !loaded.deviceId || !loaded.privateKey || !loaded.publicKey) throw new Error('Invalid local storage.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Local storage could not be opened. Saved data has not been replaced.');
        loaded = { version: 2, ...identity(), label: 'My computer', pairing: null, career: createCareerState(), identityArchives: {} };
        await persist(loaded);
      }
      if (!Number.isSafeInteger(loaded.career?.version) || loaded.career.version < 1 || loaded.career.version > CAREER_SCHEMA || !Number.isSafeInteger(loaded.career.revision) || !loaded.career.sources || !loaded.career.facts || !loaded.career.applications || !loaded.career.receipts) throw new Error('The local career format is unavailable. Saved data has not been replaced.');
      state = loaded;
    },
    get() { if (!state) throw new Error('Local storage is locked.'); return structuredClone(state); },
    update(change) {
      const pending = writes.then(async () => {
        if (!state) throw new Error('Local storage is locked.');
        const next = structuredClone(state); await change(next); await persist(next); state = next;
      });
      writes = pending.catch(() => {}); return pending;
    },
    async resetIdentity() {
      let result;
      await this.update(next => {
        const previousDeviceId = next.deviceId;
        next.identityArchives ??= {};
        next.identityArchives[previousDeviceId] = { executable: false, archivedAt: new Date().toISOString(), deviceId: previousDeviceId,
          publicKey: next.publicKey, label: next.label, pairing: next.pairing, career: next.career, retiredExecution: next.retiredExecution };
        Object.assign(next, identity()); next.pairing = null; next.career = createCareerState(); delete next.retiredExecution;
        delete next.prescanCredentials;
        delete next.prescanCredentialVersion;
        result = { previousDeviceId, deviceId: next.deviceId, archived: true, remoteDeviceRevoked: false };
      });
      return result;
    },
  };
}
