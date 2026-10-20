import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createCareerState } from '../src/mcp/state.mjs';
import { createCareerBrowser } from '../src/career-browser.mjs';
import { ASSESSMENT_POLICY_ID, deriveDecision } from '../src/mcp/matching-contract.mjs';
import { createMatchingTools } from '../src/mcp/matching-tools.mjs';
import { decisionProviders } from '../src/prescan/providers.mjs';

function fixture() {
  const state = { privateKey: 'PRIVATE_KEY_SENTINEL', career: createCareerState() };
  const store = { get: () => structuredClone(state), update: () => assert.fail('Browsing must not write') };
  return { state, store, browser: createCareerBrowser({ store }) };
}

const currentDate = () => new Date(Date.now() - 60000).toISOString();
const scoredAt = '2026-10-14T12:00:00.000Z';
const passing = { direction: 'pass', constraints: 'pass', eligibility: 'pass' };
// Equal dimensions make overall fit equal that value; the decision is always the companion's derivation.
function finalAssessment(overall = 80, changes = {}) {
  const row = { status: 'assessed',
    requirements: [{ requirement: 'Own production services', importance: 'essential', evidence: 'demonstrated', cvQuote: 'Built services.' }],
    gates: passing, dimensions: { direction: overall, capability: overall, scope: overall, preferences: overall },
    relocation: 'not_required', reason: 'Saved full-advert review.', ...changes };
  return { ...row, ...deriveDecision(row), profileVersion: '0:0', policyId: ASSESSMENT_POLICY_ID, scoredAt };
}
const unavailableAssessment = () => ({ status: 'unavailable', reason: 'Original advert unavailable.',
  ...deriveDecision({ status: 'unavailable' }), profileVersion: '0:0', policyId: ASSESSMENT_POLICY_ID, scoredAt });
function savePrescan(career, rows) {
  career.prescan = { assessmentPolicyId: ASSESSMENT_POLICY_ID, prescanPolicyId: decisionProviders.openai.policyId,
    profileVersion: '0:0', provider: 'openai', model: 'saved-model', rows: Object.fromEntries(rows.map(row => [row.id, row])) };
}
const preliminary = (id, publishedAt, priority = 75, extra = {}) => ({
  id, title: id, company: 'Company', publishedAt, priority, status: 'scored',
  direction: 'aligned', constraints: 'aligned', eligibility: 'aligned',
  dimensions: { direction: 80, capability: 70, scope: 60, preferences: 90 }, confidence: 0.8, ...extra,
});
const fieldValue = (item, heading, label) => item.sections.find(section => section.heading === heading)?.fields?.find(field => field.label === label)?.value;
const sectionFields = (item, heading) => item.sections.find(section => section.heading === heading)?.fields;

test('career reads return complete source text without exposing binary sources, credentials or prototype properties', async () => {
  const { state, browser } = fixture();
  const text = 'Complete source text. '.repeat(1500) + 'Final evidence sentence.';
  state.career.sources.saved = { id: 'saved', name: 'Original CV', purpose: 'cv', text, originalBase64: 'BINARY_SOURCE_SENTINEL' };
  const before = structuredClone(state);
  const detail = await browser.read({ kind: 'sources', id: 'saved' });
  assert.ok(detail.sections.some(section => section.text === text));
  assert.deepEqual(detail.sections.map(section => section.heading), ['CV', 'Text']);
  assert.equal(detail.sections.flatMap(section => section.fields ?? []).some(field => field.label === 'Purpose'), false);
  assert.equal((await browser.list({ kind: 'sources' })).items[0].summary, '');
  assert.equal(JSON.stringify(detail).includes('BINARY_SOURCE_SENTINEL'), false);
  assert.equal(JSON.stringify(detail).includes('PRIVATE_KEY_SENTINEL'), false);
  for (const id of ['constructor', '__proto__', 'prototype'])
    await assert.rejects(browser.read({ kind: 'sources', id }), { code: 'INVALID_INPUT' });
  await assert.rejects(browser.read({ kind: 'sources', id: 'missing' }), { code: 'NOT_FOUND' });
  await assert.rejects(browser.list({ kind: 'sources', limit: 101 }), { code: 'INVALID_INPUT' });
  await assert.rejects(browser.list({ kind: 'sources', offset: -1 }), { code: 'INVALID_INPUT' });
  await assert.rejects(browser.read({ kind: 'sources', id: 'saved', path: '/private' }), { code: 'INVALID_INPUT' });
  assert.deepEqual(state, before);
});

test('non-CV and archived sources remain accessible without repeating the CV purpose', async () => {
  const { state, browser } = fixture();
  state.career.sources.note = { name: 'Interview notes', purpose: 'supporting_evidence', text: 'Complete supporting evidence.', archived: true };
  state.career.sources.cv = { name: 'Earlier CV', purpose: 'cv', text: 'Earlier evidence.', archived: true };
  const page = await browser.list({ kind: 'sources' });
  assert.deepEqual(page.items.map(item => item.summary), ['Supporting evidence · Archived', 'Archived']);
  const note = await browser.read({ kind: 'sources', id: 'note' });
  assert.equal(fieldValue(note, 'Source', 'Purpose'), 'Supporting evidence');
  assert.equal(fieldValue(note, 'Source', 'Status'), 'Archived');
  assert.equal(note.sections[1].text, 'Complete supporting evidence.');
});

test('browser kinds cut over to jobs without keeping obsolete assessment endpoints', async () => {
  const { browser } = fixture();
  for (const kind of ['prescan', 'rankings']) {
    await assert.rejects(browser.list({ kind }), { code: 'INVALID_INPUT' });
    await assert.rejects(browser.read({ kind, id: 'saved' }), { code: 'INVALID_INPUT' });
  }
  assert.deepEqual(await browser.list({ kind: 'jobs' }), { items: [], total: 0, nextOffset: null });
  await assert.rejects(browser.read({ kind: 'jobs', id: 'missing' }), { code: 'NOT_FOUND' });
});

