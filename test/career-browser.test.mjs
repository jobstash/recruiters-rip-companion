import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile, unlink, symlink } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createCareerState } from '../src/mcp/state.mjs';
import { createCareerBrowser, openJobPage, requirementContextPrompt, setApplicationProgress } from '../src/career-browser.mjs';
import { replayProgress } from '../src/application-progress.mjs';
import { addBlock, removeBlock } from '../src/mcp/blocklist.mjs';
import { ASSESSMENT_POLICY_ID, deriveDecision } from '../src/mcp/matching-contract.mjs';
import { createMatchingTools } from '../src/mcp/matching-tools.mjs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createDocumentFiles } from '../src/mcp/files.mjs';
import { applicationContextFingerprint } from '../src/application-workflow.mjs';
import { readyMaster } from './helpers/ready-master.mjs';

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

test('Preferences exposes saved career paths, exclusions and practical constraints in Me', async () => {
  const { state, browser } = fixture();
  state.career.profile.preferences = {
    careerPaths: [
      { name: 'Engineering leadership', titles: ['Head of Engineering', 'VP Engineering'], why: 'Ran a 50-person engineering budget.' },
      { name: 'Forward-deployed engineering', titles: ['Director of Forward-Deployed Engineering'], why: 'Client-facing technical director at an agency.' },
    ],
    excludedRoles: ['Frontend engineer'], notes: 'Assess actual responsibilities, not titles.',
    locations: ['Amsterdam'], workModes: ['remote', 'hybrid'], willingToRelocate: false, travel: 'any',
    salaryMinimum: 120000, salaryCurrency: 'EUR', salaryPeriod: 'year',
    responsibilityModes: ['hands_on', 'managerial'], technologies: ['AI agents'],
  };
  const page = await browser.list({ kind: 'preferences' });
  assert.deepEqual(page.items.map(item => item.title), ['Direction', 'Location', 'Employment', 'Work']);
  assert.equal(page.items[0].summary, 'Engineering leadership · Forward-deployed engineering');
  assert.equal(page.total, 4);
  const direction = await browser.read({ kind: 'preferences', id: 'direction' });
  assert.deepEqual(sectionFields(direction, 'Engineering leadership'), [
    { label: 'Titles', value: 'Head of Engineering · VP Engineering' },
    { label: 'Why', value: 'Ran a 50-person engineering budget.' },
  ]);
  assert.deepEqual(sectionFields(direction, 'Forward-deployed engineering'), [
    { label: 'Titles', value: 'Director of Forward-Deployed Engineering' },
    { label: 'Why', value: 'Client-facing technical director at an agency.' },
  ]);
  assert.deepEqual(sectionFields(direction, 'Avoid'), [{ label: 'Roles', value: 'Frontend engineer' }]);
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
    counts: { jobs: 0, reviewed: 0, blocks: 0 }, inclusion: { included: 0, candidates: 0 } });
  await assert.rejects(browser.read({ kind: 'jobs', id: 'missing' }), { code: 'NOT_FOUND' });
});

test('Jobs views are strictly validated and obsolete sorts are rejected', async () => {
  const { browser } = fixture();
  for (const view of [null, undefined, '', 'newest', 'Score', 'rank', 'shortlist', 'queue', 0, {}, ['jobs']])
    await assert.rejects(browser.list({ kind: 'jobs', view }), { code: 'INVALID_INPUT' });
  for (const kind of ['sources', 'facts', 'preferences', 'applications', 'blocks'])
    await assert.rejects(browser.list({ kind, view: 'jobs' }), {
      code: 'INVALID_INPUT', message: 'Use view jobs or reviewed for Jobs only.' });
  for (const sort of [null, undefined, '', 'score', 'recent'])
    await assert.rejects(browser.list({ kind: 'jobs', sort }), { code: 'INVALID_INPUT' });
  for (const view of ['jobs', 'reviewed'])
    assert.deepEqual(await browser.list({ kind: 'jobs', view }), { items: [], total: 0, nextOffset: null,
      counts: { jobs: 0, reviewed: 0, blocks: 0 }, inclusion: { included: 0, candidates: 0 } });
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
  assert.deepEqual(item('leader').card, { ...item('leader').card, stage: 'reviewed', established: false, score: 70, stale: false });
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
  assert.deepEqual(item('excluded').verdict, { kind: 'ineligible', number: null, numberLabel: null, headline: scores.excluded.reason,
    detail: null, reason: null });
  assert.equal(fieldValue(item('excluded'), 'Checks', 'Location'), undefined);
  assert.equal(fieldValue(item('excluded'), 'Checks', 'Eligibility'), 'Fails');
  assert.equal(item('excluded').sections[1].chart[0].value, 85);
  for (const id of Object.keys(scores)) {
    const detail = await browser.read({ kind: 'jobs', id });
    assert.deepEqual(detail, readerOf(item(id)));
    assert.deepEqual(detail.header, { company: 'Company', published: detail.header.published, attributes: [], applyUrl: null });
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
  assert.equal(fieldValue(leader, 'Your application', 'Interview answers'), '2 answers');
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
  assert.deepEqual(await openJobPage({ store, openExternal }, { kind: 'jobs', id: 'linked' }), { opened: true, url: 'https://jobs.example/linked?utm=1' });
  assert.deepEqual(await openJobPage({ store, openExternal }, { kind: 'jobs', id: 'captured' }), { opened: true, url: 'http://jobs.example/captured' });
  assert.deepEqual((await createCareerBrowser({ store }).read({ kind: 'jobs', id: 'unsafe' })).header.applyUrl, null);
  assert.deepEqual((await createCareerBrowser({ store }).read({ kind: 'jobs', id: 'linked' })).header.applyUrl, 'https://jobs.example/linked?utm=1');
  await assert.rejects(openJobPage({ store, openExternal }, { kind: 'jobs', id: 'unsafe' }), { code: 'NOT_FOUND' });
  await assert.rejects(openJobPage({ store, openExternal }, { kind: 'jobs', id: 'bare' }), { code: 'NOT_FOUND' });
  await assert.rejects(openJobPage({ store, openExternal }, { kind: 'jobs', id: 'missing' }), { code: 'NOT_FOUND' });
  for (const id of ['', '   ', '__proto__', 'constructor', 42, null, undefined])
    await assert.rejects(openJobPage({ store, openExternal }, { kind: 'jobs', id }), { code: 'INVALID_INPUT' });
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
    counts: { jobs: 108, reviewed: 105, blocks: 0 }, inclusion: { included: 2, candidates: 2 } });
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
  assert.equal(fieldValue(excluded, 'Checks', 'Mandatory conditions'), 'Fails');
  assert.deepEqual(excluded.card, { ...excluded.card, stage: 'ineligible', established: false, score: 85 });
  const unavailable = page.items.find(item => item.id === 'unavailable');
  assert.equal(unavailable.verdict.number, null);
  assert.deepEqual(unavailable.card, { ...unavailable.card, stage: 'reviewed', score: null, stale: false });
  assert.equal(unavailable.sections.some(section => ['Fit', 'Requirements'].includes(section.heading)), false);
  const relocation = page.items.find(item => item.id === 'relocation');
  assert.deepEqual(relocation.card, { ...relocation.card, stage: 'ineligible', established: false, score: 80 });
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
    stage: 'reviewed', established: false, score: 92, stale: false });
  assert.deepEqual(card('sparse'), { title: 'Analyst', company: 'Sparse Co', logoUrl: null, publishedAt: null,
    facts: ['EUR 90,000 per year', 'Lisbon'],
    stage: 'open', established: false, score: null, stale: false });
  assert.deepEqual(card('bare'), { title: 'Bare', company: null, logoUrl: null, publishedAt: null, facts: [],
    stage: 'open', established: false, score: null, stale: false });
  assert.deepEqual(page.inclusion, { included: 2, candidates: 2 });
  assert.equal(page.items.some(item => 'summary' in item), false);
  const full = await browser.read({ kind: 'jobs', id: 'full' });
  const job = state.career.matching.jobs.full;
  assert.equal(full.header.company, job.company);
  assert.equal(full.header.published, `Published ${new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium', timeZone: 'UTC',
  }).format(new Date(job.publishedAt))}`);
  assert.deepEqual(full.header.attributes, [
    { label: 'Seniority', value: job.seniority },
    { label: 'Salary', value: 'USD 120,000–160,000 per year' },
    { label: 'Location', value: job.city },
    { label: 'Work mode', value: job.workMode },
    { label: 'Commitment', value: job.commitment },
    { label: 'Job category', value: job.classification },
  ]);
  const sparse = await browser.read({ kind: 'jobs', id: 'sparse' });
  assert.deepEqual(sparse.header, { company: state.career.matching.jobs.sparse.company, published: null,
    attributes: [{ label: 'Salary', value: 'EUR 90,000 per year' },
      { label: 'Location', value: state.career.matching.jobs.sparse.location }], applyUrl: null });
  assert.deepEqual((await browser.read({ kind: 'jobs', id: 'bare' })).header,
    { company: null, published: null, attributes: [], applyUrl: null });
  for (const item of page.items) {
    assert.equal(Object.hasOwn(item.header, 'facts'), false);
    assert.deepEqual((await browser.read({ kind: 'jobs', id: item.id })).header, item.header);
  }
});

