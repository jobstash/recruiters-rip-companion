import { createHash } from 'node:crypto';
import { open, readdir, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { privateDirectory } from '../vault.mjs';
import { fail } from './state.mjs';
import { assertPrivatePath } from '../platform-runtime.cjs';

const MAX_SOURCE = 5 * 1024 * 1024, MAX_EXPORT = 12 * 1024 * 1024;
export const exportTypes = Object.freeze({ pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain' });
export function validExport(bytes, extension) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_EXPORT) return false;
  if (extension === 'pdf') return bytes.subarray(0, 5).toString() === '%PDF-';
  if (!['csv', 'txt'].includes(extension)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch { return false; }
}
export async function readSelectedSource(filename) {
  const selected = await lstat(filename);
  if (selected.isSymbolicLink() || !selected.isFile()) fail('INVALID_INPUT', 'Choose a regular PDF, DOCX or text CV file.');
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_SOURCE) fail('INVALID_INPUT', 'Choose a PDF, DOCX or text CV no larger than 5 MiB.');
    const mimetype = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.txt': 'text/plain' }[path.extname(filename).toLowerCase()];
    if (!mimetype) fail('INVALID_INPUT', 'Choose a PDF, DOCX or text CV.');
    const buffer = await file.readFile();
    if (buffer.length > MAX_SOURCE) fail('INVALID_INPUT', 'The selected CV became too large. Choose a file no larger than 5 MiB.');
    return { buffer, originalname: path.basename(filename), mimetype, size: buffer.length };
  } finally { await file.close(); }
}
export function createDocumentFiles({ directory, store, assertAvailable, onCreated = () => {} }) {
  const root = () => {
    const deviceId = store.get().deviceId;
    if (typeof deviceId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(deviceId)) fail('EXPORT_CORRUPT', 'The local export identity is unavailable.');
    return path.join(directory, 'career-files', deviceId, 'exports');
  };
  async function privateRoot(create = false) {
    const dir = root();
    const directories = [directory, path.join(directory, 'career-files'), path.dirname(dir), dir];
    for (const entry of directories) {
      if (create) await privateDirectory(entry);
      const info = await lstat(entry);
      try { assertPrivatePath(entry, { directory: true, info }); }
      catch { fail('EXPORT_CORRUPT', 'The local export directory changed or is not private.'); }
    }
    return dir;
  }
  async function exportDocument({ bytes, mediaType }) {
    assertAvailable(true);
    const extension = Object.keys(exportTypes).find(key => exportTypes[key] === mediaType);
    if (!validExport(bytes, extension)) fail('INVALID_INPUT', 'Export a bounded PDF, UTF-8 TXT or CSV document.');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const dir = await privateRoot(true);
    const filename = path.join(dir, `${sha256}.${extension}`);
    try {
      const handle = await open(filename, 'wx', 0o600);
      try { onCreated(filename); await handle.writeFile(bytes); }
      finally { await handle.close(); }
    }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await readExport(sha256, extension);
      if (previous.length !== bytes.length) fail('EXPORT_CORRUPT', 'The saved export changed. Your source and draft are intact; remove the damaged export using local settings.');
    }
    assertAvailable(false);
    return { path: filename, sha256, bytes: bytes.length, mediaType, uri: `recruiters://exports/${sha256}.${extension}` };
  }
  async function readExport(digest, extension) {
    assertAvailable(false);
    const filename = path.join(await privateRoot(), `${digest}.${extension}`);
    if (process.platform === 'win32') {
      try { assertPrivatePath(filename, { info: await lstat(filename), maxSize: MAX_EXPORT }); }
      catch { fail('EXPORT_CORRUPT', 'This local export is unavailable or its permissions changed.'); }
    }
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_EXPORT || (process.platform !== 'win32' && ((process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)))) fail('EXPORT_CORRUPT', 'This local export is unavailable or its permissions changed.');
      const buffer = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < buffer.length) { const result = await handle.read(buffer, length, buffer.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
      if (length !== info.size) fail('EXPORT_CORRUPT', 'The saved export changed while reading it. Your source and draft are intact.');
      const bytes = buffer.subarray(0, length);
      if (!validExport(bytes, extension) || createHash('sha256').update(bytes).digest('hex') !== digest) fail('EXPORT_CORRUPT', 'The saved export failed its integrity check. Your source and draft are intact.');
      assertAvailable(false);
      return bytes;
    } finally { await handle.close(); }
  }
  async function readResource(uri) {
    const matched = /^recruiters:\/\/exports\/([a-f0-9]{64})\.(pdf|csv|txt)$/.exec(uri);
    if (!matched) fail('NOT_FOUND', 'Choose a URI returned by document or ranking export. Arbitrary file access is unavailable.');
    const bytes = await readExport(matched[1], matched[2]);
    return { uri, mimeType: exportTypes[matched[2]], ...(matched[2] !== 'pdf' ? { text: bytes.toString('utf8') } : { blob: bytes.toString('base64') }) };
  }
  async function resolveExport(uri) {
    const matched = /^recruiters:\/\/exports\/([a-f0-9]{64})\.pdf$/.exec(uri);
    if (!matched) fail('NOT_FOUND', 'Choose a current PDF exported for this application.');
    const dir = await privateRoot();
    await readExport(matched[1], 'pdf');
    assertAvailable(false);
    if (root() !== dir) fail('IDENTITY_CHANGED', 'The local account changed. Open the application again.');
    return path.join(dir, `${matched[1]}.pdf`);
  }
  async function listResources() {
    assertAvailable(false);
    try {
      const dir = await privateRoot();
      const names = (await readdir(dir)).filter(name => /^[a-f0-9]{64}\.(pdf|csv|txt)$/.test(name)).sort().slice(0, 200);
      assertAvailable(false);
      return names.map(name => ({ uri: `recruiters://exports/${name}`, name, mimeType: exportTypes[path.extname(name).slice(1)],
        description: name.endsWith('.csv') ? 'Saved complete assessment ranking CSV snapshot.' : 'Saved local document; read current application state to check whether a newer revision exists.' }));
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  return { exportDocument, readResource, resolveExport, listResources, exportDirectory: root };
}