test('Jobs sort is strictly validated and is not accepted by other browser categories', async () => {
  const { browser } = fixture();
  for (const sort of [null, undefined, '', 'newest', 'Score', 0, {}, ['score']])
    await assert.rejects(browser.list({ kind: 'jobs', sort }), { code: 'INVALID_INPUT' });
  for (const kind of ['sources', 'facts', 'applications'])
    await assert.rejects(browser.list({ kind, sort: 'score' }), { code: 'INVALID_INPUT' });
  for (const sort of ['score', 'recent'])
    assert.deepEqual(await browser.list({ kind: 'jobs', sort }), { items: [], total: 0, nextOffset: null });
  await assert.rejects(browser.read({ kind: 'jobs', id: 'missing', sort: 'score' }), { code: 'INVALID_INPUT' });
});

test('Jobs sort the complete union by one effective score or publication without using gates', async () => {
  const { state, browser } = fixture();
  const rows = [
    preliminary('high-conflict', '2026-10-10T12:00:00Z', 90, { direction: 'conflict' }),
    preliminary('low-aligned', '2026-10-11T12:00:00Z', 10),
    preliminary('zero', '2026-10-12T12:00:00Z', 0),
    preliminary('refused', '2026-10-13T12:00:00Z', 100, { status: 'refused' }),
    preliminary('invalid-score', '2026-10-09T12:00:00Z', 101),
    preliminary('unknown-b', null, 10),
    preliminary('unknown-a', 'not a date', 10),
  ];
  savePrescan(state.career, rows);
  state.career.matching = {
    jobs: { 'final-fit-99': { title: 'Reviewed', publishedAt: '2026-10-14T12:00:00Z' },
      'catalogue-only': { title: 'Saved unscored', publishedAt: '2026-10-11T13:00:00+01:00' } },
    scores: { 'final-fit-99': finalAssessment(99) },
  };
  state.career.jobs = {};
  state.career.jobs.capture = { title: 'Captured', publishedAt: '2026-10-15T12:00:00Z', complete: true,
    description: 'The original captured advert.', updatedAt: '2000-01-01T00:00:00Z' };
  // A current review outranks every pre-filter; these pre-filters are stale (no catalogue row), then unscored jobs by date.
  const expectedScore = ['final-fit-99', 'high-conflict', 'low-aligned', 'unknown-a', 'unknown-b', 'zero', 'capture',
    'refused', 'catalogue-only', 'invalid-score'];
  const expectedRecent = ['capture', 'final-fit-99', 'refused', 'zero', 'catalogue-only', 'low-aligned',
    'high-conflict', 'invalid-score', 'unknown-a', 'unknown-b'];
  for (const [sort, expected] of [['score', expectedScore], ['recent', expectedRecent]]) {
    const seen = [];
    let offset = 0;
    do {
      const page = await browser.list({ kind: 'jobs', sort, offset, limit: 3 });
      assert.equal(page.total, expected.length);
      seen.push(...page.items.map(item => item.id));
      offset = page.nextOffset;
    } while (offset !== null);
    assert.deepEqual(seen, expected);
  }
  assert.deepEqual((await browser.list({ kind: 'jobs' })).items.map(item => item.id), expectedScore);
  const reviewed = await browser.read({ kind: 'jobs', id: 'final-fit-99' });
  assert.equal(fieldValue(reviewed, 'Reviewed fit', 'Overall fit'), '99/100 (Strong)');
  assert.equal(reviewed.sections.some(section => section.heading === 'Pre-filter'), false);
  assert.equal((await browser.read({ kind: 'jobs', id: 'catalogue-only' })).title, 'Saved unscored');
  assert.equal((await browser.read({ kind: 'jobs', id: 'capture' })).sections.find(section => section.heading === 'Original advert').text,
    'The original captured advert.');
});

test('reviewed jobs show overall fit with its breakdown, gates, requirements and pairwise rank', async () => {
  const { state, browser } = fixture();
  const publishedAt = currentDate();
  const requirements = [
    { requirement: 'Own production services', importance: 'essential', evidence: 'demonstrated', cvQuote: 'Built services.' },
    { requirement: 'Mentor engineers', importance: 'preferred', evidence: 'missing' },
  ];
  const scores = {
    leader: finalAssessment(0, { requirements, dimensions: { direction: 80, capability: 70, scope: 60, preferences: 65 } }),
    runner: finalAssessment(90),
    flagged: finalAssessment(85, { gates: { ...passing, constraints: 'flag' } }),
    excluded: finalAssessment(85, { gates: { ...passing, eligibility: 'fail' } }),
  };
  state.career.matching = {
    jobs: Object.fromEntries(Object.keys(scores).map(id => [id, { id, title: id, company: 'Company', publishedAt }])), scores,
    pairs: { 'leader|runner': { a: 'leader', b: 'runner', preferred: 'a', decisive: ['direction'], reason: 'Closer to the intended move.',
      profileVersion: '0:0', policyId: ASSESSMENT_POLICY_ID, aScoredAt: scoredAt, bScoredAt: scoredAt, comparedAt: scoredAt } },
  };
  const page = await browser.list({ kind: 'jobs' });
  const item = id => page.items.find(item => item.id === id);

  assert.deepEqual(item('leader').card.score, { value: 70, source: 'reviewed', stale: false, status: 'scored', decision: 'Recommended' });
  assert.equal(item('leader').card.publishedAt, publishedAt);
  assert.deepEqual(sectionFields(item('leader'), 'Reviewed fit'), [
    { label: 'Status', value: 'Reviewed' }, { label: 'Overall fit', value: '70/100 (Good)', numeric: true },
    { label: 'Saved decision', value: 'Recommended' }, { label: 'Location match', value: 'Location compatible' },
    { label: 'Pairwise rank', value: '1 win of 1 comparison' }]);
  assert.deepEqual(sectionFields(item('leader'), 'Fit breakdown'), [
    { label: 'Direction', value: '80/100', numeric: true }, { label: 'Capability', value: '70/100', numeric: true },
    { label: 'Scope', value: '60/100', numeric: true }, { label: 'Preferences', value: '65/100', numeric: true }]);
  assert.deepEqual(sectionFields(item('leader'), 'Gates'), [
    { label: 'Career direction', value: 'Passes' }, { label: 'Mandatory conditions', value: 'Passes' },
    { label: 'Eligibility', value: 'Passes' }]);
  assert.deepEqual(sectionFields(item('leader'), 'Requirements'), [
    { label: 'Own production services', value: 'Essential · Demonstrated' }, { label: 'Mentor engineers', value: 'Preferred · Missing' }]);
  assert.equal(item('leader').sections.find(section => section.heading === 'Review reason').text, 'Saved full-advert review.');
  assert.equal(fieldValue(item('runner'), 'Reviewed fit', 'Pairwise rank'), '0 wins of 1 comparison');

  assert.equal(fieldValue(item('flagged'), 'Reviewed fit', 'Pairwise rank'), undefined);
  assert.equal(fieldValue(item('flagged'), 'Reviewed fit', 'Saved decision'), 'Needs clarification');
  assert.equal(fieldValue(item('flagged'), 'Gates', 'Mandatory conditions'), 'Needs confirmation');
  assert.equal(fieldValue(item('excluded'), 'Reviewed fit', 'Saved decision'), 'Not recommended');
  assert.equal(fieldValue(item('excluded'), 'Reviewed fit', 'Location match'), 'Excluded by a gate');
  assert.equal(fieldValue(item('excluded'), 'Gates', 'Eligibility'), 'Fails');
  for (const id of Object.keys(scores))
    assert.deepEqual(await browser.read({ kind: 'jobs', id }), { title: item(id).title, sections: item(id).sections });
  assert.equal(fieldValue(await browser.read({ kind: 'jobs', id: 'leader' }), 'Reviewed fit', 'Pairwise rank'), '1 win of 1 comparison');
});

