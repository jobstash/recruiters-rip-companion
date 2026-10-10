import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync, createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createVault } from '../vault.mjs';
const MAGIC = Buffer.from('RRN1');
export function encryption(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Invalid vault key.');
  return {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'secret-service',
    encryptString(text) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), bytes]); },
    decryptString(bytes) { if (bytes.length < 32 || !bytes.subarray(0, 4).equals(MAGIC)) throw new Error('Unrecognized encrypted vault.'); const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(4, 16)); decipher.setAuthTag(bytes.subarray(16, 32)); return Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]).toString('utf8'); },
  };
}
export function decryptMacVault(bytes, password) {
  if (bytes.subarray(0, 3).toString() !== 'v10') throw new Error('Unsupported desktop vault format.');
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  try { const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 32)); return Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]).toString('utf8'); }
  finally { key.fill(0); }
}
async function exists(file) { try { return await lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
export async function nodeVault(directory, { EntryClass, platform = process.platform } = {}) {
  if (!EntryClass) ({ Entry: EntryClass } = await import('@napi-rs/keyring'));
  const filename = 'vault.node.bin', target = path.join(directory, filename), legacy = path.join(directory, 'vault.bin');
  const entry = new EntryClass('Recruiters Companion', `node-vault-${createHash('sha256').update(directory).digest('hex')}`, { linux: { store: 'secret-service' } });
  let password = entry.getPassword();
  if (!password) {
    if (await exists(target)) throw new Error('The key for saved career data is missing from your OS keychain. Restore the keychain backup; the vault has not been replaced.');
    password = randomBytes(32).toString('base64'); entry.setPassword(password);
  }
  const codec = encryption(Buffer.from(password, 'base64'));
  if (!await exists(target) && await exists(legacy)) {
    const info = await lstat(legacy);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 130 * 1024 * 1024 || (process.getuid && info.uid !== process.getuid())) throw new Error('The existing desktop vault cannot be safely opened.');
    if (platform !== 'darwin') throw new Error('This desktop vault needs to be exported on the original desktop app before switching. Your existing data has not been changed.');
    // Electron 40 uses this exact service/account and Chromium v10 format.
    const previous = new EntryClass('Recruiters Companion Safe Storage', 'Recruiters Companion').getPassword();
    if (!previous) throw new Error('Allow access to the Recruiters Companion Safe Storage key in Keychain to carry over your desktop data.');
    const text = decryptMacVault(await readFile(legacy), previous), value = JSON.parse(text);
    if (value.version !== 2 || !value.deviceId || !value.privateKey || !value.publicKey || value.career?.version !== 1) throw new Error('The existing career vault could not be verified.');
    await writeFile(target, codec.encryptString(text), { flag: 'wx', mode: 0o600 });
  }
  const vault = createVault(codec, directory, { filename }); await vault.open(); return vault;
}