test('job detail attributes make work modes readable without duplicating a remote location', async () => {
  const { state, browser } = fixture();
  state.career.matching = { jobs: {
    remote: { title: 'Remote role', location: 'Remote', workMode: 'remote' },
    onsite: { title: 'Onsite role', location: 'Madrid', workMode: 'on_site' },
    hybrid: { title: 'Hybrid role', workMode: 'hybrid' },
    locationOnly: { title: 'Location only', location: 'Remote' },
    blank: { title: 'Missing attributes', seniority: '', commitment: ' ', classification: null,
      location: '', workMode: '', salary: { currency: 'USD', period: 'year' } },
  }, scores: {} };
  const attributes = async id => (await browser.read({ kind: 'jobs', id })).header.attributes;
  assert.deepEqual(await attributes('remote'), [{ label: 'Work mode', value: 'Remote' }]);
  assert.deepEqual(await attributes('onsite'), [
    { label: 'Location', value: 'Madrid' }, { label: 'Work mode', value: 'On site' },
  ]);
  assert.deepEqual(await attributes('hybrid'), [{ label: 'Work mode', value: 'Hybrid' }]);
  assert.deepEqual(await attributes('locationOnly'), [{ label: 'Location', value: 'Remote' }]);
  assert.deepEqual(await attributes('blank'), []);
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
  assert.deepEqual(page.counts, { jobs: 6, reviewed: 2, blocks: 0 });
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

test('ineligible reviews preserve exact saved reasons and sort order; established incompatibility is never a candidate', async () => {
  const { state, browser } = fixture();
  const publishedAt = currentDate();
  const rows = [catalogueJob('ranked', publishedAt), catalogueJob('stale-gate', publishedAt), catalogueJob('stale-relocation', publishedAt)];
  state.career.matching = { jobs: { ...Object.fromEntries(rows.map(row => [row.id, { ...row }])),
    excluded: { title: 'excluded', company: 'Company', publishedAt }, relocation: { title: 'relocation', company: 'Company', publishedAt } }, scores: {
    excluded: finalAssessment(85, { gates: { ...passing, constraints: 'fail' }, reason: 'The role requires night shifts; the saved preference excludes them.' }),
    relocation: finalAssessment(80, { relocation: 'required', reason: 'This role requires relocation to Montréal; the candidate will not relocate.' }),
    'stale-gate': { ...finalAssessment(70, { gates: { ...passing, eligibility: 'fail' }, reason: 'The advert requires an active clearance that the candidate does not hold.' }), profileVersion: 'old' },
    'stale-relocation': { ...finalAssessment(65, { relocation: 'required', reason: 'On-site work in Toronto requires a move the candidate has ruled out.' }), profileVersion: 'old' },
  } };
  state.career.profile.preferences.willingToRelocate = false;
  const page = await browser.list({ kind: 'jobs' });
  assert.deepEqual(page.items.map(item => item.id), ['excluded', 'ranked', 'relocation', 'stale-gate', 'stale-relocation']);
  const card = id => page.items.find(item => item.id === id).card;
  // Scores and stages remain internal data even when excluded rows have no list status.
  assert.deepEqual(card('excluded'), { ...card('excluded'), stage: 'ineligible', established: false, score: 85, stale: false });
  assert.deepEqual(card('relocation'), { ...card('relocation'), stage: 'ineligible', established: false, score: 80, stale: false });
  assert.deepEqual(card('stale-gate'), { ...card('stale-gate'), stage: 'ineligible', established: true, score: 70, stale: true });
  assert.deepEqual(card('stale-relocation'), { ...card('stale-relocation'), stage: 'ineligible', established: true, score: 65, stale: true });
  for (const id of ['excluded', 'relocation', 'stale-gate', 'stale-relocation']) {
    const item = page.items.find(item => item.id === id);
    assert.deepEqual(item.verdict, { kind: 'ineligible', number: null, numberLabel: null,
      headline: state.career.matching.scores[id].reason, detail: null, reason: null });
    assert.equal(Object.hasOwn(item.card, 'label'), false);
    assert.deepEqual(await browser.read({ kind: 'jobs', id }), readerOf(item));
    assert.equal(fieldValue(item, 'Checks', 'Location'), undefined);
    assert.equal(fieldValue(item, 'Checks', 'Relocation'), undefined);
  }
  assert.deepEqual(card('ranked'), { ...card('ranked'), stage: 'open', established: false, score: null, stale: false });
  assert.equal(page.items.find(item => item.id === 'ranked').verdict, null);
  assert.deepEqual(page.inclusion, { included: 1, candidates: 3 });
  assert.deepEqual(page.counts, { jobs: 5, reviewed: 4, blocks: 0 });
  assert.deepEqual((await browser.list({ kind: 'jobs', view: 'reviewed' })).items.map(item => item.id),
    ['excluded', 'relocation', 'stale-gate', 'stale-relocation']);
});

test('ineligible reviews without a saved reason omit the verdict without inventing a location explanation', async () => {
  for (const reason of [undefined, null, '', '   ']) {
    for (const stale of [false, true]) {
      const { state, browser } = fixture();
      const assessment = finalAssessment(70, { gates: { ...passing, constraints: 'fail' }, reason });
      if (stale) assessment.profileVersion = 'old';
      state.career.matching = { jobs: { excluded: catalogueJob('excluded', currentDate()) }, scores: { excluded: assessment } };
      const before = structuredClone(state);
      const page = await browser.list({ kind: 'jobs' });
      const item = page.items[0];
      assert.equal(item.card.stage, 'ineligible');
      assert.equal(item.card.score, 70);
      assert.equal(item.verdict, null);
      assert.equal(Object.hasOwn(item.card, 'label'), false);
      assert.equal(fieldValue(item, 'Checks', 'Mandatory conditions'), 'Fails');
      assert.equal(item.sections.find(section => section.chart).chart[0].value, 70);
      assert.deepEqual(await browser.read({ kind: 'jobs', id: 'excluded' }), readerOf(item));
      assert.deepEqual(state, before);
    }
  }
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
    experience: [{ roleId: '00000000-0000-4000-8000-000000000001', employer: 'Acme', role: 'Engineer', startDate: '2019', endDate: 'Present', bullets: [
      { id: '00000000-0000-4000-8000-000000000002', text: 'Built payment pipelines.', support: { sources: [{ sourceId: '00000000-0000-4000-8000-000000000003', contentHash: 'a'.repeat(64), quote: 'CV_SUPPORT_SENTINEL quote' }], facts: ['ab'] } }] }] };
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
  const names = ['records', 'list-status', 'list-retry', 'list-action', 'pagination', 'previous', 'next', 'reader', 'reader-title',
    'reader-status', 'reader-retry', 'reader-content', 'close'];
  // Pipeline has the board in place of the paged list, so no list action or pagination.
  const pipelineNames = names.filter(name => !['list-action', 'pagination', 'previous', 'next'].includes(name));
  const ids = [...names.flatMap(name => [`career-${name}`, `me-${name}`]), ...pipelineNames.map(name => `pipeline-${name}`),
    'career-browser', 'me-browser', 'pipeline-browser', 'delete-rankings',
    'stage-jobs', 'publication-range', 'publication-range-label', 'publication-count', 'review-launch', 'review-codex', 'review-claude', 'copy-review-prompt'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Node()]));
  for (const id of ids) nodes[id].id = id;
  nodes['stage-jobs'].dataset.stagePanel = 'jobs';
  // As in index.html: the Pipeline board and its reader start hidden.
  nodes['pipeline-reader'].hidden = true; nodes['pipeline-records'].hidden = true;
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
  const categories = Object.fromEntries(['master', 'sources', 'facts', 'preferences'].map(category));
  const jobCategories = Object.fromEntries(['jobs', 'blocks'].map(category));
  const stageCounts = [];
  // The Jobs tab list: two jobs views, then blocks; each tab carries its own count.
  for (const view of ['jobs', 'reviewed']) {
    const button = view === 'jobs' ? jobCategories.jobs : category('jobs')[1];
    button.dataset.careerView = view;
    button.setAttribute('aria-selected', String(view === 'jobs'));
    nodes[`career-stage-${view}`] = button;
    if (view !== 'jobs') jobCategories[view] = button;
  }
  jobCategories.blocks.setAttribute('aria-selected', 'false');
  nodes['career-category-blocks'] = jobCategories.blocks;
  for (const name of ['jobs', 'reviewed', 'blocks']) {
    const count = new Node('span'); count.className = 'stage-count'; count.dataset.stageCount = name;
    (nodes[`career-stage-${name}`] ?? jobCategories[name]).append(count);
    stageCounts.push(count);
  }
  nodes['me-browser'].querySelectorAll = selector => selector === '[data-stage-count]' ? [] : Object.values(categories);
  nodes['career-browser'].querySelectorAll = selector => selector === '[data-stage-count]' ? stageCounts : Object.values(jobCategories);
  const calls = [], notices = [];
  const window = { matchMedia: () => ({ matches: wide }), addEventListener() {}, companion: { async invoke(operation, args) {
    const input = structuredClone(args);
    calls.push({ operation, args: input });
    try {
      if (!['career-list', 'career-read', 'career-pipeline'].includes(operation)) return { ok: true, result: (await operations[operation]?.(input)) ?? {} };
      return { ok: true, result: await (operation === 'career-list' ? browser.list(input) : operation === 'career-pipeline' ? browser.pipeline(input) : browser.read(input)) };
    } catch (error) { return { ok: false, error: { code: error.code, message: error.message } }; }
  } } };
  window.showCompanionNotice = (...args) => notices.push(args);
  const document = { getElementById: id => nodes[id], createElement: tag => new Node(tag),
    querySelectorAll: () => [nodes['stage-jobs']], get activeElement() { return focused; } };
  for (const script of ['jobs-empty.js', 'pipeline.js', 'career-browser.js'])
    runInNewContext(await readFile(new URL(`../ui/${script}`, import.meta.url), 'utf8'), { window, document });
  const byClass = (node, className) => node.className.split(' ').includes(className) ? node
    : node.children.map(child => byClass(child, className)).find(Boolean) ?? null;
  const rows = prefix => nodes[`${prefix}-records`].children.map(row => byClass(row, 'career-record'));
  return { window, nodes, categories, jobCategories, calls, notices, rows, byClass, focused: () => focused,
    stageCount: name => stageCounts.find(count => count.dataset.stageCount === name),
    settle: () => new Promise(resolve => setImmediate(resolve)),
    titles: (prefix = 'career') => rows(prefix).map(button => byClass(button, 'career-record-title').textContent) };
}

test('the master editor tab never enters the source-record list API', async () => {
  const { browser } = fixture();
  const ui = await rendererFixture(browser, true);
  await ui.window.careerBrowser.refresh();
  ui.categories.master.fire('click');
  await ui.settle();
  assert.equal(ui.calls.some(call => call.args?.kind === 'master'), false);
  for (const kind of ['facts', 'preferences', 'sources']) {
    ui.categories[kind].fire('click');
    await ui.settle();
    assert.equal(ui.calls.some(call => call.operation === 'career-list' && call.args.kind === kind), true);
  }
});