test('Jobs preserve every archived assessment and capture across globally sorted pages', async () => {
  const { state, browser } = fixture();
  const publishedAt = currentDate();
  const career = state.career;
  career.matching = { jobs: {}, scores: {} };
  for (let index = 0; index < 105; index++) {
    const id = `reviewed-${index}`;
    career.matching.jobs[id] = { id, title: id, company: 'Company', publishedAt };
    career.matching.scores[id] = finalAssessment(index % 100 + 1);
  }
  const scans = [preliminary('pre-low', publishedAt, 20), preliminary('reviewed-0', publishedAt, 100),
    preliminary('pre-high', publishedAt, 99)];
  savePrescan(career, scans);
  for (const row of scans) career.matching.jobs[row.id] = { ...row };
  career.jobs = {};
  career.jobs.capture = { title: 'Saved capture', complete: false, description: 'Listing excerpt.' };
  const before = structuredClone(state);
  const byFit = Object.keys(career.matching.scores).sort((a, b) =>
    career.matching.scores[b].overall - career.matching.scores[a].overall || (a < b ? -1 : 1));
  const expected = [...byFit, 'pre-high', 'pre-low', 'capture'];
  const items = [];
  let offset = 0;
  do {
    const page = await browser.list({ kind: 'jobs', offset, limit: 17 });
    assert.equal(page.total, 108);
    items.push(...page.items);
    offset = page.nextOffset;
  } while (offset !== null);
  assert.deepEqual(items.map(item => item.id), expected);
  assert.equal(new Set(items.map(item => item.id)).size, items.length);
  assert.deepEqual(await browser.list({ kind: 'jobs', offset: 108 }), { items: [], total: 108, nextOffset: null });
  const merged = items.find(item => item.id === 'reviewed-0');
  assert.deepEqual(merged.card.score, { value: 1, source: 'reviewed', stale: false, status: 'scored', decision: 'Not recommended' });
  assert.equal(merged.sections.some(section => section.heading === 'Pre-filter'), false);
  assert.equal(merged.sections.filter(section => section.heading === 'Role').length, 1);
  assert.deepEqual(await browser.read({ kind: 'jobs', id: merged.id }), { title: merged.title, sections: merged.sections });
  assert.deepEqual(state, before);
});

test('jobs retain stale, excluded, unavailable, old, relocation and missing-metadata final assessments', async () => {
  const { state, store, browser } = fixture();
  const publishedAt = currentDate();
  const scores = {
    stale: { ...finalAssessment(99), profileVersion: 'old' },
    legacy: { ...finalAssessment(95), policyId: 'earlier-policy' },
    invalid: { ...finalAssessment(90), decision: 'old-decision' },
    excluded: finalAssessment(85, { gates: { ...passing, constraints: 'fail' } }),
    unavailable: unavailableAssessment(),
    old: finalAssessment(75),
    relocation: finalAssessment(80, { relocation: 'required' }),
    missing: finalAssessment(60),
  };
  state.career.matching = { jobs: {}, scores };
  state.career.profile.preferences.willingToRelocate = false;
  for (const id of Object.keys(scores).filter(id => id !== 'missing')) {
    state.career.matching.jobs[id] = { title: id, company: 'Company',
      publishedAt: id === 'old' ? '2000-01-01T00:00:00Z' : publishedAt,
      salary: { minimum: 100, maximum: 200, currency: 'GBP', period: 'year' } };
  }
  state.career.profile.preferences.salaryMinimum = 300;
  state.career.profile.preferences.salaryCurrency = 'GBP';
  state.career.profile.preferences.salaryPeriod = 'year';
  const before = structuredClone(state);
  const canonical = await createMatchingTools({ store }).find(tool => tool.name === 'career_matches').invoke();
  const page = await browser.list({ kind: 'jobs' });
  assert.equal(page.total, Object.keys(scores).length);
  assert.deepEqual(new Set(page.items.map(item => item.id)), new Set(Object.keys(scores)));
  const band = row => row.band.replace(/^./, letter => letter.toUpperCase());
  for (const row of canonical.matches) {
    const item = page.items.find(item => item.id === row.id);
    assert.equal(fieldValue(item, 'Reviewed fit', 'Status'), row.reviewStatus === 'current' ? 'Reviewed' : 'Needs reassessment');
    assert.equal(fieldValue(item, 'Reviewed fit', 'Overall fit'), row.overall == null ? 'Unavailable' : `${row.overall}/100 (${band(row)})`);
    assert.deepEqual(await browser.read({ kind: 'jobs', id: row.id }), { title: item.title, sections: item.sections });
  }
  assert.deepEqual(page.items.find(item => item.id === 'stale').card.score,
    { value: 99, source: 'reviewed', stale: true, status: 'scored', decision: 'Recommended' });
  assert.equal(fieldValue(page.items.find(item => item.id === 'legacy'), 'Reviewed fit', 'Status'), 'Needs reassessment');
  assert.equal(fieldValue(page.items.find(item => item.id === 'invalid'), 'Reviewed fit', 'Saved decision'), 'No saved decision');
  assert.equal(fieldValue(page.items.find(item => item.id === 'excluded'), 'Reviewed fit', 'Location match'), 'Excluded by a gate');
  assert.equal(fieldValue(page.items.find(item => item.id === 'excluded'), 'Gates', 'Mandatory conditions'), 'Fails');
  const unavailable = page.items.find(item => item.id === 'unavailable');
  assert.equal(fieldValue(unavailable, 'Reviewed fit', 'Location match'), 'Assessment unavailable');
  assert.deepEqual(unavailable.card.score, { value: null, source: null, stale: false, status: null, decision: null });
  assert.equal(unavailable.sections.some(section => ['Fit breakdown', 'Gates', 'Requirements'].includes(section.heading)), false);
  assert.equal(fieldValue(page.items.find(item => item.id === 'relocation'), 'Reviewed fit', 'Location match'), 'Location incompatible');
  assert.equal(fieldValue(page.items.find(item => item.id === 'old'), 'Role', 'Against your minimum'), 'Below your minimum');
  assert.equal(page.items.find(item => item.id === 'missing').title, 'Job details unavailable');
  assert.deepEqual(state, before);
});

