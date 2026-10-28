import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createCareerState } from '../src/mcp/state.mjs';
import { createCareerBrowser, openJobPage, requirementContextPrompt } from '../src/career-browser.mjs';
import { addBlock, removeBlock } from '../src/mcp/blocklist.mjs';
import { ASSESSMENT_POLICY_ID, deriveDecision } from '../src/mcp/matching-contract.mjs';
import { DEFAULT_INCLUSION_MINIMUM_SCORE } from '../src/prescan/state.mjs';
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
// What read({ kind: 'jobs' }) returns for a listed item: the reader projection without card, block or id.
const readerOf = ({ title, heading, header, verdict, sections }) => ({ title, heading, header, verdict, sections });

test('Preferences exposes saved direction, accepted alternatives, exclusions and practical constraints in Me', async () => {
  const { state, browser } = fixture();
  state.career.profile.preferences = {
    roles: ['Engineering leadership'], acceptedAlternatives: ['Hands-on engineering + product'],
    excludedRoles: ['Frontend engineer'], notes: 'Assess actual responsibilities, not titles.',
    locations: ['Amsterdam'], workModes: ['remote', 'hybrid'], willingToRelocate: false, travel: 'any',
    salaryMinimum: 120000, salaryCurrency: 'EUR', salaryPeriod: 'year',
    responsibilityModes: ['hands_on', 'managerial'], technologies: ['AI agents'],
  };
  const page = await browser.list({ kind: 'preferences' });
  assert.deepEqual(page.items.map(item => item.title), ['Direction', 'Location', 'Employment', 'Work']);
  assert.equal(page.total, 4);
  const direction = await browser.read({ kind: 'preferences', id: 'direction' });
  assert.deepEqual(sectionFields(direction, 'Direction'), [
    { label: 'Target roles', value: 'Engineering leadership' },
    { label: 'Accepted alternatives', value: 'Hands-on engineering + product' },
    { label: 'Avoid', value: 'Frontend engineer' },
  ]);
  assert.equal(direction.sections.find(section => section.heading === 'Direction notes').text,
    'Assess actual responsibilities, not titles.');
  const location = await browser.read({ kind: 'preferences', id: 'location' });
  assert.equal(fieldValue(location, 'Location', 'Willing to relocate'), 'No');
  assert.equal(fieldValue(location, 'Location', 'Work modes'), 'Remote · Hybrid');
  const employment = await browser.read({ kind: 'preferences', id: 'employment' });
  assert.match(fieldValue(employment, 'Employment', 'Minimum salary'), /120/);
  await assert.rejects(browser.read({ kind: 'preferences', id: 'missing' }), { code: 'NOT_FOUND' });
});

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
  assert.deepEqual(await browser.list({ kind: 'jobs' }), { items: [], total: 0, nextOffset: null,
    counts: { shortlist: 0, queue: 0, reviewed: 0, applications: 0, blocks: 0 },
    inclusion: { minimumScore: 36, included: 0, scored: null, stale: false, candidates: 0 } });
  await assert.rejects(browser.read({ kind: 'jobs', id: 'missing' }), { code: 'NOT_FOUND' });
});

test('Jobs views are strictly validated and obsolete sorts are rejected', async () => {
  const { browser } = fixture();
  for (const view of [null, undefined, '', 'newest', 'Score', 'rank', 0, {}, ['queue']])
    await assert.rejects(browser.list({ kind: 'jobs', view }), { code: 'INVALID_INPUT' });
  for (const kind of ['sources', 'facts', 'preferences', 'career', 'applications', 'blocks'])
    await assert.rejects(browser.list({ kind, view: 'shortlist' }), {
      code: 'INVALID_INPUT', message: 'Use view shortlist, queue or reviewed for Jobs only.' });
  for (const sort of [null, undefined, '', 'score', 'recent'])
    await assert.rejects(browser.list({ kind: 'jobs', sort }), { code: 'INVALID_INPUT' });
  for (const view of ['shortlist', 'queue', 'reviewed'])
    assert.deepEqual(await browser.list({ kind: 'jobs', view }), { items: [], total: 0, nextOffset: null,
      counts: { shortlist: 0, queue: 0, reviewed: 0, applications: 0, blocks: 0 },
      inclusion: { minimumScore: 36, included: 0, scored: null, stale: false, candidates: 0 } });
  await assert.rejects(browser.read({ kind: 'jobs', id: 'missing', view: 'shortlist' }), { code: 'INVALID_INPUT' });
});

test('Jobs views paginate publication order, the included queue and reviewed jobs independently', async () => {
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
  const expectedRecent = ['capture', 'final-fit-99', 'refused', 'zero', 'catalogue-only', 'low-aligned',
    'high-conflict', 'invalid-score', 'unknown-a', 'unknown-b'];
  for (const [view, expected] of [['shortlist', expectedRecent], ['queue', []], ['reviewed', ['final-fit-99']]]) {
    const seen = [];
    let offset = 0;
    do {
      const page = await browser.list({ kind: 'jobs', view, offset, limit: 3 });
      assert.equal(page.total, expected.length);
      seen.push(...page.items.map(item => item.id));
      offset = page.nextOffset;
    } while (offset !== null);
    assert.deepEqual(seen, expected);
  }
  assert.deepEqual((await browser.list({ kind: 'jobs' })).items.map(item => item.id), expectedRecent);
  const reviewed = await browser.read({ kind: 'jobs', id: 'final-fit-99' });
  assert.deepEqual(reviewed.verdict, { kind: 'reviewed', number: 99, numberLabel: 'Fit',
    headline: 'Recommended', detail: 'Strong fit · Reviewed 14 Oct 2026', reason: 'Saved full-advert review.' });
  assert.equal(reviewed.heading, 'Reviewed');
  assert.equal(fieldValue(reviewed, 'Checks', 'Pre-filter'), undefined);
  assert.equal(reviewed.sections.some(section => section.heading === 'Pre-filter'), false);
  assert.equal((await browser.read({ kind: 'jobs', id: 'catalogue-only' })).title, 'Saved unscored');
  assert.deepEqual((await browser.read({ kind: 'jobs', id: 'catalogue-only' })).verdict, { kind: 'unscored', number: null,
    numberLabel: null, headline: 'Skipped', detail: 'Not scored yet', reason: null });
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
  assert.deepEqual(item('leader').card, { ...item('leader').card, stage: 'reviewed', score: 70, stale: false, rank: null, included: false, overridden: false, status: null });
  assert.equal(item('leader').card.publishedAt, publishedAt);
  assert.equal(item('leader').heading, 'leader');
  assert.equal(item('leader').title, 'leader — Company');
  // The verdict carries the number, the saved decision, its band, the pairwise standing and the review date.
  assert.deepEqual(item('leader').verdict, { kind: 'reviewed', number: 70, numberLabel: 'Fit', headline: 'Recommended',
    detail: 'Good fit · 1 win of 1 comparison · Reviewed 14 Oct 2026', reason: 'Saved full-advert review.' });
  // Checks is one ledger: location, relocation and the three gates; no separate Gates or status fields.
  assert.deepEqual(sectionFields(item('leader'), 'Checks'), [
    { label: 'Location', value: 'Location compatible' }, { label: 'Relocation', value: 'Not required' },
    { label: 'Career direction', value: 'Passes' }, { label: 'Mandatory conditions', value: 'Passes' },
    { label: 'Eligibility', value: 'Passes' }]);
  assert.deepEqual(item('leader').sections.map(section => section.heading), ['Checks', 'Fit', 'Requirements']);
  // The breakdown is a chart section (Overall first, then the four dimensions as integers), never a numeric dl.
  assert.deepEqual(item('leader').sections.find(section => section.heading === 'Fit'), { heading: 'Fit', chart: [
    { label: 'Overall', value: 70 }, { label: 'Direction', value: 80 }, { label: 'Capability', value: 70 },
    { label: 'Scope', value: 60 }, { label: 'Preferences', value: 65 }] });
  assert.deepEqual(item('runner').sections.find(section => section.heading === 'Fit').chart.map(row => row.value), [90, 90, 90, 90, 90]);
  // Requirements are actionable rows, ordered evidence-first and essential before preferred.
  assert.deepEqual(item('leader').sections.find(section => section.heading === 'Requirements').requirements, [
    { requirement: 'Mentor engineers', evidence: 'Missing', importance: 'preferred' },
    { requirement: 'Own production services', evidence: 'Demonstrated', importance: 'essential' }]);
  assert.equal(item('runner').verdict.detail, 'Strong fit · 0 wins of 1 comparison · Reviewed 14 Oct 2026');

  assert.deepEqual({ ...item('flagged').verdict, reason: null }, { kind: 'reviewed', number: 85, numberLabel: 'Fit',
    headline: 'Needs clarification', detail: 'Strong fit · Reviewed 14 Oct 2026', reason: null });
  assert.equal(fieldValue(item('flagged'), 'Checks', 'Mandatory conditions'), 'Needs confirmation');
  assert.deepEqual(item('excluded').verdict, { kind: 'ineligible', number: null, numberLabel: null, headline: 'Excluded by a gate',
    detail: null, reason: null });
  assert.equal(fieldValue(item('excluded'), 'Checks', 'Location'), undefined);
  assert.equal(fieldValue(item('excluded'), 'Checks', 'Eligibility'), 'Fails');
  assert.equal(item('excluded').sections[1].heading, 'Fit — excluded by a gate');
  assert.equal(item('excluded').sections[1].chart[0].value, 85);
  for (const id of Object.keys(scores)) {
    const detail = await browser.read({ kind: 'jobs', id });
    assert.deepEqual(detail, readerOf(item(id)));
    assert.deepEqual(detail.header, { company: 'Company', published: detail.header.published, facts: [], applyUrl: null });
    assert.match(detail.header.published, /^Published \d{1,2} \w{3} \d{4}$/);
  }
  assert.equal(Object.keys(await browser.read({ kind: 'jobs', id: 'leader' })).join(), 'title,heading,header,verdict,sections');
});

