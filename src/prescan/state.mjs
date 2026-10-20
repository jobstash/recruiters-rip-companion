import { matchingProfileVersion } from '../mcp/assessment-policy.mjs';
import { decisionProviders } from './providers.mjs';
import { DEFAULT_PUBLICATION_RANGE, publicationInWindow, publicationWindowForRange } from './publication-range.mjs';

const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const publishedTime = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : -Infinity;

export function currentPrescan(career) {
  const run = career.prescan;
  return Boolean(run && Object.hasOwn(decisionProviders, run.provider) &&
    run.prescanPolicyId === decisionProviders[run.provider].policyId && run.profileVersion === matchingProfileVersion(career));
}

export function currentPrescanRow(career, row, now = Date.now(), window = publicationWindowForRange(career.prescan?.publicationRange ?? DEFAULT_PUBLICATION_RANGE, now)) {
  const job = career.matching?.jobs?.[row.id];
  return currentPrescan(career) && publicationInWindow(row.publishedAt, window) &&
    Boolean(job && job.publishedAt === row.publishedAt);
}

const scored = row => row.status === 'scored' && Number.isInteger(row.priority) && row.priority >= 0 && row.priority <= 100;
export function comparePrescanRows(a, b) {
  return Number(scored(b)) - Number(scored(a)) || (scored(a) && scored(b) ? b.priority - a.priority : 0) ||
    publishedTime(b.publishedAt) - publishedTime(a.publishedAt) || compareText(a.id, b.id);
}

/** Reorder, never filter: current scored priorities first, every other ID retained. */
export function prioritizePrescanIds(career, ids, window) {
  if (!currentPrescan(career)) return [...ids];
  const first = [], untouched = [], now = Date.now();
  for (const id of ids) {
    const row = career.prescan.rows?.[id];
    if (!row || !scored(row) || !currentPrescanRow(career, row, now, window)) untouched.push(id);
    else first.push(id);
  }
  const compare = (a, b) => comparePrescanRows(career.prescan.rows[a], career.prescan.rows[b]);
  return [...first.sort(compare), ...untouched];
}
