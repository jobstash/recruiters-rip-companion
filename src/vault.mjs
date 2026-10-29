import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { CAREER_SCHEMA, createCareerState } from './mcp/state.mjs';
import { protectPrivatePath, assertPrivatePath } from './platform-runtime.cjs';

export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  protectPrivatePath(directory, { directory: true });
}
function identity() {
  const pair = generateKeyPairSync('ed25519');
  return { deviceId: randomUUID(), publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'), privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
export const LEGACY_VAULT = 'vault.bin';
const LEGACY_LOCKED = 'Allow keychain access for Recruiters Companion to import the career data saved by version 3.4. To start fresh instead, move vault.bin out of the device folder. Saved data has not been replaced.';
const legacyLocked = () => Object.assign(new Error(LEGACY_LOCKED), { code: 'LEGACY_VAULT_LOCKED' });
const validEnvelope = value => value?.version === 2 && value.deviceId && value.privateKey && value.publicKey;
const pristine = value => !value.pairing && value.career?.revision === 0 && !Object.keys(value.career.sources ?? {}).length && !Object.keys(value.identityArchives ?? {}).length;
/** Plain JSON in a private (0700) directory, file mode 0600: no OS keychain or at-rest encryption. */
export function createVault(directory, { decryptLegacy } = {}) {
  const filename = path.join(directory, 'vault.json');
  const legacyFilename = path.join(directory, LEGACY_VAULT);
  let state, writes = Promise.resolve();
  async function persist(value) {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > 128 * 1024 * 1024) throw Object.assign(new Error('Local career storage is full. Export a backup before adding more documents.'), { code: 'STORAGE_LIMIT' });
    const temp = `${filename}.${randomUUID()}.tmp`;
    try { await writeFile(temp, json, { mode: 0o600, flag: 'wx' }); await rename(temp, filename); }
    finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  /** Version 3.4 kept the same envelope encrypted with the OS keychain; import it once and keep the original as vault.bin.imported. */
  async function importLegacy() {
    let encrypted;
    try { encrypted = await readFile(legacyFilename); } catch (error) { if (error.code === 'ENOENT') return null; throw legacyLocked(); }
    let value;
    try { value = JSON.parse(decryptLegacy(encrypted)); } catch { throw legacyLocked(); }
    if (!validEnvelope(value)) throw legacyLocked();
    delete value.userPaused;
    await persist(value);
    await rename(legacyFilename, `${legacyFilename}.imported`);
    return value;
  }
  return {
    async open() {
      await privateDirectory(directory); await writes;
      let loaded;
      try {
        const info = await lstat(filename);
        assertPrivatePath(filename, { info, maxSize: 130 * 1024 * 1024 });
        loaded = JSON.parse(await readFile(filename, 'utf8'));
        if (!validEnvelope(loaded)) throw new Error('Invalid local storage.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Local storage could not be opened. Saved data has not been replaced.');
      }
      if (decryptLegacy && (!loaded || pristine(loaded))) loaded = await importLegacy() ?? loaded;
      // A used vault.json wins; set the 3.4 file aside so later launches keep the mock keychain.
      else if (decryptLegacy) await rename(legacyFilename, `${legacyFilename}.superseded`).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!loaded) {
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
    async flush() { await writes; },
    /** The platform unpaired this identity: forget the pairing but keep the account it must reconnect to. */
    async forgetPairing() {
      await this.update(next => { if (next.pairing) { next.reconnectAccount = next.pairing.account; next.pairing = null; } });
    },
    /** A revoked identity cannot pair again; replace its keys and keep career data and exports. */
    async rotateIdentity() {
      let result;
      await this.update(next => { result = { previousDeviceId: next.deviceId }; Object.assign(next, identity()); next.pairing = null; result.deviceId = next.deviceId; });
      const files = path.join(directory, 'career-files');
      await rename(path.join(files, result.previousDeviceId), path.join(files, result.deviceId)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      return result;
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
