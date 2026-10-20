import test from 'node:test';
import assert from 'node:assert/strict';
import { createCareerState } from '../src/mcp/state.mjs';
import { createCareerBrowser } from '../src/career-browser.mjs';
import { ASSESSMENT_POLICY_ID, deriveDecision } from '../src/mcp/matching-contract.mjs';
import { createMatchingTools } from '../src/mcp/matching-tools.mjs';
import { decisionProviders } from '../src/prescan/providers.mjs';
import { comparePrescanRows } from '../src/prescan/state.mjs';

function fixture() {
  const state = { privateKey: 'PRIVATE_KEY_SENTINEL', career: createCareerState() };
  const store = { get: () => structuredClone(state), update: () => assert.fail('Browsing must not write') };
  return { state, store, browser: createCareerBrowser({ store }) };
}

const currentDate = () => new Date().toISOString();
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

test('jobs sort reviewed results before pagination and keep skip judgments visible', async () => {
  const { state, browser } = fixture();
  state.career.matching = { jobs: {}, scores: {} };
  for (const [id, overall, changes] of [['low', 40, {}], ['high', 90, {}], ['middle', 70, { gates: { ...passing, eligibility: 'flag' } }]]) {
    state.career.matching.jobs[id] = { title: id, company: 'Company', publishedAt: '2026-10-14T12:00:00Z' };
    state.career.matching.scores[id] = finalAssessment(overall, { ...changes, reason: `Saved reasoning for ${id}` });
  }
  const first = await browser.list({ kind: 'jobs', limit: 2 });
  assert.deepEqual(first.items.map(item => item.id), ['high', 'middle']);
  assert.match(first.items[1].summary, /Needs clarification$/);
  const second = await browser.list({ kind: 'jobs', limit: 2, offset: first.nextOffset });
  assert.deepEqual(second.items.map(item => item.id), ['low']);
  assert.equal(second.nextOffset, null);
  assert.ok(second.items[0].sections.some(section => section.text?.includes('Saved reasoning for low')));
  assert.equal(second.items[0].summary, 'Reviewed · Overall 40/100 · Weak · Not recommended');
  assert.equal(fieldValue(second.items[0], 'Reviewed fit', 'Overall fit'), '40/100 (Weak)');
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

  assert.equal(item('leader').summary, 'Reviewed · Overall 70/100 · Good · Recommended');
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

test('jobs union every assessment before paging and preserve canonical final ordering across archive pages', async () => {
  const { state, store, browser } = fixture();
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
  const before = structuredClone(state);
  const canonical = createMatchingTools({ store }).find(tool => tool.name === 'career_matches');
  const expected = [...(await canonical.invoke({ limit: 100 })).matches,
    ...(await canonical.invoke({ limit: 100, offset: 100 })).matches].map(row => row.id);
  expected.push(...scans.filter(row => row.id.startsWith('pre-')).sort(comparePrescanRows).map(row => row.id));
  const items = [];
  let offset = 0;
  do {
    const page = await browser.list({ kind: 'jobs', offset, limit: 17 });
    assert.equal(page.total, 107);
    items.push(...page.items);
    offset = page.nextOffset;
  } while (offset !== null);
  assert.deepEqual(items.map(item => item.id), expected);
  assert.equal(new Set(items.map(item => item.id)).size, items.length);
  assert.deepEqual(await browser.list({ kind: 'jobs', offset: 107 }), { items: [], total: 107, nextOffset: null });
  const merged = items.find(item => item.id === 'reviewed-0');
  assert.equal(merged.summary, 'Reviewed · Overall 1/100 · Poor · Not recommended');
  assert.equal(fieldValue(merged, 'Pre-scan result', 'Priority'), '100/100');
  assert.equal(merged.sections.filter(section => section.heading === 'Role').length, 1);
  assert.equal(merged.sections.some(section => section.heading === 'Preliminary ranking'), false);
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
  assert.equal(page.items.find(item => item.id === 'stale').summary, 'Needs reassessment · Overall 99/100 · Strong · Recommended');
  assert.equal(fieldValue(page.items.find(item => item.id === 'legacy'), 'Reviewed fit', 'Status'), 'Needs reassessment');
  assert.equal(fieldValue(page.items.find(item => item.id === 'invalid'), 'Reviewed fit', 'Saved decision'), 'No saved decision');
  assert.equal(fieldValue(page.items.find(item => item.id === 'excluded'), 'Reviewed fit', 'Location match'), 'Excluded by a gate');
  assert.equal(fieldValue(page.items.find(item => item.id === 'excluded'), 'Gates', 'Mandatory conditions'), 'Fails');
  const unavailable = page.items.find(item => item.id === 'unavailable');
  assert.equal(fieldValue(unavailable, 'Reviewed fit', 'Location match'), 'Assessment unavailable');
  assert.equal(unavailable.summary, 'Reviewed · Overall unavailable · Needs clarification');
  assert.equal(unavailable.sections.some(section => ['Fit breakdown', 'Gates', 'Requirements'].includes(section.heading)), false);
  assert.equal(fieldValue(page.items.find(item => item.id === 'relocation'), 'Reviewed fit', 'Location match'), 'Location incompatible');
  assert.equal(fieldValue(page.items.find(item => item.id === 'old'), 'Role', 'Against your minimum'), 'Below your minimum');
  assert.equal(page.items.find(item => item.id === 'missing').title, 'Job details unavailable');
  assert.deepEqual(state, before);
});

test('current pre-scans lead stale reviews without converting priority into overall fit', async () => {
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
  const current = rows.filter(row => !['old', 'missing-ad', 'changed-ad'].includes(row.id)).sort(comparePrescanRows);
  const stale = rows.filter(row => ['old', 'missing-ad', 'changed-ad'].includes(row.id)).sort(comparePrescanRows);
  assert.deepEqual(page.items.map(item => item.id), [...current, ...stale].map(row => row.id));
  const merged = page.items.find(item => item.id === 'merged');
  assert.match(merged.summary, /^Pre-scan · Priority 82\/100 · Potentially aligned$/);
  assert.equal(merged.sections[0].heading, 'Pre-scan result');
  assert.equal(fieldValue(merged, 'Reviewed fit', 'Overall fit'), '99/100 (Strong)');
  assert.equal(fieldValue(merged, 'Role', 'Location'), 'London');
  assert.equal(merged.sections.filter(section => section.heading === 'Role').length, 1);
  const uncertain = page.items.find(item => item.id === 'uncertain');
  assert.match(uncertain.summary, /Unresolved$/);
  assert.equal(fieldValue(uncertain, 'Pre-scan result', 'Mandatory conditions'), 'Unresolved');
  assert.match(page.items.find(item => item.id === 'conflict').summary, /Potential conflict$/);
  const ineligible = page.items.find(item => item.id === 'ineligible');
  assert.match(ineligible.summary, /Potential conflict$/);
  assert.equal(fieldValue(ineligible, 'Pre-scan result', 'Eligibility'), 'Potential conflict');
  assert.equal(fieldValue(page.items.find(item => item.id === 'refused'), 'Pre-scan result', 'Preliminary breakdown'), undefined);
  for (const id of ['refused', 'unavailable', 'oversize']) {
    const item = page.items.find(item => item.id === id);
    assert.equal(fieldValue(item, 'Pre-scan result', 'Priority'), 'Not scored');
    assert.equal(item.sections.some(section => section.heading === 'Reviewed fit'), false);
  }
  for (const row of stale) {
    const item = page.items.find(item => item.id === row.id);
    assert.match(item.summary, /^Out of date pre-scan/);
    assert.equal(fieldValue(item, 'Pre-scan result', 'Status'), 'Out of date');
  }
  for (const item of page.items)
    assert.deepEqual(await browser.read({ kind: 'jobs', id: item.id }), { title: item.title, sections: item.sections });
  assert.deepEqual(state, before);
});

test('pre-scan freshness respects the saved profile version and both policy IDs in list and detail', async () => {
  const { state, browser } = fixture();
  const row = preliminary('saved', currentDate());
  state.career.matching = { jobs: { saved: { ...row } }, scores: {} };
  savePrescan(state.career, [row]);
  assert.equal(fieldValue((await browser.list({ kind: 'jobs' })).items[0], 'Pre-scan result', 'Status'), 'Preliminary');
  for (const changed of [{ profileVersion: '1:0' }, { assessmentPolicyId: 'earlier-policy' }, { prescanPolicyId: 'earlier-policy' }]) {
    savePrescan(state.career, [row]);
    Object.assign(state.career.prescan, changed);
    const page = await browser.list({ kind: 'jobs' });
    assert.equal(fieldValue(page.items[0], 'Pre-scan result', 'Status'), 'Out of date');
    assert.match(page.items[0].summary, /^Out of date pre-scan/);
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

test('a current final review keeps stale pre-scan context and missing catalogue metadata', async () => {
  const { state, browser } = fixture();
  const row = preliminary('saved', '2000-01-01T00:00:00Z', 99,
    { title: 'Saved role title', company: 'Saved employer', city: 'London', applyUrl: 'https://example.test/saved' });
  state.career.matching = { jobs: {}, scores: { saved: finalAssessment(0) } };
  savePrescan(state.career, [row]);
  const page = await browser.list({ kind: 'jobs' });
  assert.equal(page.total, 1);
  const item = page.items[0];
  assert.equal(item.title, 'Saved role title — Saved employer');
  assert.equal(item.summary, 'Reviewed · Overall 0/100 · Poor · Not recommended');
  assert.equal(item.sections[0].heading, 'Reviewed fit');
  assert.equal(fieldValue(item, 'Pre-scan result', 'Status'), 'Out of date');
  assert.equal(fieldValue(item, 'Pre-scan result', 'Priority'), '99/100');
  assert.equal(fieldValue(item, 'Role', 'City'), 'London');
  assert.equal(fieldValue(item, 'Role', 'Apply URL'), 'https://example.test/saved');
  assert.equal(item.sections.filter(section => section.heading === 'Role').length, 1);
  assert.deepEqual(await browser.read({ kind: 'jobs', id: row.id }), { title: item.title, sections: item.sections });
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
