import test from 'node:test';
import assert from 'node:assert/strict';
import { createCareerState } from '../src/mcp/state.mjs';
import { matchingProfileVersion } from '../src/mcp/assessment-policy.mjs';
import { decisionProviders } from '../src/prescan/providers.mjs';
import { DEFAULT_INCLUSION_MINIMUM_SCORE, comparePrescanRows, currentPrescan, currentPrescanRow, establishedIncompatibility, prescanInclusion, setInclusionMinimumScore, setInclusionOverride } from '../src/prescan/state.mjs';
import { addBlock, listBlocks, removeBlock } from '../src/mcp/blocklist.mjs';
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
  const rows = [row('conflict', 100, 'conflict'), row('aligned', DEFAULT_INCLUSION_MINIMUM_SCORE), row('uncertain', 90, 'uncertain'), row('refused', null)];
  const career = fixture(rows), ids = ['refused', 'aligned', 'unseen', 'uncertain', 'conflict'];
  const inclusion = prescanInclusion(career, ids);
  assert.deepEqual(inclusion.rankedIds, ['conflict', 'uncertain', 'aligned']);
  assert.deepEqual([...inclusion.rank], [['conflict', 1], ['uncertain', 2], ['aligned', 3]]);
  // A priority equal to the default minimum score is still sent.
  assert.deepEqual([...inclusion.includedIds], ['conflict', 'uncertain', 'aligned']);
  assert.equal(inclusion.minimumScore, DEFAULT_INCLUSION_MINIMUM_SCORE);
  assert.equal(inclusion.ranked, true);
  assert.equal(inclusion.stale, false);
  assert.equal(inclusion.candidates, 5);
  assert.deepEqual(rows.sort(comparePrescanRows).map(item => item.id), ['conflict', 'uncertain', 'aligned', 'refused']);
  assert.deepEqual(ids, ['refused', 'aligned', 'unseen', 'uncertain', 'conflict']);
});

test('equal priorities order by unrounded fit, then publication recency, then stable ID', () => {
  const older = new Date(Date.now() - 2 * 86400000).toISOString();
  assert.deepEqual([row('z', 80), row('old', 80, 'aligned', older), row('a', 80)].sort(comparePrescanRows).map(item => item.id), ['a', 'z', 'old']);
  // Two jobs rounded to the same priority keep their real order: the discount compresses many jobs into one integer.
  const fit = (id, value) => ({ ...row(id, Math.round(value)), fit: value });
  assert.deepEqual([fit('low', 12.2), fit('high', 12.4), row('legacy', 12)].sort(comparePrescanRows).map(item => item.id), ['high', 'low', 'legacy']);
});

test('a saved review that settles the location is never a candidate for the next run, even with an override', () => {
  const career = fixture([row('moved', 95), row('failed', 90), row('fine', 85)]);
  career.profile = { preferences: { willingToRelocate: false } };
  career.matching.scores.moved = { relocation: 'required', gates: { direction: 'pass', constraints: 'pass', eligibility: 'pass' } };
  career.matching.scores.failed = { relocation: 'not_required', gates: { direction: 'pass', constraints: 'fail', eligibility: 'pass' } };
  career.matching.scores.fine = { relocation: 'required', gates: { direction: 'pass', constraints: 'pass', eligibility: 'pass' } };
  career.profile.preferences.willingToRelocate = true;
  assert.deepEqual(['moved', 'failed', 'fine'].map(id => establishedIncompatibility(career, id)), [false, true, false]);
  career.profile.preferences.willingToRelocate = false;
  assert.deepEqual(['moved', 'failed', 'fine'].map(id => establishedIncompatibility(career, id)), [true, true, true]);
  setInclusionOverride(career, 'moved', true);
  const inclusion = prescanInclusion(career, ['moved', 'failed', 'fine']);
  assert.deepEqual([...inclusion.includedIds], []);
  assert.equal(inclusion.overridden('moved'), false);
  assert.deepEqual(['moved', 'failed', 'fine'].map(inclusion.established), [true, true, true]);
  // The correction route is the preference, which re-admits relocation-only cases but never a gate fail.
  career.profile.preferences.willingToRelocate = true;
  assert.deepEqual([...prescanInclusion(career, ['moved', 'failed', 'fine']).includedIds], ['moved', 'fine']);
});

test('the minimum score splits the ranked queue by priority and per-job overrides win in either direction until cleared', () => {
  const rows = Array.from({ length: 6 }, (_, index) => row(`job-${index}`, 90 - index * 10));
  const career = fixture([...rows, row('refused', null)]);
  const ids = [...rows.map(item => item.id), 'refused', 'unscored'];
  career.matching.jobs.unscored = { id: 'unscored', publishedAt: date };
  setInclusionMinimumScore(career, 70);
  // Priorities 90, 80, 70 pass; 69 would not.
  assert.deepEqual(order(career, ids), ['job-0', 'job-1', 'job-2']);
  career.prescan.rows['job-2'].priority = 69;
  assert.deepEqual(order(career, ids), ['job-0', 'job-1']);
  career.prescan.rows['job-2'].priority = 70;
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
  assert.deepEqual(career.prescanInclusion, { minimumScore: 70, scale: 2, overrides: { 'job-4': true, refused: true } });
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
  assert.equal(inclusion.ranked, false);
  assert.deepEqual([...inclusion.includedIds], ['low', 'plain', 'high']);
  setInclusionOverride(career, 'plain', false);
  assert.deepEqual(order(career, ['low', 'plain', 'high']), ['low', 'high']);
});

