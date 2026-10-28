import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createCareerState } from '../src/mcp/state.mjs';
import { createCareerBrowser, openJobPage, requirementContextPrompt } from '../src/career-browser.mjs';
import { addBlock, removeBlock } from '../src/mcp/blocklist.mjs';
import { ASSESSMENT_POLICY_ID, deriveDecision } from '../src/mcp/matching-contract.mjs';
import { createMatchingTools } from '../src/mcp/matching-tools.mjs';

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
// Catalogue display metadata as `career_match_jobs` stores it under `career.matching.jobs`.
const catalogueJob = (id, publishedAt, extra = {}) => ({ id, title: id, company: 'Company', publishedAt, ...extra });
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
    counts: { jobs: 0, reviewed: 0, applications: 0, blocks: 0 }, inclusion: { included: 0, candidates: 0 } });
  await assert.rejects(browser.read({ kind: 'jobs', id: 'missing' }), { code: 'NOT_FOUND' });
});

test('Jobs views are strictly validated and obsolete sorts are rejected', async () => {
  const { browser } = fixture();
  for (const view of [null, undefined, '', 'newest', 'Score', 'rank', 'shortlist', 'queue', 0, {}, ['jobs']])
    await assert.rejects(browser.list({ kind: 'jobs', view }), { code: 'INVALID_INPUT' });
  for (const kind of ['sources', 'facts', 'preferences', 'career', 'applications', 'blocks'])
    await assert.rejects(browser.list({ kind, view: 'jobs' }), {
      code: 'INVALID_INPUT', message: 'Use view jobs or reviewed for Jobs only.' });
  for (const sort of [null, undefined, '', 'score', 'recent'])
    await assert.rejects(browser.list({ kind: 'jobs', sort }), { code: 'INVALID_INPUT' });
  for (const view of ['jobs', 'reviewed'])
    assert.deepEqual(await browser.list({ kind: 'jobs', view }), { items: [], total: 0, nextOffset: null,
      counts: { jobs: 0, reviewed: 0, applications: 0, blocks: 0 }, inclusion: { included: 0, candidates: 0 } });
  await assert.rejects(browser.read({ kind: 'jobs', id: 'missing', view: 'jobs' }), { code: 'INVALID_INPUT' });
});

