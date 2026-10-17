import { matchingProfileVersion, recentPublication } from '../mcp/assessment-policy.mjs';
import { ASSESSMENT_POLICY_ID } from '../mcp/matching-contract.mjs';
import { fail, readCareer } from '../mcp/state.mjs';
import { decisionProviders } from './providers.mjs';

const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function currentPrescan(career) {
  const run = career.prescan;
  return Boolean(run && run.assessmentPolicyId === ASSESSMENT_POLICY_ID && Object.hasOwn(decisionProviders, run.provider) &&
    run.prescanPolicyId === decisionProviders[run.provider].policyId && run.profileVersion === matchingProfileVersion(career));
}

export function currentPrescanRow(career, row, now = Date.now()) {
  const job = career.matching?.jobs?.[row.id];
  return currentPrescan(career) && recentPublication(row.publishedAt, now) &&
    Boolean(job && job.publishedAt === row.publishedAt);
}

const gates = row => [row.direction, row.constraints, row.eligibility];
const conflict = row => gates(row).includes('conflict');
const scored = row => row.status === 'scored' && Number.isInteger(row.priority) && row.priority >= 0 && row.priority <= 100;
const group = row => !scored(row) ? 2 : conflict(row) ? 3 : gates(row).every(value => value === 'aligned') ? 0 : 1;
export function comparePrescanRows(a, b) {
  return group(a) - group(b) || (b.priority ?? -1) - (a.priority ?? -1) ||
    (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0) || compareText(a.id, b.id);
}

/** Local-only results. Runtime/credential status is supplied by controller.results, not this pure reader. */
export function getPrescanResults(store, args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['offset', 'limit'].includes(key)))
    fail('INVALID_INPUT', 'Provide only offset and limit for pre-scan results.');
  const { offset = 0, limit = 25 } = args;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    fail('INVALID_INPUT', 'Use a non-negative offset and a result limit from 1 to 100.');
  const career = readCareer(store), run = career.prescan, now = Date.now();
  const rows = Object.values(run?.rows ?? {}).sort(comparePrescanRows);
  return { view: 'prescan', items: rows.slice(offset, offset + limit).map(row => ({ ...row,
    provider: run.provider, model: run.model, current: currentPrescanRow(career, row, now) })),
  total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null, current: currentPrescan(career) };
}

/** Reorder, never filter: current scored matches first, untouched IDs next, current conflicts last. */
export function prioritizePrescanIds(career, ids) {
  if (!currentPrescan(career)) return [...ids];
  const first = [], untouched = [], last = [], now = Date.now();
  for (const id of ids) {
    const row = career.prescan.rows?.[id];
    if (!row || !scored(row) || !currentPrescanRow(career, row, now)) untouched.push(id);
    else (conflict(row) ? last : first).push(id);
  }
  const compare = (a, b) => comparePrescanRows(career.prescan.rows[a], career.prescan.rows[b]);
  return [...first.sort(compare), ...untouched, ...last.sort(compare)];
}