for (const wide of [false, true]) test(`Jobs paging and stage changes keep the reader column and pagination stable in ${wide ? 'wide' : 'narrow'} mode`, async () => {
  const { state, browser } = fixture();
  const rows = Array.from({ length: 27 }, (_, index) => catalogueJob(String(index).padStart(2, '0'),
    new Date(Date.now() - (index + 1) * 60000).toISOString()));
  state.career.matching = { jobs: Object.fromEntries(rows.map(row => [row.id, row])), scores: { 26: finalAssessment(50) } };
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

  // Blocked shares the Jobs list + reader; the jobs-only toolbar controls hide and disable while it is active.
  ui.jobCategories.blocks.fire('click');
  await ui.settle();
  assert.deepEqual(ui.titles(), []);
  assert.equal(ui.jobCategories.blocks.attributes.get('aria-selected'), 'true');
  assert.equal(ui.jobCategories.jobs.attributes.get('aria-selected'), 'false');
  assert.equal(ui.nodes['career-stage-reviewed'].attributes.get('aria-selected'), 'false');
  for (const id of ['stage-jobs', 'review-launch', 'delete-rankings']) assert.equal(ui.nodes[id].hidden, true, id);
  assert.equal(ui.nodes['delete-rankings'].disabled, true);
  assert.equal(ui.nodes['publication-range'].disabled, true);
  assert.equal(ui.nodes['career-reader'].hidden, !wide);
  assert.equal(ui.nodes['career-reader-title'].textContent, '');
  ui.jobCategories.jobs.fire('click');
  await ui.settle();
  assert.equal(ui.titles()[0], '00');
  assert.equal(ui.nodes['stage-jobs'].hidden, false);
  assert.equal(ui.nodes['review-launch'].hidden, false);
  assert.equal(ui.nodes['delete-rankings'].hidden, true);
  assert.equal(ui.nodes['publication-range'].disabled, false);

  // Me changes its own category without changing the Jobs list.
  assert.equal(ui.titles('me').length, 0);
  ui.categories.facts.fire('click');
  await ui.settle();
  assert.equal(ui.categories.facts.attributes.get('aria-selected'), 'true');
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

  // Only numeric reviewed fit gets a side column; every other row reclaims its width.
  assert.deepEqual(row(a).children.map(node => node.className), ['career-record']);
  assert.deepEqual(row(reviewed).children.map(node => node.className), ['career-record', 'career-card-side']);
  assert.deepEqual(a.children.map(node => node.className), ['career-card-mark', 'career-card-body']);
  assert.equal(ui.byClass(side(reviewed), 'career-card-figure').textContent, '92');
  assert.deepEqual(captions(reviewed), ['Fit']);
  assert.equal(reviewed.attributes.get('aria-label'), 'Analyst, Review Co, fit 92 of 100, published 1 Jan 2000');
  for (const button of [a, b, c, x]) {
    assert.equal(side(button), undefined);
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
  assert.equal(ui.nodes['career-list-status'].textContent, '1–5');
  assert.deepEqual(['jobs', 'reviewed', 'blocks'].map(name => ui.stageCount(name).textContent), ['', ' 1', ' 0']);

  // The first record opened on its own: an open job has no verdict block and no inclusion control in the reader.
  assert.equal(ui.nodes['career-reader-title'].textContent, 'Protocol Engineer');
  assert.equal(ui.byClass(ui.nodes['career-reader-content'], 'career-verdict'), null);
  const header = (await browser.read({ kind: 'jobs', id: 'a' })).header;
  const meta = ui.byClass(ui.nodes['career-reader-content'], 'career-reader-meta');
  assert.deepEqual(meta.children.slice(0, 2).map(node => node.textContent), [header.company, header.published]);
  assert.deepEqual(ui.byClass(meta, 'career-reader-attributes').children.map(node => [node.tagName, node.textContent]),
    header.attributes.flatMap(({ label, value }) => [['DT', label], ['DD', value]]));
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
  ui.jobCategories.blocks.fire('click');
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

test('excluded rows reclaim the side column and their reader shows only the exact saved reason', async () => {
  const { state, browser } = fixture();
  const publishedAt = currentDate();
  const locationReason = 'Requires three days each week in Montréal; your saved location is Berlin and relocation is not an option.';
  const gateReason = 'Requires an active security clearance; your saved experience does not establish one.';
  state.career.matching = { jobs: {
    a: { title: 'Protocol Engineer', company: 'Example Labs', publishedAt },
    e: { title: 'Montréal Lead', company: 'Far Co', publishedAt },
    s: { title: 'Gated Role', company: 'Gate Co', publishedAt },
    n: { title: 'No Saved Reason', company: 'Other Co', publishedAt },
    u: { title: 'Unavailable Advert', company: 'Missing Co', publishedAt },
    r: { title: 'Supported Role', company: 'Review Co', publishedAt },
  }, scores: {
    e: finalAssessment(74, { relocation: 'required', reason: locationReason }),
    s: { ...finalAssessment(70, { gates: { ...passing, constraints: 'fail' }, reason: gateReason }), profileVersion: 'old' },
    n: finalAssessment(69, { gates: { ...passing, eligibility: 'fail' }, reason: '' }),
    u: unavailableAssessment(),
    r: finalAssessment(92),
  } };
  state.career.profile.preferences.willingToRelocate = false;
  const ui = await rendererFixture(browser, true);
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  const [a, e, n, r, s, u] = ui.rows('career');
  const row = button => ui.nodes['career-records'].children.find(li => li.children[0] === button);
  assert.deepEqual(ui.titles(), ['Protocol Engineer', 'Montréal Lead', 'No Saved Reason', 'Supported Role', 'Gated Role', 'Unavailable Advert']);
  for (const button of [a, e, s, n, u]) {
    assert.deepEqual(row(button).children, [button]);
    assert.equal(ui.byClass(row(button), 'career-card-side'), null);
    assert.equal(ui.byClass(row(button), 'career-card-figure'), null);
  }
  assert.equal(ui.byClass(row(r), 'career-card-figure').textContent, '92');
  // Excluded accessible names retain the job identity and date, without an invented status.
  for (const [button, id] of [[e, 'e'], [s, 's'], [n, 'n']]) {
    const job = state.career.matching.jobs[id];
    const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(publishedAt));
    assert.equal(button.attributes.get('aria-label'), `${job.title}, ${job.company}, published ${date}`);
  }
  const text = node => [node.textContent, ...node.children.map(text)].join(' ');
  for (const [button, reason] of [[e, locationReason], [s, gateReason]]) {
    button.fire('click');
    await ui.settle();
    const content = ui.nodes['career-reader-content'];
    const verdict = ui.byClass(content, 'career-verdict');
    assert.equal(ui.byClass(verdict, 'career-verdict-headline').textContent, reason);
    assert.equal(ui.byClass(verdict, 'career-verdict-detail'), null);
    assert.equal(ui.byClass(verdict, 'career-verdict-reason'), null);
    assert.equal(text(content).split(reason).length - 1, 1);
    assert.equal(verdict.querySelectorAll('button').length, 0);
  }
  n.fire('click');
  await ui.settle();
  assert.equal(ui.byClass(ui.nodes['career-reader-content'], 'career-verdict'), null);
  u.fire('click');
  await ui.settle();
  assert.equal(ui.byClass(ui.nodes['career-reader-content'], 'career-verdict-number'), null);
  ui.nodes['career-stage-reviewed'].fire('click');
  await ui.settle();
  assert.deepEqual(ui.titles(), ['Supported Role', 'Unavailable Advert', 'Montréal Lead', 'No Saved Reason', 'Gated Role']);
  assert.deepEqual(['jobs', 'reviewed', 'blocks'].map(name => ui.stageCount(name).textContent), ['', ' 5', ' 0']);
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
  assert.equal(ui.nodes['career-list-status'].textContent, '1–2');
  ui.window.careerBrowser.setContext({ review: { hosts: { codex: true, claude: false }, preferredHost: 'codex' }, publicationRange: 'past_week', paired: true });
  assert.deepEqual([input.value, input.attributes.get('aria-valuetext'), label.textContent], ['3', 'Past week', 'in the past week']);
  assert.deepEqual([launch('codex').hidden, launch('claude').hidden], [false, true]);
  assert.deepEqual([launch('codex').className, ui.nodes['copy-review-prompt'].className], ['ghost', 'ghost']);
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
  // Installed hosts and the copied prompt retain equal emphasis regardless of preference.
  ui.window.careerBrowser.setContext({ review: { hosts: { codex: true, claude: true }, preferredHost: 'claude' } });
  assert.deepEqual([launch('codex').hidden, launch('claude').hidden], [false, false]);
  assert.deepEqual([launch('codex').className, launch('claude').className, ui.nodes['copy-review-prompt'].className], ['ghost', 'ghost', 'ghost']);
  ui.window.careerBrowser.setContext({ review: { hosts: { codex: false, claude: false }, preferredHost: 'codex' } });
  assert.deepEqual([launch('codex').hidden, launch('claude').hidden], [true, true]);
  assert.equal(ui.nodes['copy-review-prompt'].className, 'ghost');
  // The launch and the slider belong to the Jobs tabs only.
  ui.jobCategories.blocks.fire('click');
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

test('Jobs uses the remote catalogue total and shows only a ready count for the displayed publication window', async () => {
  const { state, browser } = fixture();
  const jobs = Array.from({ length: 27 }, (_, index) => catalogueJob(String(index).padStart(2, '0'), currentDate()));
  state.career.matching = { jobs: Object.fromEntries(jobs.map(job => [job.id, job])), scores: {} };
  const ui = await rendererFixture(browser, true);
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  const count = ui.nodes['publication-count'];
  const context = (range, catalogue) => ui.window.careerBrowser.setContext({ paired: true, publicationRange: range, catalogue });
  assert.equal(ui.stageCount('jobs').textContent, '');
  assert.equal(count.textContent, '');
  context('past_3_days', { status: 'ready', range: 'past_3_days', total: 671, catalogueTotal: 9000 });
  assert.equal(ui.stageCount('jobs').textContent, ' 9,000');
  assert.equal(count.textContent, ' · 671');
  assert.equal(ui.nodes['career-list-status'].textContent, '1–25');
  ui.nodes['career-next'].fire('click');
  await ui.settle();
  assert.equal(ui.nodes['career-list-status'].textContent, '26–27');
  assert.equal(ui.stageCount('jobs').textContent, ' 9,000');
  const input = ui.nodes['publication-range'];
  input.value = '3';
  input.fire('input');
  assert.equal(count.textContent, '');
  context('past_week', { status: 'ready', range: 'past_3_days', total: 671, catalogueTotal: 9000 });
  assert.equal(count.textContent, '');
  context('past_week', { status: 'loading', range: 'past_week', total: 671, catalogueTotal: 9000 });
  assert.equal(count.textContent, '');
  assert.equal(ui.stageCount('jobs').textContent, ' 9,000');
  context('past_week', { status: 'ready', range: 'past_week', total: 1203, catalogueTotal: 9000 });
  assert.equal(count.textContent, ' · 1,203');
  for (const status of ['idle', 'loading', 'failed']) {
    context('past_week', { status, range: 'past_week', total: null, catalogueTotal: null });
    assert.equal(count.textContent, '');
    assert.equal(ui.stageCount('jobs').textContent, '');
  }
  context('today', { status: 'ready', range: 'today', total: 0, catalogueTotal: 0 });
  assert.equal(count.textContent, ' · 0');
  assert.equal(ui.stageCount('jobs').textContent, ' 0');
});

test('each Jobs stage preserves its active tab and controls when empty', async () => {
  const { browser } = fixture();
  const ui = await rendererFixture(browser, false);
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  for (const view of ['reviewed', 'jobs']) {
    ui.nodes[`career-stage-${view}`].fire('click');
    await ui.settle();
    assert.equal(ui.nodes['stage-jobs'].hidden, view !== 'jobs');
    assert.equal(ui.nodes['review-launch'].hidden, false);
    assert.equal(ui.nodes['delete-rankings'].hidden, view !== 'reviewed');
    assert.equal(ui.nodes['delete-rankings'].disabled, false);
    for (const candidate of ['stage-jobs', 'stage-reviewed', 'category-blocks'])
      assert.equal(ui.nodes[`career-${candidate}`].attributes.get('aria-selected'), String(candidate === `stage-${view}`));
  }
  for (const kind of ['blocks']) {
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

test('the empty Jobs list names the real reason with one action, and follows account and feed state', async () => {
  const { browser } = fixture();
  const ui = await rendererFixture(browser, true);
  const status = () => ui.nodes['career-list-status'].textContent, action = ui.nodes['career-list-action'];
  ui.window.careerBrowser.setContext({ paired: false });
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  assert.equal(status(), 'Connect your account to see new jobs.');
  assert.equal(action.hidden, false);
  assert.equal(action.textContent, 'Connect account');
  // State broadcasts update the empty state in place, without reloading the list.
  const listCalls = () => ui.calls.filter(call => call.operation === 'career-list').length, before = listCalls();
  ui.window.careerBrowser.setContext({ paired: true, catalogue: { status: 'loading', range: 'past_3_days' } });
  assert.equal(status(), 'Loading jobs…');
  assert.equal(action.hidden, true);
  ui.window.careerBrowser.setContext({ paired: true, catalogue: { status: 'failed', range: 'past_3_days', reason: 'offline' } });
  assert.equal(action.textContent, 'Retry');
  action.fire('click');
  await ui.settle();
  assert.deepEqual(ui.calls.at(-1), { operation: 'jobs-load', args: {} });
  ui.window.careerBrowser.setContext({ paired: true, catalogue: { status: 'ready', range: 'past_3_days', total: 0 } });
  assert.equal(status(), 'No jobs published in the past 3 days. Choose a longer range.');
  assert.equal(action.hidden, true);
  assert.equal(listCalls(), before);
  // Reviewed keeps its own empty state, without the Jobs action.
  ui.nodes['career-stage-reviewed'].fire('click');
  await ui.settle();
  assert.equal(status(), 'Nothing reviewed yet. Continue in Codex or Claude to review the jobs in this window.');
  assert.equal(action.hidden, true);
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
  assert.match(html, /<button id="career-category-blocks" type="button" class="tab" role="tab" data-career-kind="blocks" aria-selected="false" disabled>Blocked<span class="stage-count" data-stage-count="blocks"><\/span><\/button>/);
  // Applications left Jobs for its own Pipeline section: no tab, filter row or list code remains.
  for (const removed of ['career-category-applications', 'data-career-kind="applications"', 'data-stage-count="applications"', 'career-stage-filter'])
    assert.equal(html.includes(removed) || css.includes(removed), false, removed);
  assert.deepEqual([...html.matchAll(/data-view="([a-z]+)">([^<]+)</g)].map(match => match[2]), ['Me', 'Jobs', 'Pipeline', 'Settings', 'Help']);
  const me = html.match(/<div class="tabs" role="tablist" aria-label="Saved career records">[\s\S]*?<\/div>/)[0];
  assert.deepEqual([...me.matchAll(/data-career-kind="([^"]+)"/g)].map(match => match[1]), ['master', 'sources', 'facts', 'preferences']);
  assert.match(html, /<section id="view-pipeline" class="career-view pipeline-view" aria-label="Pipeline" hidden>/);
  assert.match(html, /<script src="pipeline.js" defer><\/script>\s*<script src="career-browser.js" defer><\/script>/);
  assert.match(css, /^#career-browser \{ grid-template-rows: auto auto minmax\(0, 1fr\); \}$/m);
  // Four explicit rows, each child pinned to one, so hidden children never let the records take the `auto` row.
  assert.match(css, /^\.career-list \{[^}]*grid-template-rows: auto auto minmax\(0, 1fr\) auto;[^}]*overflow: hidden; \}$/m);
  for (const [selector, row] of [['.career-list .panel-head', 2], ['.career-list > .ghost, .career-list > .primary', 3], ['.career-records', 3], ['.career-list .pagination', 4]])
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
  assert.equal(ui.nodes['career-list-status'].textContent, 'Blocked Example Labs · 1–2');
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

test('CV detail offers explicit deletion and preserves the local reader on cancel or failure', async () => {
  const { state, browser } = fixture();
  state.career.sources.cv = { id: 'cv', name: 'Selected CV', purpose: 'cv', text: 'Synthetic CV', contentHash: 'synthetic-hash' };
  state.career.sources.other = { id: 'other', name: 'Other CV', purpose: 'cv', text: 'Other synthetic CV', contentHash: 'other-hash' };
  let outcome = 'cancel', pending, release;
  const ui = await rendererFixture(browser, false, { 'cv-delete': async args => {
    assert.deepEqual(args, { sourceId: 'cv', contentHash: 'synthetic-hash' });
    if (outcome === 'cancel') return { cancelled: true };
    if (outcome === 'failure') throw new Error('Could not save the local profile.');
    await pending;
    delete state.career.sources.cv;
    return { deleted: true, sourceId: 'cv' };
  } });
  await ui.window.careerBrowser.refresh();
  const row = ui.rows('me').find(button => ui.byClass(button, 'career-record-title').textContent === 'Selected CV');
  row.fire('click'); await ui.settle();
  const content = ui.nodes['me-reader-content'];
  const action = content.querySelectorAll('button').find(button => button.textContent === 'Delete CV');
  assert.ok(action);
  action.fire('click'); await ui.settle();
  assert.ok(state.career.sources.cv);
  assert.equal(action.disabled, false);
  outcome = 'failure';
  action.fire('click'); await ui.settle();
  assert.equal(ui.nodes['me-reader-title'].textContent, 'Selected CV');
  assert.ok(state.career.sources.cv);
  outcome = 'success';
  pending = new Promise(resolve => { release = resolve; });
  action.fire('click');
  assert.equal(action.disabled, true);
  action.fire('click');
  assert.equal(ui.calls.filter(call => call.operation === 'cv-delete').length, 3);
  release(); await ui.settle();
  assert.equal(state.career.sources.cv, undefined);
  assert.ok(state.career.sources.other);
  assert.equal(ui.nodes['me-list-status'].textContent, 'CV deleted.');
});

async function savedPdfFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'career-browser-pdf-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { state, store } = fixture();
  state.deviceId = 'synthetic-document-reader';
  const files = createDocumentFiles({ directory, store, assertAvailable() {} });
  state.career.profile.name = 'Synthetic Candidate';
  const ready = await readyMaster({ get: store.get, async update(change) {
    const next = structuredClone(state);
    await change(next);
    Object.assign(state, next);
  } });
  const job = catalogueJob('local:exact', currentDate(), { title: 'Engineer', company: 'Same employer',
    url: 'https://jobs.example.test/roles/exact', applyUrl: 'https://jobs.example.test/roles/exact' });
  state.career.matching = { jobs: { [job.id]: job }, scores: {} };
  state.career.applications.exact = { id: 'exact', job: { ...job }, exports: [] };
  const binding = { masterVersion: ready.master.version,
    contextFingerprint: applicationContextFingerprint(state.career, state.career.applications.exact) };
  state.career.applications.exact.cv = { version: 1, ...binding, document: ready.document };
  const pdf = await files.exportDocument({ applicationId: 'exact', kind: 'cv', bytes: Buffer.from('%PDF-1.7\nsynthetic saved CV\n%%EOF'), mediaType: 'application/pdf' });
  const exported = { ...pdf, ...binding, createdAt: '2025-01-02T12:00:00.000Z' };
  state.career.applications.exact.exports.push(exported);
  const saveLetter = async (text, createdAt) => {
    const app = state.career.applications.exact;
    const binding = { masterVersion: ready.master.version, contextFingerprint: applicationContextFingerprint(state.career, app) };
    app.coverLetter = { version: 1, ...binding, paragraphs: [text] };
    const letter = await files.exportDocument({ applicationId: 'exact', kind: 'cover_letter',
      bytes: Buffer.from(`%PDF-1.7\n${text}\n%%EOF`), mediaType: 'application/pdf' });
    app.exports.push({ ...letter, ...binding, createdAt });
    return letter;
  };
  const opened = [];
  const browser = createCareerBrowser({ store, files, openPath: async filename => { opened.push(filename); return ''; } });
  const args = async (kind = 'jobs', id = job.id) => {
    const detail = await browser.read({ kind, id });
    return { kind, id, document: 'cv', token: detail.documents.find(item => item.kind === 'cv').token };
  };
  return { state, store, files, browser, opened, pdf, job, exported, args, saveLetter };
}

test('saved PDFs bind to the exact job and application, expose no paths and open through private resources', async t => {
  const f = await savedPdfFixture(t);
  const other = { ...f.job, id: 'local:other', url: 'https://jobs.example.test/roles/other', applyUrl: 'https://jobs.example.test/roles/other' };
  f.state.career.matching.jobs[other.id] = other;
  const page = await f.browser.list({ kind: 'jobs' });
  assert.ok(page.items.every(item => item.documents === undefined));
  const exact = await f.browser.read({ kind: 'jobs', id: f.job.id });
  assert.equal((await f.browser.read({ kind: 'jobs', id: other.id })).documents, undefined);
  assert.deepEqual(exact.documents.map(item => [item.kind, item.status]), [['cv', 'saved'], ['cover_letter', 'missing']]);
  assert.equal(exact.documents[0].createdAt, f.exported.createdAt);
  assert.equal(JSON.stringify({ page, exact }).includes(f.pdf.path), false);
  assert.equal(JSON.stringify({ page, exact }).includes(f.pdf.uri), false);
  const args = await f.args();
  await assert.rejects(f.browser.openDocument({ ...args, id: other.id }), { code: 'DOCUMENT_MISSING' });
  for (const extra of [{ path: f.pdf.path }, { uri: f.pdf.uri }, { applicationId: 'exact' }])
    await assert.rejects(f.browser.openDocument({ ...args, ...extra }), { code: 'INVALID_INPUT' });
  assert.deepEqual(await f.browser.openDocument(args), { opened: true });
  assert.deepEqual(await f.browser.openDocument(await f.args('applications', 'exact')), { opened: true });
  assert.deepEqual(f.opened, [f.pdf.path, f.pdf.path]);
  f.state.deviceId = 'synthetic-document-reader-reset';
  await assert.rejects(f.browser.openDocument(args), { code: 'DOCUMENT_UNAVAILABLE' });
  assert.deepEqual(f.opened, [f.pdf.path, f.pdf.path]);
});

test('saved document discovery reuses ATS identity and refuses ambiguous application selection', async t => {
  const f = await savedPdfFixture(t);
  f.job.applyUrl = 'https://boards.greenhouse.io/example/jobs/123/application';
  f.job.url = f.job.applyUrl;
  f.state.career.applications.exact.job = { title: 'Engineer', company: 'Same employer', url: 'https://boards.greenhouse.io/example/jobs/123' };
  assert.equal((await f.browser.read({ kind: 'jobs', id: f.job.id })).documents[0].status, 'saved');
  f.state.career.applications.duplicate = { ...f.state.career.applications.exact, id: 'duplicate' };
  const detail = await f.browser.read({ kind: 'jobs', id: f.job.id });
  assert.deepEqual(detail.documents, []);
  assert.ok(detail.documentNotice);
  assert.equal((await f.browser.read({ kind: 'applications', id: 'exact' })).documents[0].status, 'saved');
});

test('missing, changed, symlinked and arbitrary saved resource references never reach the native shell', async t => {
  const f = await savedPdfFixture(t);
  const args = await f.args();
  await writeFile(f.pdf.path, '%PDF-1.7\nchanged bytes\n%%EOF', { mode: 0o600 });
  await assert.rejects(f.browser.openDocument(args), { code: 'DOCUMENT_UNAVAILABLE' });
  assert.equal((await f.browser.read({ kind: 'applications', id: 'exact' })).documents[0].status, 'unavailable');
  await unlink(f.pdf.path);
  await assert.rejects(f.browser.openDocument(args), { code: 'DOCUMENT_UNAVAILABLE' });
  const target = path.join(path.dirname(f.pdf.path), 'unrelated.pdf');
  await writeFile(target, '%PDF-1.7\nsynthetic saved CV\n%%EOF', { mode: 0o600 });
  if (process.platform !== 'win32') {
    await symlink(target, f.pdf.path);
    await assert.rejects(f.browser.openDocument(args), { code: 'DOCUMENT_UNAVAILABLE' });
  }
  for (const uri of [target, `file://${target}`, 'recruiters://exports/../../unrelated.pdf']) {
    f.exported.uri = uri;
    assert.equal((await f.browser.read({ kind: 'applications', id: 'exact' })).documents[0].status, 'unavailable');
  }
  assert.deepEqual(f.opened, []);
});

test('selection and file validity are rechecked after asynchronous resolution, without opening replacements', async t => {
  const f = await savedPdfFixture(t);
  const args = await f.args();
  const original = structuredClone(f.state.career.applications.exact);
  for (const resolution of [1, 2]) {
    for (const change of [
      () => { f.state.career.applications.exact.job.url = 'https://other.example.test/job'; },
      () => { f.state.career.applications.exact.exports[0].documentVersion++; },
      () => { delete f.state.career.applications.exact; },
    ]) {
      let calls = 0;
      f.state.career.applications.exact = structuredClone(original);
      const browser = createCareerBrowser({ store: f.store, files: { async resolveExport(uri) {
        const filename = await f.files.resolveExport(uri);
        if (++calls === resolution) change();
        return filename;
      } }, openPath: () => assert.fail('Changed selection must not open') });
      await assert.rejects(browser.openDocument(args));
      assert.equal(calls, resolution);
    }
  }
  f.state.career.applications.exact = structuredClone(original);
  let calls = 0;
  const browser = createCareerBrowser({ store: f.store, files: { async resolveExport(uri) {
    const filename = await f.files.resolveExport(uri);
    if (++calls === 1) await writeFile(filename, '%PDF-1.7\nchanged after validation\n%%EOF');
    return filename;
  } }, openPath: () => assert.fail('Changed file must not open') });
  await assert.rejects(browser.openDocument(args), { code: 'DOCUMENT_UNAVAILABLE' });
});

test('selected detail groups exact job and document actions once, preserves counts and narrow selection', async t => {
  const f = await savedPdfFixture(t);
  f.state.career.applications.exact.job.applyUrl = 'https://jobs.example.test/roles/exact/apply';
  const letter = await f.saveLetter('synthetic letter for grouped actions', '2025-02-03T12:00:00.000Z');
  const pages = { jobs: await f.browser.list({ kind: 'jobs' }) };
  let application = await f.browser.read({ kind: 'applications', id: 'exact' });
  let job = await f.browser.read({ kind: 'jobs', id: f.job.id });
  const urls = [];
  let opening;
  const ui = await rendererFixture({
    list: args => pages[args.kind] ?? f.browser.list(args),
    read: args => args.kind === 'applications' ? application : args.kind === 'jobs' ? job : f.browser.read(args),
    pipeline: args => f.browser.pipeline(args),
  }, false, {
    'career-open-document': args => (opening = f.browser.openDocument(args)),
    'career-open-job': args => (opening = openJobPage({ store: f.store, openExternal: async url => { urls.push(url); } }, args)),
  });
  await ui.window.careerBrowser.refresh();
  assert.equal(ui.nodes['career-records'].querySelectorAll('button').length, ui.rows('career').length);
  const count = ui.nodes['career-list-status'].textContent;
  assert.equal(ui.nodes['career-reader'].hidden, true);
  ui.rows('career')[0].fire('click'); await ui.settle();
  const content = ui.nodes['career-reader-content'];
  const files = ui.byClass(content, 'career-files');
  assert.ok(content.children.indexOf(files) > content.children.indexOf(ui.byClass(content, 'career-reader-meta')));
  const actions = files.querySelectorAll('button');
  assert.deepEqual(actions.map(button => button.dataset.careerAction), ['job', 'cv', 'cover_letter']);
  assert.equal(new Set(actions.map(button => button.className)).size, 1);
  assert.equal(content.querySelectorAll('button').filter(button => button.dataset.careerAction).length, 3);
  const columns = files.querySelectorAll('.career-document-action');
  assert.equal(columns[1].querySelector('button'), actions[1]);
  assert.equal(columns[2].querySelector('button'), actions[2]);
  assert.notEqual(columns[1].querySelector('.caption').textContent, columns[2].querySelector('.caption').textContent);
  for (const button of actions) { button.fire('click'); await opening; await ui.settle(); }
  assert.deepEqual(f.opened, [f.pdf.path, letter.path]);
  assert.deepEqual(urls, [f.job.applyUrl]);
  assert.equal(ui.nodes['career-list-status'].textContent, count);
  assert.equal(ui.notices.at(-1)[1], 'document-open');
  assert.deepEqual(ui.calls.find(call => call.operation === 'career-open-document').args, await f.args());
  actions[1].focus();
  ui.nodes['career-reader'].scrollTop = 120;
  await ui.window.careerBrowser.refresh(); await ui.settle();
  assert.equal(ui.focused(), actions[1]);
  assert.equal(ui.nodes['career-reader'].scrollTop, 120);
  assert.equal(ui.nodes['career-records'].querySelectorAll('[aria-current]').length, 1);
  f.exported.createdAt = '2025-04-05T12:00:00.000Z';
  job = await f.browser.read({ kind: 'jobs', id: f.job.id });
  application = await f.browser.read({ kind: 'applications', id: 'exact' });
  await ui.window.careerBrowser.refresh(); await ui.settle();
  const refreshedAction = content.querySelectorAll('button').find(button => button.dataset.document === 'cv');
  assert.notEqual(refreshedAction, actions[1]);
  assert.equal(ui.focused(), refreshedAction);
  assert.equal(ui.nodes['career-reader'].scrollTop, 120);
  assert.equal(ui.nodes['career-records'].querySelectorAll('[aria-current]').length, 1);
  assert.ok(ui.calls.filter(call => call.operation === 'career-read' && call.args.kind === 'jobs').length >= 3);
  // The same reader opens beside Pipeline: Progress leads, then the Application metadata, then Job and documents.
  ui.byClass(ui.nodes['pipeline-records'], 'pipeline-card-open').fire('click'); await ui.settle();
  const appContent = ui.nodes['pipeline-reader-content'];
  const appFiles = ui.byClass(appContent, 'career-files');
  assert.deepEqual(appContent.children.slice(0, 3).map(child => child.className || child.children[0]?.textContent), ['career-progress', 'Application', 'career-files']);
  const appActions = appFiles.querySelectorAll('button');
  appActions[0].fire('click'); await opening; await ui.settle();
  assert.deepEqual(urls, [f.job.applyUrl, f.state.career.applications.exact.job.applyUrl]);
  assert.deepEqual(ui.calls.filter(call => call.operation === 'career-open-job').at(-1).args, { kind: 'applications', id: 'exact' });
  appActions[1].fire('click'); await opening; await ui.settle();
  assert.deepEqual(ui.calls.filter(call => call.operation === 'career-open-document').at(-1).args, await f.args('applications', 'exact'));
  const applicationCount = ui.nodes['pipeline-list-status'].textContent;
  await unlink(f.pdf.path);
  appActions[1].fire('click');
  await assert.rejects(opening, { code: 'DOCUMENT_UNAVAILABLE' }); await ui.settle();
  assert.equal(ui.nodes['pipeline-list-status'].textContent, applicationCount);
  assert.equal(ui.notices.at(-1)[1], 'error');
});

test('CV and letter select separate saved PDFs and shell failures are not reported as opened', async t => {
  const f = await savedPdfFixture(t);
  const letter = await f.saveLetter('synthetic saved letter', '2025-01-03T12:00:00.000Z');
  const detail = await f.browser.read({ kind: 'applications', id: 'exact' });
  const args = { kind: 'applications', id: 'exact', document: 'cover_letter', token: detail.documents[1].token };
  await assert.rejects(f.browser.openDocument({ ...args, document: 'cv' }), { code: 'DOCUMENT_CHANGED' });
  assert.deepEqual(await f.browser.openDocument(args), { opened: true });
  assert.deepEqual(f.opened, [letter.path]);
  const unavailable = createCareerBrowser({ store: f.store, files: f.files, openPath: async () => 'No application registered' });
  await assert.rejects(unavailable.openDocument(args), { code: 'DOCUMENT_UNAVAILABLE' });
});

test('application job opening uses its exact saved destination, not a colliding job ID or renderer URL', async t => {
  const f = await savedPdfFixture(t);
  f.state.career.matching.jobs.exact = catalogueJob('exact', currentDate(), { applyUrl: 'https://other.example.test/unrelated' });
  const opened = [], access = { store: f.store, openExternal: async url => { opened.push(url); } };
  await openJobPage(access, { kind: 'applications', id: 'exact' });
  await openJobPage(access, { kind: 'jobs', id: 'exact' });
  assert.deepEqual(opened, [f.job.applyUrl, 'https://other.example.test/unrelated']);
  await assert.rejects(openJobPage(access, { kind: 'applications', id: f.job.id }), { code: 'NOT_FOUND' });
  await assert.rejects(openJobPage(access, { kind: 'applications', id: 'exact', url: 'https://foreign.example' }), { code: 'INVALID_INPUT' });
  await assert.rejects(openJobPage(access, { id: 'exact' }), { code: 'INVALID_INPUT' });
  f.state.career.applications.exact.job = { url: 'file:///private/unrelated.pdf' };
  assert.equal((await f.browser.read({ kind: 'applications', id: 'exact' })).jobPage, false);
  await assert.rejects(openJobPage(access, { kind: 'applications', id: 'exact' }), { code: 'NOT_FOUND' });
  assert.equal(opened.length, 2);
});

test('list refresh never validates PDFs; only the selected detail resolves its saved files', async t => {
  const f = await savedPdfFixture(t);
  const resolved = [];
  const browser = createCareerBrowser({ store: f.store, files: { async resolveExport(uri) {
    resolved.push(uri);
    return f.files.resolveExport(uri);
  } } });
  for (const load of [() => browser.list({ kind: 'jobs' }), () => browser.pipeline()]) {
    const first = await load();
    await load();
    assert.equal(JSON.stringify(first).includes('"documents":['), false);
    assert.equal(JSON.stringify(first).includes('"token"'), false);
  }
  assert.deepEqual(resolved, []);
  const detail = await browser.read({ kind: 'jobs', id: f.job.id });
  assert.equal(detail.documents[0].status, 'saved');
  assert.deepEqual(resolved, [f.pdf.uri]);
  await unlink(f.pdf.path);
  assert.equal((await browser.read({ kind: 'jobs', id: f.job.id })).documents[0].status, 'unavailable');
});

// Applications with recorded progress; dates are in 2025 so short dates always carry the year.
function progressFixture() {
  const state = { career: createCareerState() };
  const store = { get: () => structuredClone(state), update: async change => { const next = structuredClone(state); await change(next); Object.assign(state, next); } };
  const steps = (...entries) => replayProgress(entries.map(([stage, at]) => ({ stage, at })));
  const app = (id, progress, documents = {}) => {
    state.career.applications[id] = { id, job: { title: id, company: 'Example' }, cv: null, coverLetter: null, cvHistory: [], coverLetterHistory: [], exports: [],
      createdAt: '2025-10-01T10:00:00Z', updatedAt: '2025-10-01T10:00:00Z', ...(progress ? { progress } : {}), ...documents };
  };
  const both = { cv: { version: 1 }, coverLetter: { version: 1, paragraphs: ['Dear team,', 'Hello.'] } };
  const set = args => setApplicationProgress({ store }, args);
  const from = id => ({ stage: replayProgress(state.career.applications[id].progress?.history ?? []).stage,
    round: replayProgress(state.career.applications[id].progress?.history ?? []).round ?? 0, steps: state.career.applications[id].progress?.history.length ?? 0,
    ...(state.career.applications[id].progress?.nextInterviewAt ? { nextInterviewAt: state.career.applications[id].progress.nextInterviewAt } : {}) });
  return { state, store, steps, app, both, set, from, browser: createCareerBrowser({ store }) };
}

test('Pipeline puts every application in its stage column with the last step and change identity, without document readiness', async () => {
  const { steps, app, both, browser } = progressFixture();
  app('prepared', null, both);
  app('applied', steps(['applied', '2025-10-21']));
  app('round 1', steps(['applied', '2025-10-20'], ['interviewing', '2025-10-31']), both);
  app('round 2', steps(['applied', '2025-10-21'], ['interviewing', '2025-10-24'], ['interviewing', '2025-10-30']), { cv: { version: 1 } });
  app('offer', steps(['applied', '2025-10-01'], ['interviewing', '2025-10-02'], ['offer', '2025-11-05']));
  app('hired', steps(['applied', '2025-09-01'], ['interviewing', '2025-09-02'], ['offer', '2025-09-03'], ['hired', '2025-09-04']));
  app('rejected', steps(['applied', '2025-10-21'], ['interviewing', '2025-10-24'], ['rejected', '2025-11-02']), both);
  app('declined', steps(['applied', '2025-10-01'], ['interviewing', '2025-10-02'], ['offer', '2025-10-03'], ['withdrawn', '2025-10-04']));
  const board = await browser.pipeline();
  assert.equal(board.total, 8);
  assert.deepEqual(board.columns.map(column => [column.id, column.cards.map(card => [card.title, card.detail])]), [
    ['prepared', [['prepared', 'Created 1 Oct 2025']]],
    ['applied', [['applied', 'Applied · 21 Oct 2025']]],
    // The later round leads even though round 1 moved more recently.
    ['interviewing', [['round 2', 'Round 2 · 30 Oct 2025'], ['round 1', 'Round 1 · 31 Oct 2025']]],
    ['offer', [['offer', 'Offer · 5 Nov 2025']]],
    ['hired', [['hired', 'Hired · 4 Sept 2025']]],
    ['closed', [['rejected', 'Rejected after round 1 · 2 Nov 2025'], ['declined', 'Declined offer · 4 Oct 2025']]],
  ]);
  assert.deepEqual(board.columns[2].cards[0], { id: 'round 2', title: 'round 2', company: 'Example', stage: 'interviewing',
    detail: 'Round 2 · 30 Oct 2025', from: { stage: 'interviewing', round: 2, steps: 3 } });
  assert.ok(board.columns.flatMap(column => column.cards).every(card => !Object.hasOwn(card, 'documents')));
  await assert.rejects(browser.pipeline({ stage: 'applied' }), { code: 'INVALID_INPUT' });
  // Applications are no longer a Jobs list.
  await assert.rejects(browser.list({ kind: 'applications' }), { code: 'INVALID_INPUT' });
  assert.equal(Object.hasOwn((await browser.list({ kind: 'jobs' })).counts, 'applications'), false);

  const progress = async id => (await browser.read({ kind: 'applications', id })).progress;
  assert.deepEqual(await progress('round 2'), { headline: 'Interview round 2 · 30 Oct 2025', from: { stage: 'interviewing', round: 2, steps: 3 }, at: '2025-10-30',
    actions: [{ label: 'Next round', nextRound: true }, { label: 'Offer', move: 'offer' }, { label: 'Rejected', move: 'rejected' },
      { label: 'Withdrew', move: 'withdrawn', quiet: true }],
    history: [{ date: '30 Oct 2025', label: 'Interview round 2' }, { date: '24 Oct 2025', label: 'Interview round 1' }, { date: '21 Oct 2025', label: 'Applied' }] });
  assert.deepEqual(await progress('prepared'), { headline: 'Not applied yet', from: { stage: 'prepared', round: 0, steps: 0 }, at: null,
    actions: [{ label: 'Mark applied', move: 'applied' }], history: [] });
  assert.deepEqual((await progress('offer')).actions.map(action => action.label), ['Accepted', 'Declined']);
  assert.equal((await progress('declined')).headline, 'Declined offer · 4 Oct 2025');
});

test('Pipeline moves fill skipped steps, undo backwards, close as rejected or withdrew and add interview rounds', async () => {
  const { state, steps, app, set, from } = progressFixture();
  const history = id => state.career.applications[id].progress.history.map(step => [step.stage, step.round ?? null, step.at]);
  app('a', null);
  // Forward: Prepared → Interviewing records applied and round 1, dated as given.
  assert.equal((await set({ id: 'a', from: from('a'), move: 'interviewing', at: '2025-11-01' })).changed, true);
  assert.deepEqual(history('a'), [['applied', null, '2025-11-01'], ['interviewing', 1, '2025-11-01']]);
  assert.equal((await set({ id: 'a', from: from('a'), nextRound: true, at: '2025-11-03' })).progress.round, 2);
  // Prepared → Offer always passes through an interview.
  app('b', null);
  await set({ id: 'b', from: from('b'), move: 'offer', at: '2025-11-01' });
  assert.deepEqual(history('b').map(([stage]) => stage), ['applied', 'interviewing', 'offer']);
  // Backward: undo steps until the card reaches the column; nothing new is recorded.
  await set({ id: 'a', from: from('a'), move: 'applied', at: '2025-11-05' });
  assert.deepEqual(history('a'), [['applied', null, '2025-11-01']]);
  await set({ id: 'a', from: from('a'), move: 'prepared' });
  assert.deepEqual(state.career.applications.a.progress, { stage: 'prepared', history: [] });
  // Closed: the user's choice; where it ended is kept, and moving out of Closed undoes the ending.
  app('c', steps(['applied', '2025-10-21'], ['interviewing', '2025-10-24']));
  const rejected = (await set({ id: 'c', from: from('c'), move: 'rejected', at: '2025-10-28' })).progress;
  assert.deepEqual([rejected.stage, rejected.atStage, rejected.round], ['rejected', 'interviewing', 1]);
  const withdrew = (await set({ id: 'c', from: from('c'), move: 'withdrawn', at: '2025-10-29' })).progress;
  assert.deepEqual([withdrew.stage, withdrew.atStage, withdrew.history.length], ['withdrawn', 'interviewing', 3]);
  await set({ id: 'c', from: from('c'), move: 'interviewing', at: '2025-10-30' });
  assert.deepEqual(history('c'), [['applied', null, '2025-10-21'], ['interviewing', 1, '2025-10-24']]);
  app('d', null);
  await set({ id: 'd', from: from('d'), move: 'withdrawn', at: '2025-10-30' });
  assert.deepEqual(history('d').map(([stage]) => stage), ['applied', 'withdrawn']);
  // Dates still never run backwards or into the future.
  await assert.rejects(set({ id: 'c', from: from('c'), move: 'offer', at: '2025-10-01' }), { code: 'INVALID_PROGRESS' });
  await assert.rejects(set({ id: 'c', from: from('c'), move: 'offer', at: '2099-01-01' }), { code: 'INVALID_PROGRESS' });
  await assert.rejects(set({ id: 'a', from: from('a'), nextRound: true }), { code: 'INVALID_PROGRESS' });
  for (const args of [{ id: 'a', move: 'applied' }, { id: 'a', from: { stage: 'prepared', round: 0 }, move: 'applied' },
    { id: 'a', from: from('a'), move: 'closed' }, { id: 'a', from: from('a'), move: 'applied', undo: true }, { id: 'a', from: from('a') },
    { id: 'a', from: from('a'), undo: true, at: '2025-10-01' }, { id: 'a', from: from('a'), nextRound: 'yes' }, { id: '__proto__', from: from('a'), undo: true },
    { id: 'a', from: from('a'), move: 'applied', steps: 0 }])
    await assert.rejects(set(args), { code: 'INVALID_INPUT' }, JSON.stringify(args));
  await assert.rejects(set({ id: 'missing', from: from('a'), move: 'applied' }), { code: 'NOT_FOUND' });
});

test('a repeated click or drag never conflicts with itself; only a change made meanwhile is reported', async () => {
  const { state, app, set, from } = progressFixture();
  app('lifi', null);
  // The owner's report: Mark applied, then the same click again before the reader redrew (a double click).
  const shown = from('lifi'), revision = state.career.revision;
  assert.equal((await set({ id: 'lifi', from: shown, move: 'applied', at: '2025-11-01' })).changed, true);
  assert.deepEqual(await set({ id: 'lifi', from: shown, move: 'applied', at: '2025-11-01' }),
    { progress: state.career.applications.lifi.progress, changed: false });
  assert.equal(state.career.applications.lifi.progress.history.length, 1);
  assert.equal(state.career.revision, revision + 1);
  // Next round twice from the same view adds one round, not two; a repeated date change is also already done.
  await set({ id: 'lifi', from: from('lifi'), move: 'interviewing', at: '2025-11-01' });
  const interview = from('lifi');
  await set({ id: 'lifi', from: interview, nextRound: true, at: '2025-11-02' });
  assert.equal((await set({ id: 'lifi', from: interview, nextRound: true, at: '2025-11-02' })).changed, false);
  assert.equal(state.career.applications.lifi.progress.round, 2);
  const dated = from('lifi');
  await set({ id: 'lifi', from: dated, at: '2025-11-03' });
  assert.equal((await set({ id: 'lifi', from: dated, at: '2025-11-03' })).changed, false);
  // Someone else moved it meanwhile (the AI app recorded an offer): a stale move, round or undo is reported, never stacked.
  const stale = from('lifi');
  state.career.applications.lifi.progress = replayProgress([...state.career.applications.lifi.progress.history, { stage: 'offer', at: '2025-11-04' }]);
  for (const change of [{ move: 'rejected' }, { nextRound: true }, { undo: true }, { at: '2025-11-04' }])
    await assert.rejects(set({ id: 'lifi', from: stale, ...change }), { code: 'PROGRESS_CHANGED' }, JSON.stringify(change));
  assert.equal(state.career.applications.lifi.progress.stage, 'offer');
  // A move to where it already is succeeds whatever was shown.
  assert.equal((await set({ id: 'lifi', from: stale, move: 'offer' })).changed, false);
});

test('Pipeline schedule DTOs and mutations save, reschedule and clear dates with optimistic concurrency and exact retries', async () => {
  const { state, app, set, from, browser } = progressFixture();
  app('scheduled', null);
  const id = 'scheduled', initial = from(id);
  const enter = { id, from: initial, move: 'interviewing', at: '2025-10-24', nextInterviewAt: '2099-05-17' };
  assert.equal((await set(enter)).changed, true);
  assert.equal((await set(enter)).changed, false);
  const card = (await browser.pipeline()).columns[2].cards[0];
  const detail = await browser.read({ kind: 'applications', id });
  assert.equal(card.nextInterviewAt, '2099-05-17');
  assert.equal(detail.progress.nextInterviewAt, card.nextInterviewAt);
  assert.deepEqual(card.from, { stage: 'interviewing', round: 1, steps: 2, nextInterviewAt: '2099-05-17' });
  assert.deepEqual(detail.progress.from, card.from);
  assert.equal(detail.progress.at, '2025-10-24');
  assert.ok(Array.isArray(detail.documents), 'Detailed reader retains document controls');
  const schedule = { id, from: card.from, nextInterviewAt: '2099-05-18' }, revision = state.career.revision;
  const history = structuredClone(state.career.applications[id].progress.history);
  assert.equal((await set(schedule)).changed, true);
  assert.equal((await set(schedule)).changed, false);
  assert.equal(state.career.revision, revision + 1);
  assert.deepEqual(state.career.applications[id].progress.history, history);
  // A stale view must not erase a reschedule, advance its round or leave the stage.
  for (const change of [{ nextInterviewAt: null }, { nextInterviewAt: '2099-05-19' }, { nextRound: true }, { move: 'offer' }, { undo: true }, { at: '2025-10-25' }])
    await assert.rejects(set({ id, from: card.from, ...change }), { code: 'PROGRESS_CHANGED' });
  assert.equal(state.career.applications[id].progress.nextInterviewAt, '2099-05-18');
  const current = from(id);
  for (const nextInterviewAt of ['2099-02-29', '2099-04-31', '2099-05-17T00:00:00Z', '', 123, false]) {
    const before = structuredClone(state);
    await assert.rejects(set({ id, from: current, nextInterviewAt }), { code: 'INVALID_INPUT' });
    assert.deepEqual(state, before);
  }
  await set({ id, from: from(id), at: '2025-10-25' });
  assert.equal(state.career.applications[id].progress.nextInterviewAt, '2099-05-18');
  const clear = { id, from: from(id), nextInterviewAt: null };
  assert.equal((await set(clear)).changed, true);
  assert.equal((await set(clear)).changed, false);
  assert.equal(Object.hasOwn(state.career.applications[id].progress, 'nextInterviewAt'), false);
  assert.equal(Object.hasOwn((await browser.pipeline()).columns[2].cards[0], 'nextInterviewAt'), false);
  const clearedReader = (await browser.read({ kind: 'applications', id })).progress;
  assert.equal(Object.hasOwn(clearedReader, 'nextInterviewAt'), false);
  assert.equal(Object.hasOwn(clearedReader.from, 'nextInterviewAt'), false);
  await set({ id, from: from(id), nextInterviewAt: '2099-05-19' });
  const round = { id, from: from(id), nextRound: true };
  assert.equal((await set(round)).progress.nextInterviewAt, undefined);
  assert.equal((await set(round)).changed, false);
  const newRound = { id, from: from(id), nextRound: true, nextInterviewAt: '2099-05-20' };
  assert.equal((await set(newRound)).progress.nextInterviewAt, '2099-05-20');
  assert.equal((await set(newRound)).changed, false);
  const offer = { id, from: from(id), move: 'offer' };
  assert.equal((await set(offer)).progress.nextInterviewAt, undefined);
  assert.equal((await set(offer)).changed, false);
  for (const nextInterviewAt of ['2099-05-17', null])
    await assert.rejects(set({ id, from: from(id), nextInterviewAt }), { code: 'INVALID_PROGRESS' });
  await set({ id, from: from(id), undo: true });
  assert.equal(state.career.applications[id].progress.nextInterviewAt, undefined);
});

test('the Pipeline board moves cards by keyboard and Set status…, closes inline, adds rounds and opens the shared reader', async () => {
  const { state, store, steps, app, browser } = progressFixture();
  app('tangem', steps(['applied', '2025-10-21'], ['interviewing', '2025-10-24']));
  app('example', steps(['applied', '2025-10-22']));
  app('draft', null);
  const ui = await rendererFixture(browser, true, { 'application-progress': input => setApplicationProgress({ store }, input) });
  const board = ui.nodes['pipeline-records'];
  const column = id => board.children.find(section => section.dataset.column === id);
  const titles = id => column(id).querySelectorAll('.pipeline-card-role').map(role => role.textContent);
  const card = title => board.querySelectorAll('.pipeline-card').find(item => ui.byClass(item, 'pipeline-card-role').textContent === title);
  const open = title => ui.byClass(card(title), 'pipeline-card-open');
  const status = () => ui.nodes['pipeline-list-status'].textContent;
  const lastMove = () => ui.calls.findLast(call => call.operation === 'application-progress').args;
  await ui.window.careerBrowser.refresh();
  await ui.settle();
  assert.equal(board.hidden, false);
  assert.deepEqual(board.children.map(section => section.querySelector('.pipeline-column-head').children.map(part => part.textContent)),
    [['Prepared', '1'], ['Applied', '1'], ['Interviewing', '1'], ['Offer', '0'], ['Hired', '0'], ['Closed', '0']]);
  assert.deepEqual(titles('interviewing'), ['tangem']);
  // Empty lanes say so rather than showing blank cells.
  assert.deepEqual(['offer', 'hired', 'closed'].map(id => ui.byClass(column(id), 'pipeline-empty')?.textContent), ['No applications', 'No applications', 'No applications']);
  assert.equal(ui.byClass(column('applied'), 'pipeline-empty'), null);
  assert.equal(open('tangem').attributes.get('aria-label'), 'tangem, Example, Round 1 · 24 Oct 2025');
  assert.equal(ui.byClass(card('tangem'), 'pipeline-card-interview'), null);
  assert.equal(ui.byClass(card('tangem'), 'pipeline-card-documents'), null);
  assert.deepEqual(card('tangem').querySelectorAll('button').map(button => button.textContent).slice(1), ['Next round']);
  assert.deepEqual(card('example').querySelectorAll('button').length, 1);
  // The reader is closed until a card is chosen; nothing opens by itself.
  assert.equal(ui.nodes['pipeline-reader'].hidden, true);

  // Keyboard: Right moves the focused card one column on, filling the skipped step, and focus stays on that card.
  open('draft').focus();
  open('draft').fire('keydown', { key: 'ArrowRight' });
  await ui.settle(); await ui.settle();
  assert.deepEqual(lastMove(), { id: 'draft', from: { stage: 'prepared', round: 0, steps: 0 }, move: 'applied', at: lastMove().at });
  assert.match(lastMove().at, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(titles('applied').sort(), ['draft', 'example']);
  assert.equal(status(), 'Moved draft — Example to Applied.');
  assert.equal(ui.focused(), open('draft'));
  open('draft').fire('keydown', { key: 'ArrowLeft' });
  await ui.settle(); await ui.settle();
  assert.deepEqual(titles('prepared'), ['draft']);
  assert.deepEqual(state.career.applications.draft.progress, { stage: 'prepared', history: [] });
  open('draft').fire('keydown', { key: 'ArrowLeft' });
  await ui.settle();
  assert.equal(ui.calls.filter(call => call.operation === 'application-progress').length, 2);

  // Set status…: Closed asks Rejected or Withdrew on the card, never a dialog; Escape or Cancel keeps the card where it was.
  const select = ui.byClass(card('example'), 'pipeline-move');
  assert.equal(select.attributes.get('aria-label'), 'Set status for example');
  assert.deepEqual(select.children.map(option => option.textContent), ['Set status…', 'Prepared', 'Interviewing', 'Offer', 'Hired', 'Closed']);
  select.value = 'closed';
  select.fire('change');
  const choice = ui.byClass(card('example'), 'pipeline-choice');
  assert.equal(choice.attributes.get('aria-label'), 'Close example as');
  assert.deepEqual(choice.children.map(part => part.textContent), ['Close as', 'Rejected', 'Withdrew', 'Cancel']);
  assert.equal(ui.focused(), choice.children[1]);
  choice.fire('keydown', { key: 'Escape' });
  assert.equal(ui.byClass(card('example'), 'pipeline-choice'), null);
  assert.equal(ui.focused(), open('example'));
  select.value = '';
  ui.byClass(card('example'), 'pipeline-move').value = 'closed';
  ui.byClass(card('example'), 'pipeline-move').fire('change');
  ui.byClass(card('example'), 'pipeline-choice').children[1].fire('click');
  await ui.settle(); await ui.settle();
  assert.deepEqual(titles('closed'), ['example']);
  assert.equal(state.career.applications.example.progress.atStage, 'applied');
  assert.equal(status(), 'Moved example — Example to Closed, rejected.');
  assert.equal(ui.byClass(card('example'), 'pipeline-card-detail').textContent.startsWith('Rejected after applying · '), true);

  // Next round on an Interviewing card; the second click of a double click does nothing.
  const next = card('tangem').querySelectorAll('button').find(button => button.textContent === 'Next round');
  next.fire('click');
  next.fire('click', { detail: 2 });
  await ui.settle(); await ui.settle();
  assert.equal(state.career.applications.tangem.progress.round, 2);
  assert.equal(status(), 'tangem — Example: interview round 2.');

  // Selecting a card opens the shared reader beside the board; Escape returns focus to the card.
  open('tangem').fire('click');
  await ui.settle();
  assert.equal(ui.nodes['pipeline-reader'].hidden, false);
  assert.equal(ui.nodes['pipeline-reader-title'].textContent, 'tangem — Example');
  assert.equal(open('tangem').attributes.get('aria-current'), 'true');
  const progress = () => ui.byClass(ui.nodes['pipeline-reader-content'], 'career-progress');
  assert.equal(ui.byClass(progress(), 'career-progress-current').textContent, 'Interview round 2 · ' + ui.byClass(card('tangem'), 'pipeline-card-detail').textContent.split(' · ')[1]);
  const buttons = () => progress().querySelectorAll('button');
  assert.deepEqual(buttons().map(button => button.textContent), ['Change date', 'Undo last step', 'Next round', 'Offer', 'Rejected', 'Withdrew', 'Save date']);
  // The reader's step redraws both the reader and the board; its controls stay disabled until then.
  const offer = buttons().find(button => button.textContent === 'Offer');
  offer.fire('click');
  assert.equal(offer.disabled, true);
  offer.fire('click', { detail: 2 });
  await ui.settle(); await ui.settle(); await ui.settle();
  assert.equal(ui.calls.filter(call => call.operation === 'application-progress' && call.args.move === 'offer').length, 1);
  assert.deepEqual(titles('offer'), ['tangem']);
  assert.match(ui.byClass(progress(), 'career-progress-current').textContent, /^Offer · /);
  assert.deepEqual(buttons().map(button => button.textContent), ['Change date', 'Undo last step', 'Accepted', 'Declined']);
  ui.nodes['pipeline-reader'].fire('keydown', { key: 'Escape' });
  assert.equal(ui.nodes['pipeline-reader'].hidden, true);
  assert.equal(ui.focused(), open('tangem'));
  ui.window.careerBrowser.clear();
  assert.equal(ui.nodes['pipeline-list-status'].textContent, 'Unlock to see your saved applications.');
});

test('Pipeline schedules optional interview dates, preserves snapshots and clears appointments through the reader', async () => {
  const { state, store, steps, app, browser } = progressFixture();
  app('scheduled', steps(['applied', '2025-10-21'], ['interviewing', '2025-10-24']));
  app('unscheduled', steps(['applied', '2025-10-21'], ['interviewing', '2025-10-24']));
  app('applied', steps(['applied', '2025-10-21']));
  const ui = await rendererFixture(browser, true, { 'application-progress': input => setApplicationProgress({ store }, input) });
  await ui.window.careerBrowser.refresh(); await ui.settle();
  const card = id => ui.nodes['pipeline-records'].querySelectorAll('.pipeline-card').find(item => item.dataset.id === id);
  const reader = ui.nodes['pipeline-reader-content'];
  const schedule = () => ui.byClass(reader, 'career-progress-schedule');
  const field = () => schedule().querySelector('input');
  const button = label => reader.querySelectorAll('button').find(item => item.textContent === label);
  const saved = () => state.career.applications.scheduled.progress;
  ui.byClass(card('scheduled'), 'pipeline-card-open').fire('click'); await ui.settle();
  assert.equal(schedule().querySelector('label').textContent, 'Next interview date (optional)');
  assert.equal(schedule().querySelector('label').htmlFor, field().id);
  assert.equal(field().value, '');
  assert.equal(field().max, undefined);
  field().value = '2099-11-12';
  button('Save date').fire('click'); await ui.settle(); await ui.settle();
  assert.equal(saved().nextInterviewAt, '2099-11-12');
  assert.equal(ui.byClass(card('scheduled'), 'pipeline-card-interview').textContent, 'Next interview · 12 Nov 2099');
  assert.match(ui.byClass(card('scheduled'), 'pipeline-card-open').attributes.get('aria-label'), /Next interview · 12 Nov 2099/);
  assert.equal(ui.byClass(card('unscheduled'), 'pipeline-card-interview'), null);
  assert.equal(ui.byClass(card('applied'), 'pipeline-card-interview'), null);
  await ui.window.careerBrowser.refresh(); await ui.settle();
  assert.equal(field().value, '2099-11-12');
  button('Clear date').fire('click'); await ui.settle(); await ui.settle();
  const clearing = ui.calls.findLast(call => call.operation === 'application-progress').args;
  assert.equal(clearing.from.nextInterviewAt, '2099-11-12');
  assert.equal(clearing.nextInterviewAt, null);
  assert.equal(saved().nextInterviewAt, undefined);
  assert.equal(ui.byClass(card('scheduled'), 'pipeline-card-interview'), null);
  field().value = '2099-11-13';
  button('Save date').fire('click'); await ui.settle(); await ui.settle();
  field().value = '';
  button('Save date').fire('click'); await ui.settle(); await ui.settle();
  assert.equal(saved().nextInterviewAt, undefined);
  field().value = '2099-11-14';
  button('Save date').fire('click'); await ui.settle(); await ui.settle();
  button('Next round').fire('click'); await ui.settle(); await ui.settle();
  assert.equal(saved().nextInterviewAt, undefined);
  assert.equal(field().value, '');
  button('Offer').fire('click'); await ui.settle(); await ui.settle();
  assert.equal(schedule(), null);
});