test('Jobs views paginate publication order and reviewed jobs independently', async () => {
  const { state, browser } = fixture();
  const rows = [
    catalogueJob('high-conflict', '2026-10-10T12:00:00Z'),
    catalogueJob('low-aligned', '2026-10-11T12:00:00Z'),
    catalogueJob('zero', '2026-10-12T12:00:00Z'),
    catalogueJob('refused', '2026-10-13T12:00:00Z'),
    catalogueJob('invalid-score', '2026-10-09T12:00:00Z'),
    catalogueJob('unknown-b', null),
    catalogueJob('unknown-a', 'not a date'),
  ];
  state.career.matching = {
    jobs: { ...Object.fromEntries(rows.map(row => [row.id, row])),
      'final-fit-99': { title: 'Reviewed', publishedAt: '2026-10-14T12:00:00Z' },
      'catalogue-only': { title: 'Saved unscored', publishedAt: '2026-10-11T13:00:00+01:00' } },
    scores: { 'final-fit-99': finalAssessment(99) },
  };
  state.career.jobs = {};
  state.career.jobs.capture = { title: 'Captured', publishedAt: '2026-10-15T12:00:00Z', complete: true,
    description: 'The original captured advert.', updatedAt: '2000-01-01T00:00:00Z' };
  const expectedRecent = ['capture', 'final-fit-99', 'refused', 'zero', 'catalogue-only', 'low-aligned',
    'high-conflict', 'invalid-score', 'unknown-a', 'unknown-b'];
  for (const [view, expected] of [['jobs', expectedRecent], ['reviewed', ['final-fit-99']]]) {
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
  assert.equal((await browser.read({ kind: 'jobs', id: 'catalogue-only' })).title, 'Saved unscored');
  // An open job without an earlier review has no verdict at all.
  assert.equal((await browser.read({ kind: 'jobs', id: 'catalogue-only' })).verdict, null);
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
  assert.deepEqual(item('leader').card, { ...item('leader').card, stage: 'reviewed', label: null, established: false, score: 70, stale: false });
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
  for (const row of [catalogueJob('pre-low', publishedAt), catalogueJob('pre-high', publishedAt)]) career.matching.jobs[row.id] = { ...row };
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
    counts: { jobs: 108, reviewed: 105, applications: 0, blocks: 0 }, inclusion: { included: 2, candidates: 2 } });
  const merged = items.find(item => item.id === 'reviewed-0');
  assert.deepEqual(merged.card, { ...merged.card, stage: 'reviewed', score: 1, stale: false });
  assert.deepEqual({ ...merged.verdict, reason: null }, { kind: 'reviewed', number: 1, numberLabel: 'Fit', headline: 'Not recommended',
    detail: 'Poor fit · Reviewed 14 Oct 2026', reason: null });
  assert.equal(merged.sections.some(section => ['Metadata', 'Shortlist'].includes(section.heading)), false);
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
  assert.deepEqual([stale.card.score, stale.card.stale, stale.card.stage], [99, true, 'open']);
  assert.equal(stale.verdict.reason.includes('Reviewed at 99 before your profile changed'), true);
  assert.equal(page.items.find(item => item.id === 'legacy').verdict.reason.includes('Reviewed at'), true);
  assert.equal(page.items.find(item => item.id === 'invalid').verdict.headline, 'Not reviewed yet');
  const excluded = page.items.find(item => item.id === 'excluded');
  assert.equal(excluded.verdict.headline, 'Excluded by a gate');
  assert.equal(fieldValue(excluded, 'Checks', 'Mandatory conditions'), 'Fails');
  assert.deepEqual(excluded.card, { ...excluded.card, stage: 'ineligible', label: 'Excluded by a gate', established: false, score: 85 });
  assert.equal(excluded.sections.find(section => section.chart).heading, 'Fit — excluded by a gate');
  const unavailable = page.items.find(item => item.id === 'unavailable');
  assert.equal(unavailable.verdict.number, null);
  assert.deepEqual(unavailable.card, { ...unavailable.card, stage: 'reviewed', score: null, stale: false });
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

test('each jobs operation uses one local snapshot for metadata and reviews', async () => {
  const { state, store, browser } = fixture();
  const publishedAt = currentDate();
  const row = catalogueJob('saved', publishedAt);
  state.career.matching = { jobs: { saved: { ...row }, other: catalogueJob('other', publishedAt) }, scores: { saved: finalAssessment() } };
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
  assert.deepEqual(detail, readerOf(page.items.find(item => item.id === row.id)));
  assert.equal(JSON.stringify(detail).includes('PRIVATE_KEY_SENTINEL'), false);
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
  const page = await browser.list({ kind: 'jobs' });
  const card = id => page.items.find(item => item.id === id).card;
  assert.deepEqual(card('full'), { title: 'Protocol Engineer', company: 'Example Labs', logoUrl: null, publishedAt,
    facts: ['Senior', 'USD 120,000–160,000 per year', 'Berlin · Remote', 'Full Time', 'Smart Contracts'],
    stage: 'reviewed', label: null, established: false, score: 92, stale: false });
  assert.deepEqual(card('sparse'), { title: 'Analyst', company: 'Sparse Co', logoUrl: null, publishedAt: null,
    facts: ['EUR 90,000 per year', 'Lisbon'],
    stage: 'open', label: null, established: false, score: null, stale: false });
  assert.deepEqual(card('bare'), { title: 'Bare', company: null, logoUrl: null, publishedAt: null, facts: [],
    stage: 'open', label: null, established: false, score: null, stale: false });
  assert.deepEqual(page.inclusion, { included: 2, candidates: 2 });
  assert.equal(page.items.some(item => 'summary' in item), false);
});

test('Jobs views separate publication order from current reviews; stale reviews are open with their earlier fit as context', async () => {
  const { state, browser } = fixture();
  const publishedAt = currentDate();
  const rows = [catalogueJob('weak-review', publishedAt), catalogueJob('never-reviewed', publishedAt),
    catalogueJob('stale-review', publishedAt), catalogueJob('stale-both', '2000-01-01T00:00:00Z'), catalogueJob('old-open', '2000-01-01T00:00:00Z')];
  state.career.matching = { jobs: Object.fromEntries(rows.map(row => [row.id, { ...row }])), scores: {
    'weak-review': finalAssessment(40),
    'stale-review': { ...finalAssessment(88), profileVersion: 'old' },
    'stale-both': { ...finalAssessment(30), profileVersion: 'old' },
    'review-only': finalAssessment(35),
  } };
  state.career.matching.jobs['review-only'] = { title: 'Review only', publishedAt };
  const page = await browser.list({ kind: 'jobs', view: 'jobs' });
  assert.deepEqual(page.items.map(item => item.id),
    ['never-reviewed', 'review-only', 'stale-review', 'weak-review', 'old-open', 'stale-both']);
  assert.deepEqual(page.inclusion, { included: 4, candidates: 4 });
  assert.deepEqual(page.counts, { jobs: 6, reviewed: 2, applications: 0, blocks: 0 });
  assert.equal(Object.hasOwn(page, 'cutoffIndex'), false);
  const stage = id => { const { stage, score, stale } = page.items.find(item => item.id === id).card; return { stage, score, stale }; };
  assert.deepEqual(stage('weak-review'), { stage: 'reviewed', score: 40, stale: false });
  assert.deepEqual(stage('review-only'), { stage: 'reviewed', score: 35, stale: false });
  assert.deepEqual(stage('never-reviewed'), { stage: 'open', score: null, stale: false });
  assert.deepEqual(stage('stale-review'), { stage: 'open', score: 88, stale: true });
  assert.deepEqual(stage('stale-both'), { stage: 'open', score: 30, stale: true });
  assert.deepEqual(stage('old-open'), { stage: 'open', score: null, stale: false });
  const verdict = id => page.items.find(item => item.id === id).verdict;
  assert.equal(verdict('weak-review').kind, 'reviewed');
  assert.deepEqual(verdict('stale-review'), { kind: 'open', number: null, numberLabel: null, headline: 'Not reviewed yet', detail: null,
    reason: 'Reviewed at 88 before your profile changed · Saved full-advert review.' });
  assert.equal(verdict('stale-both').kind, 'open');
  assert.equal(verdict('never-reviewed'), null);
  assert.equal(verdict('old-open'), null);
  for (const item of page.items) assert.equal('reviewed' in item.card, false);
  assert.deepEqual((await browser.list({ kind: 'jobs', view: 'reviewed' })).items.map(item => item.id),
    ['weak-review', 'review-only']);
});

test('ineligible reviews sort last with a label instead of a number; established incompatibility is never a candidate', async () => {
  const { state, browser } = fixture();
  const publishedAt = currentDate();
  const rows = [catalogueJob('ranked', publishedAt), catalogueJob('stale-gate', publishedAt), catalogueJob('stale-relocation', publishedAt)];
  state.career.matching = { jobs: { ...Object.fromEntries(rows.map(row => [row.id, { ...row }])),
    excluded: { title: 'excluded', company: 'Company', publishedAt }, relocation: { title: 'relocation', company: 'Company', publishedAt } }, scores: {
    excluded: finalAssessment(85, { gates: { ...passing, constraints: 'fail' } }),
    relocation: finalAssessment(80, { relocation: 'required' }),
    'stale-gate': { ...finalAssessment(70, { gates: { ...passing, eligibility: 'fail' } }), profileVersion: 'old' },
    'stale-relocation': { ...finalAssessment(65, { relocation: 'required' }), profileVersion: 'old' },
  } };
  state.career.profile.preferences.willingToRelocate = false;
  const page = await browser.list({ kind: 'jobs' });
  assert.deepEqual(page.items.map(item => item.id), ['excluded', 'ranked', 'relocation', 'stale-gate', 'stale-relocation']);
  const card = id => page.items.find(item => item.id === id).card;
  // Current ineligible reviews: the verdict is the card; the number lives only in the reader's qualified chart.
  assert.deepEqual(card('excluded'), { ...card('excluded'), stage: 'ineligible', label: 'Excluded by a gate', established: false, score: 85, stale: false });
  assert.deepEqual(card('relocation'), { ...card('relocation'), stage: 'ineligible', label: 'Location incompatible', established: false, score: 80, stale: false });
  // Established incompatibility from a stale review: never a candidate, label from the saved verdict.
  assert.deepEqual(card('stale-gate'), { ...card('stale-gate'), stage: 'ineligible', label: 'Excluded by a gate', established: true, score: 70, stale: true });
  assert.deepEqual(card('stale-relocation'), { ...card('stale-relocation'), stage: 'ineligible', label: 'Location incompatible', established: true, score: 65, stale: true });
  assert.equal(page.items.find(item => item.id === 'stale-gate').sections.find(section => section.chart).heading, 'Fit — excluded by a gate');
  for (const id of ['excluded', 'relocation', 'stale-gate', 'stale-relocation']) {
    const item = page.items.find(item => item.id === id);
    assert.deepEqual(item.verdict, { kind: 'ineligible', number: null, numberLabel: null, headline: item.card.label, detail: null, reason: null });
    assert.equal(fieldValue(item, 'Checks', 'Location'), undefined);
    assert.equal(fieldValue(item, 'Checks', 'Relocation'), undefined);
  }
  assert.deepEqual(card('ranked'), { ...card('ranked'), stage: 'open', label: null, established: false, score: null, stale: false });
  assert.equal(page.items.find(item => item.id === 'ranked').verdict, null);
  assert.deepEqual(page.inclusion, { included: 1, candidates: 3 });
  assert.deepEqual(page.counts, { jobs: 5, reviewed: 4, applications: 0, blocks: 0 });
  assert.deepEqual((await browser.list({ kind: 'jobs', view: 'reviewed' })).items.map(item => item.id),
    ['excluded', 'relocation', 'stale-gate', 'stale-relocation']);
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
      this.id = '';
      this.children = [];
      this.attributes = new Map();
      this.listeners = new Map();
      const classes = new Set();
      this.classList = {
        add: (...names) => { names.forEach(name => classes.add(name)); },
        remove: (...names) => { names.forEach(name => classes.delete(name)); },
        toggle: (name, force) => { (force ?? !classes.has(name)) ? classes.add(name) : classes.delete(name); },
      };
      Object.defineProperty(this, 'className', {
        get: () => [...classes].join(' '),
        set: value => { classes.clear(); String(value).split(' ').filter(Boolean).forEach(name => classes.add(name)); },
      });
      this.hidden = false;
      this.disabled = false;
      this.isConnected = true;
      this.textContent = '';
      this.value = '';
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
      const matches = child => selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1))
        : selector.startsWith('#') ? child.id === selector.slice(1)
          : selector.startsWith('[') ? child.attributes.has(selector.slice(1, -1)) : child.tagName === selector.toUpperCase();
      return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    fire(name, event = {}) {
      let propagated = true;
      const payload = { target: this, stopPropagation() { propagated = false; }, preventDefault() {}, ...event };
      this[`on${name}`]?.(payload);
      this.listeners.get(name)?.(payload);
      return propagated;
    }
  }
  const names = ['records', 'list-status', 'list-retry', 'pagination', 'previous', 'next', 'reader', 'reader-title',
    'reader-status', 'reader-retry', 'reader-content', 'close'];
  const ids = [...names.flatMap(name => [`career-${name}`, `me-${name}`]), 'career-browser', 'me-browser', 'delete-rankings',
    'stage-jobs', 'publication-range', 'publication-range-label', 'review-launch', 'review-codex', 'review-claude', 'copy-review-prompt'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Node()]));
  for (const id of ids) nodes[id].id = id;
  nodes['stage-jobs'].dataset.stagePanel = 'jobs';
  nodes['publication-range'].value = '2';
  nodes['publication-range'].disabled = true;
  nodes['publication-range-label'].textContent = 'in the past 3 days';
  for (const id of ['review-codex', 'review-claude', 'copy-review-prompt']) { nodes[id].className = 'ghost'; nodes['review-launch'].append(nodes[id]); }
  nodes['review-codex'].hidden = true; nodes['review-claude'].hidden = true;
  const category = kind => {
    const node = new Node('button');
    node.dataset.careerKind = kind;
    return [kind, node];
  };
  const categories = Object.fromEntries(['sources', 'facts', 'preferences'].map(category));
  const jobCategories = Object.fromEntries(['jobs', 'applications', 'blocks'].map(category));
  const stageCounts = [];
  // The Jobs tab list: two jobs views, then applications and blocks; each tab carries its own count.
  for (const view of ['jobs', 'reviewed']) {
    const button = view === 'jobs' ? jobCategories.jobs : category('jobs')[1];
    button.dataset.careerView = view;
    button.setAttribute('aria-selected', String(view === 'jobs'));
    nodes[`career-stage-${view}`] = button;
    if (view !== 'jobs') jobCategories[view] = button;
  }
  for (const name of ['applications', 'blocks']) {
    jobCategories[name].setAttribute('aria-selected', 'false');
    nodes[`career-category-${name}`] = jobCategories[name];
  }
  for (const name of ['jobs', 'reviewed', 'applications', 'blocks']) {
    const count = new Node('span'); count.className = 'stage-count'; count.dataset.stageCount = name;
    (nodes[`career-stage-${name}`] ?? jobCategories[name]).append(count);
    stageCounts.push(count);
  }
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
    querySelectorAll: () => [nodes['stage-jobs']], get activeElement() { return focused; } };
  runInNewContext(await readFile(new URL('../ui/career-browser.js', import.meta.url), 'utf8'), { window, document });
  const byClass = (node, className) => node.className.split(' ').includes(className) ? node
    : node.children.map(child => byClass(child, className)).find(Boolean) ?? null;
  const rows = prefix => nodes[`${prefix}-records`].children.map(row => byClass(row, 'career-record'));
  return { window, nodes, categories, jobCategories, calls, rows, byClass, focused: () => focused,
    stageCount: name => stageCounts.find(count => count.dataset.stageCount === name),
    settle: () => new Promise(resolve => setImmediate(resolve)),
    titles: (prefix = 'career') => rows(prefix).map(button => byClass(button, 'career-record-title').textContent) };
}

