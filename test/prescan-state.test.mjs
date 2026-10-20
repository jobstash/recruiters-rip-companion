import test from 'node:test';
import assert from 'node:assert/strict';
import { createCareerState } from '../src/mcp/state.mjs';
import { matchingProfileVersion } from '../src/mcp/assessment-policy.mjs';
import { decisionProviders } from '../src/prescan/providers.mjs';
import { comparePrescanRows, currentPrescan, currentPrescanRow, prioritizePrescanIds } from '../src/prescan/state.mjs';
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

test('numeric priorities outrank gate verdicts and preserve every unscored or unseen ID', () => {
  const rows = [row('conflict', 100, 'conflict'), row('aligned', 50), row('uncertain', 90, 'uncertain'), row('refused', null)];
  const career = fixture(rows), ids = ['refused', 'aligned', 'unseen', 'uncertain', 'conflict'];
  assert.deepEqual(prioritizePrescanIds(career, ids), ['conflict', 'uncertain', 'aligned', 'refused', 'unseen']);
  assert.deepEqual(rows.sort(comparePrescanRows).map(item => item.id), ['conflict', 'uncertain', 'aligned', 'refused']);
  assert.deepEqual(ids, ['refused', 'aligned', 'unseen', 'uncertain', 'conflict']);
});

test('equal scores resolve by publication recency then stable ID', () => {
  const older = new Date(Date.now() - 2 * 86400000).toISOString();
  assert.deepEqual([row('z', 80), row('old', 80, 'aligned', older), row('a', 80)].sort(comparePrescanRows).map(item => item.id), ['a', 'z', 'old']);
});

test('career evidence and provider policy changes invalidate ordering, final assessment policy does not', () => {
  const career = fixture([row('high', 99), row('low', 20)]);
  career.prescan.assessmentPolicyId = 'unrelated-final-review-policy';
  assert.equal(currentPrescan(career), true);
  assert.deepEqual(prioritizePrescanIds(career, ['low', 'high']), ['high', 'low']);
  for (const change of [value => value.evidenceRevision++, value => value.rankingVersion = 1,
    value => value.prescan.prescanPolicyId = 'old', value => value.prescan.provider = '__proto__']) {
    const changed = structuredClone(career); change(changed);
    assert.equal(currentPrescan(changed), false);
    assert.deepEqual(prioritizePrescanIds(changed, ['low', 'high']), ['low', 'high']);
  }
});

test('expired or changed adverts remain accessible but cannot influence current ordering', () => {
  const older = new Date(Date.now() - 20 * 86400000).toISOString();
  const career = fixture([row('older', 99, 'aligned', older), row('recent', 70)]);
  assert.deepEqual(prioritizePrescanIds(career, ['older', 'recent']), ['recent', 'older']);
  assert.deepEqual(prioritizePrescanIds(career, ['recent', 'older'], publicationWindowForRange('all')), ['older', 'recent']);
  career.matching.jobs.older.publishedAt = date;
  assert.equal(currentPrescanRow(career, career.prescan.rows.older, Date.now(), publicationWindowForRange('all')), false);
  assert.equal(Object.keys(career.prescan.rows).length, 2);
});