test('pre-filter presentation keeps priority, freshness and operational failures, and a stale review yields to a current pre-filter', async () => {
  const { state, browser } = fixture();
  const publishedAt = currentDate();
  const rows = [
    preliminary('merged', publishedAt, 82, { location: 'London', applyUrl: 'https://example.test/job' }),
    preliminary('uncertain', publishedAt, 95, { constraints: 'uncertain' }),
    preliminary('refused', publishedAt, null, { status: 'refused', direction: null, constraints: null, eligibility: null, dimensions: null, confidence: null }),
    preliminary('unavailable', publishedAt, null, { status: 'unavailable' }),
    preliminary('oversize', publishedAt, null, { status: 'oversize' }),
    preliminary('conflict', publishedAt, 100, { direction: 'conflict' }),
    preliminary('ineligible', publishedAt, 98, { eligibility: 'conflict' }),
    preliminary('old', '2000-01-01T00:00:00Z'),
    preliminary('missing-ad', publishedAt),
    preliminary('changed-ad', publishedAt),
  ];
  state.career.matching = { jobs: Object.fromEntries(rows.filter(row => row.id !== 'missing-ad').map(row => [row.id, { ...row }])),
    scores: { merged: { ...finalAssessment(99), profileVersion: 'old' } } };
  state.career.matching.jobs['changed-ad'].publishedAt = '2000-01-01T00:00:00Z';
  savePrescan(state.career, rows);
  const before = structuredClone(state);
  const page = await browser.list({ kind: 'jobs' });
  assert.equal(page.total, rows.length);
  const stale = rows.filter(row => ['old', 'missing-ad', 'changed-ad'].includes(row.id));
  assert.deepEqual(page.items.slice(0, 4).map(item => item.id), ['conflict', 'ineligible', 'uncertain', 'merged']);
  const merged = page.items.find(item => item.id === 'merged');
  assert.deepEqual(merged.card.score, { value: 82, source: 'prefilter', stale: false, status: 'scored', decision: null });
  assert.equal(merged.sections[0].heading, 'Pre-filter');
  assert.equal(fieldValue(merged, 'Pre-filter', 'Priority'), '82/100');
  assert.equal(fieldValue(merged, 'Reviewed fit', 'Overall fit'), '99/100 (Strong)');
  assert.equal(fieldValue(merged, 'Role', 'Location'), 'London');
  assert.equal(merged.sections.filter(section => section.heading === 'Role').length, 1);
  for (const item of page.items) {
    assert.deepEqual(sectionFields(item, 'Pre-filter').map(field => field.label),
      ['Priority', 'Status', 'Freshness', 'Provider', 'Model']);
  }
  const failures = { refused: 'Provider declined assessment', unavailable: 'Original advert unavailable',
    oversize: 'Input exceeds the provider limit' };
  for (const [id, reason] of Object.entries(failures)) {
    const item = page.items.find(item => item.id === id);
    assert.equal(fieldValue(item, 'Pre-filter', 'Status'), reason);
    assert.deepEqual(item.card.score, { value: null, source: null, stale: false, status: id, decision: null });
  }
  for (const id of ['refused', 'unavailable', 'oversize']) {
    const item = page.items.find(item => item.id === id);
    assert.equal(fieldValue(item, 'Pre-filter', 'Priority'), 'Not scored');
    assert.equal(item.sections.some(section => section.heading === 'Reviewed fit'), false);
  }
  for (const row of stale) {
    const item = page.items.find(item => item.id === row.id);
    assert.equal(item.card.score.stale, true);
    assert.equal(fieldValue(item, 'Pre-filter', 'Freshness'), 'Out of date');
  }
  for (const item of page.items)
    assert.deepEqual(await browser.read({ kind: 'jobs', id: item.id }), { title: item.title, sections: item.sections });
  assert.deepEqual(state, before);
});