for (const wide of [false, true]) test(`Jobs paging and stage changes keep the reader column and pagination stable in ${wide ? 'wide' : 'narrow'} mode`, async () => {
  const { state, browser } = fixture();
  const rows = Array.from({ length: 27 }, (_, index) => catalogueJob(String(index).padStart(2, '0'),
    new Date(Date.now() - (index + 1) * 60000).toISOString()));
  state.career.matching = { jobs: Object.fromEntries(rows.map(row => [row.id, row])), scores: { 26: finalAssessment(50) } };
  state.career.applications.app = { id: 'app', job: { title: 'Applied Role', company: 'Employer' } };
  const ui = await rendererFixture(browser, wide);
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  assert.equal(ui.titles()[0], '00');
  assert.equal(ui.nodes['stage-jobs'].hidden, false);
  assert.equal(ui.nodes['review-launch'].hidden, false);
  assert.equal(ui.nodes['delete-rankings'].hidden, true);
  assert.equal(ui.nodes['publication-range'].disabled, false);
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

  ui.nodes['career-stage-reviewed'].focus();
  ui.nodes['career-stage-reviewed'].fire('click');
  await ui.settle();
  assert.equal(ui.calls.at(-1).args.view, 'reviewed');
  assert.deepEqual(ui.titles(), ['26']);
  assert.equal(ui.nodes['stage-jobs'].hidden, true);
  assert.equal(ui.nodes['review-launch'].hidden, false);
  assert.equal(ui.nodes['delete-rankings'].hidden, false);
  assert.equal(ui.nodes['delete-rankings'].disabled, false);
  assert.equal(ui.nodes['career-previous'].disabled, true);
  assert.equal(ui.nodes['career-next'].disabled, true);
  assert.equal(ui.nodes['career-pagination'].hidden, true);
  assert.equal(ui.nodes['career-reader'].hidden, !wide);
  assert.equal(ui.nodes['career-reader-title'].textContent, wide ? '26' : '');
  assert.equal(ui.focused(), ui.nodes['career-stage-reviewed']);
  assert.equal(ui.nodes['career-records'].querySelectorAll('[aria-current]').length, wide ? 1 : 0);

  // Applications shares the Jobs list + reader; the jobs-only toolbar controls hide and disable while it is active.
  ui.jobCategories.applications.fire('click');
  await ui.settle();
  assert.equal(ui.calls.at(-1).args.kind, 'applications');
  assert.equal(Object.hasOwn(ui.calls.at(-1).args, 'view'), false);
  assert.deepEqual(ui.titles(), ['Applied Role — Employer']);
  assert.equal(ui.jobCategories.applications.attributes.get('aria-selected'), 'true');
  assert.equal(ui.jobCategories.jobs.attributes.get('aria-selected'), 'false');
  assert.equal(ui.nodes['career-stage-reviewed'].attributes.get('aria-selected'), 'false');
  for (const id of ['stage-jobs', 'review-launch', 'delete-rankings']) assert.equal(ui.nodes[id].hidden, true, id);
  assert.equal(ui.nodes['delete-rankings'].disabled, true);
  assert.equal(ui.nodes['publication-range'].disabled, true);
  assert.equal(ui.nodes['career-reader'].hidden, !wide);
  assert.equal(ui.nodes['career-reader-title'].textContent, wide ? 'Applied Role — Employer' : '');
  ui.jobCategories.jobs.fire('click');
  await ui.settle();
  assert.equal(ui.calls.at(-1).args.kind, 'jobs');
  assert.equal(ui.calls.at(-1).args.view, 'jobs');
  assert.equal(ui.titles()[0], '00');
  assert.equal(ui.nodes['stage-jobs'].hidden, false);
  assert.equal(ui.nodes['review-launch'].hidden, false);
  assert.equal(ui.nodes['delete-rankings'].hidden, true);
  assert.equal(ui.nodes['publication-range'].disabled, false);

  // Me browses CVs and facts with its own list and never sends a jobs view.
  assert.equal(ui.titles('me').length, 0);
  ui.categories.facts.fire('click');
  await ui.settle();
  assert.equal(ui.calls.at(-1).args.kind, 'facts');
  assert.equal(Object.hasOwn(ui.calls.at(-1).args, 'view'), false);
  assert.equal(ui.titles()[0], '00');
  ui.window.careerBrowser.clear();
  assert.equal(ui.nodes['delete-rankings'].disabled, true);
  assert.equal(ui.nodes['publication-range'].disabled, true);
  assert.equal(ui.nodes['career-pagination'].hidden, true);
  assert.equal(ui.nodes['career-reader'].hidden, !wide);
  assert.equal(ui.nodes['career-reader-status'].textContent, wide ? 'Select a job' : '');
});

