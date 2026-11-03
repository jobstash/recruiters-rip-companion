import { fail, hash, readCareer } from './state.mjs';

/** Remove one exact local source and invalidate answers derived from its evidence. */
export async function deleteCv({ store, sourceId, contentHash }) {
  if (typeof sourceId !== 'string' || !sourceId || ['__proto__', 'prototype', 'constructor'].includes(sourceId) ||
      typeof contentHash !== 'string' || !contentHash)
    fail('INVALID_INPUT', 'Choose a saved CV and reopen it before deleting.');
  const before = readCareer(store);
  const source = Object.hasOwn(before.sources, sourceId) ? before.sources[sourceId] : null;
  if (!source || source.purpose !== 'cv') fail('NOT_FOUND', 'This CV is no longer saved. Refresh the CV list.');
  if (source.contentHash !== contentHash) fail('CV_CHANGED', 'This CV changed. Reopen it before deleting.');
  const sourceSnapshot = hash(source);
  await store.update(state => {
    const career = state.career;
    if (!career?.sources[sourceId] || hash(career.sources[sourceId]) !== sourceSnapshot)
      fail('CV_CHANGED', 'This CV changed during deletion. The changed local CV is still saved. Reopen it before trying again.');
    delete career.sources[sourceId];
    // Existing review/document fingerprints include evidenceRevision. Keep applications and history,
    // but do not leave previously staged answers available after their source evidence is removed.
    for (const draft of Object.values(career.formDrafts ?? {})) draft.answers = {};
    for (const application of Object.values(career.applications ?? {})) application.formAnswers = {};
    career.evidenceRevision++;
    career.revision++;
  });
  return { deleted: true, sourceId };
}