test('pre-scan freshness respects the saved career evidence and provider policy', async () => {
  const { state, browser } = fixture();
  const row = preliminary('saved', currentDate());
  state.career.matching = { jobs: { saved: { ...row } }, scores: {} };
  savePrescan(state.career, [row]);
  assert.equal(fieldValue((await browser.list({ kind: 'jobs' })).items[0], 'Pre-filter', 'Freshness'), 'Current');
  for (const changed of [{ profileVersion: '1:0' }, { prescanPolicyId: 'earlier-policy' }]) {
    savePrescan(state.career, [row]);
    Object.assign(state.career.prescan, changed);
    const page = await browser.list({ kind: 'jobs' });
    assert.equal(fieldValue(page.items[0], 'Pre-filter', 'Freshness'), 'Out of date');
    assert.equal(page.items[0].card.score.stale, true);
    assert.equal(page.items[0].card.score.value, 75);
    assert.deepEqual(await browser.read({ kind: 'jobs', id: row.id }), { title: page.items[0].title, sections: page.items[0].sections });
  }
});

test('each jobs operation uses one local snapshot for both assessment types', async () => {
  const { state, store, browser } = fixture();
  const publishedAt = currentDate();
  const row = preliminary('saved', publishedAt);
  state.career.matching = { jobs: { saved: { ...row } }, scores: { saved: finalAssessment() } };
  savePrescan(state.career, [row]);
  let reads = 0;
  store.get = () => {
    assert.equal(++reads, 1, 'An operation must not mix career snapshots');
    return structuredClone(state);
  };
  const page = await browser.list({ kind: 'jobs' });
  assert.equal(reads, 1);
  reads = 0;
  const detail = await browser.read({ kind: 'jobs', id: row.id });
  assert.equal(reads, 1);
  assert.deepEqual(detail, { title: page.items[0].title, sections: page.items[0].sections });
  assert.equal(JSON.stringify(detail).includes('PRIVATE_KEY_SENTINEL'), false);
});

test('a current final review supersedes a stale pre-scan and fills missing catalogue metadata', async () => {
  const { state, browser } = fixture();
  const row = preliminary('saved', '2000-01-01T00:00:00Z', 99,
    { title: 'Saved role title', company: 'Saved employer', city: 'London', applyUrl: 'https://example.test/saved' });
  state.career.matching = { jobs: {}, scores: { saved: finalAssessment(0) } };
  savePrescan(state.career, [row]);
  const page = await browser.list({ kind: 'jobs' });
  assert.equal(page.total, 1);
  const item = page.items[0];
  assert.equal(item.title, 'Saved role title — Saved employer');
  assert.deepEqual(item.card, { title: 'Saved role title', company: 'Saved employer', publishedAt: '2000-01-01T00:00:00Z',
    score: { value: 0, source: 'reviewed', stale: false, status: 'scored', decision: 'Not recommended' },
    chips: [{ kind: 'location', text: 'London' }] });
  assert.equal(item.sections[0].heading, 'Reviewed fit');
  assert.equal(item.sections.some(section => section.heading === 'Pre-filter'), false);
  assert.equal(fieldValue(item, 'Role', 'City'), 'London');
  assert.equal(fieldValue(item, 'Role', 'Apply URL'), 'https://example.test/saved');
  assert.equal(item.sections.filter(section => section.heading === 'Role').length, 1);
  assert.deepEqual(await browser.read({ kind: 'jobs', id: row.id }), { title: item.title, sections: item.sections });
});

test('job cards mirror structured catalogue fields, omit missing chips and carry one score', async () => {
  const { state, browser } = fixture();
  const publishedAt = currentDate();
  state.career.matching = { jobs: {
    full: { title: 'Protocol Engineer', company: 'Example Labs', publishedAt, seniority: 'Senior', commitment: 'Full Time',
      classification: 'Smart Contracts', city: 'Berlin', location: 'Germany', workMode: 'Remote',
      salary: { minimum: 120000, maximum: 160000, currency: 'USD', period: 'year' } },
    sparse: { title: 'Analyst', company: 'Sparse Co', publishedAt: 'not a date', seniority: null, commitment: null, classification: null,
      city: null, location: 'Lisbon', workMode: null, salary: { stated: 90000, currency: 'EUR', period: 'year' } },
    bare: { title: 'Bare', publishedAt: null },
  }, scores: { full: finalAssessment(92) } };
  savePrescan(state.career, [preliminary('full', publishedAt, 70), preliminary('sparse', publishedAt, 15)]);
  const page = await browser.list({ kind: 'jobs' });
  const card = id => page.items.find(item => item.id === id).card;
  assert.deepEqual(card('full'), { title: 'Protocol Engineer', company: 'Example Labs', publishedAt,
    score: { value: 92, source: 'reviewed', stale: false, status: 'scored', decision: 'Recommended' },
    chips: [{ kind: 'seniority', text: 'Senior' }, { kind: 'salary', text: 'USD 120,000–160,000 per year' }, { kind: 'location', text: 'Berlin · Remote' },
      { kind: 'commitment', text: 'Full Time' }, { kind: 'classification', text: 'Smart Contracts' }] });
  assert.deepEqual(card('sparse'), { title: 'Analyst', company: 'Sparse Co', publishedAt: null,
    score: { value: 15, source: 'prefilter', stale: true, status: 'scored', decision: null },
    chips: [{ kind: 'salary', text: 'EUR 90,000 per year' }, { kind: 'location', text: 'Lisbon' }] });
  assert.deepEqual(card('bare'), { title: 'Bare', company: null, publishedAt: null,
    score: { value: null, source: null, stale: false, status: null, decision: null }, chips: [] });
  assert.equal(page.items.some(item => 'summary' in item), false);
});

