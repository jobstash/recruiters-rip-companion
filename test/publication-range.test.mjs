import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { publicationWindowForRange, publicationInWindow } from '../src/mcp/publication-range.mjs';

const now = Date.parse('2026-10-20T12:00:00.000Z');
const day = 86400000;

test('rolling publication ranges include their lower boundary and exclude their upper boundary', () => {
  for (const [range, days] of [['past_3_days', 3], ['past_week', 7], ['past_2_weeks', 14], ['past_month', 30]]) {
    const window = publicationWindowForRange(range, now);
    assert.equal(Date.parse(window.since), now - days * day);
    assert.equal(Date.parse(window.until), now);
    assert.equal(publicationInWindow(window.since, window), true);
    assert.equal(publicationInWindow(new Date(Date.parse(window.since) - 1).toISOString(), window), false);
    assert.equal(publicationInWindow(window.until, window), false);
  }
});

test('whole catalogue includes old publications without including future or invalid dates', () => {
  const window = publicationWindowForRange('all', now);
  assert.equal(window.since, null);
  assert.equal(publicationInWindow('1990-01-01T00:00:00Z', window), true);
  assert.equal(publicationInWindow('2026-10-21T00:00:00Z', window), false);
  assert.equal(publicationInWindow('unknown', window), false);
});

test('today and yesterday follow the local calendar through daylight-saving changes', () => {
  const source = new URL('../src/mcp/publication-range.mjs', import.meta.url).href;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {publicationWindowForRange} from ${JSON.stringify(source)};
     const now=Date.parse('2026-10-26T12:00:00Z');
     console.log(JSON.stringify({today:publicationWindowForRange('today',now),yesterday:publicationWindowForRange('yesterday',now)}));`],
  { env: { PATH: process.env.PATH, TZ: 'Europe/Amsterdam' }, encoding: 'utf8' }));
  assert.equal(result.today.since, '2026-10-25T23:00:00.000Z');
  assert.equal(result.yesterday.since, '2026-10-24T22:00:00.000Z');
  assert.equal(result.yesterday.until, result.today.since);
  assert.equal(Date.parse(result.yesterday.until) - Date.parse(result.yesterday.since), 25 * 60 * 60 * 1000);
  assert.equal(publicationInWindow(result.today.since, result.yesterday), false);
  assert.equal(publicationInWindow(result.today.since, result.today), true);
});

test('invalid range choices and invalid bounds never imply whole-catalogue access', () => {
  for (const range of ['last_year', '', null, 100000]) assert.throws(() => publicationWindowForRange(range, now), { code: 'INVALID_INPUT' });
  assert.throws(() => publicationWindowForRange('today', NaN), { code: 'INVALID_INPUT' });
  assert.equal(publicationInWindow('2026-10-20T00:00:00Z', { since: '2026-10-21T00:00:00Z', until: '2026-10-19T00:00:00Z' }), false);
});
