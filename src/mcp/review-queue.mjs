import { blockedIds } from './blocklist.mjs';
import { DEFAULT_PUBLICATION_RANGE, assertPublicationRange } from './publication-range.mjs';

/** A saved review that fails a gate, or requires relocation the candidate refuses, settles the job: it is never offered again
 *  until the profile changes. Applies to current and stale reviews alike. */
export function establishedIncompatibility(career, id) {
  const review = career.matching?.scores?.[id];
  if (!review || typeof review !== 'object') return false;
  return Object.values(review.gates ?? {}).includes('fail') ||
    (review.relocation === 'required' && career.profile?.preferences?.willingToRelocate === false);
}

/** Which of the given catalogue/imported job IDs the agent should review next: everything in scope except blocked jobs and
 *  established incompatibilities. There is no score, threshold or per-job switch; exclusion is blocking. */
export function reviewInclusion(career, allIds) {
  const isBlocked = blockedIds(career);
  const established = id => establishedIncompatibility(career, id);
  const ids = allIds.filter(id => !isBlocked(id));
  return { candidates: ids.length, blocked: allIds.length - ids.length, established,
    includedIds: new Set(ids.filter(id => !established(id))) };
}

/** The publication window the Jobs tab and `career_match_jobs` share. Older vaults saved it under the pre-scan name. */
export function savedPublicationRange(career) {
  const value = career.publicationRange ?? career.prescanPublicationRange;
  try { return assertPublicationRange(value); } catch { return DEFAULT_PUBLICATION_RANGE; }
}
export function setPublicationRange(career, range) {
  career.publicationRange = assertPublicationRange(range);
  delete career.prescanPublicationRange;
}