test('one score per job: a current review outranks any pre-filter and the reader never shows both', async () => {
  const { state, browser } = fixture();
  const publishedAt = currentDate();
  const rows = [preliminary('weak-review', publishedAt, 70), preliminary('strong-prefilter', publishedAt, 95),
    preliminary('stale-review', publishedAt, 60), preliminary('stale-both', '2000-01-01T00:00:00Z', 99), preliminary('stale-prefilter', '2000-01-01T00:00:00Z', 97)];
  state.career.matching = { jobs: Object.fromEntries(rows.map(row => [row.id, { ...row }])), scores: {
    'weak-review': finalAssessment(40),
    'stale-review': { ...finalAssessment(88), profileVersion: 'old' },
    'stale-both': { ...finalAssessment(30), profileVersion: 'old' },
    'review-only': finalAssessment(35),
  } };
  state.career.matching.jobs['review-only'] = { title: 'Review only', publishedAt };
  savePrescan(state.career, rows);
  const page = await browser.list({ kind: 'jobs', sort: 'score' });
  assert.deepEqual(page.items.map(item => item.id),
    ['weak-review', 'review-only', 'strong-prefilter', 'stale-review', 'stale-both', 'stale-prefilter']);
  const score = id => page.items.find(item => item.id === id).card.score;
  assert.deepEqual(score('weak-review'), { value: 40, source: 'reviewed', stale: false, status: 'scored', decision: 'Not recommended' });
  assert.deepEqual(score('strong-prefilter'), { value: 95, source: 'prefilter', stale: false, status: 'scored', decision: null });
  assert.deepEqual(score('stale-review'), { value: 60, source: 'prefilter', stale: false, status: 'scored', decision: null });
  assert.deepEqual(score('stale-both'), { value: 30, source: 'reviewed', stale: true, status: 'scored', decision: 'Not recommended' });
  assert.deepEqual(score('stale-prefilter'), { value: 97, source: 'prefilter', stale: true, status: 'scored', decision: null });
  const headings = id => page.items.find(item => item.id === id).sections.map(section => section.heading);
  assert.equal(headings('weak-review').includes('Pre-filter'), false);
  assert.equal(headings('weak-review')[0], 'Reviewed fit');
  assert.deepEqual(headings('stale-review').slice(0, 2), ['Pre-filter', 'Reviewed fit']);
  assert.deepEqual(headings('stale-both').filter(heading => ['Pre-filter', 'Reviewed fit'].includes(heading)), ['Reviewed fit', 'Pre-filter']);
  assert.deepEqual(headings('strong-prefilter').filter(heading => ['Pre-filter', 'Reviewed fit'].includes(heading)), ['Pre-filter']);
  for (const item of page.items) assert.equal('reviewed' in item.card, false);
  assert.deepEqual((await browser.list({ kind: 'jobs', sort: 'recent' })).items.map(item => item.id),
    ['review-only', 'stale-review', 'strong-prefilter', 'weak-review', 'stale-both', 'stale-prefilter']);
});

test('facts lead with explanations and preserve actual interview context; applications show saved drafts', async () => {
  const { state, browser } = fixture();
  Object.assign(state.career.profile, { name: 'Jane Candidate', email: 'jane@example.test', location: 'London' });
  state.career.facts.ab = { id: 'ab', kind: 'capability', subject: 'A/B testing', answer: 'Led it', detail: 'Led checkout experiments at Acme, reducing abandoned purchases.', employer: 'Acme',
    question: 'Have you led checkout experiments?', context: 'This role owns conversion improvements.', applicationId: 'app',
    followUps: [{ question: 'What did you personally change?', answer: 'Designed the experiment and coordinated the rollout.',
      context: 'This listing needs experiment design.', applicationId: 'later-app' }] };
  state.career.facts.k8s = { id: 'k8s', kind: 'yes_no', subject: 'Kubernetes in production', answer: 'No', applicationId: 'missing-app' };
  state.career.applications['later-app'] = { id: 'later-app', job: { title: 'Experiment Lead', company: 'Other Employer' } };
  const document = { headline: 'Platform Engineer', summary: 'Builds data services.',
    experience: [{ employer: 'Acme', role: 'Engineer', startDate: '2019', endDate: 'Present', bullets: [
      { text: 'Built payment pipelines.', support: { cv: ['CV_SUPPORT_SENTINEL quote'], facts: ['ab'] } }] }] };
  state.career.applications.app = { id: 'app', job: { title: 'Senior Engineer', company: 'Example Employer', description: 'Ad', url: 'https://example.test/job' },
    cv: { version: 2, document, presentation: { template: 'classic', paper: 'A4' }, createdAt: '2026-10-14T10:00:00Z' },
    cvHistory: [{ version: 1, document: { ...document, headline: 'Engineer' }, presentation: { template: 'classic', paper: 'A4' }, createdAt: '2026-10-13T10:00:00Z' }],
    coverLetter: { version: 1, paragraphs: ['Dear team,', 'I build payment pipelines.'], createdAt: '2026-10-14T10:00:00Z' }, coverLetterHistory: [], exports: [],
    createdAt: '2026-10-13T10:00:00Z', updatedAt: '2026-10-14T10:00:00Z' };

  const facts = await browser.list({ kind: 'facts' });
  assert.deepEqual(facts.items.map(({ title, summary }) => ({ title, summary })),
    [{ title: 'A/B testing', summary: state.career.facts.ab.detail }, { title: 'Kubernetes in production', summary: 'No' }]);
  const ab = await browser.read({ kind: 'facts', id: 'ab' });
  assert.equal(ab.title, 'A/B testing');
  assert.equal(ab.sections[0].text, state.career.facts.ab.detail);
  assert.deepEqual(ab.sections[1].fields, [{ label: 'Level', value: 'Led it' },
    { label: 'Question', value: state.career.facts.ab.question }, { label: 'Context', value: state.career.facts.ab.context },
    { label: 'Application', value: 'Senior Engineer — Example Employer' }, { label: 'Employer', value: 'Acme' }]);
  assert.deepEqual(ab.sections[2].fields, [{ label: 'Question', value: state.career.facts.ab.followUps[0].question },
    { label: 'Answer', value: state.career.facts.ab.followUps[0].answer },
    { label: 'Context', value: state.career.facts.ab.followUps[0].context },
    { label: 'Application', value: 'Experiment Lead — Other Employer' }]);
  const historical = await browser.read({ kind: 'facts', id: 'k8s' });
  assert.equal(historical.sections[0].text, 'No');
  assert.deepEqual(historical.sections[1].fields, [{ label: 'Level', value: 'No' }]);
  assert.equal(historical.sections.length, 2);
  assert.equal(ab.sections.flatMap(section => section.fields ?? []).some(field => field.label === 'Kind' || field.label === 'Role'), false);

  const detail = await browser.read({ kind: 'applications', id: 'app' });
  assert.equal(detail.title, 'Senior Engineer — Example Employer');
  const sections = Object.fromEntries(detail.sections.slice(1).map(section => [section.heading.split(' — ')[0], section.text]));
  assert.equal(sections.CV, 'Jane Candidate\nPlatform Engineer\njane@example.test · London\n\nSummary\n\nBuilds data services.\n\nExperience\n\nAcme\nEngineer\n2019 – Present\n• Built payment pipelines.\n');
  assert.equal(JSON.stringify(detail).includes('CV_SUPPORT_SENTINEL'), false);
  assert.match(sections['Earlier CV'], /^Jane Candidate\nEngineer\n/);
  assert.equal(sections['Cover letter'], 'Dear team,\n\nI build payment pipelines.');
});

