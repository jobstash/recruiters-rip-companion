import test from 'node:test';
import assert from 'node:assert/strict';
import { createCareerState } from '../src/mcp/state.mjs';
import { matchingProfileVersion } from '../src/mcp/assessment-policy.mjs';
import { decisionProviders } from '../src/prescan/providers.mjs';
import { comparePrescanRows, currentPrescan, currentPrescanRow, prescanInclusion, setInclusionCutoff, setInclusionOverride } from '../src/prescan/state.mjs';
import { publicationWindowForRange } from '../src/prescan/publication-range.mjs';

const date = new Date(Date.now() - 86400000).toISOString();
const row = (id, priority, direction = 'aligned', publishedAt = date) => ({ id, priority, direction, publishedAt,
  status: priority === null ? 'refused' : 'scored', constraints: 'aligned', eligibility: 'aligned' });
function fixture(rows) {
  const career = createCareerState();
  career.matching = { jobs: Object.fromEntries(rows.map(item => [item.id, { id: item.id, publishedAt: item.publishedAt }])), scores: {} };
  career.prescan = { profileVersion: matchingProfileVersion(career), prescanPolicyId: decisionProviders.openai.policyId,
    provider: 'openai', rows: Object.fromEntries(rows.map(item => [item.id, item])) };
  return career;
}
const order = (career, ids, window) => [...prescanInclusion(career, ids, window).includedIds];
const ranked = (career, ids, window) => prescanInclusion(career, ids, window).rankedIds;

test('numeric priorities outrank gate verdicts; unscored and unseen IDs stay unranked and excluded by default', () => {
  const rows = [row('conflict', 100, 'conflict'), row('aligned', 50), row('uncertain', 90, 'uncertain'), row('refused', null)];
  const career = fixture(rows), ids = ['refused', 'aligned', 'unseen', 'uncertain', 'conflict'];
  const inclusion = prescanInclusion(career, ids);
  assert.deepEqual(inclusion.rankedIds, ['conflict', 'uncertain', 'aligned']);
  assert.deepEqual([...inclusion.rank], [['conflict', 1], ['uncertain', 2], ['aligned', 3]]);
  assert.deepEqual([...inclusion.includedIds], ['conflict', 'uncertain', 'aligned']);
  assert.equal(inclusion.cutoff, 50);
  assert.deepEqual(rows.sort(comparePrescanRows).map(item => item.id), ['conflict', 'uncertain', 'aligned', 'refused']);
  assert.deepEqual(ids, ['refused', 'aligned', 'unseen', 'uncertain', 'conflict']);
});

test('equal scores resolve by publication recency then stable ID', () => {
  const older = new Date(Date.now() - 2 * 86400000).toISOString();
  assert.deepEqual([row('z', 80), row('old', 80, 'aligned', older), row('a', 80)].sort(comparePrescanRows).map(item => item.id), ['a', 'z', 'old']);
});

test('the cutoff splits the ranked queue and per-job overrides win in either direction until cleared', () => {
  const rows = Array.from({ length: 6 }, (_, index) => row(`job-${index}`, 90 - index * 10));
  const career = fixture([...rows, row('refused', null)]);
  const ids = [...rows.map(item => item.id), 'refused', 'unscored'];
  career.matching.jobs.unscored = { id: 'unscored', publishedAt: date };
  setInclusionCutoff(career, 3);
  assert.deepEqual(order(career, ids), ['job-0', 'job-1', 'job-2']);
  assert.deepEqual(ranked(career, ids), rows.map(item => item.id));
  setInclusionOverride(career, 'job-4', true);
  setInclusionOverride(career, 'job-1', false);
  setInclusionOverride(career, 'unscored', true);
  setInclusionOverride(career, 'refused', true);
  const inclusion = prescanInclusion(career, ids);
  assert.deepEqual([...inclusion.includedIds], ['job-0', 'job-2', 'job-4', 'refused', 'unscored']);
  assert.equal(inclusion.rank.get('job-1'), 2);
  assert.deepEqual(ids.map(id => inclusion.overridden(id)), [false, true, false, false, true, false, true, true]);
  setInclusionOverride(career, 'job-1', null);
  setInclusionOverride(career, 'unscored', null);
  assert.deepEqual(order(career, ids), ['job-0', 'job-1', 'job-2', 'job-4', 'refused']);
  assert.deepEqual(career.prescanInclusion, { cutoff: 3, overrides: { 'job-4': true, refused: true } });
  // Overrides for jobs that left the catalogue are ignored, not deleted.
  delete career.matching.jobs['job-4'];
  assert.deepEqual(order(career, ids.filter(id => id !== 'job-4')), ['job-0', 'job-1', 'job-2', 'refused']);
  assert.equal(career.prescanInclusion.overrides['job-4'], true);
});