test('a saved application for a reviewed job appears as its own section with drafts, exports and bound answers', async () => {
  const { state, browser } = fixture();
  state.career.matching = { jobs: { leader: { id: 'leader', title: 'leader', company: 'Company', publishedAt: '2026-10-10T12:00:00Z' },
    other: { id: 'other', title: 'other', company: 'Company', publishedAt: '2026-10-10T12:00:00Z' } }, scores: { leader: finalAssessment(70) } };
  state.career.applications = { app: { id: 'app', job: { id: 'leader', title: 'leader', company: 'Company' }, createdAt: '2026-10-15T09:00:00Z',
    cv: { createdAt: '2026-10-16T09:00:00Z', document: {} }, exports: [{ format: 'pdf' }, { format: 'docx' }] } };
  state.career.facts = {
    one: { subject: 'Why this role', answer: 'Growth.', applicationId: 'app' },
    two: { subject: 'Notice period', answer: 'One month.', applicationId: 'app' },
    unrelated: { subject: 'Hobby', answer: 'Chess.' },
  };
  const leader = await browser.read({ kind: 'jobs', id: 'leader' });
  assert.deepEqual(leader.sections.map(section => section.heading), ['Checks', 'Fit', 'Requirements', 'Your application']);
  assert.deepEqual(sectionFields(leader, 'Your application'), [
    { label: 'Prepared', value: '15 Oct 2026' }, { label: 'CV draft', value: '16 Oct 2026' }, { label: 'Cover letter', value: 'Not drafted' },
    { label: 'Exports', value: '2 exports' }, { label: 'Interview answers', value: '2 answers' }]);
  const other = await browser.read({ kind: 'jobs', id: 'other' });
  assert.equal(other.sections.some(section => section.heading === 'Your application'), false);
  assert.deepEqual(other.sections.map(section => section.heading), ['Checks']);
});

test('openJobPage opens only a saved http(s) job page and rejects unknown or malformed ids', async () => {
  const { state, store } = fixture();
  state.career.matching = { jobs: {
    linked: { title: 'Linked', applyUrl: 'https://jobs.example/linked?utm=1' },
    unsafe: { title: 'Unsafe', applyUrl: 'javascript:alert(1)' },
    bare: { title: 'Bare' },
  }, scores: {} };
  state.career.jobs = { captured: { title: 'Captured', applyUrl: 'http://jobs.example/captured', complete: true, description: 'Advert.', updatedAt: '2026-10-01T00:00:00Z' } };
  const opened = [];
  const openExternal = async url => { opened.push(url); };
  assert.deepEqual(await openJobPage({ store, openExternal }, { id: 'linked' }), { opened: true, url: 'https://jobs.example/linked?utm=1' });
  assert.deepEqual(await openJobPage({ store, openExternal }, { id: 'captured' }), { opened: true, url: 'http://jobs.example/captured' });
  assert.deepEqual((await createCareerBrowser({ store }).read({ kind: 'jobs', id: 'unsafe' })).header.applyUrl, null);
  assert.deepEqual((await createCareerBrowser({ store }).read({ kind: 'jobs', id: 'linked' })).header.applyUrl, 'https://jobs.example/linked?utm=1');
  await assert.rejects(openJobPage({ store, openExternal }, { id: 'unsafe' }), { code: 'NOT_FOUND' });
  await assert.rejects(openJobPage({ store, openExternal }, { id: 'bare' }), { code: 'NOT_FOUND' });
  await assert.rejects(openJobPage({ store, openExternal }, { id: 'missing' }), { code: 'NOT_FOUND' });
  for (const id of ['', '   ', '__proto__', 'constructor', 42, null, undefined])
    await assert.rejects(openJobPage({ store, openExternal }, { id }), { code: 'INVALID_INPUT' });
  await assert.rejects(openJobPage({ store, openExternal }, null), { code: 'INVALID_INPUT' });
  assert.deepEqual(opened, ['https://jobs.example/linked?utm=1', 'http://jobs.example/captured']);
});

test('requirement context prompt accepts only an exact saved assessment requirement and preserves plain Unicode text', () => {
  const { state, store } = fixture();
  const requirement = 'Explain <script>alert("no")</script> & “delivery”';
  state.career.matching = {
    jobs: { saved: { title: 'Staff Engineer', company: 'R&D <Labs>' } },
    scores: { saved: finalAssessment(80, { requirements: [{ requirement, importance: 'essential', evidence: 'missing' }] }) },
  };
  assert.equal(requirementContextPrompt({ store }, { id: 'saved', requirement }),
    `Use the recruiters.rip skill to help me add context for this requirement in Staff Engineer at R&D <Labs>: “${requirement}”. Read the saved job and my current career record. If this is a material gap, create or reuse its application, ask me one focused question, save my answer as a reusable fact, then reassess this job. Do not invent evidence or change unrelated preferences.`);
  assert.throws(() => requirementContextPrompt({ store }, { id: 'saved', requirement: 'Close but not exact' }), { code: 'NOT_FOUND' });
  assert.throws(() => requirementContextPrompt({ store }, { id: 'missing', requirement }), { code: 'NOT_FOUND' });
  for (const args of [null, {}, { id: 'saved', requirement: '' }, { id: '__proto__', requirement }, { id: 'saved', requirement, extra: true }])
    assert.throws(() => requirementContextPrompt({ store }, args), { code: 'INVALID_INPUT' });
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
  const expected = [...Object.keys(career.matching.scores), 'pre-high', 'pre-low'].sort().concat('capture');
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
  assert.deepEqual(await browser.list({ kind: 'jobs', offset: 108 }), { items: [], total: 108, nextOffset: null,
    counts: { shortlist: 108, queue: 1, reviewed: 105, applications: 0, blocks: 0 },
    inclusion: { minimumScore: 36, included: 1, scored: 2, stale: false, candidates: 2 } });
  const merged = items.find(item => item.id === 'reviewed-0');
  assert.deepEqual(merged.card, { ...merged.card, stage: 'reviewed', score: 1, stale: false, rank: null, included: false });
  // A current review supersedes the pre-filter: the verdict is the fit, the pre-scan survives only as a Role row.
  assert.deepEqual({ ...merged.verdict, reason: null }, { kind: 'reviewed', number: 1, numberLabel: 'Fit', headline: 'Not recommended',
    detail: 'Poor fit · Reviewed 14 Oct 2026', reason: null });
  assert.equal(merged.sections.filter(section => section.heading === 'Metadata').length, 1);
  assert.deepEqual(await browser.read({ kind: 'jobs', id: merged.id }), readerOf(merged));
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
  for (const row of canonical.matches) {
    const item = page.items.find(item => item.id === row.id);
    assert.equal(item.verdict.number, item.card.stage === 'reviewed' ? row.overall : null);
    assert.equal(item.verdict.kind, ['incompatible_location', 'excluded'].includes(row.matchStatus) ? 'ineligible'
      : row.reviewStatus === 'current' ? 'reviewed' : item.card.stage);
    assert.deepEqual(await browser.read({ kind: 'jobs', id: row.id }), readerOf(item));
  }
  const stale = page.items.find(item => item.id === 'stale');
  assert.deepEqual([stale.card.score, stale.card.stale, stale.card.stage, stale.card.rank], [99, true, 'unscored', null]);
  assert.equal(stale.verdict.reason.includes('Reviewed at 99 before your profile changed'), true);
  assert.equal(page.items.find(item => item.id === 'legacy').verdict.reason.includes('Reviewed at'), true);
  assert.equal(page.items.find(item => item.id === 'invalid').verdict.headline, 'Pre-qualified for AI review');
  const excluded = page.items.find(item => item.id === 'excluded');
  assert.equal(excluded.verdict.headline, 'Excluded by a gate');
  assert.equal(fieldValue(excluded, 'Checks', 'Mandatory conditions'), 'Fails');
  assert.deepEqual(excluded.card, { ...excluded.card, stage: 'ineligible', label: 'Excluded by a gate', established: false, score: 85, rank: null, included: false });
  assert.equal(excluded.sections.find(section => section.chart).heading, 'Fit — excluded by a gate');
  const unavailable = page.items.find(item => item.id === 'unavailable');
  assert.equal(unavailable.verdict.number, null);
  assert.deepEqual(unavailable.card, { ...unavailable.card, score: null, rank: null, status: null });
  assert.equal(unavailable.sections.some(section => ['Fit', 'Requirements'].includes(section.heading)), false);
  const relocation = page.items.find(item => item.id === 'relocation');
  assert.equal(relocation.verdict.headline, 'Location incompatible');
  assert.deepEqual(relocation.card, { ...relocation.card, stage: 'ineligible', label: 'Location incompatible', established: false, score: 80 });
  assert.equal(relocation.sections.find(section => section.chart).heading, 'Fit excluding location — not eligible');
  const reviewed = await browser.list({ kind: 'jobs', view: 'reviewed' });
  assert.deepEqual(reviewed.items.slice(-2).map(item => item.id), ['excluded', 'relocation']);
  assert.equal(page.items.find(item => item.id === 'old').sections.find(section => section.chart).heading, 'Fit');
  assert.equal(fieldValue(page.items.find(item => item.id === 'old'), 'Checks', 'Salary'), 'GBP 100–200 per year · Below your minimum');
  assert.equal(page.items.find(item => item.id === 'missing').title, 'Job details unavailable');
  assert.deepEqual(state, before);
});