async function rendererFixture(browser, wide) {
  let focused = null;
  class Node {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attributes = new Map();
      this.listeners = new Map();
      this.classList = { add() {}, remove() {} };
      this.hidden = false;
      this.disabled = false;
      this.isConnected = true;
      this.textContent = '';
      this.dataset = {};
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    get childElementCount() { return this.children.length; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    focus() { focused = this; }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [
        ...((selector === 'button' ? child.tagName === 'BUTTON' : child.attributes.has('aria-current')) ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    fire(name) { this.listeners.get(name)?.({ target: this }); }
  }
  const names = ['records', 'list-status', 'list-retry', 'pagination', 'previous', 'next', 'reader', 'reader-title',
    'reader-status', 'reader-retry', 'reader-content', 'close'];
  const ids = [...names.flatMap(name => [`career-${name}`, `me-${name}`]), 'career-browser', 'me-browser',
    'delete-rankings', 'career-sort-control', 'career-sort', 'prefilter-controls'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Node()]));
  nodes['career-sort'].value = 'score';
  const category = kind => {
    const node = new Node('button');
    node.dataset.careerKind = kind;
    return [kind, node];
  };
  const categories = Object.fromEntries(['sources', 'facts'].map(category));
  const jobCategories = Object.fromEntries(['jobs', 'applications'].map(category));
  nodes['career-category-ranked'] = jobCategories.jobs;
  nodes['career-category-applications'] = jobCategories.applications;
  nodes['me-browser'].querySelectorAll = () => Object.values(categories);
  nodes['career-browser'].querySelectorAll = () => Object.values(jobCategories);
  const calls = [];
  const window = { matchMedia: () => ({ matches: wide }), companion: { async invoke(operation, args) {
    const input = structuredClone(args);
    calls.push({ operation, args: input });
    return { ok: true, result: await (operation === 'career-list' ? browser.list(input) : browser.read(input)) };
  } } };
  const document = { getElementById: id => nodes[id], createElement: tag => new Node(tag) };
  runInNewContext(await readFile(new URL('../ui/career-browser.js', import.meta.url), 'utf8'), { window, document });
  const byClass = (node, className) => node.className?.split(' ').includes(className) ? node
    : node.children.map(child => byClass(child, className)).find(Boolean) ?? null;
  const rows = prefix => nodes[`${prefix}-records`].children.map(row => row.children[0]);
  return { window, nodes, categories, jobCategories, calls, rows, byClass, focused: () => focused,
    settle: () => new Promise(resolve => setImmediate(resolve)),
    titles: (prefix = 'career') => rows(prefix).map(button => byClass(button, 'career-record-title').textContent) };
}

for (const wide of [false, true]) test(`Jobs paging and sorting keep the reader column and pagination stable in ${wide ? 'wide' : 'narrow'} mode`, async () => {
  const { state, browser } = fixture();
  const rows = Array.from({ length: 27 }, (_, index) => preliminary(String(index).padStart(2, '0'),
    new Date(Date.UTC(2026, 9, 20) - index * 60000).toISOString(), index));
  savePrescan(state.career, rows);
  state.career.matching = { jobs: Object.fromEntries(rows.map(row => [row.id, row])), scores: {} };
  state.career.applications.app = { id: 'app', job: { title: 'Applied Role', company: 'Employer' } };
  const ui = await rendererFixture(browser, wide);
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  assert.equal(ui.titles()[0], '26');
  assert.equal(ui.nodes['career-sort'].disabled, false);
  assert.equal(ui.nodes['delete-rankings'].disabled, false);
  assert.equal(ui.nodes['career-pagination'].hidden, false);
  assert.equal(ui.nodes['career-reader'].hidden, !wide);
  assert.equal(ui.nodes['career-reader-title'].textContent, wide ? '26 — Company' : '');
  ui.nodes['career-next'].fire('click');
  await ui.settle();
  assert.deepEqual(ui.titles(), ['01', '00']);
  assert.equal(ui.nodes['career-pagination'].hidden, false);
  assert.equal(ui.nodes['career-previous'].disabled, false);
  assert.equal(ui.nodes['career-next'].disabled, true);
  // Next keeps the reader column: wide screens open the first record of the new page without stealing list focus.
  assert.equal(ui.focused(), ui.rows('career')[0]);
  assert.equal(ui.nodes['career-reader'].hidden, !wide);
  assert.equal(ui.nodes['career-reader-title'].textContent, wide ? '01 — Company' : '');
  assert.equal(ui.nodes['career-records'].querySelectorAll('[aria-current]').length, wide ? 1 : 0);
  ui.rows('career')[1].fire('click');
  await ui.settle();
  assert.equal(ui.nodes['career-reader-title'].textContent, '00 — Company');
  assert.equal(ui.nodes['career-reader'].hidden, false);

  ui.nodes['career-sort'].focus();
  ui.nodes['career-sort'].value = 'recent';
  ui.nodes['career-sort'].fire('change');
  await ui.settle();
  assert.equal(ui.titles()[0], '00');
  assert.equal(ui.nodes['career-previous'].disabled, true);
  assert.equal(ui.nodes['career-next'].disabled, false);
  assert.equal(ui.nodes['career-reader'].hidden, !wide);
  assert.equal(ui.nodes['career-reader-title'].textContent, wide ? '00 — Company' : '');
  assert.equal(ui.focused(), ui.nodes['career-sort']);
  assert.equal(ui.nodes['career-records'].querySelectorAll('[aria-current]').length, wide ? 1 : 0);

  // Applications shares the Jobs list + reader; the jobs-only toolbar controls hide and disable while it is active.
  ui.jobCategories.applications.fire('click');
  await ui.settle();
  assert.equal(ui.calls.at(-1).args.kind, 'applications');
  assert.equal(Object.hasOwn(ui.calls.at(-1).args, 'sort'), false);
  assert.deepEqual(ui.titles(), ['Applied Role — Employer']);
  assert.equal(ui.jobCategories.applications.attributes.get('aria-pressed'), 'true');
  assert.equal(ui.jobCategories.jobs.attributes.get('aria-pressed'), 'false');
  for (const id of ['prefilter-controls', 'career-sort-control', 'delete-rankings']) assert.equal(ui.nodes[id].hidden, true, id);
  assert.equal(ui.nodes['career-sort'].disabled, true);
  assert.equal(ui.nodes['delete-rankings'].disabled, true);
  assert.equal(ui.nodes['career-reader'].hidden, !wide);
  assert.equal(ui.nodes['career-reader-title'].textContent, wide ? 'Applied Role — Employer' : '');
  ui.jobCategories.jobs.fire('click');
  await ui.settle();
  assert.equal(ui.calls.at(-1).args.kind, 'jobs');
  assert.equal(ui.calls.at(-1).args.sort, 'recent');
  assert.equal(ui.titles()[0], '00');
  for (const id of ['prefilter-controls', 'career-sort-control', 'delete-rankings']) assert.equal(ui.nodes[id].hidden, false, id);
  assert.equal(ui.nodes['career-sort'].disabled, false);
  assert.equal(ui.nodes['delete-rankings'].disabled, false);

  // Me browses CVs and facts with its own list and never sends a jobs sort.
  assert.equal(ui.titles('me').length, 0);
  ui.categories.facts.fire('click');
  await ui.settle();
  assert.equal(ui.calls.at(-1).args.kind, 'facts');
  assert.equal(Object.hasOwn(ui.calls.at(-1).args, 'sort'), false);
  assert.equal(ui.titles()[0], '00');
  ui.window.careerBrowser.clear();
  assert.equal(ui.nodes['career-sort'].disabled, true);
  assert.equal(ui.nodes['delete-rankings'].disabled, true);
  assert.equal(ui.nodes['career-pagination'].hidden, true);
  assert.equal(ui.nodes['career-reader'].hidden, !wide);
  assert.equal(ui.nodes['career-reader-status'].textContent, wide ? 'Select a job' : '');
});

test('job cards render one score with its source caption, publication date, chips and an accessible row label', async () => {
  const { state, browser } = fixture();
  const publishedAt = '2020-10-17T09:00:00Z';
  state.career.matching = { jobs: {
    scored: { title: 'Protocol Engineer', company: 'Example Labs', publishedAt, seniority: 'Senior', commitment: 'Full Time',
      classification: 'Smart Contracts', city: 'Berlin', workMode: 'Remote', salary: { stated: 150000, currency: 'USD', period: 'year' } },
    reviewed: { title: 'Analyst', company: 'Review Co', publishedAt: '2000-01-01T00:00:00Z' },
    refused: { title: 'Declined', company: 'Other', publishedAt: null },
  }, scores: { reviewed: finalAssessment(92) } };
  savePrescan(state.career, [preliminary('scored', publishedAt, 70), preliminary('refused', null, null, { status: 'refused' })]);
  const ui = await rendererFixture(browser, true);
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  const [reviewed, scored, refused] = ui.rows('career');
  assert.equal(ui.byClass(scored, 'career-card-score-value').textContent, '70');
  assert.equal(ui.byClass(scored, 'career-card-score-caption').textContent, 'Pre-filter · out of date');
  assert.equal(ui.byClass(scored, 'career-card-company').textContent, 'Example Labs');
  assert.equal(ui.byClass(scored, 'career-card-date').textContent, 'Published 17 Oct 2020');
  assert.deepEqual(ui.byClass(scored, 'career-card-chips').children.map(chip => [chip.dataset.kind, chip.textContent]), [
    ['seniority', 'Senior'], ['salary', 'USD 150,000 per year'], ['location', 'Berlin · Remote'],
    ['commitment', 'Full Time'], ['classification', 'Smart Contracts']]);
  assert.equal(ui.byClass(scored, 'career-card-reviewed'), null);
  assert.equal(scored.attributes.get('aria-label'),
    'Protocol Engineer, Example Labs, pre-filter score 70 of 100, out of date, published 17 Oct 2020');
  assert.equal(ui.byClass(reviewed, 'career-card-score-value').textContent, '92');
  assert.equal(ui.byClass(reviewed, 'career-card-score-caption').textContent, 'Reviewed · Recommended');
  assert.equal(ui.byClass(reviewed, 'career-card-chips'), null);
  assert.equal(ui.byClass(reviewed, 'career-card-reviewed'), null);
  assert.equal(reviewed.attributes.get('aria-label'),
    'Analyst, Review Co, reviewed score 92 of 100, Recommended, published 1 Jan 2000');
  assert.equal(ui.byClass(refused, 'career-card-score-value').textContent, '—');
  assert.equal(ui.byClass(refused, 'career-card-score-caption').textContent, 'Declined');
  assert.equal(refused.attributes.get('aria-label'), 'Declined, Other, declined, publication date not stated');
  assert.equal(ui.byClass(refused, 'career-card-date').textContent, 'Publication date not stated');
  assert.equal(ui.byClass(refused, 'career-card-chips'), null);
  assert.equal(scored.attributes.get('aria-controls'), 'career-reader');
});