test('inclusion writes validate the catalogue ID, the override value and the minimum score range', () => {
  const career = fixture([row('high', 99)]);
  for (const id of ['missing', '__proto__', 'constructor', 42, null, undefined])
    assert.throws(() => setInclusionOverride(career, id, true), { code: 'INVALID_INPUT' });
  for (const value of ['yes', 1, undefined, {}])
    assert.throws(() => setInclusionOverride(career, 'high', value), { code: 'INVALID_INPUT' });
  for (const score of [-1, 0.5, 101, '10', null, undefined, Number.NaN])
    assert.throws(() => setInclusionMinimumScore(career, score), { code: 'INVALID_INPUT' });
  assert.equal(career.prescanInclusion, undefined);
  setInclusionMinimumScore(career, 0);
  assert.deepEqual(career.prescanInclusion, { minimumScore: 0, scale: 2, overrides: {} });
  assert.deepEqual(order(career, ['high']), ['high']);
  setInclusionMinimumScore(career, 100);
  assert.deepEqual(order(career, ['high']), []);
  setInclusionOverride(career, 'high', true);
  assert.deepEqual(career.prescanInclusion, { minimumScore: 100, scale: 2, overrides: { high: true } });
  assert.deepEqual(order(career, ['high']), ['high']);
  // Saved garbage, and a threshold saved on the previous priority scale, fall back to the default instead of breaking ranking.
  for (const saved of [{ minimumScore: 'all', overrides: null }, { minimumScore: 100, overrides: {} }, { minimumScore: 100, scale: 1, overrides: {} }]) {
    career.prescanInclusion = saved;
    assert.equal(prescanInclusion(career, ['high']).minimumScore, DEFAULT_INCLUSION_MINIMUM_SCORE);
    assert.deepEqual(order(career, ['high']), ['high']);
  }
});

test('profile and provider policy changes keep the pre-filter ranking, marked stale, instead of releasing every job', () => {
  const career = fixture([row('high', 99), row('low', 70), row('weak', 30)]);
  career.prescan.assessmentPolicyId = 'unrelated-final-review-policy';
  assert.equal(currentPrescan(career), true);
  assert.deepEqual(order(career, ['low', 'weak', 'high']), ['high', 'low']);
  for (const change of [value => value.evidenceRevision++, value => value.rankingVersion = 1, value => value.prescan.prescanPolicyId = 'old']) {
    const changed = structuredClone(career); change(changed);
    assert.equal(currentPrescan(changed), false);
    const inclusion = prescanInclusion(changed, ['low', 'weak', 'high']);
    assert.equal(inclusion.stale, true);
    assert.deepEqual(inclusion.rankedIds, ['high', 'low', 'weak']);
    assert.deepEqual([...inclusion.includedIds], ['high', 'low']);
  }
  // Only a run from an unknown provider carries no usable ranking.
  const unknown = structuredClone(career); unknown.prescan.provider = '__proto__';
  const inclusion = prescanInclusion(unknown, ['low', 'weak', 'high']);
  assert.deepEqual([inclusion.ranked, inclusion.stale, inclusion.rankedIds], [false, false, []]);
  assert.deepEqual([...inclusion.includedIds], ['low', 'weak', 'high']);
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

test('blocked jobs leave the next run even when switched on; company and category names match across spellings', () => {
  const career = fixture([row('high', 99), row('mid', 80), row('low', 70), row('other', 65)]);
  career.matching.jobs.high.company = 'Acme Labs';
  career.matching.jobs.other.company = 'ACME  labs';
  career.matching.jobs.mid.classification = 'Smart Contracts';
  // The catalogue's raw code on the pre-filter row still matches the category label.
  career.prescan.rows.low.classification = 'SMART_CONTRACTS';
  setInclusionOverride(career, 'high', true);
  const company = addBlock(career, { id: 'high', kind: 'company' });
  addBlock(career, { id: 'mid', kind: 'category' });
  assert.deepEqual(addBlock(career, { id: 'other', kind: 'company' }).id, company.id);
  const ids = ['high', 'mid', 'low', 'other'];
  const inclusion = prescanInclusion(career, ids);
  assert.deepEqual([...inclusion.includedIds], []);
  assert.deepEqual(inclusion.rankedIds, []);
  assert.equal(inclusion.candidates, 0);
  assert.equal(inclusion.blocked, 4);
  assert.deepEqual(listBlocks(career).map(entry => [entry.kind, entry.label, entry.matches]).sort(),
    [['category', 'Smart Contracts', 2], ['company', 'Acme Labs', 2]]);
  removeBlock(career, company.id);
  assert.deepEqual(order(career, ids), ['high', 'other']);
  addBlock(career, { id: 'other', kind: 'job' });
  assert.deepEqual(order(career, ids), ['high']);
  assert.throws(() => removeBlock(career, company.id), { code: 'NOT_FOUND' });
  assert.throws(() => addBlock(career, { id: 'low', kind: 'company' }), { code: 'INVALID_INPUT' });
  assert.throws(() => addBlock(career, { id: 'missing', kind: 'job' }), { code: 'NOT_FOUND' });
  assert.throws(() => addBlock(career, { id: 'high', kind: 'location' }), { code: 'INVALID_INPUT' });
});