test('shortlist presentation keeps qualification, freshness and operational failures, and a stale review yields to a current shortlist', async () => {
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
  assert.deepEqual(page.items.slice(0, 4).map(item => item.id), ['conflict', 'ineligible', 'merged', 'missing-ad']);
  const merged = page.items.find(item => item.id === 'merged');
  assert.deepEqual(merged.card, { ...merged.card, stage: 'prefilter', rank: 4, included: true, overridden: false, score: 99, stale: true, status: null });
  assert.equal(merged.sections[0].heading, 'Checks');
  // Shortlist qualification has no numeric score; the previous review fit remains separate.
  assert.deepEqual(merged.verdict, { kind: 'prefilter', number: null, numberLabel: null, headline: 'Pre-qualified for AI review',
    detail: 'Shortlist found this worth a full review · shortlisted before your profile changed',
    reason: 'Reviewed at 99 before your profile changed · Saved full-advert review.' });
  assert.equal(Object.hasOwn(merged.card, 'prefilterScore'), false);
  assert.equal(merged.sections.find(section => section.chart).chart[0].value, 99);
  assert.equal(merged.header.facts.includes('London'), true);
  assert.equal(merged.sections.filter(section => section.heading === 'Metadata').length, 1);
  assert.equal(fieldValue(merged, 'Metadata', 'Shortlist'), 'OpenAI Decisions · saved-model · current');
  const failures = { refused: 'Provider declined assessment', unavailable: 'Original advert unavailable',
    oversize: 'Input exceeds the provider limit' };
  for (const [id, reason] of Object.entries(failures)) {
    const item = page.items.find(item => item.id === id);
    assert.equal(item.verdict.detail, reason);
    assert.deepEqual(item.card, { ...item.card, stage: 'unscored', rank: null, included: false, score: null, stale: false, status: id });
    assert.equal(item.sections.some(section => section.chart), false);
  }
  for (const row of stale) {
    const item = page.items.find(item => item.id === row.id);
    assert.deepEqual([item.card.stale, item.card.stage, item.card.rank, item.card.included], [true, 'unscored', null, false]);
    assert.match(fieldValue(item, 'Metadata', 'Shortlist'), /out of date$/);
  }
  for (const item of page.items) assert.deepEqual(await browser.read({ kind: 'jobs', id: item.id }), readerOf(item));
  assert.deepEqual(state, before);
});

