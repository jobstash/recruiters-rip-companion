import { fail } from '../mcp/state.mjs';

export const DEFAULT_PUBLICATION_RANGE = 'past_3_days';
export const PUBLICATION_RANGES = Object.freeze(['today', 'yesterday', 'past_3_days', 'past_week', 'past_2_weeks', 'past_month', 'all']);
const DAY_MS = 24 * 60 * 60 * 1000;
const rollingDays = { past_3_days: 3, past_week: 7, past_2_weeks: 14, past_month: 30 };

export function assertPublicationRange(value) {
  if (!PUBLICATION_RANGES.includes(value)) fail('INVALID_INPUT', 'Choose a supported job publication range.');
  return value;
}

/** Today/yesterday follow the companion's local calendar; other periods are rolling. */
export function publicationWindowForRange(range = DEFAULT_PUBLICATION_RANGE, now = Date.now()) {
  assertPublicationRange(range);
  if (!Number.isFinite(now)) fail('INVALID_INPUT', 'A valid publication-window time is required.');
  let since = null, until = new Date(now);
  if (range === 'today' || range === 'yesterday') {
    since = new Date(now);
    since.setHours(0, 0, 0, 0);
    if (range === 'yesterday') {
      until = new Date(since);
      since.setDate(since.getDate() - 1);
    }
  } else if (range !== 'all') {
    since = new Date(now - rollingDays[range] * DAY_MS);
  }
  return { range, since: since?.toISOString() ?? null, until: until.toISOString() };
}

/** Publication scopes are left-inclusive and right-exclusive, including Yesterday. */
export function publicationInWindow(publishedAt, window) {
  if (!window || (window.since !== null && typeof window.since !== 'string') || typeof window.until !== 'string') return false;
  const timestamp = Date.parse(publishedAt), until = Date.parse(window.until);
  const since = window.since === null ? -Infinity : Date.parse(window.since);
  return Number.isFinite(timestamp) && Number.isFinite(until) && !Number.isNaN(since) && since <= until && timestamp >= since && timestamp < until;
}