test('without a current pre-scan every candidate is included unless excluded by hand', () => {
  const career = fixture([row('high', 99), row('low', 20)]);
  delete career.prescan;
  career.matching.jobs.plain = { id: 'plain', publishedAt: date };
  const inclusion = prescanInclusion(career, ['low', 'plain', 'high']);
  assert.deepEqual(inclusion.rankedIds, []);
  assert.deepEqual([...inclusion.includedIds], ['low', 'plain', 'high']);
  setInclusionOverride(career, 'plain', false);
  assert.deepEqual(order(career, ['low', 'plain', 'high']), ['low', 'high']);
});

test('inclusion writes validate the catalogue ID, the override value and the cutoff range', () => {
  const career = fixture([row('high', 99)]);
  for (const id of ['missing', '__proto__', 'constructor', 42, null, undefined])
    assert.throws(() => setInclusionOverride(career, id, true), { code: 'INVALID_INPUT' });
  for (const value of ['yes', 1, undefined, {}])
    assert.throws(() => setInclusionOverride(career, 'high', value), { code: 'INVALID_INPUT' });
  for (const count of [0, -1, 1.5, 100001, '10', null, undefined, Number.NaN])
    assert.throws(() => setInclusionCutoff(career, count), { code: 'INVALID_INPUT' });
  assert.equal(career.prescanInclusion, undefined);
  setInclusionCutoff(career, 100000);
  assert.deepEqual(career.prescanInclusion, { cutoff: 100000, overrides: {} });
  setInclusionCutoff(career, 1);
  setInclusionOverride(career, 'high', false);
  assert.deepEqual(career.prescanInclusion, { cutoff: 1, overrides: { high: false } });
  assert.deepEqual(order(career, ['high']), []);
  // Saved garbage falls back to the defaults instead of breaking ranking.
  career.prescanInclusion = { cutoff: 'all', overrides: null };
  assert.equal(prescanInclusion(career, ['high']).cutoff, 50);
  assert.deepEqual(order(career, ['high']), ['high']);
});

test('career evidence and provider policy changes invalidate ordering, final assessment policy does not', () => {
  const career = fixture([row('high', 99), row('low', 20)]);
  career.prescan.assessmentPolicyId = 'unrelated-final-review-policy';
  assert.equal(currentPrescan(career), true);
  assert.deepEqual(order(career, ['low', 'high']), ['high', 'low']);
  for (const change of [value => value.evidenceRevision++, value => value.rankingVersion = 1,
    value => value.prescan.prescanPolicyId = 'old', value => value.prescan.provider = '__proto__']) {
    const changed = structuredClone(career); change(changed);
    assert.equal(currentPrescan(changed), false);
    assert.deepEqual(ranked(changed, ['low', 'high']), []);
    assert.deepEqual(order(changed, ['low', 'high']), ['low', 'high']);
  }
});

test('expired or changed adverts remain accessible but cannot influence current ordering', () => {
  const older = new Date(Date.now() - 20 * 86400000).toISOString();
  const career = fixture([row('older', 99, 'aligned', older), row('recent', 70)]);
  assert.deepEqual(ranked(career, ['older', 'recent']), ['recent']);
  assert.deepEqual(order(career, ['older', 'recent']), ['recent']);
  assert.deepEqual(order(career, ['recent', 'older'], publicationWindowForRange('all')), ['older', 'recent']);
  career.matching.jobs.older.publishedAt = date;
  assert.equal(currentPrescanRow(career, career.prescan.rows.older, Date.now(), publicationWindowForRange('all')), false);
  assert.equal(Object.keys(career.prescan.rows).length, 2);
});
