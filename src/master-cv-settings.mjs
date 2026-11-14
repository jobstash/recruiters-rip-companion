import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import path from 'node:path';
import { protectPrivatePath } from './platform-runtime.cjs';
import { createCareerState, fail, hash } from './mcp/state.mjs';
import { masterCvState, saveManualMaster, masterExportSnapshot, renderMaster } from './mcp/master-cv.mjs';

export const MASTER_CV_ACTIONS = Object.freeze(['master-cv-read', 'master-cv-save', 'master-cv-export']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function exact(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(input, key)))
    fail('INVALID_INPUT', 'Provide only the fields required for this master CV action.');
}

/** Stage privately, then publish synchronously with the final access/snapshot check. */
export async function publishMasterFile(filename, bytes, assertCurrent) {
  const temporary = path.join(path.dirname(filename), `.master-cv-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    protectPrivatePath(temporary);
    assertCurrent();
    renameSync(temporary, filename);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

/** One instance per shell; request receipts are deliberately ephemeral and identity-bound. */
export function createMasterCvSettings({ access, identity, documents, selectDestination, publish = publishMasterFile, afterSave = () => {}, browserAccess = () => () => {}, snapshot = masterExportSnapshot, render = renderMaster }) {
  let receiptIdentity;
  const exports = new Map(), saving = new Set();
  function session() {
    const scoped = access();
    scoped.assertAvailable(false);
    const currentIdentity = identity();
    if (receiptIdentity !== currentIdentity) { exports.clear(); saving.clear(); receiptIdentity = currentIdentity; }
    const assertBrowser = browserAccess();
    const assertCurrent = () => {
      scoped.assertAvailable(false);
      if (identity() !== currentIdentity) fail('IDENTITY_CHANGED', 'The local profile changed. Reopen the master CV before continuing.');
      assertBrowser();
    };
    return { scoped, currentIdentity, assertCurrent };
  }
  return async function operate(op, input = {}) {
    if (!MASTER_CV_ACTIONS.includes(op)) fail('INVALID_INPUT', 'This master CV action is unavailable.');
    exact(input, op === 'master-cv-save' ? ['requestId', 'revision', 'baseVersion', 'contact', 'document', 'presentation']
      : op === 'master-cv-export' ? ['requestId', 'revision', 'baseVersion', 'format'] : []);
    const { scoped, currentIdentity, assertCurrent } = session();
    const career = () => scoped.store.get().career ?? createCareerState();
    if (op === 'master-cv-read') return masterCvState(career(), currentIdentity);
    if (op === 'master-cv-save') {
      assertCurrent();
      if (exports.has(input.requestId)) fail('REQUEST_CONFLICT', 'This request ID was already used for an export. Use a new request ID.');
      saving.add(input.requestId);
      try {
        const savingStore = { get: () => scoped.store.get(), update: change => scoped.store.update(change, { beforeCommit: assertCurrent }) };
        const result = await saveManualMaster({ store: savingStore, args: input, identity: currentIdentity });
        assertCurrent();
        afterSave();
        return result;
      } finally { if (receiptIdentity === currentIdentity) saving.delete(input.requestId); }
    }
    if (typeof input.requestId !== 'string' || !uuid.test(input.requestId) || !Number.isSafeInteger(input.revision) || input.revision < 0 || !Number.isSafeInteger(input.baseVersion) || input.baseVersion < 1 || !['pdf', 'txt'].includes(input.format))
      fail('INVALID_INPUT', 'Choose PDF or text and export the current master CV version with a new request ID.');
    if (saving.has(input.requestId) || career().receipts?.[input.requestId]) fail('REQUEST_CONFLICT', 'This request ID was already used for another action. Use a new request ID.');
    const inputHash = hash(input), prior = exports.get(input.requestId);
    if (prior && prior.inputHash !== inputHash) fail('REQUEST_CONFLICT', 'This request ID was already used with different content. Use a new request ID.');
    const initial = snapshot(career(), input), initialHash = hash(initial);
    const assertSnapshot = () => {
      assertCurrent();
      if (hash(snapshot(career(), input)) !== initialHash) fail('REVISION_CONFLICT', 'The saved CV changed. Reopen the master CV before exporting.');
    };
    assertSnapshot();
    if (prior) return prior.pending;
    // Reserve before any asynchronous work so concurrent retries cannot open a second dialog.
    const pending = Promise.resolve().then(async () => {
      assertSnapshot();
      const suggestedName = `Master CV.${input.format}`;
      const destination = await selectDestination(suggestedName, input.format);
      assertSnapshot();
      if (!destination) return { exported: false };
      const rendered = await render(initial, initial.contact, documents(), input.format);
      assertSnapshot();
      if (!rendered || !Buffer.isBuffer(rendered.bytes) || !rendered.bytes.length || (input.format === 'pdf' && rendered.textValidation?.passed !== true))
        fail('EXPORT_INVALID', 'The master CV could not be rendered faithfully. Try exporting again.');
      await publish(destination, rendered.bytes, assertSnapshot);
      return { exported: true, filename: path.basename(destination) };
    });
    exports.set(input.requestId, { inputHash, pending });
    return pending;
  };
}