test('profile and provider policy changes keep the pre-filter ranking as out of date; an unknown provider drops it', async () => {
  const { state, browser } = fixture();
  const row = preliminary('saved', currentDate());
  state.career.matching = { jobs: { saved: { ...row } }, scores: {} };
  savePrescan(state.career, [row]);
  const current = await browser.list({ kind: 'jobs' });
  assert.match(fieldValue(current.items[0], 'Metadata', 'Shortlist'), /current$/);
  assert.deepEqual(current.items[0].card, { ...current.items[0].card, stage: 'prefilter', rank: 1, included: true, score: null, stale: false });
  for (const [changed, card, inclusion] of [
    [{ profileVersion: '1:0' }, { stage: 'prefilter', rank: 1 }, { scored: 1, stale: true }],
    [{ prescanPolicyId: 'earlier-policy' }, { stage: 'prefilter', rank: 1 }, { scored: 1, stale: true }],
    [{ provider: 'retired-provider' }, { stage: 'unscored', rank: null }, { scored: null, stale: false }]]) {
    savePrescan(state.career, [row]);
    Object.assign(state.career.prescan, changed);
    const page = await browser.list({ kind: 'jobs' });
    assert.match(fieldValue(page.items[0], 'Metadata', 'Shortlist'), /out of date$/);
    assert.deepEqual(page.items[0].card, { ...page.items[0].card, ...card, included: true, score: null, stale: true });
    assert.deepEqual(page.inclusion, { minimumScore: 36, included: 1, ...inclusion, candidates: 1 });
    assert.deepEqual(await browser.read({ kind: 'jobs', id: row.id }), readerOf(page.items[0]));
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
  assert.deepEqual(detail, readerOf(page.items[0]));
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
  assert.deepEqual(item.card, { title: 'Saved role title', company: 'Saved employer', logoUrl: null, publishedAt: '2000-01-01T00:00:00Z',
    facts: ['London'], stage: 'reviewed', label: null, established: false, rank: null, included: false, overridden: false, score: 0, stale: false, status: null });
  assert.equal(item.sections[0].heading, 'Checks');
  assert.equal(item.sections.some(section => section.heading === 'Pre-filter'), false);
  assert.equal(item.header.facts.includes('London'), true);
  assert.equal(item.header.applyUrl, 'https://example.test/saved');
  assert.equal(item.sections.filter(section => section.heading === 'Metadata').length, 1);
  assert.deepEqual(await browser.read({ kind: 'jobs', id: row.id }), readerOf(item));
});

test('job cards mirror structured catalogue fields as plain facts and omit missing facts and shortlist scores', async () => {
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
  assert.deepEqual(card('full'), { title: 'Protocol Engineer', company: 'Example Labs', logoUrl: null, publishedAt,
    facts: ['Senior', 'USD 120,000–160,000 per year', 'Berlin · Remote', 'Full Time', 'Smart Contracts'],
    stage: 'reviewed', label: null, established: false, rank: null, included: false, overridden: false, score: 92, stale: false, status: null });
  assert.deepEqual(card('sparse'), { title: 'Analyst', company: 'Sparse Co', logoUrl: null, publishedAt: null,
    facts: ['EUR 90,000 per year', 'Lisbon'],
    stage: 'unscored', label: null, established: false, rank: null, included: false, overridden: false, score: null, stale: true, status: null });
  assert.deepEqual(card('bare'), { title: 'Bare', company: null, logoUrl: null, publishedAt: null, facts: [],
    stage: 'unscored', label: null, established: false, rank: null, included: false, overridden: false, score: null, stale: false, status: null });
  assert.deepEqual(page.inclusion, { minimumScore: 36, included: 0, scored: 0, stale: false, candidates: 2 });
  assert.equal(page.items.some(item => 'summary' in item), false);
});

test('Jobs views separate publication order, shortlist-ranked inclusion and current reviews', async () => {
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
  const page = await browser.list({ kind: 'jobs', view: 'shortlist' });
  assert.deepEqual(page.items.map(item => item.id),
    ['review-only', 'stale-review', 'strong-prefilter', 'weak-review', 'stale-both', 'stale-prefilter']);
  assert.deepEqual(page.inclusion, { minimumScore: 36, included: 2, scored: 2, stale: false, candidates: 4 });
  assert.deepEqual(page.counts, { shortlist: 6, queue: 2, reviewed: 2, applications: 0, blocks: 0 });
  assert.equal(Object.hasOwn(page, 'cutoffIndex'), false);
  const stage = id => { const { stage, rank, included, score, stale } = page.items.find(item => item.id === id).card; return { stage, rank, included, score, stale }; };
  assert.deepEqual(stage('weak-review'), { stage: 'reviewed', rank: null, included: false, score: 40, stale: false });
  assert.deepEqual(stage('review-only'), { stage: 'reviewed', rank: null, included: false, score: 35, stale: false });
  assert.deepEqual(stage('strong-prefilter'), { stage: 'prefilter', rank: 1, included: true, score: null, stale: false });
  assert.deepEqual(stage('stale-review'), { stage: 'prefilter', rank: 2, included: true, score: 88, stale: true });
  assert.deepEqual(stage('stale-both'), { stage: 'unscored', rank: null, included: false, score: 30, stale: true });
  assert.deepEqual(stage('stale-prefilter'), { stage: 'unscored', rank: null, included: false, score: null, stale: true });
  const verdict = id => page.items.find(item => item.id === id).verdict;
  assert.equal(verdict('weak-review').kind, 'reviewed');
  assert.equal(verdict('stale-review').kind, 'prefilter');
  assert.equal(verdict('stale-review').reason.includes('Reviewed at 88 before your profile changed'), true);
  assert.equal(verdict('stale-both').kind, 'unscored');
  assert.equal(verdict('strong-prefilter').kind, 'prefilter');
  for (const item of page.items) assert.equal('reviewed' in item.card, false);
  assert.deepEqual((await browser.list({ kind: 'jobs', view: 'queue' })).items.map(item => item.id),
    ['strong-prefilter', 'stale-review']);
  assert.deepEqual((await browser.list({ kind: 'jobs', view: 'reviewed' })).items.map(item => item.id),
    ['weak-review', 'review-only']);
});

test('ineligible reviews sort last with a label instead of a number; established incompatibility has no switch even with an override saved', async () => {
  const { state, browser } = fixture();
  const publishedAt = currentDate();
  const rows = [preliminary('ranked', publishedAt, 90), preliminary('predicted', publishedAt, null,
    { status: 'incompatible_location', priority: null, fit: null, location: 'conflict', locationConflict: 0.8, dimensions: null, confidence: null }),
  preliminary('stale-gate', publishedAt, 95), preliminary('stale-relocation', publishedAt, 94), preliminary('cheap', publishedAt, null,
    { status: 'below_minimum', priority: null, fit: null, location: null, dimensions: null, confidence: null })];
  state.career.matching = { jobs: { ...Object.fromEntries(rows.map(row => [row.id, { ...row }])),
    excluded: { title: 'excluded', company: 'Company', publishedAt }, relocation: { title: 'relocation', company: 'Company', publishedAt } }, scores: {
    excluded: finalAssessment(85, { gates: { ...passing, constraints: 'fail' } }),
    relocation: finalAssessment(80, { relocation: 'required' }),
    'stale-gate': { ...finalAssessment(70, { gates: { ...passing, eligibility: 'fail' } }), profileVersion: 'old' },
    'stale-relocation': { ...finalAssessment(65, { relocation: 'required' }), profileVersion: 'old' },
  } };
  state.career.profile.preferences.willingToRelocate = false;
  savePrescan(state.career, rows);
  state.career.prescanInclusion = { scale: 2, minimumScore: 60, overrides: { 'stale-gate': true, 'stale-relocation': true, predicted: true, cheap: true } };
  const page = await browser.list({ kind: 'jobs' });
  assert.deepEqual(page.items.map(item => item.id), ['cheap', 'excluded', 'predicted', 'ranked', 'relocation', 'stale-gate', 'stale-relocation']);
  const card = id => page.items.find(item => item.id === id).card;
  // Current ineligible reviews: the verdict is the card; the number lives only in the reader's qualified chart.
  assert.deepEqual(card('excluded'), { ...card('excluded'), stage: 'ineligible', label: 'Excluded by a gate', established: false, score: 85, rank: null, included: false, overridden: false });
  assert.deepEqual(card('relocation'), { ...card('relocation'), stage: 'ineligible', label: 'Location incompatible', established: false, score: 80, rank: null, included: false });
  // Established incompatibility from a stale review: never a candidate, overrides ignored, label from the saved verdict.
  assert.deepEqual(card('stale-gate'), { ...card('stale-gate'), stage: 'ineligible', label: 'Excluded by a gate', established: true, rank: null, included: false, overridden: false, stale: true });
  assert.deepEqual(card('stale-relocation'), { ...card('stale-relocation'), stage: 'ineligible', label: 'Location incompatible', established: true, rank: null, included: false, overridden: false, stale: true });
  assert.equal(page.items.find(item => item.id === 'stale-gate').sections.find(section => section.chart).heading, 'Fit — excluded by a gate');
  // Predicted conflicts and verified salary shortfalls stay unranked but overridable.
  assert.deepEqual(card('predicted'), { ...card('predicted'), stage: 'unscored', label: null, established: false, rank: null, included: true, overridden: true, status: 'incompatible_location' });
  assert.deepEqual(card('cheap'), { ...card('cheap'), stage: 'unscored', label: null, established: false, rank: null, included: true, overridden: true, status: 'below_minimum' });
  const predicted = page.items.find(item => item.id === 'predicted');
  assert.deepEqual(predicted.verdict, { kind: 'unscored', number: null, numberLabel: null,
    headline: 'Pre-qualified for AI review · manual', detail: 'Location conflict predicted', reason: null });
  assert.equal(fieldValue(predicted, 'Checks', 'Location'), 'Conflict');
  assert.equal(fieldValue(predicted, 'Metadata', 'Shortlist'), 'Location conflict predicted · OpenAI Decisions · saved-model · current');
  assert.equal(page.items.find(item => item.id === 'cheap').verdict.detail, 'Salary below your minimum');
  assert.equal(fieldValue(page.items.find(item => item.id === 'cheap'), 'Checks', 'Location'), undefined);
  assert.deepEqual(card('ranked'), { ...card('ranked'), stage: 'prefilter', included: true, label: null, established: false });
  assert.deepEqual(page.inclusion, { minimumScore: 60, included: 3, scored: 3, stale: false, candidates: 5 });
  assert.deepEqual((await browser.list({ kind: 'jobs', view: 'queue' })).items.map(item => item.id), ['ranked', 'cheap', 'predicted']);
  assert.deepEqual((await browser.list({ kind: 'jobs', view: 'reviewed' })).items.map(item => item.id),
    ['excluded', 'relocation', 'stale-gate', 'stale-relocation']);
});

test('queue pages include switched-on jobs by shortlist rank then unscored jobs without a cutoff', async () => {
  const { state, browser } = fixture();
  const publishedAt = currentDate();
  const rows = Array.from({ length: 7 }, (_, index) => preliminary(`job-${index}`, publishedAt, 99 - index));
  state.career.matching = { jobs: Object.fromEntries(rows.map(row => [row.id, { ...row }])), scores: { reviewed: finalAssessment(50) } };
  state.career.matching.jobs.reviewed = { title: 'Reviewed', publishedAt };
  state.career.matching.jobs.plain = { title: 'Plain', publishedAt };
  savePrescan(state.career, rows);
  state.career.prescanInclusion = { scale: 2, minimumScore: 96, overrides: { 'job-1': false, 'job-5': true, plain: true, reviewed: true } };
  const first = await browser.list({ kind: 'jobs', view: 'queue', limit: 3 });
  assert.deepEqual(first.items.map(item => item.id), ['job-0', 'job-2', 'job-3']);
  assert.equal(first.nextOffset, 3);
  assert.equal(Object.hasOwn(first, 'cutoffIndex'), false);
  assert.deepEqual(first.inclusion, { minimumScore: 96, included: 5, scored: 7, stale: false, candidates: 8 });
  assert.deepEqual(first.counts, { shortlist: 9, queue: 5, reviewed: 1, applications: 0, blocks: 0 });
  const second = await browser.list({ kind: 'jobs', view: 'queue', offset: 3, limit: 3 });
  assert.deepEqual(second.items.map(item => item.id), ['job-5', 'plain']);
  assert.equal(second.nextOffset, null);
  assert.equal(Object.hasOwn(second, 'cutoffIndex'), false);
  const all = await browser.list({ kind: 'jobs', view: 'shortlist' });
  assert.deepEqual(all.items.map(item => item.id), [...rows.map(row => row.id), 'plain', 'reviewed']);
  const flags = Object.fromEntries(all.items.map(item => [item.id, [item.card.rank, item.card.included, item.card.overridden]]));
  assert.deepEqual(flags, {
    reviewed: [null, false, false], 'job-0': [1, true, false], 'job-1': [2, false, true], 'job-2': [3, true, false], 'job-3': [4, true, false],
    'job-4': [5, false, false], 'job-5': [6, true, true], 'job-6': [7, false, false], plain: [null, true, true],
  });
  assert.deepEqual((await browser.list({ kind: 'jobs', view: 'reviewed' })).items.map(item => item.id), ['reviewed']);
  state.career.prescanInclusion = { scale: 2, minimumScore: 93, overrides: {} };
  const wide = await browser.list({ kind: 'jobs', view: 'queue' });
  assert.deepEqual(wide.items.map(item => item.id), rows.map(row => row.id));
  assert.deepEqual(wide.inclusion, { minimumScore: 93, included: 7, scored: 7, stale: false, candidates: 8 });
  state.career.prescanInclusion = { scale: 2, minimumScore: 100, overrides: {} };
  const none = await browser.list({ kind: 'jobs', view: 'queue' });
  assert.deepEqual(none.items, []);
  assert.deepEqual(none.inclusion, { minimumScore: 100, included: 0, scored: 7, stale: false, candidates: 8 });
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

async function rendererFixture(browser, wide, operations = {}) {
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
      this.style = {};
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    get childElementCount() { return this.children.length; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    focus() { focused = this; }
    querySelectorAll(selector) {
      const matches = child => selector.startsWith('.') ? child.className?.split(' ').includes(selector.slice(1))
        : selector.startsWith('[') ? child.attributes.has(selector.slice(1, -1)) : child.tagName === selector.toUpperCase();
      return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    fire(name, event = {}) {
      let propagated = true;
      this.listeners.get(name)?.({ target: this, stopPropagation() { propagated = false; }, preventDefault() {}, ...event });
      return propagated;
    }
  }
  const names = ['records', 'list-status', 'list-retry', 'pagination', 'previous', 'next', 'reader', 'reader-title',
    'reader-status', 'reader-retry', 'reader-content', 'close'];
  const ids = [...names.flatMap(name => [`career-${name}`, `me-${name}`]), 'career-browser', 'me-browser', 'delete-rankings',
    'career-surface', 'career-queue-qualified', 'career-queue-all', 'career-surface-sentence', 'run-step-prefilter', 'run-step-handover'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Node()]));
  nodes['run-step-prefilter'].dataset.stagePanel = 'shortlist';
  nodes['run-step-handover'].dataset.stagePanel = 'queue';
  const category = kind => {
    const node = new Node('button');
    node.dataset.careerKind = kind;
    return [kind, node];
  };
  const categories = Object.fromEntries(['sources', 'facts', 'preferences'].map(category));
  const jobCategories = Object.fromEntries(['jobs', 'applications', 'blocks'].map(category));
  const stageCounts = [];
  for (const view of ['shortlist', 'queue', 'reviewed']) {
    const button = view === 'shortlist' ? jobCategories.jobs : category('jobs')[1];
    button.dataset.careerView = view;
    button.setAttribute('aria-pressed', String(view === 'shortlist'));
    nodes[`career-stage-${view}`] = button;
    if (view !== 'shortlist') jobCategories[view] = button;
  }
  for (const name of ['shortlist', 'queue', 'reviewed', 'applications', 'blocks']) {
    const count = new Node('span'); count.className = 'stage-count'; count.dataset.stageCount = name;
    (nodes[`career-stage-${name}`] ?? jobCategories[name]).append(count);
    stageCounts.push(count);
  }
  nodes['career-category-applications'] = jobCategories.applications;
  nodes['career-category-blocks'] = jobCategories.blocks;
  nodes['me-browser'].querySelectorAll = selector => selector === '[data-stage-count]' ? [] : Object.values(categories);
  nodes['career-browser'].querySelectorAll = selector => selector === '[data-stage-count]' ? stageCounts : Object.values(jobCategories);
  const calls = [];
  const window = { matchMedia: () => ({ matches: wide }), companion: { async invoke(operation, args) {
    const input = structuredClone(args);
    calls.push({ operation, args: input });
    if (operation !== 'career-list' && operation !== 'career-read') return { ok: true, result: (await operations[operation]?.(input)) ?? {} };
    return { ok: true, result: await (operation === 'career-list' ? browser.list(input) : browser.read(input)) };
  } } };
  const document = { getElementById: id => nodes[id], createElement: tag => new Node(tag),
    querySelectorAll: () => [nodes['run-step-prefilter'], nodes['run-step-handover']] };
  runInNewContext(await readFile(new URL('../ui/career-browser.js', import.meta.url), 'utf8'), { window, document });
  const byClass = (node, className) => node.className?.split(' ').includes(className) ? node
    : node.children.map(child => byClass(child, className)).find(Boolean) ?? null;
  const rows = prefix => nodes[`${prefix}-records`].children.filter(row => row.className !== 'career-cutoff').map(row => byClass(row, 'career-record'));
  return { window, nodes, categories, jobCategories, calls, rows, byClass, focused: () => focused,
    settle: () => new Promise(resolve => setImmediate(resolve)),
    titles: (prefix = 'career') => rows(prefix).map(button => byClass(button, 'career-record-title').textContent) };
}

for (const wide of [false, true]) test(`Jobs paging and stage changes keep the reader column and pagination stable in ${wide ? 'wide' : 'narrow'} mode`, async () => {
  const { state, browser } = fixture();
  const rows = Array.from({ length: 27 }, (_, index) => preliminary(String(index).padStart(2, '0'),
    new Date(Date.now() - (index + 1) * 60000).toISOString(), index + 40));
  savePrescan(state.career, rows);
  state.career.matching = { jobs: Object.fromEntries(rows.map(row => [row.id, row])), scores: {} };
  state.career.applications.app = { id: 'app', job: { title: 'Applied Role', company: 'Employer' } };
  const ui = await rendererFixture(browser, wide);
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  assert.equal(ui.titles()[0], '00');
  assert.equal(ui.nodes['run-step-prefilter'].hidden, false);
  assert.equal(ui.nodes['delete-rankings'].disabled, false);
  assert.equal(ui.nodes['career-pagination'].hidden, false);
  assert.equal(ui.nodes['career-reader'].hidden, !wide);
  assert.equal(ui.nodes['career-reader-title'].textContent, wide ? '00' : '');
  ui.nodes['career-next'].fire('click');
  await ui.settle();
  assert.deepEqual(ui.titles(), ['25', '26']);
  assert.equal(ui.nodes['career-pagination'].hidden, false);
  assert.equal(ui.nodes['career-previous'].disabled, false);
  assert.equal(ui.nodes['career-next'].disabled, true);
  // Next keeps the reader column: wide screens open the first record of the new page without stealing list focus.
  assert.equal(ui.focused(), ui.rows('career')[0]);
  assert.equal(ui.nodes['career-reader'].hidden, !wide);
  assert.equal(ui.nodes['career-reader-title'].textContent, wide ? '25' : '');
  assert.equal(ui.nodes['career-records'].querySelectorAll('[aria-current]').length, wide ? 1 : 0);
  ui.rows('career')[1].fire('click');
  await ui.settle();
  assert.equal(ui.nodes['career-reader-title'].textContent, '26');
  assert.equal(ui.nodes['career-reader'].hidden, false);

  ui.nodes['career-stage-queue'].focus();
  ui.nodes['career-stage-queue'].fire('click');
  await ui.settle();
  assert.equal(ui.titles()[0], '26');
  assert.equal(ui.nodes['run-step-prefilter'].hidden, true);
  assert.equal(ui.nodes['run-step-handover'].hidden, false);
  assert.equal(ui.nodes['career-previous'].disabled, true);
  assert.equal(ui.nodes['career-next'].disabled, false);
  assert.equal(ui.nodes['career-reader'].hidden, !wide);
  assert.equal(ui.nodes['career-reader-title'].textContent, wide ? '26' : '');
  assert.equal(ui.focused(), ui.nodes['career-stage-queue']);
  assert.equal(ui.nodes['career-records'].querySelectorAll('[aria-current]').length, wide ? 1 : 0);

  // Applications shares the Jobs list + reader; the jobs-only toolbar controls hide and disable while it is active.
  ui.jobCategories.applications.fire('click');
  await ui.settle();
  assert.equal(ui.calls.at(-1).args.kind, 'applications');
  assert.equal(Object.hasOwn(ui.calls.at(-1).args, 'view'), false);
  assert.deepEqual(ui.titles(), ['Applied Role — Employer']);
  assert.equal(ui.jobCategories.applications.attributes.get('aria-pressed'), 'true');
  assert.equal(ui.jobCategories.jobs.attributes.get('aria-pressed'), 'false');
  for (const id of ['run-step-prefilter', 'run-step-handover', 'delete-rankings']) assert.equal(ui.nodes[id].hidden, true, id);
  assert.equal(ui.nodes['delete-rankings'].disabled, true);
  assert.equal(ui.nodes['career-reader'].hidden, !wide);
  assert.equal(ui.nodes['career-reader-title'].textContent, wide ? 'Applied Role — Employer' : '');
  ui.jobCategories.jobs.fire('click');
  await ui.settle();
  assert.equal(ui.calls.at(-1).args.kind, 'jobs');
  assert.equal(ui.calls.at(-1).args.view, 'shortlist');
  assert.equal(ui.titles()[0], '00');
  assert.equal(ui.nodes['run-step-handover'].hidden, true);
  assert.equal(ui.nodes['delete-rankings'].hidden, true);
  assert.equal(ui.nodes['run-step-prefilter'].hidden, false);
  assert.equal(ui.nodes['delete-rankings'].disabled, false);

  // Me browses CVs and facts with its own list and never sends a jobs view.
  assert.equal(ui.titles('me').length, 0);
  ui.categories.facts.fire('click');
  await ui.settle();
  assert.equal(ui.calls.at(-1).args.kind, 'facts');
  assert.equal(Object.hasOwn(ui.calls.at(-1).args, 'view'), false);
  assert.equal(ui.titles()[0], '00');
  ui.window.careerBrowser.clear();
  assert.equal(ui.nodes['delete-rankings'].disabled, true);
  assert.equal(ui.nodes['career-pagination'].hidden, true);
  assert.equal(ui.nodes['career-reader'].hidden, !wide);
  assert.equal(ui.nodes['career-reader-status'].textContent, wide ? 'Select a job' : '');
});

test('job cards show reviewed fit or shortlist qualification, a Review switch and facts without a cutoff', async () => {
  const { state, browser } = fixture();
  const publishedAt = currentDate();
  state.career.matching = { jobs: {
    a: { title: 'Protocol Engineer', company: 'Example Labs', publishedAt, seniority: 'Senior', commitment: 'Full Time',
      classification: 'Smart Contracts', city: 'Berlin', workMode: 'Remote', salary: { stated: 150000, currency: 'USD', period: 'year' } },
    b: { title: 'Backend Engineer', company: 'Second Co', publishedAt },
    c: { title: 'Data Engineer', company: 'Third Co', publishedAt },
    r: { title: 'Analyst', company: 'Review Co', publishedAt: '2000-01-01T00:00:00Z' },
    x: { title: 'Declined Role', company: 'Other', publishedAt: null },
  }, scores: { r: finalAssessment(92) } };
  savePrescan(state.career, [preliminary('a', publishedAt, 90), preliminary('b', publishedAt, 80), preliminary('c', publishedAt, 70),
    preliminary('x', null, null, { status: 'refused' })]);
  state.career.prescanInclusion = { scale: 2, minimumScore: 75, overrides: { b: false } };
  const ui = await rendererFixture(browser, true);
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  const lis = ui.nodes['career-records'].children;
  const [a, b, c, reviewed, x] = ui.rows('career');
  const row = button => lis.find(li => li.children[1] === button);
  const lead = button => row(button).children[0];
  const side = button => row(button).children[2];
  const checkbox = button => ui.byClass(lead(button), 'career-include');
  const captions = button => side(button).querySelectorAll('.career-card-caption').map(node => node.textContent);

  // Reviewed: fit with an empty lead. Candidates: Review switch in the lead, qualification in the side.
  assert.deepEqual(row(a).children.map(node => node.className), ['career-card-lead', 'career-record', 'career-card-side']);
  assert.deepEqual(a.children.map(node => node.className), ['career-card-mark', 'career-card-body']);
  assert.equal(lead(reviewed).children.length, 0);
  assert.equal(ui.byClass(side(reviewed), 'career-card-figure').textContent, '92');
  assert.deepEqual(captions(reviewed), ['Fit']);
  assert.equal(checkbox(reviewed), null);
  assert.equal(reviewed.attributes.get('aria-label'), 'Analyst, Review Co, fit 92 of 100, published 1 Jan 2000');
  assert.equal(ui.byClass(side(a), 'career-card-figure'), null);
  assert.equal(ui.byClass(side(b), 'career-card-figure'), null);
  assert.equal(ui.byClass(side(c), 'career-card-figure'), null);
  assert.equal(checkbox(a).type, 'checkbox');
  assert.equal(checkbox(a).checked, true);
  assert.equal(checkbox(a).attributes.get('aria-label'), 'Queue Protocol Engineer for AI review');
  assert.deepEqual(captions(a), ['Pre-qualified']);
  assert.equal(ui.byClass(lead(a), 'career-card-caption').textContent, 'Review');
  assert.equal(checkbox(b).checked, false);
  assert.deepEqual(captions(b), ['Skipped']);
  assert.equal(ui.byClass(lead(b), 'career-card-caption').textContent, 'Review · manual');
  assert.equal(checkbox(c).checked, false);
  assert.deepEqual(captions(c), ['Skipped']);
  assert.equal(ui.byClass(lead(c), 'career-card-caption').textContent, 'Review');
  assert.equal(checkbox(x).checked, false);
  assert.deepEqual(captions(x), ['Declined']);
  assert.equal(ui.byClass(lead(x), 'career-card-caption').textContent, 'Review');
  assert.equal(ui.byClass(side(x), 'career-card-reason').textContent, 'Declined');
  assert.equal(a.attributes.get('aria-label'), `Protocol Engineer, Example Labs, pre-qualified for AI review, published ${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(publishedAt))}`);
  assert.equal(x.attributes.get('aria-label'), 'Declined Role, Other, declined, skipped, publication date not stated');
  // Facts are one plain line; missing facts leave no line at all.
  assert.equal(ui.byClass(a, 'career-card-facts').textContent, 'Senior · USD 150,000 per year · Berlin · Remote · Full Time · Smart Contracts');
  assert.equal(ui.byClass(a, 'career-card-company').textContent, 'Example Labs');
  assert.equal(ui.byClass(b, 'career-card-facts'), null);
  assert.equal(ui.byClass(x, 'career-card-date').textContent, 'Publication date not stated');
  assert.equal(a.attributes.get('aria-controls'), 'career-reader');

  assert.deepEqual(lis.map(li => li.className), Array(5).fill('career-row career-card'));
  assert.equal(ui.nodes['career-list-status'].textContent, '1–5 of 5');
  assert.equal(ui.nodes['career-surface-sentence'].textContent, '1 of 4 jobs found suitable for further review.');
  assert.equal(ui.nodes['career-queue-qualified'].attributes.get('aria-pressed'), 'true');
  assert.equal(ui.nodes['career-queue-all'].attributes.get('aria-pressed'), 'false');
  assert.equal(ui.nodes['career-queue-qualified'].disabled, false);
  assert.equal(ui.nodes['career-queue-all'].disabled, false);

  // Toggling records the choice without opening the record; the switch never bubbles to the row.
  const openTitle = ui.nodes['career-reader-title'].textContent;
  const readsBefore = ui.calls.filter(call => call.operation === 'career-read').length;
  assert.equal(checkbox(c).fire('click'), false);
  checkbox(c).checked = true;
  checkbox(c).fire('change');
  await ui.settle();
  assert.deepEqual(ui.calls.at(-1), { operation: 'prescan-include', args: { id: 'c', included: true } });
  assert.equal(ui.nodes['career-reader-title'].textContent, openTitle);
  assert.equal(ui.nodes['career-records'].querySelectorAll('[aria-current]').length, 1);
  assert.equal(ui.calls.filter(call => call.operation === 'career-read').length, readsBefore);

  // The verdict owns the inclusion control and offers Reset only for manual overrides.
  b.fire('click');
  await ui.settle();
  let verdict = ui.byClass(ui.nodes['career-reader-content'], 'career-verdict');
  assert.equal(ui.byClass(verdict, 'career-verdict-headline').textContent, 'Skipped · manual');
  const reset = verdict.querySelector('button');
  assert.equal(reset.id, 'career-inclusion-reset');
  assert.equal(reset.textContent, 'Reset');
  reset.fire('click');
  await ui.settle();
  assert.deepEqual(ui.calls.at(-1), { operation: 'prescan-include', args: { id: 'b', included: null } });
  a.fire('click');
  await ui.settle();
  verdict = ui.byClass(ui.nodes['career-reader-content'], 'career-verdict');
  assert.equal(ui.byClass(verdict, 'career-verdict-headline').textContent, 'Pre-qualified for AI review');
  reviewed.fire('click');
  await ui.settle();
  verdict = ui.byClass(ui.nodes['career-reader-content'], 'career-verdict');
  assert.equal(ui.byClass(verdict, 'career-verdict-headline').textContent, 'Recommended');
  // A reviewed job's fit is a bar chart: Overall first and heavier, then the four dimensions, each fill as wide as its score.
  const chart = ui.byClass(ui.nodes['career-reader-content'], 'career-chart');
  assert.equal(chart.querySelectorAll('.career-chart-row').map(row => row.className)[0], 'career-chart-row is-overall');
  assert.deepEqual(chart.querySelectorAll('.career-chart-row').map(row => [
    ui.byClass(row, 'career-chart-label').textContent, ui.byClass(row, 'career-chart-fill').style.width, ui.byClass(row, 'career-chart-value').textContent]),
  [['Overall', '92%', '92'], ['Direction', '92%', '92'], ['Capability', '92%', '92'], ['Scope', '92%', '92'], ['Preferences', '92%', '92']]);
  assert.equal(ui.byClass(chart, 'career-chart-track').attributes.get('aria-hidden'), 'true');
  assert.equal(ui.nodes['career-reader-content'].children.some(section => section.children[0]?.textContent === 'Fit breakdown'), false);

  // Queue modes save zero for all jobs and the default qualifying score for pre-qualified jobs.
  ui.nodes['career-queue-all'].fire('click');
  await ui.settle();
  assert.deepEqual(ui.calls.at(-1), { operation: 'prescan-threshold', args: { minimumScore: 0 } });
  ui.nodes['career-queue-qualified'].fire('click');
  await ui.settle();
  assert.deepEqual(ui.calls.at(-1), { operation: 'prescan-threshold', args: { minimumScore: 36 } });

  // An inclusion edit keeps the open record and the toggled switch through the state refresh that follows.
  c.fire('click');
  await ui.settle();
  checkbox(c).checked = true;
  checkbox(c).fire('change');
  await ui.settle();
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  assert.equal(ui.nodes['career-reader-title'].textContent, 'Data Engineer');
  assert.equal(ui.focused().className, 'career-include');
  assert.equal(ui.focused().dataset.id, 'c');

  // The queue filters to included jobs and never adds a cutoff.
  ui.nodes['career-stage-queue'].fire('click');
  await ui.settle();
  assert.equal(ui.calls.findLast(call => call.operation === 'career-list').args.view, 'queue');
  assert.deepEqual(ui.titles(), ['Protocol Engineer']);
  assert.equal(ui.nodes['career-records'].children.some(li => li.className === 'career-cutoff'), false);
  ui.jobCategories.applications.fire('click');
  await ui.settle();
  assert.equal(ui.nodes['run-step-handover'].hidden, true);
  assert.equal(ui.nodes['career-queue-qualified'].disabled, true);
  assert.equal(ui.nodes['career-queue-all'].disabled, true);
});

test('requirement rows copy the exact saved requirement and report success or safe failure inline', async () => {
  const { state, browser } = fixture();
  const requirement = 'Lead secure delivery & explain <trade-offs>';
  state.career.matching = {
    jobs: { reviewed: { title: 'Platform Lead', company: 'Example Labs', publishedAt: currentDate() } },
    scores: { reviewed: finalAssessment(88, { requirements: [{ requirement, importance: 'essential', evidence: 'missing' }] }) },
  };
  let failure = false;
  const ui = await rendererFixture(browser, true, {
    'copy-requirement-prompt': async () => {
      if (failure) throw new Error('Saved assessment changed. Refresh the job.');
      return { copied: true };
    },
  });
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  const row = ui.byClass(ui.nodes['career-reader-content'], 'career-requirement');
  assert.equal(ui.byClass(row, 'career-requirement-label').textContent, 'Missing · essential');
  assert.equal(ui.byClass(row, 'career-requirement-body').textContent, requirement);
  const button = row.children[2];
  const status = ui.byClass(row, 'career-requirement-status');
  button.fire('click');
  assert.equal(button.disabled, true);
  await ui.settle();
  assert.deepEqual(ui.calls.at(-1), { operation: 'copy-requirement-prompt', args: { id: 'reviewed', requirement } });
  assert.equal(button.disabled, false);
  assert.equal(status.textContent, 'Prompt copied. Paste it into your connected agent.');
  assert.equal(status.attributes.get('role'), 'status');
  assert.equal(status.attributes.get('aria-live'), 'polite');
  failure = true;
  button.fire('click');
  await ui.settle();
  assert.equal(status.textContent, 'Saved assessment changed. Refresh the job.');
  assert.equal(ui.nodes['career-list-status'].textContent.includes('Saved assessment changed'), false);
});

test('ineligible cards show the verdict instead of a number or switch, and an established incompatibility reads as a sentence', async () => {
  const { state, browser } = fixture();
  const publishedAt = currentDate();
  state.career.matching = { jobs: {
    a: { title: 'Protocol Engineer', company: 'Example Labs', publishedAt },
    e: { title: 'Montréal Lead', company: 'Far Co', publishedAt },
    s: { title: 'Gated Role', company: 'Gate Co', publishedAt },
    p: { title: 'Waltham Role', company: 'Site Co', publishedAt },
  }, scores: {
    e: finalAssessment(74, { relocation: 'required' }),
    s: { ...finalAssessment(70, { gates: { ...passing, constraints: 'fail' } }), profileVersion: 'old' },
  } };
  state.career.profile.preferences.willingToRelocate = false;
  savePrescan(state.career, [preliminary('a', publishedAt, 90), preliminary('s', publishedAt, 95),
    preliminary('p', publishedAt, null, { status: 'incompatible_location', priority: null, location: 'conflict', dimensions: null, confidence: null })]);
  state.career.prescanInclusion = { scale: 2, minimumScore: 75, overrides: { s: true } };
  const ui = await rendererFixture(browser, true);
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  const lis = ui.nodes['career-records'].children;
  const [a, e, p, s] = ui.rows('career');
  const row = button => lis.find(li => li.children[1] === button);
  const lead = button => row(button).children[0];
  const side = button => row(button).children[2];
  const captions = button => side(button).querySelectorAll('.career-card-caption').map(node => node.textContent);
  assert.deepEqual(ui.titles(), ['Protocol Engineer', 'Montréal Lead', 'Waltham Role', 'Gated Role']);
  // Predicted conflict: unranked, switch kept, reason captioned.
  assert.equal(ui.byClass(lead(p), 'career-include').checked, false);
  assert.deepEqual(captions(p), ['Location conflict predicted']);
  assert.equal(ui.byClass(lead(p), 'career-card-caption').textContent, 'Review');
  assert.equal(ui.byClass(side(p), 'career-card-reason').textContent, 'Location conflict predicted');
  assert.equal(p.attributes.get('aria-label').includes('location conflict predicted, skipped'), true);
  // Current ineligible review and established stale review: the label only; no number, no switch, no "manual".
  for (const [button, label] of [[e, 'Location incompatible'], [s, 'Excluded by a gate']]) {
    assert.equal(ui.byClass(side(button), 'career-card-figure'), null);
    assert.equal(ui.byClass(lead(button), 'career-include'), null);
    assert.equal(lead(button).children.length, 0);
    assert.deepEqual(captions(button), [label]);
    assert.equal(ui.byClass(side(button), 'career-card-verdict').textContent, label);
  }
  assert.equal(JSON.stringify(side(e)).includes('74'), false);
  assert.equal(e.attributes.get('aria-label').startsWith('Montréal Lead, Far Co, not eligible, Location incompatible, published'), true);
  assert.equal(s.attributes.get('aria-label').startsWith('Gated Role, Gate Co, not eligible, Excluded by a gate, published'), true);
  assert.equal(ui.nodes['career-surface-sentence'].textContent, '1 of 3 jobs found suitable for further review.');
  // The reader verdict explains both current and established ineligibility; neither has an inclusion control.
  e.fire('click');
  await ui.settle();
  let verdict = ui.byClass(ui.nodes['career-reader-content'], 'career-verdict');
  assert.equal(ui.byClass(verdict, 'career-verdict-headline').textContent, 'Location incompatible');
  assert.equal(ui.byClass(verdict, 'career-verdict-switch'), null);
  s.fire('click');
  await ui.settle();
  verdict = ui.byClass(ui.nodes['career-reader-content'], 'career-verdict');
  assert.equal(ui.byClass(verdict, 'career-verdict-headline').textContent, 'Excluded by a gate');
  assert.equal(ui.byClass(verdict, 'career-verdict-switch'), null);
});

test('queue modes restore saved selection, skip unchanged saves and show exact current and stale shortlist counts', async () => {
  const { state, browser } = fixture();
  const publishedAt = currentDate();
  const rows = Array.from({ length: 1000 }, (_, index) => preliminary(`job-${index}`, publishedAt, 80));
  state.career.matching = { jobs: Object.fromEntries(rows.map(row => [row.id, { ...row }])), scores: {} };
  savePrescan(state.career, rows);
  const ui = await rendererFixture(browser, true, {
    'prescan-threshold': ({ minimumScore }) => {
      state.career.prescanInclusion = { scale: 2, minimumScore, overrides: {} };
    },
  });
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  assert.equal(ui.nodes['career-surface-sentence'].textContent, '1000 of 1000 jobs found suitable for further review.');
  assert.deepEqual(['shortlist', 'queue', 'reviewed'].map(view => ui.nodes[`career-stage-${view}`].querySelector('.stage-count').textContent),
    [' 1,000', ' 1,000', ' 0']);
  assert.equal(ui.nodes['career-category-applications'].querySelector('.stage-count').textContent, ' 0');
  assert.equal(ui.nodes['career-category-blocks'].querySelector('.stage-count').textContent, ' 0');
  assert.equal(ui.nodes['career-list-status'].textContent, '1–25 of 1,000');
  ui.nodes['career-queue-all'].fire('click');
  await ui.settle();
  assert.deepEqual(ui.calls.at(-1), { operation: 'prescan-threshold', args: { minimumScore: 0 } });
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  assert.equal(ui.nodes['career-queue-qualified'].attributes.get('aria-pressed'), 'false');
  assert.equal(ui.nodes['career-queue-all'].attributes.get('aria-pressed'), 'true');
  assert.equal(ui.nodes['career-surface-sentence'].textContent, 'All 1000 jobs go on for review.');
  const callsBefore = ui.calls.length;
  ui.nodes['career-queue-all'].fire('click');
  assert.equal(ui.calls.length, callsBefore);
  state.career.prescan.profileVersion = '1:0';
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  assert.equal(ui.nodes['career-surface-sentence'].textContent, 'All 1000 jobs go on for review. Scored before your profile changed; shortlist again.');
  assert.equal(ui.byClass(ui.nodes['career-records'].children[0], 'career-card-reason').textContent,
    'Pre-qualified · out of date');
  ui.nodes['career-queue-qualified'].fire('click');
  await ui.settle();
  assert.deepEqual(ui.calls.at(-1), { operation: 'prescan-threshold', args: { minimumScore: 36 } });
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  assert.equal(ui.nodes['career-queue-qualified'].attributes.get('aria-pressed'), 'true');
  assert.equal(ui.nodes['career-queue-all'].attributes.get('aria-pressed'), 'false');
  assert.equal(ui.nodes['career-surface-sentence'].textContent, '1000 of 1000 jobs found suitable for further review. Scored before your profile changed; shortlist again.');
});

test('without a shortlist all jobs go on for review and a failed queue-mode save restores the saved selection', async () => {
  const { state, browser } = fixture();
  const publishedAt = currentDate();
  state.career.matching = { jobs: { a: { title: 'One', company: 'Co', publishedAt }, b: { title: 'Two', company: 'Co', publishedAt } }, scores: {} };
  const ui = await rendererFixture(browser, true);
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  assert.equal(ui.nodes['career-surface-sentence'].textContent, 'No shortlist yet: all 2 jobs go on for review.');
  assert.equal(ui.nodes['career-list-status'].textContent, '1–2 of 2');
  assert.equal(ui.nodes['career-queue-qualified'].attributes.get('aria-pressed'), 'true');
  assert.equal(ui.nodes['career-queue-all'].attributes.get('aria-pressed'), 'false');
  assert.equal(ui.nodes['career-records'].children.some(li => li.className === 'career-cutoff'), false);
  ui.window.companion.invoke = async () => ({ ok: false, error: { message: 'Storage is locked.' } });
  ui.nodes['career-queue-all'].fire('click');
  await ui.settle();
  assert.equal(ui.nodes['career-queue-qualified'].attributes.get('aria-pressed'), 'true');
  assert.equal(ui.nodes['career-queue-all'].attributes.get('aria-pressed'), 'false');
  assert.equal(ui.nodes['career-list-status'].textContent, 'Could not change which jobs go on for review. Storage is locked.');
  ui.window.careerBrowser.clear();
  assert.equal(ui.nodes['career-surface-sentence'].textContent, '');
  assert.equal(ui.nodes['career-queue-qualified'].disabled, true);
  assert.equal(ui.nodes['career-queue-all'].disabled, true);
});

test('each Jobs stage has its own empty state, active button and controls', async () => {
  const { browser } = fixture();
  const ui = await rendererFixture(browser, false);
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  for (const [view, empty] of [
    ['shortlist', 'No jobs in this publication window yet. Widen the window or start the shortlist.'],
    ['queue', 'Nothing pre-qualified yet. Run the shortlist, or choose All jobs.'],
    ['reviewed', 'Nothing reviewed yet. Continue in Codex or Claude to review the pre-qualified jobs.'],
  ]) {
    ui.nodes[`career-stage-${view}`].fire('click');
    await ui.settle();
    assert.equal(ui.nodes['career-list-status'].textContent, empty);
    assert.equal(ui.nodes['run-step-prefilter'].hidden, view !== 'shortlist');
    assert.equal(ui.nodes['run-step-handover'].hidden, view !== 'queue');
    assert.equal(ui.nodes['delete-rankings'].hidden, view !== 'reviewed');
    assert.equal(ui.nodes['delete-rankings'].disabled, false);
    for (const candidate of ['shortlist', 'queue', 'reviewed'])
      assert.equal(ui.nodes[`career-stage-${candidate}`].attributes.get('aria-pressed'), String(candidate === view));
  }
  for (const kind of ['applications', 'blocks']) {
    ui.jobCategories[kind].fire('click');
    await ui.settle();
    assert.equal(ui.nodes['run-step-prefilter'].hidden, true);
    assert.equal(ui.nodes['run-step-handover'].hidden, true);
    assert.equal(ui.nodes['delete-rankings'].hidden, true);
    assert.equal(ui.nodes['delete-rankings'].disabled, true);
  }
});

test('the Jobs list column keeps Previous/Next on its own last grid row regardless of window height', async () => {
  const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../ui/settings.css', import.meta.url), 'utf8');
  const list = html.match(/<section class="career-list panel" aria-label="Saved jobs">([\s\S]*?)<\/section>/)[1];
  const ids = [...list.matchAll(/ id="([\w-]+)"/g)].map(match => match[1]);
  const order = ['career-list-status', 'career-list-retry', 'career-records', 'career-pagination', 'career-next'];
  assert.deepEqual(ids.filter(id => order.includes(id)), order);
  assert.match(list.trim(), /<nav id="career-pagination"[\s\S]*<\/nav>$/);
  // Queue controls belong to the queue stage panel, above the list.
  const rail = html.match(/<section id="stage-panels"[\s\S]*?<\/section>/)[0];
  assert.match(rail, /<div id="run-step-handover" class="stage-panel" data-stage-panel="queue" hidden>[\s\S]*<div id="career-surface" class="career-surface stage-block">/);
  assert.match(rail, /<div class="career-categories" role="group" aria-label="Jobs that go on for review">/);
  assert.match(rail, /<button id="career-queue-qualified" type="button" class="ghost" aria-pressed="true" disabled>Pre-qualified only<\/button>/);
  assert.match(rail, /<button id="career-queue-all" type="button" class="ghost" aria-pressed="false" disabled>All jobs<\/button>/);
  assert.match(rail, /<div id="run-step-prefilter" class="stage-panel" data-stage-panel="shortlist">\s*<div id="run-step-key" class="stage-block" hidden>/);
  assert.match(list, /<div class="career-list-tools">\s*<p id="career-list-status"/);
  for (const obsolete of ['id="run-rail"', 'class="run-steps"', 'class="run-step-number"', 'aria-current="step"', 'id="career-sort"', 'id="career-sort-control"', 'id="career-category-ranked"'])
    assert.equal(html.includes(obsolete), false, obsolete);
  for (const view of ['shortlist', 'queue', 'reviewed'])
    assert.match(html, new RegExp(`<button id="career-stage-${view}"[^>]*data-career-kind="jobs" data-career-view="${view}"[^>]*>[^<]*<span class="stage-count" data-stage-count="${view}"></span></button>`));
  assert.equal(html.includes('career-minimum-score'), false);
  assert.equal(html.includes('id="review-help"'), false);
  assert.match(css, /^#career-browser \{ grid-template-rows: auto auto minmax\(0, 1fr\); \}$/m);
  // Four explicit rows, each child pinned to one, so hidden children never let the records take the `auto` row.
  assert.match(css, /^\.career-list \{[^}]*grid-template-rows: auto auto minmax\(0, 1fr\) auto;[^}]*overflow: hidden; \}$/m);
  for (const [selector, row] of [['.career-list .panel-head', 2], ['.career-list > .ghost', 3], ['.career-records', 3], ['.career-list .pagination', 4]])
    assert.match(css, new RegExp(`^${selector.replaceAll('.', '\\.')} \\{ grid-row: ${row};`, 'm'), selector);
  assert.match(css, /^\.career-records \{[^}]*overflow: auto;/m);
  assert.match(css, /^\.career-card-side \{[^}]*width: 112px;/m);
  assert.match(css, /\.career-card-side \{ width: 96px; padding: var\(--spacing-16\) var\(--spacing-16\) var\(--spacing-16\) 0; \}/);
  assert.equal(html.includes('career-cutoff-control'), false);
});

test('blocking from the reader hides matching jobs; Blocked lists each block and Unblock restores its jobs', async () => {
  const { state, browser } = fixture();
  const publishedAt = currentDate();
  state.career.matching = { jobs: {
    a: { id: 'a', title: 'Protocol Engineer', company: 'Example Labs', publishedAt, classification: 'smart contracts' },
    b: { id: 'b', title: 'Backend Engineer', company: 'EXAMPLE  labs', publishedAt },
    c: { id: 'c', title: 'Auditor', company: 'Third Co', publishedAt, classification: 'Smart Contracts' },
    d: { id: 'd', title: 'Data Engineer', company: 'Fourth Co', publishedAt },
  }, scores: {} };
  const ui = await rendererFixture(browser, true, {
    'job-block': input => addBlock(state.career, input),
    'job-unblock': input => { removeBlock(state.career, input.id); },
  });
  // Each change is followed by the state broadcast that refreshes the list.
  const act = async control => { control.fire('click'); await ui.settle(); await ui.window.careerBrowser.refresh(); await ui.settle(); };
  const blockButtons = () => ui.byClass(ui.nodes['career-reader-content'], 'career-block').querySelectorAll('button');
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  assert.equal(ui.nodes['career-reader-title'].textContent, 'Protocol Engineer');
  assert.deepEqual(blockButtons().map(button => button.textContent), ['Block job', 'Block Example Labs', 'Block smart contracts']);
  assert.deepEqual(blockButtons().map(button => button.attributes.get('aria-label')),
    ['Block Protocol Engineer', 'Block all Example Labs jobs', 'Block all smart contracts jobs']);
  await act(blockButtons()[1]);
  assert.deepEqual(ui.calls.find(call => call.operation === 'job-block'), { operation: 'job-block', args: { id: 'a', kind: 'company' } });
  assert.deepEqual(ui.titles(), ['Auditor', 'Data Engineer']);
  assert.match(ui.nodes['career-list-status'].textContent, /^Blocked Example Labs · 1–2 of 2/);
  assert.equal(ui.focused(), ui.rows('career')[0]);
  // A job without a category offers only the job and company blocks.
  ui.rows('career')[1].fire('click');
  await ui.settle();
  assert.deepEqual(blockButtons().map(button => button.textContent), ['Block job', 'Block Fourth Co']);
  ui.rows('career')[0].fire('click');
  await ui.settle();
  await act(blockButtons()[2]);
  assert.deepEqual(ui.titles(), ['Data Engineer']);
  await assert.rejects(browser.read({ kind: 'jobs', id: 'c' }), { code: 'NOT_FOUND' });

  // Blocked lists one row per block, with what it blocks and how many saved jobs it currently hides.
  ui.jobCategories.blocks.fire('click');
  await ui.settle();
  assert.deepEqual(ui.calls.at(-2).args, { kind: 'blocks', offset: 0, limit: 25 });
  assert.equal(ui.nodes['run-step-handover'].hidden, true);
  const summaries = () => ui.rows('career').map(button => ui.byClass(button, 'career-record-summary').textContent);
  assert.deepEqual(ui.titles().sort(), ['Example Labs', 'Smart Contracts']);
  assert.deepEqual(summaries().sort(), ['Category · 1 saved job', 'Company · 2 saved jobs']);
  const companyRow = ui.nodes['career-records'].children.find(row => ui.byClass(row, 'career-record-title').textContent === 'Example Labs');
  companyRow.children[0].fire('click');
  await ui.settle();
  assert.deepEqual(sectionFields(await browser.read({ kind: 'blocks', id: 'company:example labs' }), 'Block').slice(0, 2),
    [{ label: 'Type', value: 'Company' }, { label: 'Saved jobs blocked', value: '2 jobs' }]);
  assert.equal(ui.byClass(ui.nodes['career-reader-content'], 'career-block').querySelector('button').textContent, 'Unblock');
  const remove = ui.byClass(companyRow, 'career-row-action');
  assert.equal(remove.textContent, 'Unblock');
  await act(remove);
  assert.deepEqual(ui.calls.find(call => call.operation === 'job-unblock'), { operation: 'job-unblock', args: { id: 'company:example labs' } });
  assert.deepEqual(ui.titles(), ['Smart Contracts']);
  assert.match(ui.nodes['career-list-status'].textContent, /^Unblocked Example Labs · 1–1 of 1/);
  // Protocol Engineer is still in the blocked category; Backend Engineer returns.
  ui.jobCategories.jobs.fire('click');
  await ui.settle();
  assert.deepEqual(ui.titles(), ['Backend Engineer', 'Data Engineer']);
  await act(ui.byClass(ui.nodes['career-reader-content'], 'career-block').querySelectorAll('button')[0]);
  assert.deepEqual(ui.titles(), ['Data Engineer']);
  ui.jobCategories.blocks.fire('click');
  await ui.settle();
  assert.deepEqual(ui.titles().sort(), ['Backend Engineer — EXAMPLE  labs', 'Smart Contracts']);
});
