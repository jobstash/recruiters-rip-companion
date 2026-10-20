import { fail } from '../mcp/state.mjs';
import { blockedIds } from '../mcp/blocklist.mjs';
import { matchingProfileVersion } from '../mcp/assessment-policy.mjs';
import { decisionProviders } from './providers.mjs';
import { DEFAULT_PUBLICATION_RANGE, publicationInWindow, publicationWindowForRange } from './publication-range.mjs';

const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const publishedTime = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : -Infinity;

/**
 * A run from a known provider. Its priorities may predate the current profile or provider policy (see currentPrescan);
 * an outdated ranking still bounds the next agent run far better than releasing every job.
 */
function rankablePrescan(career) {
  const run = career.prescan;
  return Boolean(run && Object.hasOwn(decisionProviders, run.provider) && run.rows && typeof run.rows === 'object');
}
export function currentPrescan(career) {
  return rankablePrescan(career) && career.prescan.prescanPolicyId === decisionProviders[career.prescan.provider].policyId &&
    career.prescan.profileVersion === matchingProfileVersion(career);
}

function rowMatchesJob(career, row, window) {
  const job = career.matching?.jobs?.[row.id];
  return publicationInWindow(row.publishedAt, window) && Boolean(job && job.publishedAt === row.publishedAt);
}
export function currentPrescanRow(career, row, now = Date.now(), window = publicationWindowForRange(career.prescan?.publicationRange ?? DEFAULT_PUBLICATION_RANGE, now)) {
  return currentPrescan(career) && rowMatchesJob(career, row, window);
}

const scored = row => row.status === 'scored' && Number.isInteger(row.priority) && row.priority >= 0 && row.priority <= 100;
export function comparePrescanRows(a, b) {
  return Number(scored(b)) - Number(scored(a)) || (scored(a) && scored(b) ? b.priority - a.priority : 0) ||
    publishedTime(b.publishedAt) - publishedTime(a.publishedAt) || compareText(a.id, b.id);
}

export const DEFAULT_INCLUSION_MINIMUM_SCORE = 60;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const validMinimumScore = value => Number.isInteger(value) && value >= 0 && value <= 100;

/** Saved inclusion settings; never created here. Overrides for IDs outside the catalogue are kept but ignored. */
export function inclusionSettings(career) {
  const saved = career.prescanInclusion;
  const minimumScore = validMinimumScore(saved?.minimumScore) ? saved.minimumScore : DEFAULT_INCLUSION_MINIMUM_SCORE;
  const overrides = saved?.overrides && typeof saved.overrides === 'object' ? saved.overrides : {};
  return { minimumScore, override: id => !forbidden.has(id) && Object.hasOwn(overrides, id) && typeof overrides[id] === 'boolean' ? overrides[id] : null };
}

/**
 * Which candidate jobs the next agent review covers. `ids` are the catalogue jobs without a current review.
 * Blocked jobs leave the candidates entirely (`blocked` counts them), even when switched on.
 * Rank numbers scored pre-filter rows in pre-filter order; an override wins, then priority ≥ minimumScore. Only when no
 * pre-filter exists is every candidate included. A profile or provider policy change makes the ranking `stale` but it keeps
 * bounding the run: falling back to "include everything" would silently hand the whole catalogue to the expensive agent review.
 * `includedIds` iterates in review order: ranked rows by rank, then the remaining candidates in the order given.
 */
export function prescanInclusion(career, allIds, window) {
  const settings = inclusionSettings(career);
  const isBlocked = blockedIds(career), ids = allIds.filter(id => !isBlocked(id));
  const ranked = [], unranked = [], ranking = rankablePrescan(career), current = currentPrescan(career);
  const rowWindow = window ?? publicationWindowForRange(career.prescan?.publicationRange ?? DEFAULT_PUBLICATION_RANGE);
  for (const id of ids) {
    const row = ranking ? career.prescan.rows?.[id] : undefined;
    if (row && scored(row) && rowMatchesJob(career, { ...row, id }, rowWindow)) ranked.push(id);
    else unranked.push(id);
  }
  ranked.sort((a, b) => comparePrescanRows(career.prescan.rows[a], career.prescan.rows[b]));
  const rank = new Map(ranked.map((id, index) => [id, index + 1]));
  const included = id => settings.override(id) ?? (ranking ? rank.has(id) && career.prescan.rows[id].priority >= settings.minimumScore : true);
  return { minimumScore: settings.minimumScore, ranked: ranking, stale: ranking && !current, candidates: ids.length,
    blocked: allIds.length - ids.length, rankedIds: ranked, rank,
    includedIds: new Set([...ranked, ...unranked].filter(included)), overridden: id => settings.override(id) !== null };
}

/** Save a per-job override (`null` clears it). The ID must be in the current catalogue. */
export function setInclusionOverride(career, id, included) {
  if (typeof id !== 'string' || forbidden.has(id) || !Object.hasOwn(career.matching?.jobs ?? {}, id))
    fail('INVALID_INPUT', 'This job is not in the current catalogue. Refresh the list.');
  if (included !== null && typeof included !== 'boolean') fail('INVALID_INPUT', 'Choose include, exclude or reset.');
  const saved = career.prescanInclusion ??= { minimumScore: DEFAULT_INCLUSION_MINIMUM_SCORE, overrides: {} };
  saved.overrides ??= {};
  if (included === null) delete saved.overrides[id];
  else saved.overrides[id] = included;
}

export function setInclusionMinimumScore(career, minimumScore) {
  if (!validMinimumScore(minimumScore)) fail('INVALID_INPUT', 'Use a whole number from 0 to 100.');
  const saved = career.prescanInclusion ??= { minimumScore: DEFAULT_INCLUSION_MINIMUM_SCORE, overrides: {} };
  saved.minimumScore = minimumScore;
}