test('job cards show reviewed fit or nothing yet, plus facts, without a switch, lead column or cutoff', async () => {
  const { state, browser } = fixture();
  const publishedAt = currentDate();
  state.career.matching = { jobs: {
    a: { title: 'Protocol Engineer', company: 'Example Labs', publishedAt, seniority: 'Senior', commitment: 'Full Time',
      classification: 'Smart Contracts', city: 'Berlin', workMode: 'Remote', salary: { stated: 150000, currency: 'USD', period: 'year' } },
    b: { title: 'Backend Engineer', company: 'Second Co', publishedAt },
    c: { title: 'Data Engineer', company: 'Third Co', publishedAt },
    r: { title: 'Analyst', company: 'Review Co', publishedAt: '2000-01-01T00:00:00Z' },
    x: { title: 'Undated Role', company: 'Other', publishedAt: null },
  }, scores: { r: finalAssessment(92), c: { ...finalAssessment(61), profileVersion: 'old' } } };
  const ui = await rendererFixture(browser, true);
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  const lis = ui.nodes['career-records'].children;
  const [a, b, c, reviewed, x] = ui.rows('career');
  const row = button => lis.find(li => li.children[0] === button);
  const side = button => row(button).children[1];
  const captions = button => side(button).querySelectorAll('.career-card-caption').map(node => node.textContent);

  // Each row is the record button then the side column; reviewed rows carry the fit, open rows carry nothing.
  assert.deepEqual(row(a).children.map(node => node.className), ['career-record', 'career-card-side']);
  assert.deepEqual(a.children.map(node => node.className), ['career-card-mark', 'career-card-body']);
  assert.equal(ui.byClass(side(reviewed), 'career-card-figure').textContent, '92');
  assert.deepEqual(captions(reviewed), ['Fit']);
  assert.equal(reviewed.attributes.get('aria-label'), 'Analyst, Review Co, fit 92 of 100, published 1 Jan 2000');
  for (const button of [a, b, c, x]) {
    assert.equal(side(button).children.length, 0);
    assert.equal(ui.byClass(row(button), 'career-include'), null);
    assert.equal(button.querySelectorAll('input').length, 0);
  }
  const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(publishedAt));
  assert.equal(a.attributes.get('aria-label'), `Protocol Engineer, Example Labs, not reviewed yet, published ${date}`);
  assert.equal(c.attributes.get('aria-label'), `Data Engineer, Third Co, not reviewed yet, published ${date}`);
  assert.equal(x.attributes.get('aria-label'), 'Undated Role, Other, not reviewed yet, publication date not stated');
  // Facts are one plain line; missing facts leave no line at all.
  assert.equal(ui.byClass(a, 'career-card-facts').textContent, 'Senior · USD 150,000 per year · Berlin · Remote · Full Time · Smart Contracts');
  assert.equal(ui.byClass(a, 'career-card-company').textContent, 'Example Labs');
  assert.equal(ui.byClass(a, 'career-card-mark').textContent, 'E');
  assert.equal(ui.byClass(b, 'career-card-facts'), null);
  assert.equal(ui.byClass(x, 'career-card-date').textContent, 'Publication date not stated');
  assert.equal(a.attributes.get('aria-controls'), 'career-reader');

  assert.deepEqual(lis.map(li => li.className), Array(5).fill('career-row career-card'));
  assert.equal(lis.some(li => li.className === 'career-cutoff'), false);
  assert.equal(ui.nodes['career-list-status'].textContent, '1–5 of 5');
  assert.deepEqual(['jobs', 'reviewed', 'applications', 'blocks'].map(name => ui.stageCount(name).textContent), [' 5', ' 1', ' 0', ' 0']);

  // The first record opened on its own: an open job has no verdict block and no inclusion control in the reader.
  assert.equal(ui.nodes['career-reader-title'].textContent, 'Protocol Engineer');
  assert.equal(ui.byClass(ui.nodes['career-reader-content'], 'career-verdict'), null);
  assert.equal(ui.byClass(ui.nodes['career-reader-content'], 'career-reader-facts').textContent, 'Senior · USD 150,000 per year · Berlin · Remote · Full Time · Smart Contracts');
  // A stale earlier review shows as context under "Not reviewed yet", without a number.
  c.fire('click');
  await ui.settle();
  let verdict = ui.byClass(ui.nodes['career-reader-content'], 'career-verdict');
  assert.equal(verdict.className, 'career-verdict is-open');
  assert.equal(ui.byClass(verdict, 'career-verdict-headline').textContent, 'Not reviewed yet');
  assert.equal(ui.byClass(verdict, 'career-verdict-number'), null);
  assert.equal(ui.byClass(verdict, 'career-verdict-reason').textContent, 'Reviewed at 61 before your profile changed · Saved full-advert review.');
  assert.equal(verdict.querySelectorAll('button').length, 0);
  reviewed.fire('click');
  await ui.settle();
  verdict = ui.byClass(ui.nodes['career-reader-content'], 'career-verdict');
  assert.equal(ui.byClass(verdict, 'career-verdict-number').textContent, '92');
  assert.equal(ui.byClass(verdict, 'career-verdict-headline').textContent, 'Recommended');
  // A reviewed job's fit is a bar chart: Overall first and heavier, then the four dimensions, each fill as wide as its score.
  const chart = ui.byClass(ui.nodes['career-reader-content'], 'career-chart');
  assert.equal(chart.querySelectorAll('.career-chart-row').map(row => row.className)[0], 'career-chart-row is-overall');
  assert.deepEqual(chart.querySelectorAll('.career-chart-row').map(row => [
    ui.byClass(row, 'career-chart-label').textContent, ui.byClass(row, 'career-chart-fill').style.width, ui.byClass(row, 'career-chart-value').textContent]),
  [['Overall', '92%', '92'], ['Direction', '92%', '92'], ['Capability', '92%', '92'], ['Scope', '92%', '92'], ['Preferences', '92%', '92']]);
  assert.equal(ui.byClass(chart, 'career-chart-track').attributes.get('aria-hidden'), 'true');
  assert.equal(ui.nodes['career-reader-content'].children.some(section => section.children[0]?.textContent === 'Fit breakdown'), false);

  // Reviewed lists current reviews only; Clear reviews appears there and nowhere else.
  ui.nodes['career-stage-reviewed'].fire('click');
  await ui.settle();
  assert.equal(ui.calls.findLast(call => call.operation === 'career-list').args.view, 'reviewed');
  assert.deepEqual(ui.titles(), ['Analyst']);
  assert.equal(ui.nodes['delete-rankings'].hidden, false);
  ui.jobCategories.applications.fire('click');
  await ui.settle();
  assert.equal(ui.nodes['stage-jobs'].hidden, true);
  assert.equal(ui.nodes['delete-rankings'].hidden, true);
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

test('ineligible cards show the verdict instead of a number, and an established incompatibility reads as a sentence', async () => {
  const { state, browser } = fixture();
  const publishedAt = currentDate();
  state.career.matching = { jobs: {
    a: { title: 'Protocol Engineer', company: 'Example Labs', publishedAt },
    e: { title: 'Montréal Lead', company: 'Far Co', publishedAt },
    s: { title: 'Gated Role', company: 'Gate Co', publishedAt },
  }, scores: {
    e: finalAssessment(74, { relocation: 'required' }),
    s: { ...finalAssessment(70, { gates: { ...passing, constraints: 'fail' } }), profileVersion: 'old' },
  } };
  state.career.profile.preferences.willingToRelocate = false;
  const ui = await rendererFixture(browser, true);
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  const lis = ui.nodes['career-records'].children;
  const [a, e, s] = ui.rows('career');
  const row = button => lis.find(li => li.children[0] === button);
  const side = button => row(button).children[1];
  const captions = button => side(button).querySelectorAll('.career-card-caption').map(node => node.textContent);
  assert.deepEqual(ui.titles(), ['Protocol Engineer', 'Montréal Lead', 'Gated Role']);
  // Open: nothing on the right yet.
  assert.equal(side(a).children.length, 0);
  assert.equal(a.attributes.get('aria-label').startsWith('Protocol Engineer, Example Labs, not reviewed yet, published'), true);
  // Current ineligible review and established stale review: the label only; no number, no switch.
  for (const [button, label] of [[e, 'Location incompatible'], [s, 'Excluded by a gate']]) {
    assert.equal(ui.byClass(side(button), 'career-card-figure'), null);
    assert.equal(ui.byClass(row(button), 'career-include'), null);
    assert.deepEqual(captions(button), [label]);
    assert.equal(ui.byClass(side(button), 'career-card-verdict').textContent, label);
  }
  assert.equal(JSON.stringify(side(e)).includes('74'), false);
  assert.equal(e.attributes.get('aria-label').startsWith('Montréal Lead, Far Co, not eligible, Location incompatible, published'), true);
  assert.equal(s.attributes.get('aria-label').startsWith('Gated Role, Gate Co, not eligible, Excluded by a gate, published'), true);
  // The reader verdict explains both current and established ineligibility; neither has an inclusion control.
  e.fire('click');
  await ui.settle();
  let verdict = ui.byClass(ui.nodes['career-reader-content'], 'career-verdict');
  assert.equal(ui.byClass(verdict, 'career-verdict-headline').textContent, 'Location incompatible');
  assert.equal(verdict.querySelectorAll('button').length, 0);
  s.fire('click');
  await ui.settle();
  verdict = ui.byClass(ui.nodes['career-reader-content'], 'career-verdict');
  assert.equal(ui.byClass(verdict, 'career-verdict-headline').textContent, 'Excluded by a gate');
  assert.equal(verdict.querySelectorAll('button').length, 0);
  assert.equal(ui.byClass(verdict, 'career-verdict-reason'), null);
  // Reviewed lists both; the open job stays in Jobs only.
  ui.nodes['career-stage-reviewed'].fire('click');
  await ui.settle();
  assert.deepEqual(ui.titles(), ['Montréal Lead', 'Gated Role']);
  assert.deepEqual(['jobs', 'reviewed', 'applications', 'blocks'].map(name => ui.stageCount(name).textContent), [' 3', ' 2', ' 0', ' 0']);
});

test('a state refresh while reading keeps the page and the open record; a record that left the page keeps its reader', async () => {
  const { state, browser } = fixture();
  const rows = Array.from({ length: 27 }, (_, index) => catalogueJob(String(index).padStart(2, '0'),
    new Date(Date.now() - (index + 1) * 60000).toISOString()));
  state.career.matching = { jobs: Object.fromEntries(rows.map(row => [row.id, row])), scores: {} };
  const ui = await rendererFixture(browser, true);
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  ui.nodes['career-next'].fire('click');
  await ui.settle();
  ui.rows('career')[1].fire('click');
  await ui.settle();
  assert.equal(ui.nodes['career-reader-title'].textContent, '26');
  // The agent saves a review: the companion broadcasts state and the list refreshes in the background. Nothing blinks:
  // unchanged rows are the same nodes, the reader keeps its content, and no loading state is shown in between.
  const rowsBefore = [...ui.nodes['career-records'].children];
  const contentBefore = ui.nodes['career-reader-content'].children;
  let loadingSeen = false, readerCleared = false;
  const refreshing = ui.window.careerBrowser.refresh();
  loadingSeen = /^Loading/.test(ui.nodes['career-list-status'].textContent) || ui.nodes['career-records'].hidden;
  readerCleared = ui.nodes['career-reader-content'].children.length === 0 || /Loading/.test(ui.nodes['career-reader-status'].textContent);
  await refreshing;
  await ui.settle();
  assert.equal(loadingSeen, false);
  assert.equal(readerCleared, false);
  assert.deepEqual(ui.titles(), ['25', '26']);
  assert.equal(ui.calls.at(-1).args.offset, 25);
  assert.deepEqual([...ui.nodes['career-records'].children], rowsBefore);
  assert.equal(ui.nodes['career-reader-content'].children, contentBefore);
  assert.equal(ui.nodes['career-reader-title'].textContent, '26');
  assert.equal(ui.nodes['career-records'].querySelectorAll('[aria-current]').length, 1);
  // The open record disappears from this page (blocked elsewhere): the reader is left as it was, not replaced by another job.
  delete state.career.matching.jobs['26'];
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  assert.deepEqual(ui.titles(), ['25']);
  assert.equal(ui.nodes['career-reader-title'].textContent, '26');
  assert.equal(ui.nodes['career-records'].querySelectorAll('[aria-current]').length, 0);
});

test('the publication slider saves its range once on change, restores the saved range on failure, and setContext drives the review launch', async () => {
  const { state, browser } = fixture();
  const publishedAt = currentDate();
  state.career.matching = { jobs: { a: { title: 'One', company: 'Co', publishedAt }, b: { title: 'Two', company: 'Co', publishedAt } }, scores: {} };
  let failure = null;
  const ui = await rendererFixture(browser, true, {
    'publication-range-set': ({ publicationRange }) => {
      if (failure) throw new Error(failure);
      state.career.publicationRange = publicationRange;
    },
  });
  const input = ui.nodes['publication-range'], label = ui.nodes['publication-range-label'];
  const launch = host => ui.nodes[`review-${host}`];
  assert.equal(input.disabled, true);
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  assert.equal(input.disabled, false);
  assert.equal(ui.nodes['career-list-status'].textContent, '1–2 of 2');
  ui.window.careerBrowser.setContext({ review: { hosts: { codex: true, claude: false }, preferredHost: 'codex' }, publicationRange: 'past_week', paired: true });
  assert.deepEqual([input.value, input.attributes.get('aria-valuetext'), label.textContent], ['3', 'Past week', 'in the past week']);
  assert.deepEqual([launch('codex').hidden, launch('claude').hidden], [false, true]);
  assert.deepEqual([launch('codex').className, ui.nodes['copy-review-prompt'].className], ['primary', 'text']);
  // Dragging only moves the label; the change event saves once, and an unchanged value never saves.
  input.value = '4';
  input.fire('input');
  assert.equal(label.textContent, 'in the past 2 weeks');
  assert.equal(ui.calls.some(call => call.operation === 'publication-range-set'), false);
  input.fire('change');
  await ui.settle();
  assert.deepEqual(ui.calls.at(-1), { operation: 'publication-range-set', args: { publicationRange: 'past_2_weeks' } });
  ui.window.careerBrowser.setContext({ publicationRange: state.career.publicationRange });
  assert.deepEqual([input.value, label.textContent], ['4', 'in the past 2 weeks']);
  const callsBefore = ui.calls.length;
  input.fire('change');
  await ui.settle();
  assert.equal(ui.calls.length, callsBefore);
  // A failed save reports the error and restores the saved range.
  failure = 'Storage is locked.';
  input.value = '0';
  input.fire('input');
  input.fire('change');
  await ui.settle();
  assert.equal(ui.nodes['career-list-status'].textContent, 'Could not change the publication window. Storage is locked.');
  assert.deepEqual([input.value, input.attributes.get('aria-valuetext'), label.textContent], ['4', 'Past 2 weeks', 'in the past 2 weeks']);
  // Only installed hosts are offered; the preferred installed one leads, Copy prompt leads when none is installed.
  ui.window.careerBrowser.setContext({ review: { hosts: { codex: true, claude: true }, preferredHost: 'claude' } });
  assert.deepEqual([launch('codex').hidden, launch('claude').hidden], [false, false]);
  assert.deepEqual([launch('codex').className, launch('claude').className, ui.nodes['copy-review-prompt'].className], ['ghost', 'primary', 'text']);
  ui.window.careerBrowser.setContext({ review: { hosts: { codex: false, claude: false }, preferredHost: 'codex' } });
  assert.deepEqual([launch('codex').hidden, launch('claude').hidden], [true, true]);
  assert.equal(ui.nodes['copy-review-prompt'].className, 'primary');
  // The launch and the slider belong to the Jobs tabs only.
  ui.jobCategories.applications.fire('click');
  await ui.settle();
  assert.equal(ui.nodes['review-launch'].hidden, true);
  assert.equal(input.disabled, true);
  ui.nodes['career-stage-reviewed'].fire('click');
  await ui.settle();
  assert.equal(ui.nodes['review-launch'].hidden, false);
  assert.equal(ui.nodes['stage-jobs'].hidden, true);
  ui.window.careerBrowser.clear();
  assert.equal(input.disabled, true);
});

test('each Jobs stage has its own empty state, active tab and controls', async () => {
  const { browser } = fixture();
  const ui = await rendererFixture(browser, false);
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  for (const [view, empty] of [
    ['reviewed', 'Nothing reviewed yet. Continue in Codex or Claude to review the jobs in this window.'],
    ['jobs', 'No jobs in this publication window yet. Widen the window or start the shortlist.'],
  ]) {
    ui.nodes[`career-stage-${view}`].fire('click');
    await ui.settle();
    assert.equal(ui.calls.at(-1).args.view, view);
    assert.equal(ui.nodes['career-list-status'].textContent, empty);
    assert.equal(ui.nodes['stage-jobs'].hidden, view !== 'jobs');
    assert.equal(ui.nodes['review-launch'].hidden, false);
    assert.equal(ui.nodes['delete-rankings'].hidden, view !== 'reviewed');
    assert.equal(ui.nodes['delete-rankings'].disabled, false);
    for (const candidate of ['stage-jobs', 'stage-reviewed', 'category-applications', 'category-blocks'])
      assert.equal(ui.nodes[`career-${candidate}`].attributes.get('aria-selected'), String(candidate === `stage-${view}`));
  }
  for (const kind of ['applications', 'blocks']) {
    ui.jobCategories[kind].fire('click');
    await ui.settle();
    assert.equal(ui.jobCategories[kind].attributes.get('aria-selected'), 'true');
    assert.equal(ui.nodes['career-stage-jobs'].attributes.get('aria-selected'), 'false');
    assert.equal(ui.nodes['stage-jobs'].hidden, true);
    assert.equal(ui.nodes['review-launch'].hidden, true);
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
  // The publication window and the review launch belong to the Jobs stage panel, above the list.
  const rail = html.match(/<section id="stage-panels"[\s\S]*?<\/section>/)[0];
  assert.match(rail, /<div id="stage-jobs" class="stage-panel stage-panel-jobs" data-stage-panel="jobs">[\s\S]*<input id="publication-range" type="range" min="0" max="4" step="1" value="2" aria-valuetext="Past 3 days" disabled>/);
  assert.match(rail, /<span id="publication-range-label">in the past 3 days<\/span>/);
  assert.match(rail, /<div id="review-launch"[^>]*>(<button id="review-codex" class="ghost" type="button" hidden>[^<]*<\/button>)(<button id="review-claude" class="ghost" type="button" hidden>[^<]*<\/button>)<button id="copy-review-prompt" class="ghost" type="button">Copy prompt<\/button><\/div>/);
  assert.match(list, /<div class="career-list-tools">\s*<p id="career-list-status"/);
  assert.match(list, /<button id="delete-rankings" class="text" type="button" disabled hidden>Clear reviews<\/button>/);
  for (const obsolete of ['id="run-rail"', 'class="run-steps"', 'class="run-step-number"', 'aria-current="step"', 'id="career-sort"', 'id="career-sort-control"', 'id="career-category-ranked"',
    'id="run-step-prefilter"', 'id="run-step-handover"', 'id="career-queue-qualified"', 'id="career-queue-all"', 'id="career-surface"', 'career-minimum-score', 'id="review-help"', 'career-cutoff-control',
    'data-career-view="shortlist"', 'data-career-view="queue"', 'aria-pressed'])
    assert.equal(html.includes(obsolete), false, obsolete);
  assert.match(html, /<div class="tabs jobs-stages" role="tablist" aria-label="Job stages">/);
  for (const view of ['jobs', 'reviewed'])
    assert.match(html, new RegExp(`<button id="career-stage-${view}" type="button" class="tab" role="tab" data-career-kind="jobs" data-career-view="${view}" aria-selected="${view === 'jobs'}" disabled>[^<]*<span class="stage-count" data-stage-count="${view}"></span></button>`));
  for (const kind of ['applications', 'blocks'])
    assert.match(html, new RegExp(`<button id="career-category-${kind}" type="button" class="tab" role="tab" data-career-kind="${kind}" aria-selected="false" disabled>[^<]*<span class="stage-count" data-stage-count="${kind}"></span></button>`));
  assert.match(css, /^#career-browser \{ grid-template-rows: auto auto minmax\(0, 1fr\); \}$/m);
  // Four explicit rows, each child pinned to one, so hidden children never let the records take the `auto` row.
  assert.match(css, /^\.career-list \{[^}]*grid-template-rows: auto auto minmax\(0, 1fr\) auto;[^}]*overflow: hidden; \}$/m);
  for (const [selector, row] of [['.career-list .panel-head', 2], ['.career-list > .ghost', 3], ['.career-records', 3], ['.career-list .pagination', 4]])
    assert.match(css, new RegExp(`^${selector.replaceAll('.', '\\.')} \\{ grid-row: ${row};`, 'm'), selector);
  assert.match(css, /^\.career-records \{[^}]*overflow: auto;/m);
  assert.match(css, /^\.career-card-side \{[^}]*width: 112px;/m);
  assert.match(css, /\.career-card-side \{ width: 96px; padding: var\(--spacing-16\) var\(--spacing-16\) var\(--spacing-16\) 0; \}/);
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
  assert.equal(ui.nodes['stage-jobs'].hidden, true);
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
