import { fail, hash, readCareer } from './state.mjs';

// Shared across native actions and agent sessions, which use separate scoped store wrappers.
const operations = new Set();
export async function withCvOperation(store, sourceId, action) {
  const key = JSON.stringify([store.get().deviceId ?? null, sourceId]);
  if (operations.has(key)) fail('CV_BUSY', 'This CV is being shared or deleted. Wait for that action to finish, then try again.');
  operations.add(key);
  try { return await action(); } finally { operations.delete(key); }
}

export function cvRemoteCopies(entry) {
  const copies = Array.isArray(entry?.remoteCopies) ? [...entry.remoteCopies] : [];
  if (entry?.documentId && !copies.some(copy => copy.documentId === entry.documentId))
    copies.push({ documentId: entry.documentId, ...(entry.sharedAccountId ? { accountId: entry.sharedAccountId } : {}) });
  return copies;
}

/** Removes one exact source only after all its known remote copies have been removed. */
export async function deleteCv({ store, sourceId, contentHash, deleteRemote, getAccountId = () => store.get().pairing?.account?.id }) {
  if (typeof sourceId !== 'string' || !sourceId || ['__proto__', 'prototype', 'constructor'].includes(sourceId) ||
      typeof contentHash !== 'string' || !contentHash)
    fail('INVALID_INPUT', 'Choose a saved CV and reopen it before deleting.');
  return withCvOperation(store, sourceId, async () => {
    const before = readCareer(store);
    const source = Object.hasOwn(before.sources, sourceId) ? before.sources[sourceId] : null;
    if (!source || source.purpose !== 'cv') fail('NOT_FOUND', 'This CV is no longer saved. Refresh the CV list.');
    if (source.contentHash !== contentHash) fail('CV_CHANGED', 'This CV changed. Reopen it before deleting.');
    const sourceSnapshot = hash(source);
    const entry = before.introductions?.documents?.[sourceId];
    const copies = cvRemoteCopies(entry);
    const provenance = hash(entry ?? null);
    const accountId = getAccountId();
    const identity = hash([store.get().deviceId ?? null, store.get().pairing?.origin ?? null, accountId ?? null]);
    const assertIdentity = () => {
      if (hash([store.get().deviceId ?? null, store.get().pairing?.origin ?? null, getAccountId() ?? null]) !== identity)
        fail('IDENTITY_CHANGED', 'The connected profile changed. Reopen the CV and try again.');
    };
    if (copies.length) {
      if (!accountId || typeof deleteRemote !== 'function') fail('PAIRING_REQUIRED', 'Reconnect the account used to share this CV, then try deleting it again. Your CV is still saved.');
      if (copies.some(copy => copy.accountId && copy.accountId !== accountId))
        fail('CV_ACCOUNT_MISMATCH', 'Connect the JobStash account used to share this CV before deleting it. Your CV is still saved.');
      for (const copy of copies) {
        assertIdentity();
        const result = await deleteRemote({ documentId: copy.documentId });
        assertIdentity();
        if (result?.deleted !== true || result.documentId !== copy.documentId)
          fail('CV_DELETE_FAILED', 'JobStash did not confirm removal. Your CV is still saved; try deleting it again.');
      }
    }
    await store.update(state => {
      assertIdentity();
      const career = state.career;
      if (!career?.sources[sourceId] || hash(career.sources[sourceId]) !== sourceSnapshot ||
          hash(career.introductions?.documents?.[sourceId] ?? null) !== provenance)
        fail('CV_CHANGED', 'This CV changed during deletion. The changed local CV is still saved. Reopen it before trying again.');
      delete career.sources[sourceId];
      if (career.introductions?.documents) delete career.introductions.documents[sourceId];
      // Existing review/document fingerprints include evidenceRevision. Keep applications and history,
      // but do not leave previously staged answers available after their source evidence is removed.
      for (const draft of Object.values(career.formDrafts ?? {})) draft.answers = {};
      for (const application of Object.values(career.applications ?? {})) application.formAnswers = {};
      career.evidenceRevision++;
      career.revision++;
    });
    return { deleted: true, sourceId, remoteCopies: copies.length };
  });
}
