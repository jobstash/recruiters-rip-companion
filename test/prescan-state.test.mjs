import test from 'node:test';
import assert from 'node:assert/strict';
import { createCareerState } from '../src/mcp/state.mjs';
import { matchingProfileVersion } from '../src/mcp/assessment-policy.mjs';
import { ASSESSMENT_POLICY_ID } from '../src/mcp/matching-contract.mjs';
import { decisionProviders } from '../src/prescan/providers.mjs';
import { getPrescanResults, prioritizePrescanIds } from '../src/prescan/state.mjs';
import { publicationWindowForRange } from '../src/prescan/publication-range.mjs';

const date = new Date(Date.now() - 86400000).toISOString();
const row = (id, priority, direction = 'aligned', constraints = 'aligned', publishedAt = date, eligibility = 'aligned') => ({
  id, title: id, company: 'Synthetic company', publishedAt, status: priority === null ? 'refused' : 'scored',
  priority, direction, constraints, eligibility, confidence: priority === null ? null : 0.8,
});
function fixture(rows) {
  const career = createCareerState();
  career.matching = { jobs: Object.fromEntries(rows.map(row => [row.id, { id: row.id, publishedAt: row.publishedAt }])), scores: {} };
  career.prescan = { id: 'run', profileVersion: matchingProfileVersion(career), assessmentPolicyId: ASSESSMENT_POLICY_ID,
    prescanPolicyId: decisionProviders.openai.policyId, provider: 'openai', model: 'gpt-6-luna', status: 'completed', rows: Object.fromEntries(rows.map(row => [row.id, row])) };
  return { career, store: { get: () => structuredClone({ career }) } };
}

test('results sort the full set before paging, retaining refusals and high-priority conflicts', () => {
  const f = fixture([
    row('conflict', 100, 'conflict'), row('uncertain', 95, 'uncertain'), row('refusal', null, null, null, date, null),
    row('aligned-low', 50), row('aligned-high', 90), row('constraint-conflict', 80, 'aligned', 'conflict'),
    row('eligibility-conflict', 99, 'aligned', 'aligned', date, 'conflict'), row('eligibility-uncertain', 96, 'aligned', 'aligned', date, 'uncertain'),
  ]);
  const first = getPrescanResults(f.store, { limit: 3 });
  const second = getPrescanResults(f.store, { offset: first.nextOffset, limit: 3 });
  const last = getPrescanResults(f.store, { offset: second.nextOffset, limit: 3 });
  assert.deepEqual([...first.items, ...second.items, ...last.items].map(row => row.id),
    ['aligned-high', 'aligned-low', 'eligibility-uncertain', 'uncertain', 'refusal', 'conflict', 'eligibility-conflict', 'constraint-conflict']);
  assert.equal(first.total, 8);
  assert.equal(first.current, true);
  assert.equal(last.nextOffset, null);
  assert.equal(first.items[0].provider, 'openai');
  assert.equal(first.items[0].model, 'gpt-6-luna');
  assert.equal(first.items[0].current, true);
  assert.equal(first.status, undefined);
});

test('priority ties resolve by publication date then ID, independent of insertion order', () => {
  const older = new Date(Date.now() - 2 * 86400000).toISOString();
  const f = fixture([row('z', 80), row('old', 80, 'aligned', 'aligned', older), row('a', 80)]);
  assert.deepEqual(getPrescanResults(f.store).items.map(row => row.id), ['a', 'z', 'old']);
});

test('prioritization keeps every ID, unscanned relative order, and conflicts last', () => {
  const f = fixture([row('conflict', 100, 'conflict'), row('best', 80), row('uncertain', 99, 'uncertain'), row('refusal', null, null, null, date, null),
    row('ineligible', 100, 'aligned', 'aligned', date, 'conflict')]);
  const ids = ['conflict', 'unseen-b', 'refusal', 'ineligible', 'uncertain', 'unseen-a', 'best'];
  assert.deepEqual(prioritizePrescanIds(f.career, ids), ['best', 'uncertain', 'unseen-b', 'refusal', 'unseen-a', 'conflict', 'ineligible']);
  assert.deepEqual(ids, ['conflict', 'unseen-b', 'refusal', 'ineligible', 'uncertain', 'unseen-a', 'best']);
});

test('changed profile, assessment policy and pre-scan provider policy never drive discovery order', () => {
  for (const change of [career => { career.evidenceRevision++; }, career => { career.rankingVersion = 1; },
    career => { career.prescan.assessmentPolicyId = 'old-assessment'; }, career => { career.prescan.prescanPolicyId = 'old-prescan'; },
    career => { career.prescan.provider = '__proto__'; }]) {
    const f = fixture([row('best', 99), row('conflict', 100, 'conflict')]);
    change(f.career);
    const ids = ['conflict', 'unseen', 'best'];
    assert.deepEqual(prioritizePrescanIds(f.career, ids), ids);
    const result = getPrescanResults(f.store);
    assert.equal(result.current, false);
    assert.equal(result.items.every(row => !row.current), true);
    assert.equal(result.total, 2);
  }
});

test('expired, future, absent and changed-publication rows cannot influence discovery order', () => {
  const expired = new Date(Date.now() - 8 * 86400000).toISOString(), future = new Date(Date.now() + 86400000).toISOString();
  const f = fixture([row('expired', 100, 'conflict', 'aligned', expired), row('future', 100, 'aligned', 'aligned', future),
    row('absent', 100), row('changed', 100), row('current', 70)]);
  delete f.career.matching.jobs.absent;
  f.career.matching.jobs.changed.publishedAt = new Date(Date.now() - 1000).toISOString();
  const ids = ['expired', 'future', 'absent', 'changed', 'current'];
  assert.deepEqual(prioritizePrescanIds(f.career, ids), ['current', 'expired', 'future', 'absent', 'changed']);
  const result = getPrescanResults(f.store);
  assert.equal(result.items.filter(row => row.current).length, 1);
  assert.equal(result.total, 5);
});

test('local result reads work without matching catalogue, credentials or network and validate paging', () => {
  const f = fixture([row('saved', 80)]);
  delete f.career.matching;
  assert.equal(getPrescanResults(f.store).items[0].current, false);
  for (const args of [null, [], { limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 0.5 }, { apiKey: 'never' }])
    assert.throws(() => getPrescanResults(f.store, args), { code: 'INVALID_INPUT' });
  assert.equal(getPrescanResults(f.store, { offset: 100 }).items.length, 0);
  assert.deepEqual(prioritizePrescanIds(createCareerState(), ['a', 'b']), ['a', 'b']);
});

test('whole-catalogue selection reuses current older successes while preserving narrower-range visibility', () => {
  const older = new Date(Date.now() - 20 * 86400000).toISOString();
  const f = fixture([row('older', 95, 'aligned', 'aligned', older), row('recent', 70)]);
  const ids = ['recent', 'older'];
  assert.deepEqual(prioritizePrescanIds(f.career, ids), ['recent', 'older']);
  assert.deepEqual(prioritizePrescanIds(f.career, ids, publicationWindowForRange('all')), ['older', 'recent']);
  const allStore = { get: () => ({ ...f.store.get(), prescanPublicationRange: 'all' }) };
  assert.equal(getPrescanResults(allStore).items.find(item => item.id === 'older').current, true);
  assert.equal(getPrescanResults(f.store).items.find(item => item.id === 'older').current, false);
  assert.equal(getPrescanResults(f.store).total, 2);
});
