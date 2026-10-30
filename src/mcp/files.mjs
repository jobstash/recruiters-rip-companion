import { createHash, randomUUID } from 'node:crypto';
import { open, readdir, lstat, unlink, rmdir, mkdir, rename, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { privateDirectory } from '../vault.mjs';
import { fail } from './state.mjs';
import { assertPrivatePath } from '../platform-runtime.cjs';
import { currentApplicationJob, applicationContextFingerprint } from '../application-workflow.mjs';

const MAX_SOURCE = 5 * 1024 * 1024, MAX_EXPORT = 12 * 1024 * 1024;
export const exportTypes = Object.freeze({ pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain' });
export const documentURI = /^recruiters:\/\/documents\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.(pdf|txt)$/;
const rankingURI = /^recruiters:\/\/exports\/([a-f0-9]{64})\.csv$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function documentName(value, maximum = 96) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_INPUT', 'Save the candidate full name, company and job title before exporting documents.');
  let name = value.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
  // Bound UTF-8 bytes as well as UTF-16 code units for all three supported filesystems.
  let bounded = '';
  for (const character of name) { if (Buffer.byteLength(bounded + character) > maximum - 1) break; bounded += character; }
  name = bounded.replace(/[. ]+$/g, '');
  if (!name || /^\.+$/.test(name)) fail('INVALID_INPUT', 'The candidate, company or job name has no usable filename characters.');
  if (/^(con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}
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
  let transaction, queue = Promise.resolve();
  const allocated = new Map();
  async function withExportTransaction(action) {
    const run = queue.then(async () => {
      const changes = [];
      transaction = changes;
      let result;
      try {
        result = await action();
        transaction = undefined;
      } catch (error) {
        transaction = undefined;
        for (const change of changes.reverse()) {
          if (change.folder) {
            allocated.delete(change.key);
            await rmdir(change.folder).catch(cleanup => { if (!['ENOENT', 'ENOTEMPTY'].includes(cleanup.code)) throw cleanup; });
            continue;
          }
          // Paths originate only from this transaction's validated private layout.
          const parts = path.relative(directory, path.dirname(change.filename)).split(path.sep);
          await privateDirectories([directory, ...parts.map((_, index) => path.join(directory, ...parts.slice(0, index + 1)))], false);
          if (change.backup) {
            assertPrivatePath(change.backup, { info: await lstat(change.backup), maxSize: MAX_EXPORT });
            await rename(change.backup, change.filename);
          }
          else await unlink(change.filename).catch(cleanup => { if (cleanup.code !== 'ENOENT') throw cleanup; });
        }
        throw error;
      }
      let cleanupFailed = false;
      for (const change of changes) if (change.backup) {
        try { await unlink(change.backup); } catch (error) { if (error.code !== 'ENOENT') cleanupFailed = true; }
      }
      return cleanupFailed && result && typeof result === 'object'
        ? { ...result, cleanupWarning: 'The current document is saved, but a private temporary file could not be removed.' } : result;
    });
    queue = run.catch(() => {});
    return run;
  }
  const root = () => {
    const deviceId = store.get().deviceId;
    if (typeof deviceId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(deviceId)) fail('EXPORT_CORRUPT', 'The local export identity is unavailable.');
    return path.join(directory, 'career-files', deviceId, 'exports');
  };
  async function privateDirectories(entries, create) {
    for (const entry of entries) {
      if (create) await privateDirectory(entry);
      const info = await lstat(entry);
      try { assertPrivatePath(entry, { directory: true, info }); }
      catch { fail('EXPORT_CORRUPT', 'The local export directory changed or is not private.'); }
    }
  }
  async function privateRoot(create = false) {
    const dir = root();
    await privateDirectories([directory, path.join(directory, 'career-files'), path.dirname(dir), dir], create);
    if (root() !== dir) fail('IDENTITY_CHANGED', 'The local account changed. Open the application again.');
    return dir;
  }
  function documentParts(record) {
    const match = documentURI.exec(record.uri);
    if (!match || record.resourceId !== match[1] || !['cv', 'cover_letter'].includes(record.kind) || record.format !== match[2] ||
      !/^[a-f0-9]{64}$/.test(record.sha256) || record.mediaType !== exportTypes[match[2]] || !Number.isSafeInteger(record.documentVersion) || record.documentVersion < 1 ||
      !Number.isSafeInteger(record.folderNumber) || record.folderNumber < 1 || record.folderNumber > 999999 ||
      !Number.isSafeInteger(record.companyLimit) || record.companyLimit < 4 || record.companyLimit > 96 ||
      !Number.isSafeInteger(record.jobLimit) || record.jobLimit < 4 || record.jobLimit > 96)
      fail('EXPORT_CORRUPT', 'The saved document identity is invalid.');
    const parts = [documentName(record.company, record.companyLimit),
      `${documentName(record.jobTitle, record.jobLimit)}${record.folderNumber > 1 ? ` (${record.folderNumber})` : ''}`,
      `${documentName(record.candidateName)} - ${record.kind === 'cv' ? 'CV' : 'COVER LETTER'}.${match[2]}`];
    if (Buffer.byteLength(path.join(root(), ...parts)) > 248) fail('INVALID_INPUT', 'The document storage path is too long. Use a shorter private storage location.');
    return parts;
  }
  async function documentPath(record, create = false) {
    const dir = await privateRoot(create), parts = documentParts(record);
    await privateDirectories(parts.slice(0, -1).map((_, index) => path.join(dir, ...parts.slice(0, index + 1))), create);
    if (root() !== dir) fail('IDENTITY_CHANGED', 'The local account changed. Open the application again.');
    return path.join(dir, ...parts);
  }
  function currentRecords() {
    const records = [];
    const career = store.get().career;
    for (const app of Object.values(career?.applications ?? {})) {
      const seen = new Set();
      for (const record of [...(app.exports ?? [])].reverse()) {
        const key = `${record.kind}:${record.format}`;
        const draft = record.kind === 'cv' ? app.cv : app.coverLetter;
        if (draft && (record.documentVersion !== draft.version || (draft.contextFingerprint &&
          (record.contextFingerprint !== draft.contextFingerprint || draft.contextFingerprint !== applicationContextFingerprint(career, app))))) continue;
        if (record.applicationId !== app.id || !documentURI.test(record.uri) || seen.has(key)) continue;
        seen.add(key);
        records.push(record);
      }
    }
    return records;
  }
  function currentRecord(uri) {
    const record = currentRecords().find(item => item.uri === uri);
    if (!record) fail('NOT_FOUND', 'Choose a current document exported for this application.');
    return record;
  }
  async function allocateFolder(record, app) {
    const key = JSON.stringify([root(), app.id, record.company, record.jobTitle]);
    const existing = allocated.get(key) ?? [...(app.exports ?? [])].reverse().find(item => item.applicationId === app.id &&
      item.company === record.company && item.jobTitle === record.jobTitle && Number.isSafeInteger(item.folderNumber));
    if (existing) {
      for (const field of ['folderNumber', 'companyLimit', 'jobLimit']) record[field] = existing[field];
      await documentPath(record, true);
      return;
    }
    const remaining = 248 - Buffer.byteLength(root()) - Math.max(41, Buffer.byteLength(`${documentName(record.candidateName)} - COVER LETTER.pdf`)) - 11;
    if (remaining < 8) fail('INVALID_INPUT', 'The document storage path is too long. Use a shorter private storage location.');
    record.companyLimit = Math.min(64, Math.floor(remaining / 2), Math.max(4, Buffer.byteLength(documentName(record.company)) + 1));
    record.jobLimit = Math.min(96, remaining - record.companyLimit);
    record.folderNumber = 1;
    const companyDirectory = path.join(await privateRoot(true), documentParts(record)[0]);
    await privateDirectories([companyDirectory], true);
    for (; record.folderNumber <= 999999; record.folderNumber++) {
      const folder = path.join(companyDirectory, documentParts(record)[1]);
      try {
        await mkdir(folder, { mode: 0o700 });
        await privateDirectories([folder], true);
        allocated.set(key, { folderNumber: record.folderNumber, companyLimit: record.companyLimit, jobLimit: record.jobLimit });
        transaction?.push({ folder, key });
        return;
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    fail('EXPORT_CORRUPT', 'No private application document folder is available.');
  }
  async function exportDocument({ bytes, mediaType, applicationId, kind, documentVersion }) {
    assertAvailable(true);
    const extension = Object.keys(exportTypes).find(key => exportTypes[key] === mediaType);
    if (!validExport(bytes, extension)) fail('INVALID_INPUT', 'Export a bounded PDF, UTF-8 TXT or CSV document.');
    const sha256 = digest(bytes), dir = await privateRoot(true);
    let record, filename;
    if (extension === 'csv') {
      filename = path.join(dir, `${sha256}.csv`);
      record = { sha256, bytes: bytes.length, mediaType, uri: `recruiters://exports/${sha256}.csv` };
    } else {
      const career = store.get().career, app = career?.applications?.[applicationId];
      if (!app || app.id !== applicationId || !['cv', 'cover_letter'].includes(kind)) fail('INVALID_INPUT', 'Choose a saved application and document kind.');
      const job = currentApplicationJob(career, app), resourceId = randomUUID();
      record = { applicationId, resourceId, candidateName: career.profile.name, company: job.company, jobTitle: job.title,
        kind, format: extension, documentVersion: documentVersion ?? (kind === 'cv' ? app.cv?.version : app.coverLetter?.version) ?? 1,
        sha256, bytes: bytes.length, mediaType, uri: `recruiters://documents/${resourceId}.${extension}` };
      await allocateFolder(record, app);
      filename = await documentPath(record);
    }
    if (extension === 'csv') {
      try {
        const handle = await open(filename, 'wx', 0o600);
        try { onCreated(filename); await handle.writeFile(bytes); }
        finally { await handle.close(); }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await readExport(filename, sha256, extension);
      }
    } else {
      const temporary = path.join(path.dirname(filename), `.${randomUUID()}.tmp`);
      let backup, existed = false;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(bytes); } finally { await handle.close(); }
        try {
          assertPrivatePath(filename, { info: await lstat(filename), maxSize: MAX_EXPORT });
          existed = true;
          if (transaction) {
            backup = path.join(path.dirname(filename), `.${randomUUID()}.tmp`);
            await copyFile(filename, backup, constants.COPYFILE_EXCL);
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        assertAvailable(true);
        await documentPath(record);
        if (root() !== dir) fail('IDENTITY_CHANGED', 'The local account changed. Export the document again.');
        await rename(temporary, filename);
        if (transaction) transaction.push({ filename, backup });
        if (!existed) onCreated(filename);
      } catch (error) {
        if (backup) await unlink(backup).catch(cleanup => { if (cleanup.code !== 'ENOENT') throw cleanup; });
        throw error;
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    assertAvailable(false);
    if (root() !== dir) fail('IDENTITY_CHANGED', 'The local account changed. Export the document again.');
    return { ...record, filename: path.basename(filename), path: filename };
  }
  async function readExport(filename, expectedDigest, extension) {
    assertAvailable(false);
    try { assertPrivatePath(filename, { info: await lstat(filename), maxSize: MAX_EXPORT }); }
    catch (error) { if (error.code === 'ENOENT') throw error; fail('EXPORT_CORRUPT', 'This local export is unavailable or its permissions changed.'); }
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_EXPORT || (process.platform !== 'win32' && ((process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)))) fail('EXPORT_CORRUPT', 'This local export is unavailable or its permissions changed.');
      const buffer = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < buffer.length) { const result = await handle.read(buffer, length, buffer.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
      if (length !== info.size) fail('EXPORT_CORRUPT', 'The saved export changed while reading it. Your source and draft are intact.');
      const bytes = buffer.subarray(0, length);
      if (!validExport(bytes, extension) || digest(bytes) !== expectedDigest) fail('EXPORT_CORRUPT', 'The saved export failed its integrity check. Your source and draft are intact.');
      assertAvailable(false);
      return bytes;
    } finally { await handle.close(); }
  }
  async function readResource(uri) {
    const ranking = rankingURI.exec(uri), document = documentURI.exec(uri);
    if (!ranking && !document) fail('NOT_FOUND', 'Choose a URI returned by document or ranking export. Arbitrary file access is unavailable.');
    const dir = await privateRoot(), record = document ? currentRecord(uri) : null;
    const filename = record ? await documentPath(record) : path.join(dir, `${ranking[1]}.csv`);
    const extension = document?.[2] ?? 'csv';
    const bytes = await readExport(filename, record?.sha256 ?? ranking[1], extension);
    if (record) await documentPath(record); else await privateRoot();
    if (root() !== dir) fail('IDENTITY_CHANGED', 'The local account changed. Open the application again.');
    if (record && JSON.stringify(currentRecord(uri)) !== JSON.stringify(record)) fail('NOT_FOUND', 'The saved document changed. Select its current version.');
    return { uri, mimeType: exportTypes[extension], ...(extension !== 'pdf' ? { text: bytes.toString('utf8') } : { blob: bytes.toString('base64') }) };
  }
  async function resolveExport(uri) {
    if (!documentURI.test(uri) || !uri.endsWith('.pdf')) fail('NOT_FOUND', 'Choose a current PDF exported for this application.');
    const record = currentRecord(uri), filename = await documentPath(record);
    await readResource(uri);
    if (await documentPath(currentRecord(uri)) !== filename) fail('NOT_FOUND', 'The saved document changed. Select its current version.');
    return filename;
  }
  async function listResources() {
    assertAvailable(false);
    try {
      const dir = await privateRoot();
      const names = (await readdir(dir)).filter(name => /^[a-f0-9]{64}\.csv$/.test(name)).sort();
      const records = [];
      for (const record of currentRecords()) {
        try {
          const filename = await documentPath(record);
          try { assertPrivatePath(filename, { info: await lstat(filename), maxSize: MAX_EXPORT }); }
          catch (error) { if (error.code === 'ENOENT') throw error; fail('EXPORT_CORRUPT', 'This local export is unavailable or its permissions changed.'); }
          records.push(record);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      assertAvailable(false);
      return [...records.map(record => ({ uri: record.uri, name: documentParts(record).at(-1), mimeType: record.mediaType,
        description: `Saved ${record.kind === 'cv' ? 'CV' : 'cover letter'} for ${record.jobTitle} at ${record.company}.` })),
      ...names.map(name => ({ uri: `recruiters://exports/${name}`, name, mimeType: 'text/csv', description: 'Saved complete assessment ranking CSV snapshot.' }))].slice(0, 200);
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async function cleanupExports(previousRecords = []) {
    assertAvailable(true);
    let dir;
    try { dir = await privateRoot(); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const active = new Set(currentRecords().map(record => record.uri));
    const activePaths = new Set(currentRecords().map(record => path.join(dir, ...documentParts(record))));
    const obsolete = [...previousRecords, ...Object.values(store.get().career?.applications ?? {}).flatMap(app => app.exports ?? [])];
    for (const record of obsolete) {
      if (!documentURI.test(record.uri) || active.has(record.uri)) continue;
      try {
        const filename = await documentPath(record);
        if (activePaths.has(filename)) continue;
        assertPrivatePath(filename, { info: await lstat(filename), maxSize: MAX_EXPORT });
        assertAvailable(true);
        await unlink(filename);
        const folder = path.dirname(filename);
        const reserved = Object.values(store.get().career?.applications ?? {}).some(app => (app.exports ?? []).some(item => {
          if (item.applicationId !== app.id || !documentURI.test(item.uri ?? '')) return false;
          try { return path.dirname(path.join(dir, ...documentParts(item))) === folder; } catch { return false; }
        }));
        if (!reserved) await rmdir(folder).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // Only the old generated flat PDF/TXT namespace is retired. Never recurse or follow links.
    for (const name of await readdir(dir)) {
      if (!/^[a-f0-9]{64}\.(pdf|txt)$/.test(name)) continue;
      const filename = path.join(dir, name), info = await lstat(filename);
      if (info.isFile() && !info.isSymbolicLink()) { assertAvailable(true); await unlink(filename); }
    }
  }
  return { exportDocument, readResource, resolveExport, listResources, cleanupExports, withExportTransaction, exportDirectory: root };
}
