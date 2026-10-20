import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createMatchingTools } from '../src/mcp/matching-tools.mjs';
import { createCareerState } from '../src/mcp/state.mjs';
import { salaryEligibility, recentPublication, matchingProfileVersion } from '../src/mcp/assessment-policy.mjs';
import { ASSESSMENT_POLICY_ID, RERANK_POLICY, RERANK_SIZE, deriveDecision, fitBand, overallFit } from '../src/mcp/matching-contract.mjs';
import { publicationInWindow } from '../src/prescan/publication-range.mjs';
import { decisionProviders } from '../src/prescan/providers.mjs';

const publishedAt = new Date(Date.now() - 86400000).toISOString();
const job = (id, date = publishedAt) => ({ id: `node:${id}`, title: `Engineer ${id}`, company: 'Company', publishedAt: date });
const passing = Object.freeze({ direction: 'pass', constraints: 'pass', eligibility: 'pass' });
const dimensions = value => ({ direction: value, capability: value, scope: value, preferences: value });
const cited = { requirement: 'Build reporting services', importance: 'essential', evidence: 'demonstrated', cvQuote: 'Built reporting services.' };
const missingEssential = { requirement: 'Operate a regulated payments ledger', importance: 'essential', evidence: 'missing' };
const contradictedEssential = { requirement: 'Manage a team of engineers', importance: 'essential', evidence: 'contradicted' };
/** A structured assessment whose companion-derived overall equals `overall` and whose derived decision equals `decision`. */
function assessment(id, overall = 80, relocation = 'unclear', decision = overall >= 60 ? 'recommend' : 'skip') {
  if (decision === 'recommend' && overall < 60) throw new Error('A recommendation needs an overall of at least 60.');
  const extra = decision === 'clarify' ? [missingEssential] : decision === 'skip' && overall >= 60 ? [contradictedEssential] : [];
  return { id: `node:${id}`, status: 'assessed', requirements: [cited, ...extra], gates: { ...passing },
    dimensions: dimensions(overall), relocation, reason: 'Relevant engineering experience.' };
}
const excluded = (id, overall = 90, relocation = 'not_required') =>
  ({ ...assessment(id, overall, relocation), gates: { ...passing, constraints: 'fail' }, reason: 'Excluded employer business.' });
const unavailable = id => ({ id: `node:${id}`, status: 'unavailable', reason: 'Original advertisement is unavailable.' });
/** A row as career_match_save would have stored it. */
const stored = (row, profileVersion = '0:0') =>
  ({ ...row, ...deriveDecision(row), profileVersion, policyId: ASSESSMENT_POLICY_ID, scoredAt: '2026-01-01T00:00:00.000Z', host: null });
const missingTerms = { salary: null, city: null, location: null, workMode: null, seniority: null, commitment: null, classification: null };
const statedTerms = {
  salary: { minimum: 90000, maximum: 120000, stated: null, currency: 'EUR', period: 'year' },
  city: 'Dublin', location: 'Dublin, Ireland', workMode: 'hybrid',
  seniority: 'Senior', commitment: 'Full Time', classification: 'Smart Contracts',
};
const termsOf = ({ salary, city, location, workMode, seniority, commitment, classification }) =>
  ({ salary, city, location, workMode, seniority, commitment, classification });
const fact = (subject, answer, kind = 'note') => ({ kind, subject, answer });
const emptyMatching = { jobs: {}, scores: {}, pairs: {} };
function fixture({ jobs = [job('a'), job('b'), job('c')], batch, emptyProfile = false, exportDocument, preserveFinalAssessments = false } = {}) {
  const career = createCareerState();
  if (!emptyProfile) {
    Object.assign(career.profile, { headline: 'Software engineer', skills: ['JavaScript'], location: 'Dublin',
      name: 'PRIVATE NAME', email: 'private@example.test', phone: '+353 123 456 789', links: ['https://private.test'],
      preferences: { willingToRelocate: false, salaryMinimum: 0, locations: ['Dublin'], notes: 'Prefer hands-on work' } });
    career.facts = { recent: fact('Reporting services', 'Hands-on', 'capability'), early: fact('Internal tooling', 'Led it', 'capability') };
    career.sources = { cv: { purpose: 'cv', text: 'Software engineer at Acme, 2019–2023. Built reporting services.', originalBase64: 'PRIVATE PDF', archived: false } };
  }
  let state = { career }, queue = Promise.resolve(), catalogue = jobs, platformError;
  const calls = [];
  const store = {
    get: () => structuredClone(state),
    update(change) {
      const pending = queue.then(async () => {
        const next = structuredClone(state);
        await change(next);
        state = next;
      });
      queue = pending.catch(() => {});
      return pending;
    },
  };
  const platform = async (operation, args) => {
    calls.push({ operation, args: structuredClone(args) });
    if (platformError) throw platformError;
    if (operation === 'matching_catalogue') {
      const publicationWindow = { range: args.publicationRange, since: args.since, until: args.until };
      const jobs = structuredClone(catalogue).filter(job => publicationInWindow(job.publishedAt, publicationWindow));
      return { jobs, total: jobs.length, nextOffset: null, publicationWindow };
    }
    assert.equal(operation, 'matching_jobs');
    return batch ? batch(args) : { jobs: args.ids.map(id => ({ ...catalogue.find(job => job.id === id), ad: 'Full original ad', company: { name: 'Company' } })), remainingIds: [], unavailableIds: [] };
  };
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const tools = new Map(createMatchingTools({ store, platform, exportDocument, preserveFinalAssessments }).map(tool => [tool.name, { ...tool, validate: ajv.compile(tool.inputSchema) }]));
  const call = async (name, args = {}, context) => {
    const tool = tools.get(name);
    if (!tool.validate(args)) throw Object.assign(new Error(ajv.errorsText(tool.validate.errors)), { code: 'INVALID_INPUT' });
    return tool.invoke(args, context);
  };
  const save = (assessments, profileVersion = '0:0', context) =>
    call('career_match_save', { profileVersion, policyId: ASSESSMENT_POLICY_ID, assessments }, context);
  return { store, calls, tools, call, save, setCatalogue: jobs => { catalogue = jobs; }, setPlatformError: error => { platformError = error; } };
}

test('subscription assignment and original batches never expose saved preliminary judgments', async () => {
  const f = fixture();
  const sentinel = 'PRIVATE_PRELIMINARY_JUDGMENT';
  await f.store.update(state => {
    state.career.prescan = { provider: 'openai', profileVersion: '0:0', rows: {
      'node:a': { id: 'node:a', priority: 99, direction: sentinel, constraints: sentinel, eligibility: sentinel,
        dimensions: { direction: sentinel }, confidence: sentinel, answers: [sentinel], reason: sentinel, commentary: sentinel },
    }, rawAnswers: sentinel, commentary: sentinel };
  });
  const context = await f.call('career_match_jobs');
  const batch = await f.call('career_match_batch', { ids: context.jobIds });
  assert.equal(JSON.stringify({ context, batch }).includes(sentinel), false);
  assert.equal(context.candidate.cv, 'Software engineer at Acme, 2019–2023. Built reporting services.');
  assert.equal(batch.jobs[0].ad, 'Full original ad');
  assert.deepEqual(new Set(context.jobIds), new Set(['node:a', 'node:b', 'node:c']));
});

test('overall fit weights the four dimensions and bands follow their thresholds', () => {
  const only = (key, value = 100) => ({ ...dimensions(0), [key]: value });
  assert.equal(overallFit(only('direction')), 30);
  assert.equal(overallFit(only('capability')), 25);
  assert.equal(overallFit(only('scope')), 15);
  assert.equal(overallFit(only('preferences')), 30);
  assert.equal(overallFit(dimensions(60)), 60);
  assert.equal(overallFit({ direction: 61, capability: 60, scope: 60, preferences: 60 }), 60);
  assert.deepEqual([100, 75, 74, 60, 59, 45, 44, 30, 29, 0].map(fitBand),
    ['strong', 'strong', 'good', 'good', 'moderate', 'moderate', 'weak', 'weak', 'poor', 'poor']);
});

test('the companion derives decisions with gates and essential requirements taking precedence over overall fit', () => {
  const row = (overrides = {}) => ({ status: 'assessed', requirements: [cited], gates: { ...passing }, dimensions: dimensions(100), ...overrides });
  for (const gate of ['direction', 'constraints', 'eligibility'])
    assert.deepEqual(deriveDecision(row({ gates: { ...passing, [gate]: 'fail' } })), { overall: 100, band: 'strong', decision: 'skip' });
  assert.equal(deriveDecision(row({ gates: { direction: 'fail', constraints: 'flag', eligibility: 'pass' } })).decision, 'skip');
  assert.equal(deriveDecision(row({ requirements: [cited, contradictedEssential] })).decision, 'skip');
  assert.equal(deriveDecision(row({ requirements: [contradictedEssential], gates: { ...passing, eligibility: 'flag' } })).decision, 'skip');
  for (const gate of ['direction', 'constraints', 'eligibility'])
    assert.equal(deriveDecision(row({ gates: { ...passing, [gate]: 'flag' } })).decision, 'clarify');
  assert.equal(deriveDecision(row({ requirements: [cited, missingEssential] })).decision, 'clarify');
  assert.equal(deriveDecision(row({ requirements: [cited, missingEssential], dimensions: dimensions(10) })).decision, 'clarify');
  assert.equal(deriveDecision(row({ requirements: [cited, { ...contradictedEssential, importance: 'preferred' },
    { ...missingEssential, importance: 'preferred' }] })).decision, 'recommend');
  assert.deepEqual(deriveDecision(row({ dimensions: dimensions(60) })), { overall: 60, band: 'good', decision: 'recommend' });
  assert.deepEqual(deriveDecision(row({ dimensions: dimensions(59) })), { overall: 59, band: 'moderate', decision: 'skip' });
  assert.deepEqual(deriveDecision({ status: 'unavailable' }), { overall: null, band: null, decision: 'clarify' });
});

test('candidate brief combines the CV with additional answers without exporting source bytes or profile contacts', async () => {
  const f = fixture();
  const result = await f.call('career_match_jobs');
  assert.deepEqual(result.jobIds, ['node:a', 'node:b', 'node:c']);
  assert.equal(result.jobs, undefined);
  assert.equal(result.policyId, ASSESSMENT_POLICY_ID);
  assert.deepEqual(result.candidate.facts.map(fact => fact.subject), ['Internal tooling', 'Reporting services']);
  assert.equal(result.candidate.cv, 'Software engineer at Acme, 2019–2023. Built reporting services.');
  assert.equal(result.candidate.preferences.willingToRelocate, false);
  assert.equal(result.candidate.preferences.salaryMinimum, 0);
  assert.equal(result.candidate.location, 'Dublin');
  for (const secret of ['PRIVATE NAME', 'private@example.test', '+353 123 456 789', 'https://private.test', 'PRIVATE FULL CV', 'PRIVATE PDF'])
    assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual({ total: result.total, scored: result.scored, pending: result.pending, batchSize: result.batchSize, workers: result.workers },
    { total: 3, scored: 0, pending: 3, batchSize: 10, workers: 8 });
});

test('candidate brief preserves decisive late preferences through the valid note bound and sanitizes contacts', async () => {
  const f = fixture();
  const direction = 'For this search I want engineering management toward CTO, not a narrower IC role. No gaming employers.';
  const notes = 'Contact a@b.co or https://x.y Hands-on and managerial work were both fine previously. '
    .padEnd(5000 - direction.length, ' ') + direction;
  await f.store.update(state => { state.career.profile.preferences.notes = notes; });
  const result = await f.call('career_match_jobs');
  assert.equal(notes.length, 5000);
  assert.equal(result.candidate.preferences.notes.includes('a@b.co'), false);
  assert.equal(result.candidate.preferences.notes.includes('https://x.y'), false);
  assert.equal(result.candidate.preferences.notes.includes('Hands-on and managerial work were both fine previously.'), true);
  assert.equal(result.candidate.preferences.notes.endsWith(direction), true);
  assert.equal(f.store.get().career.profile.preferences.notes, notes);
});

test('insufficient profile data gives actionable errors before fetching jobs', async () => {
  const f = fixture({ emptyProfile: true });
  await assert.rejects(f.call('career_match_jobs'), error => error.code === 'PROFILE_INCOMPLETE' && /career_facts_save/.test(error.message));
  assert.deepEqual(f.calls, []);
  const skillsOnly = fixture();
  await skillsOnly.store.update(state => { state.career.facts = {}; state.career.sources = {}; });
  await assert.rejects(skillsOnly.call('career_match_jobs'), { code: 'PROFILE_INCOMPLETE' });
  const roleless = fixture();
  await roleless.store.update(state => { state.career.profile.headline = null; });
  await assert.rejects(roleless.call('career_match_jobs'), { code: 'PROFILE_INCOMPLETE' });
  assert.deepEqual([...skillsOnly.calls, ...roleless.calls], []);
});

test('candidate brief preserves negative and limited-depth answers and excludes archived CVs', async () => {
  const f = fixture();
  await f.store.update(state => {
    state.career.facts.language = { kind: 'language', subject: 'Italian', answer: 'Native' };
    state.career.facts.go = { kind: 'capability', subject: 'Go', answer: 'None' };
    state.career.facts.recent.detail = 'Worked on query optimization.';
    state.career.sources.archived = { purpose: 'cv', archived: true, text: 'OLD CAREER CLAIM' };
  });
  const { candidate } = await f.call('career_match_jobs');
  assert.deepEqual(candidate.facts.find(row => row.kind === 'language'), { kind: 'language', subject: 'Italian', answer: 'Native' });
  assert.equal(candidate.facts.find(row => row.subject === 'Go').answer, 'None');
  assert.equal(candidate.facts.find(row => row.subject === 'Reporting services').detail, 'Worked on query optimization.');
  assert.equal(candidate.cv.includes('OLD CAREER CLAIM'), false);
});

test('candidate brief retains reusable interview context while omitting contact data', async () => {
  const f = fixture();
  const explanation = 'Optimized reporting queries. '.repeat(40);
  const original = {
    id: 'reporting-fact', question: 'Did you build reports for private@example.test?',
    context: 'Reporting role described at https://private.test/job', applicationId: 'original-application',
    employer: 'Acme private@example.test', detail: explanation,
    followUps: [{ question: 'Which report at https://private.test/report?', answer: `${explanation}Contact private@example.test`,
      context: 'Requirement at https://private.test/later contact private@example.test', applicationId: 'later-application' }],
  };
  await f.store.update(state => { Object.assign(state.career.facts.recent, original); });
  const { candidate } = await f.call('career_match_jobs');
  const saved = candidate.facts.find(row => row.id === original.id);
  assert.equal(saved.question, 'Did you build reports for [contact omitted]?');
  assert.equal(saved.context, 'Reporting role described at [link omitted]');
  assert.equal(saved.employer, 'Acme [contact omitted]');
  assert.equal(saved.detail, explanation.trim());
  assert.equal(saved.applicationId, 'original-application');
  assert.deepEqual(saved.followUps, [{ question: 'Which report at [link omitted]', answer: `${explanation}Contact [contact omitted]`,
    context: 'Requirement at [link omitted] contact [contact omitted]', applicationId: 'later-application' }]);
  assert.equal(candidate.facts.find(row => row.subject === 'Internal tooling').question, undefined);
  const stored = f.store.get().career.facts.recent;
  for (const key of Object.keys(original)) assert.deepEqual(stored[key], original[key]);
});

test('eight concurrent assessment batches merge atomically and saved matches are readable before completion', async () => {
  const f = fixture({ jobs: Array.from({ length: 81 }, (_, index) => job(String(index))) });
  await f.call('career_match_jobs');
  await Promise.all(Array.from({ length: 8 }, (_, worker) => f.save(
    Array.from({ length: 10 }, (_, index) => assessment(String(worker * 10 + index), worker * 10 + index)))));
  const result = await f.call('career_matches', { limit: 100 });
  assert.equal(result.matches.length, 80);
  assert.equal(result.scored, 80);
  assert.equal(result.pending, 1);
  assert.equal(result.unavailable, 0);
  assert.equal(result.matches[0].id, 'node:79');
  assert.equal(result.matches[0].overall, 79);
  assert.equal(Object.keys(f.store.get().career.matching.scores).length, 80);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.get().career.revision, 0);
});

test('one invalid or unknown row rejects an entire batch and leaves prior assessments intact', async () => {
  const f = fixture();
  await f.call('career_match_jobs');
  await f.save([assessment('a', 40)]);
  const fractional = { ...assessment('a'), dimensions: { ...dimensions(100), scope: 100.5 } };
  for (const assessments of [[assessment('a', 90), assessment('unknown')], [assessment('b'), fractional], [assessment('b'), assessment('b')]]) {
    await assert.rejects(f.tools.get('career_match_save').invoke({ profileVersion: '0:0', policyId: ASSESSMENT_POLICY_ID, assessments }));
    assert.deepEqual(Object.keys(f.store.get().career.matching.scores), ['node:a']);
    assert.equal(f.store.get().career.matching.scores['node:a'].overall, 40);
  }
});

test('evidence citations must resolve to the saved CV or saved facts and stale rubrics are refused without writes', async () => {
  const factId = '3f1c2a4e-8b7d-4c6e-9a1f-2d3b4c5e6f70', unknownFactId = '00000000-0000-4000-8000-000000000000';
  const f = fixture();
  await f.store.update(state => {
    state.career.facts[factId] = { id: factId, kind: 'capability', subject: 'Query tuning', answer: 'Hands-on' };
  });
  await f.call('career_match_jobs');
  const withRequirement = requirement => ({ ...assessment('a'), requirements: [requirement] });
  const before = f.store.get();
  for (const [code, args] of [
    ['UNSUPPORTED_REQUIREMENT', { assessments: [withRequirement({ requirement: 'Build reporting services', importance: 'essential', evidence: 'demonstrated' })] }],
    ['UNSUPPORTED_REQUIREMENT', { assessments: [withRequirement({ requirement: 'Tune queries', importance: 'preferred', evidence: 'transferable', factIds: [] })] }],
    ['UNKNOWN_QUOTE', { assessments: [withRequirement({ ...cited, cvQuote: 'Designed reporting services at scale.' })] }],
    ['UNKNOWN_QUOTE', { assessments: [assessment('b'), withRequirement({ ...cited, evidence: 'missing', cvQuote: 'Built billing services.' })] }],
    ['UNKNOWN_FACT', { assessments: [withRequirement({ requirement: 'Tune queries', importance: 'essential', evidence: 'transferable', factIds: [factId, unknownFactId] })] }],
    ['POLICY_CHANGED', { policyId: 'old-policy', assessments: [assessment('a')] }],
    ['PROFILE_CHANGED', { profileVersion: '1:0', assessments: [assessment('a')] }],
  ]) {
    await assert.rejects(f.call('career_match_save', { profileVersion: '0:0', policyId: ASSESSMENT_POLICY_ID, ...args }), { code });
    assert.deepEqual(f.store.get(), before);
  }
  // Quotes tolerate bullets, typography, spacing and case but never rewording.
  await f.save([
    withRequirement({ ...cited, cvQuote: '• software ENGINEER at Acme,   2019–2023.' }),
    { ...assessment('b'), requirements: [{ requirement: 'Tune queries', importance: 'essential', evidence: 'transferable', factIds: [factId] }] },
  ]);
  assert.deepEqual(Object.keys(f.store.get().career.matching.scores), ['node:a', 'node:b']);
});

test('saved assessments record the host client internally and visible rows omit internal bindings', async () => {
  let document;
  const f = fixture({ exportDocument: async value => { document = value; return {}; } });
  const { profileVersion } = await f.call('career_match_jobs');
  await f.save([assessment('a', 90, 'not_required')], profileVersion, { client: { name: 'codex', version: '1.2.3' } });
  await f.save([assessment('b', 70, 'not_required')], profileVersion);
  const saved = f.store.get().career.matching.scores;
  assert.deepEqual(saved['node:a'].host, { name: 'codex', version: '1.2.3' });
  assert.equal(saved['node:b'].host, null);
  assert.equal(saved['node:a'].policyId, ASSESSMENT_POLICY_ID);
  assert.equal(saved['node:a'].profileVersion, profileVersion);
  assert.deepEqual({ overall: saved['node:a'].overall, band: saved['node:a'].band, decision: saved['node:a'].decision },
    { overall: 90, band: 'strong', decision: 'recommend' });
  const internal = ['host', 'policyId', 'profileVersion'];
  const visible = [...(await f.call('career_matches')).matches, ...(await f.call('career_recommendations')).recommendations];
  assert.equal(visible.length, 4);
  for (const row of visible) for (const key of internal) assert.equal(Object.hasOwn(row, key), false, key);
  await f.call('career_matches_export');
  const header = document.bytes.toString('utf8').split('\r\n')[0];
  for (const key of internal) assert.equal(header.includes(key), false, key);
});

test('full ads and partial availability are returned as plain objects without local page mutations', async () => {
  const ad = 'Original advertisement\n'.repeat(5000);
  const response = { jobs: [{ ...job('a'), ad, company: { name: 'Company' } }], remainingIds: ['node:b'], unavailableIds: ['node:c'] };
  const f = fixture({ batch: () => response });
  await f.call('career_match_jobs');
  const before = f.store.get();
  assert.deepEqual(await f.call('career_match_batch', { ids: ['node:a', 'node:b', 'node:c'] }), response);
  assert.deepEqual(f.store.get(), before);
  assert.deepEqual(f.calls.at(-1), { operation: 'matching_jobs', args: { ids: ['node:a', 'node:b', 'node:c'] } });
  await f.save([assessment('a', 90), unavailable('c')]);
  const result = await f.call('career_matches');
  assert.equal(result.total, 2);
  assert.equal(result.scored, 1);
  assert.equal(result.unavailable, 1);
  assert.equal(result.pending, 1);
  assert.deepEqual((await f.call('career_match_jobs')).jobIds, ['node:b']);
});

test('missing original ads stay explicit and empty catalogues return honest zero coverage', async () => {
  const f = fixture({ jobs: [job('a')], batch: () => ({ jobs: [{ ...job('a'), ad: null }], remainingIds: [], unavailableIds: [] }) });
  await f.call('career_match_jobs');
  assert.equal((await f.call('career_match_batch', { ids: ['node:a'] })).jobs[0].ad, null);
  await f.save([unavailable('a')]);
  const result = await f.call('career_matches');
  assert.deepEqual({ ...result, matches: result.matches.map(row => [row.id, row.overall, row.band, row.decision, row.matchStatus]) },
    { view: 'assessment_archive', matches: [['node:a', null, null, 'clarify', 'unavailable']], total: 1, policyId: ASSESSMENT_POLICY_ID,
      nextOffset: null, scored: 0, pending: 0, unavailable: 1, reviewed: 1, needsReview: 0 });
  const empty = fixture({ jobs: [] });
  const catalogue = await empty.call('career_match_jobs');
  assert.deepEqual(catalogue.jobIds, []);
  assert.equal(catalogue.total, 0);
  assert.equal(catalogue.pending, 0);
  assert.deepEqual(await empty.call('career_matches'), { view: 'assessment_archive', matches: [], total: 0, policyId: ASSESSMENT_POLICY_ID,
    nextOffset: null, scored: 0, pending: 0, unavailable: 0, reviewed: 0, needsReview: 0 });
});

test('unaccounted-for backend IDs are errors rather than invented unavailable jobs', async () => {
  const f = fixture({ batch: () => ({ jobs: [], remainingIds: [], unavailableIds: [] }) });
  await f.call('career_match_jobs');
  await assert.rejects(f.call('career_match_batch', { ids: ['node:a'] }), { code: 'INVALID_BATCH' });
  await assert.rejects(f.call('career_match_batch', { ids: ['node:unknown'] }), { code: 'UNKNOWN_JOB' });
  assert.equal(f.calls.length, 2);
});

test('eligibility and gates precede fit without filtering records or changing saved assessments when willingness changes', async () => {
  const f = fixture({ jobs: [
    { ...job('ny'), title: 'New York office role', city: 'New York', workMode: 'onsite' },
    { ...job('compatible'), title: 'Compatible role', city: 'Dublin', workMode: 'hybrid' },
    job('unclear'), job('excluded'), job('unavailable'),
  ] });
  await f.call('career_match_jobs');
  await f.save([
    assessment('ny', 88, 'required'), assessment('compatible', 79, 'not_required'), assessment('unclear', 95, 'unclear'),
    excluded('excluded', 99, 'not_required'), unavailable('unavailable'),
  ]);
  const saved = f.store.get().career.matching;
  const ranked = async () => {
    const result = await f.call('career_matches');
    assert.equal(result.total, 5);
    assert.equal(result.scored, 4);
    assert.equal(result.unavailable, 1);
    assert.equal(result.nextOffset, null);
    assert.deepEqual(f.store.get().career.matching, saved);
    for (const row of result.matches)
      for (const field of ['overall', 'band', 'decision', 'gates', 'dimensions', 'requirements', 'reason', 'relocation', 'scoredAt'])
        assert.deepEqual(row[field], saved.scores[row.id][field]);
    return result.matches.map(row => [row.id, row.overall, row.matchStatus]);
  };
  const noRelocation = [
    ['node:compatible', 79, 'eligible'], ['node:unclear', 95, 'needs_location_confirmation'],
    ['node:ny', 88, 'incompatible_location'], ['node:excluded', 99, 'excluded'], ['node:unavailable', null, 'unavailable'],
  ];
  assert.deepEqual(await ranked(), noRelocation);
  assert.equal(saved.scores['node:excluded'].decision, 'skip');
  await assert.rejects(f.call('career_matches', { includeRelocation: true }), { code: 'INVALID_INPUT' });
  await f.store.update(state => { state.career.profile.preferences.willingToRelocate = true; });
  assert.deepEqual(await ranked(), [
    ['node:ny', 88, 'requires_relocation'], ['node:compatible', 79, 'eligible'],
    ['node:unclear', 95, 'needs_location_confirmation'], ['node:excluded', 99, 'excluded'], ['node:unavailable', null, 'unavailable'],
  ]);
  for (const willingness of [undefined, null]) {
    await f.store.update(state => {
      if (willingness === undefined) delete state.career.profile.preferences.willingToRelocate;
      else state.career.profile.preferences.willingToRelocate = willingness;
    });
    assert.deepEqual(await ranked(), [
      ['node:compatible', 79, 'eligible'], ['node:unclear', 95, 'needs_location_confirmation'],
      ['node:ny', 88, 'needs_location_confirmation'], ['node:excluded', 99, 'excluded'], ['node:unavailable', null, 'unavailable'],
    ]);
  }
  await f.store.update(state => { state.career.profile.preferences.willingToRelocate = false; });
  assert.deepEqual(await ranked(), noRelocation);
  assert.equal(f.calls.length, 1);
});

test('ordinary refresh replaces rankings while retaining the current candidate context', async () => {
  const f = fixture({ jobs: [job('a')] });
  await f.call('career_match_jobs');
  await f.save([assessment('a', 50)]);
  f.setCatalogue([job('a'), job('b')]);
  assert.deepEqual((await f.call('career_match_jobs')).jobIds, ['node:b']);
  await f.store.update(state => { state.career.profile.skills.push('Rust'); });
  const refreshed = await f.call('career_match_jobs', { refresh: true });
  assert.deepEqual(refreshed.jobIds, ['node:a', 'node:b']);
  assert.deepEqual(refreshed.candidate.skills, ['JavaScript', 'Rust']);
  assert.deepEqual((await f.call('career_matches')).matches, []);
  await f.save([assessment('a', 95)], refreshed.profileVersion);
  const saved = (await f.call('career_matches')).matches[0];
  assert.equal(saved.overall, 95);
  assert.equal(saved.band, 'strong');
  assert.equal(saved.title, 'Engineer a');
  assert.equal(saved.company, 'Company');
  assert.ok(Number.isFinite(Date.parse(saved.scoredAt)));
});

test('rank ties sort by publication date then ID and paging total remains unpaged', async () => {
  const f = fixture({ jobs: [job('a', new Date(Date.now() - 2 * 86400000).toISOString()), job('c'), job('b')] });
  await f.call('career_match_jobs');
  await f.save([assessment('a'), assessment('c'), assessment('b')]);
  assert.deepEqual((await f.call('career_matches')).matches.map(row => row.id), ['node:b', 'node:c', 'node:a']);
  const result = await f.call('career_matches', { offset: 1, limit: 1 });
  assert.deepEqual(result.matches.map(row => row.id), ['node:c']);
  assert.equal(result.total, 3);
  assert.equal(result.nextOffset, 2);
  assert.equal((await f.call('career_matches', { offset: 2, limit: 1 })).nextOffset, null);
  assert.equal((await f.call('career_matches', { offset: 20 })).nextOffset, null);
});

test('expired feed access leaves local assessments and profile available without contacting the platform', async () => {
  const f = fixture();
  await f.call('career_match_jobs');
  await f.save([assessment('a', 91)]);
  const before = f.store.get();
  f.setPlatformError(Object.assign(new Error('Active subscription required'), { code: 'SUBSCRIPTION_REQUIRED' }));
  await assert.rejects(f.call('career_match_jobs'), { code: 'SUBSCRIPTION_REQUIRED' });
  await assert.rejects(f.call('career_match_batch', { ids: ['node:b'] }), { code: 'SUBSCRIPTION_REQUIRED' });
  assert.deepEqual(f.store.get(), before);
  const requests = f.calls.length;
  const saved = await f.call('career_matches');
  assert.deepEqual(saved.matches.map(row => [row.id, row.overall]), [['node:a', 91]]);
  // Already obtained data can still be assessed and saved locally after access expires.
  await f.save([assessment('b', 80)]);
  assert.equal((await f.call('career_matches')).total, 2);
  assert.deepEqual(f.store.get().career.profile, before.career.profile);
  assert.equal(f.calls.length, requests);
});

test('schemas and direct invokes reject invalid inputs without writes or provider calls', async () => {
  const f = fixture();
  await f.call('career_match_jobs');
  const row = assessment('a');
  const { gates: _gates, ...gateless } = row;
  const invalid = [
    ['career_match_jobs', { refresh: 'yes' }], ['career_match_jobs', { requestId: 'old-workflow' }],
    ['career_match_batch', {}], ['career_match_batch', { ids: [] }], ['career_match_batch', { ids: ['node:a', 'node:a'] }],
    ['career_match_batch', { ids: Array.from({ length: 11 }, (_, i) => `node:${i}`) }],
    ['career_match_save', { assessments: [] }],
    ['career_match_save', { assessments: Array.from({ length: 11 }, (_, i) => assessment(String(i))) }],
    ...[-1, 101, 0.5, '90'].map(value => ['career_match_save', { assessments: [{ ...row, dimensions: { ...row.dimensions, capability: value } }] }]),
    ['career_match_save', { assessments: [{ ...row, dimensions: { direction: 80, capability: 80, scope: 80 } }] }],
    ['career_match_save', { assessments: [{ ...row, gates: { ...passing, direction: 'maybe' } }] }],
    ['career_match_save', { assessments: [gateless] }],
    ['career_match_save', { assessments: [{ ...row, requirements: [] }] }],
    ['career_match_save', { assessments: [{ ...row, requirements: Array.from({ length: 13 }, () => cited) }] }],
    ['career_match_save', { assessments: [{ ...row, requirements: [{ ...cited, evidence: 'likely' }] }] }],
    ['career_match_save', { assessments: [{ ...row, requirements: [{ ...cited, cvQuote: 'x'.repeat(301) }] }] }],
    ['career_match_save', { assessments: [{ ...row, requirements: [{ ...cited, factIds: ['not-a-uuid'] }] }] }],
    ['career_match_save', { assessments: [{ ...row, relocation: 'maybe' }] }],
    ['career_match_save', { assessments: [{ ...row, status: 'zero_fit' }] }],
    ['career_match_save', { assessments: [{ ...unavailable('a'), dimensions: dimensions(0) }] }],
    ['career_match_save', { assessments: [{ ...unavailable('a'), relocation: 'unclear' }] }],
    ['career_match_save', { assessments: [{ ...row, reason: 'x'.repeat(401) }] }],
    ['career_match_save', { assessments: [{ ...row, reason: '   ' }] }],
    ...['title', 'matchStatus', 'overall', 'band', 'decision', 'score'].map(field =>
      ['career_match_save', { assessments: [{ ...row, [field]: field === 'overall' || field === 'score' ? 80 : 'recommend' }] }]),
    ...Object.entries(statedTerms).map(([field, value]) =>
      ['career_match_save', { assessments: [{ ...row, [field]: value }] }]),
    ['career_matches', { limit: 0 }], ['career_matches', { limit: 101 }], ['career_matches', { offset: -1 }],
    ['career_matches', { offset: 0.5 }], ['career_matches', { includeRelocation: 'true' }],
    ['career_matches_export', { limit: 100 }], ['career_matches_export', { includeRelocation: false }],
  ];
  const before = f.store.get();
  for (const [name, args] of invalid) {
    const input = name === 'career_match_save' ? { profileVersion: '0:0', policyId: ASSESSMENT_POLICY_ID, ...args } : args;
    assert.equal(f.tools.get(name).validate(input), false, `${name}: schema accepted ${JSON.stringify(input)}`);
    await assert.rejects(f.tools.get(name).invoke(input), { code: 'INVALID_INPUT' }, JSON.stringify(input));
  }
  assert.deepEqual(f.store.get(), before);
  assert.equal(f.calls.length, 1);
  await f.save([{ ...assessment('a', 0), reason: 'x'.repeat(400) }, assessment('b', 100), unavailable('c')]);
  assert.equal((await f.call('career_matches')).scored, 2);
});

test('catalogue replacement keeps current terms and assessments, removes absent jobs and retains saved work offline', async () => {
  const f = fixture({ jobs: [{ ...job('a'), ...statedTerms }, job('b'),
    { ...job('c'), salary: { stated: 0 }, location: 'Ireland' }] });
  const discovery = await f.call('career_match_jobs');
  await f.save([assessment('a', 90), assessment('b', 80), assessment('c', 70)], discovery.profileVersion);
  const updatedTerms = { ...statedTerms, city: 'Cork', location: 'Cork, Ireland', workMode: 'onsite' };
  f.setCatalogue([{ ...job('a'), ...updatedTerms }, job('b')]);
  assert.deepEqual((await f.call('career_match_jobs')).jobIds, []);
  const before = f.store.get();
  assert.deepEqual(Object.keys(before.career.matching.jobs), ['node:a', 'node:b']);
  assert.deepEqual(Object.keys(before.career.matching.scores), ['node:a', 'node:b']);
  for (const code of ['SUBSCRIPTION_REQUIRED', 'OFFLINE']) {
    f.setPlatformError(Object.assign(new Error(code), { code }));
    await assert.rejects(f.call('career_match_jobs'), { code });
    const requests = f.calls.length;
    const saved = await f.call('career_matches');
    assert.deepEqual(saved.matches.map(termsOf), [updatedTerms, missingTerms]);
    assert.deepEqual(saved.matches.map(row => row.overall), [90, 80]);
    assert.equal(f.calls.length, requests);
    assert.deepEqual(f.store.get(), before);
  }
  f.setPlatformError(undefined);
  f.setCatalogue([]);
  await f.call('career_match_jobs');
  assert.deepEqual(f.store.get().career.matching, emptyMatching);
});

test('batch terms refresh saved display metadata without storing ads, company graphs or changing assessments', async () => {
  const updatedTerms = { salary: { minimum: null, maximum: null, stated: 55, currency: null, period: null },
    city: null, location: 'Europe', workMode: 'remote', seniority: 'Junior', commitment: 'Part Time', classification: 'Backend' };
  const rawTerms = { ...updatedTerms, seniority: '2', commitment: 'PART_TIME', classification: 'BACKEND' };
  const response = {
    jobs: [
      { ...job('a'), ...rawTerms, locationEvidence: ['Advertised role location: Europe'], ad: 'Full original ad', company: { name: 'Company', graph: ['Do not persist'] } },
      { ...job('b'), ad: 'Terms are not stated', company: { name: 'Company' } },
    ],
    remainingIds: ['node:c'], unavailableIds: ['node:d'],
  };
  const f = fixture({ jobs: ['a', 'b', 'c', 'd'].map(id => ({ ...job(id), ...statedTerms })), batch: () => response });
  await f.call('career_match_jobs');
  await f.save(['a', 'b', 'c', 'd'].map(id => assessment(id)));
  const before = f.store.get();
  assert.equal(f.tools.get('career_match_batch').readOnly, false);
  assert.equal(f.tools.get('career_matches').readOnly, true);
  assert.deepEqual(await f.call('career_match_batch', { ids: ['node:a', 'node:b', 'node:c', 'node:d'] }), response);
  const after = f.store.get();
  assert.deepEqual(after.career.matching.scores, before.career.matching.scores);
  assert.deepEqual(after.career.profile, before.career.profile);
  assert.equal(after.career.revision, before.career.revision);
  assert.deepEqual(after.career.matching.jobs['node:a'], { ...job('a'), ...updatedTerms });
  assert.deepEqual(after.career.matching.jobs['node:b'], { ...job('b'), ...missingTerms });
  assert.deepEqual(after.career.matching.jobs['node:c'], before.career.matching.jobs['node:c']);
  assert.deepEqual(after.career.matching.jobs['node:d'], before.career.matching.jobs['node:d']);
  await f.save([assessment('a', 95), assessment('b', 90)]);
  f.setPlatformError(Object.assign(new Error('Offline'), { code: 'OFFLINE' }));
  const requests = f.calls.length;
  assert.deepEqual((await f.call('career_matches')).matches.map(termsOf),
    [updatedTerms, missingTerms, statedTerms, statedTerms]);
  assert.equal(f.calls.length, requests);
});

test('assessment submissions cannot replace catalogue display terms', async () => {
  const f = fixture({ jobs: [{ ...job('a'), ...statedTerms }] });
  await f.call('career_match_jobs');
  await f.save([assessment('a')]);
  const before = f.store.get();
  for (const [field, value] of Object.entries(missingTerms)) {
    const args = { profileVersion: '0:0', policyId: ASSESSMENT_POLICY_ID, assessments: [{ ...assessment('a', 99), [field]: value }] };
    assert.equal(f.tools.get('career_match_save').validate(args), false);
    await assert.rejects(f.tools.get('career_match_save').invoke(args), { code: 'INVALID_INPUT' });
  }
  assert.deepEqual(f.store.get(), before);
  assert.deepEqual(termsOf((await f.call('career_matches')).matches[0]), statedTerms);
});

test('raw catalogue seniority codes and commitment/classification values become card labels in stored jobs', async () => {
  const raw = { seniority: '3', commitment: 'FULL_TIME', classification: 'SMART_CONTRACTS' };
  const f = fixture({ jobs: [{ ...job('a'), ...raw }, { ...job('b'), seniority: '9', commitment: ' ', classification: null },
    { ...job('c'), seniority: '1', commitment: 'PART_TIME', classification: 'BACKEND' }, job('d')] });
  await f.call('career_match_jobs');
  const jobs = f.store.get().career.matching.jobs;
  const labels = ({ seniority, commitment, classification }) => ({ seniority, commitment, classification });
  assert.deepEqual(labels(jobs['node:a']), { seniority: 'Senior', commitment: 'Full Time', classification: 'Smart Contracts' });
  assert.deepEqual(labels(jobs['node:b']), { seniority: null, commitment: null, classification: null });
  assert.deepEqual(labels(jobs['node:c']), { seniority: 'Intern', commitment: 'Part Time', classification: 'Backend' });
  assert.deepEqual(labels(jobs['node:d']), { seniority: null, commitment: null, classification: null });
  await f.save([assessment('a'), assessment('b')]);
  assert.deepEqual((await f.call('career_matches')).matches.map(labels),
    [labels(jobs['node:a']), labels(jobs['node:b'])]);
});


function parseCSV(text) {
  const records = [];
  let record = [], cell = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && char === ',') { record.push(cell); cell = ''; }
    else if (!quoted && char === '\r' && text[index + 1] === '\n') {
      record.push(cell); records.push(record); record = []; cell = ''; index++;
    } else cell += char;
  }
  assert.equal(quoted, false);
  assert.equal(cell, '');
  assert.deepEqual(record, []);
  const [headers, ...rows] = records;
  return rows.map(row => {
    assert.equal(row.length, headers.length);
    return Object.fromEntries(headers.map((header, index) => [header, row[index]]));
  });
}

test('complete traversal and CSV include every unique assessment above 1000, offline and after expiry', async () => {
  let exported, exports = 0;
  const f = fixture({ exportDocument: async document => {
    exported = document; exports++;
    return { path: '/private/ranking.csv', uri: `recruiters://exports/${'a'.repeat(64)}.csv`, bytes: document.bytes.length };
  } });
  const ids = Array.from({ length: 1107 }, (_, index) => String(index).padStart(4, '0'));
  const rowFor = (id, index) => {
    if (index % 11 === 0) return unavailable(id);
    const relocation = ['required', 'unclear', 'not_required'][index % 3];
    return index % 17 === 0 ? excluded(id, index % 101, relocation) : assessment(id, index % 101, relocation);
  };
  await f.store.update(state => {
    state.career.matching = {
      jobs: Object.fromEntries(ids.filter((_, index) => index % 7 !== 0).map(id => [job(id).id,
        { ...job(id, '2020-01-02T00:00:00.000Z'), ...statedTerms }])),
      scores: Object.fromEntries(ids.map((id, index) => [job(id).id, stored(rowFor(id, index))])),
      pairs: {},
    };
  });
  const saved = f.store.get().career.matching, expectedIds = ids.map(id => `node:${id}`);
  const priority = { eligible: 0, requires_relocation: 0, needs_location_confirmation: 1,
    incompatible_location: 2, excluded: 3, unavailable: 4 };
  for (const [code, willingness] of [['OFFLINE', false], ['OFFLINE', true],
    ['SUBSCRIPTION_REQUIRED', false], ['SUBSCRIPTION_REQUIRED', true]]) {
    await f.store.update(state => { state.career.profile.preferences.willingToRelocate = willingness; });
    const before = f.store.get();
    f.setPlatformError(Object.assign(new Error(code), { code }));
    const rows = [];
    let offset = 0;
    do {
      const page = await f.call('career_matches', { offset, limit: 100 });
      assert.equal(page.total, ids.length);
      assert.equal(page.scored + page.unavailable, ids.length);
      assert.equal(page.pending, 0);
      assert.ok(page.matches.length > 0 && page.matches.length <= 100);
      rows.push(...page.matches);
      offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(new Set(rows.map(row => row.id)).size, ids.length);
    assert.deepEqual(rows.map(row => row.id).sort(), expectedIds);
    const firstNull = rows.findIndex(row => row.overall === null);
    assert.ok(firstNull > 0);
    assert.equal(rows[firstNull - 1].matchStatus, 'excluded');
    assert.ok(rows.slice(firstNull).every(row => row.overall === null && row.matchStatus === 'unavailable'));
    assert.equal(rows[0].matchStatus === 'eligible' || willingness && rows[0].matchStatus === 'requires_relocation', true);
    for (let index = 1; index < rows.length; index++) {
      const previous = rows[index - 1], current = rows[index];
      assert.ok(priority[previous.matchStatus] <= priority[current.matchStatus]);
      if (priority[previous.matchStatus] === priority[current.matchStatus])
        assert.ok((previous.overall ?? -1) >= (current.overall ?? -1));
    }
    for (const row of rows) {
      const assessment = saved.scores[row.id];
      for (const field of ['overall', 'band', 'decision', 'relocation', 'reason', 'gates', 'dimensions'])
        assert.deepEqual(row[field], assessment[field]);
      const expectedStatus = assessment.status === 'unavailable' ? 'unavailable' : assessment.gates.constraints === 'fail' ? 'excluded' :
        assessment.relocation === 'not_required' ? 'eligible' : assessment.relocation === 'unclear' ? 'needs_location_confirmation' :
          willingness ? 'requires_relocation' : 'incompatible_location';
      assert.equal(row.matchStatus, expectedStatus);
    }
    const missing = rows.find(row => row.id === 'node:0000');
    for (const field of ['title', 'company', 'publishedAt', 'applyUrl', ...Object.keys(missingTerms)]) assert.equal(missing[field], null);
    const result = await f.call('career_matches_export');
    assert.equal(result.total, ids.length);
    assert.equal(result.scored + result.unavailable, ids.length);
    assert.equal(result.export.mediaType, 'text/csv');
    assert.equal(exported.mediaType, 'text/csv');
    const csvRows = parseCSV(exported.bytes.toString('utf8'));
    assert.deepEqual(csvRows.map(row => [row.id, row.matchStatus]), rows.map(row => [row.id, row.matchStatus]));
    assert.ok(csvRows.some(row => row.overall === '0' && row.band === 'poor'));
    assert.ok(csvRows.some(row => row.matchStatus === 'excluded' && row.constraintsGate === 'fail' && row.decision === 'skip'));
    assert.equal(csvRows.filter(row => row.overall === '').length, result.unavailable);
    assert.deepEqual(f.store.get(), before);
    assert.deepEqual(f.calls, []);
  }
  assert.equal(exports, 4);
});

test('CSV escapes source text, preserves salary and guards spreadsheet formulas in every string column', async () => {
  let document;
  const f = fixture({ exportDocument: async value => { document = value; return {}; } });
  await f.store.update(state => {
    state.career.matching = { jobs: {
      'node:a': { ...job('a'), ...statedTerms, title: '=HYPERLINK("https://bad.test","click")',
        company: '+Company', city: '-City', location: '@Location', workMode: '\tremote',
        applyUrl: 'https://jobs.test/a?x=1,2', salary: { ...statedTerms.salary, currency: ' EUR', period: '\r=year' } },
      'node:b': { ...job('b'), title: 'Engineer, "platform"\r\nDublin', company: 'Société' },
    }, scores: {
      'node:a': stored({ ...excluded('a', 72, 'required'), reason: ' \n=SUM(1,2)' }),
      'node:b': stored({ ...unavailable('b'), reason: 'Unavailable,\nnot assessed' }),
    }, pairs: {} };
  });
  await f.call('career_matches_export');
  const csv = document.bytes.toString('utf8');
  const header = csv.split('\r\n')[0].split(',').map(column => column.slice(1, -1));
  assert.deepEqual(header.slice(header.indexOf('workMode'), header.indexOf('workMode') + 4),
    ['workMode', 'seniority', 'commitment', 'classification']);
  assert.equal(new Set(header).size, header.length);
  const [a, b] = parseCSV(csv);
  for (const field of ['title', 'company', 'city', 'location', 'workMode', 'reason', 'salaryPeriod']) assert.ok(a[field].startsWith("'"), field);
  assert.deepEqual([a.seniority, a.commitment, a.classification], ['Senior', 'Full Time', 'Smart Contracts']);
  assert.deepEqual([b.seniority, b.commitment, b.classification], ['', '', '']);
  assert.equal(a.title, '\'=HYPERLINK("https://bad.test","click")');
  assert.deepEqual([a.overall, a.band, a.direction, a.preferences, a.directionGate, a.constraintsGate, a.decision],
    ['72', 'good', '72', '72', 'pass', 'fail', 'skip']);
  assert.deepEqual([b.overall, b.band, b.direction, b.constraintsGate, b.decision], ['', '', '', '', 'clarify']);
  assert.equal(a.matchStatus, 'excluded'); assert.equal(b.matchStatus, 'unavailable');
  assert.equal(a.salaryMinimum, '90000'); assert.equal(a.salaryMaximum, '120000');
  assert.equal(a.salaryCurrency, ' EUR'); assert.equal(a.applyUrl, 'https://jobs.test/a?x=1,2');
  assert.equal(a.publishedAt, publishedAt);
  assert.equal(b.title, 'Engineer, "platform"\r\nDublin'); assert.equal(b.company, 'Société');
  assert.equal(b.reason, 'Unavailable,\nnot assessed');
});


test('empty rankings export a header-only CSV and absent export callbacks give actionable errors', async () => {
  let document;
  const f = fixture({ exportDocument: async value => { document = value; return {}; } });
  const result = await f.call('career_matches_export');
  assert.equal(result.total, 0); assert.equal(result.scored, 0); assert.equal(result.unavailable, 0);
  assert.deepEqual(parseCSV(document.bytes.toString('utf8')), []);
  await assert.rejects(fixture().call('career_matches_export'), { code: 'EXPORT_UNAVAILABLE' });
});

test('ties use known publication dates then IDs with unknown metadata deterministic and unavailable rows last', async () => {
  const f = fixture();
  await f.store.update(state => {
    state.career.matching = {
      jobs: { 'node:dated': job('dated', '2020-01-01T00:00:00Z'),
        'node:unknown-b': { ...job('unknown-b'), publishedAt: null },
        'node:null-dated': job('null-dated', '2026-01-01T00:00:00Z') },
      scores: Object.fromEntries([
        assessment('unknown-b', 50), assessment('unknown-a', 50), assessment('dated', 50),
        unavailable('null-unknown'), unavailable('null-dated'),
      ].map(row => [row.id, stored(row)])),
      pairs: {},
    };
  });
  const expected = ['node:dated', 'node:unknown-a', 'node:unknown-b', 'node:null-dated', 'node:null-unknown'];
  assert.deepEqual((await f.call('career_matches')).matches.map(row => row.id), expected);
  assert.deepEqual((await f.call('career_matches')).matches.map(row => row.id), expected);
  assert.deepEqual(f.calls, []);
});

test('recommendations never pad with location-compatible skips, unresolved gaps, exclusions, unavailable or unreviewed rows', async () => {
  const ids = ['weak', 'gap', 'contradicted', 'perfect', 'move', 'location', 'unavailable', 'excluded', 'legacy', 'no-decision'];
  let document;
  const f = fixture({ jobs: ids.map(id => job(id)), exportDocument: async value => { document = value; return {}; } });
  const { profileVersion } = await f.call('career_match_jobs');
  assert.equal(profileVersion, '0:0');
  await f.save([
    assessment('weak', 52, 'not_required'), assessment('gap', 90, 'not_required', 'clarify'),
    assessment('contradicted', 95, 'not_required', 'skip'),
    assessment('perfect', 100, 'not_required'), assessment('move', 100, 'required'), assessment('location', 99, 'unclear'),
    unavailable('unavailable'), excluded('excluded', 98, 'not_required'),
  ], profileVersion);
  await f.store.update(state => {
    state.career.matching.scores['node:legacy'] = { ...stored(assessment('legacy', 100, 'not_required')), policyId: 'old-policy' };
    const { decision: _decision, ...undecided } = stored(assessment('no-decision', 100, 'not_required'));
    state.career.matching.scores['node:no-decision'] = undecided;
  });
  f.setPlatformError(new Error('No paid or network reads allowed'));
  const before = f.store.get(), calls = f.calls.length;
  const recommendations = await f.call('career_recommendations');
  assert.equal(f.tools.get('career_recommendations').readOnly, true);
  assert.deepEqual(recommendations.recommendations.map(row => [row.id, row.overall, row.band]), [['node:perfect', 100, 'strong']]);
  assert.equal(recommendations.total, 1);
  assert.equal(recommendations.policyId, ASSESSMENT_POLICY_ID);
  assert.equal(recommendations.reviewed, 8);
  assert.equal(recommendations.needsReview, 2);
  const archive = await f.call('career_matches');
  const find = id => archive.matches.find(row => row.id === `node:${id}`);
  assert.equal(archive.view, 'assessment_archive');
  assert.equal(archive.total, ids.length);
  assert.deepEqual(['weak', 'gap', 'contradicted', 'excluded'].map(id => [find(id).decision, find(id).matchStatus]),
    [['skip', 'eligible'], ['clarify', 'eligible'], ['skip', 'eligible'], ['skip', 'excluded']]);
  assert.equal(find('legacy').reviewStatus, 'needs_review');
  assert.equal(find('no-decision').decision, null);
  assert.equal(find('no-decision').reviewStatus, 'needs_review');
  await f.call('career_matches_export');
  const exported = parseCSV(document.bytes.toString('utf8'));
  assert.equal(exported.length, ids.length);
  assert.ok(exported.some(row => row.overall === '100' && row.decision === 'recommend'));
  assert.ok(exported.some(row => row.overall === '98' && row.decision === 'skip' && row.matchStatus === 'excluded'));
  assert.deepEqual(f.store.get(), before);
  assert.equal(f.calls.length, calls);
  // Relocation status is a separate final filter, never a fit penalty.
  await f.store.update(state => { state.career.profile.preferences.willingToRelocate = true; });
  assert.deepEqual((await f.call('career_recommendations')).recommendations.map(row => row.id), ['node:move', 'node:perfect']);
});

test('changed evidence suppresses old recommendations and requeues the current weekly catalogue', async () => {
  const f = fixture({ jobs: [job('old'), job('current')] });
  const { profileVersion } = await f.call('career_match_jobs');
  await f.save([assessment('old', 100, 'not_required'), assessment('current', 80, 'not_required')], profileVersion);
  assert.equal((await f.call('career_recommendations')).total, 2);
  f.setCatalogue([job('current'), job('new')]);
  await f.store.update(state => {
    state.career.profile.preferences.notes = 'Only engineering management for this search.';
    state.career.evidenceRevision++;
  });
  const stale = await f.call('career_recommendations');
  assert.deepEqual(stale.recommendations, []);
  assert.equal(stale.total, 0);
  assert.equal(stale.reviewed, 0);
  assert.equal(stale.needsReview, 2);
  const archive = await f.call('career_matches');
  assert.deepEqual(archive.matches.map(row => row.overall), [100, 80]);
  assert.ok(archive.matches.every(row => row.reviewStatus === 'needs_review'));
  const before = f.store.get();
  await assert.rejects(f.save([assessment('old', 0), assessment('current', 0)], profileVersion), { code: 'PROFILE_CHANGED' });
  assert.deepEqual(f.store.get(), before);
  const planned = await f.call('career_match_jobs');
  assert.equal(planned.profileVersion, '1:0');
  assert.deepEqual(planned.jobIds, ['node:current', 'node:new']);
  assert.equal(planned.pending, 1);
  assert.equal(planned.needsReview, 1);
  await f.save([assessment('current', 0)], planned.profileVersion);
  assert.deepEqual((await f.call('career_match_jobs')).jobIds, ['node:new']);
  assert.deepEqual((await f.call('career_match_jobs', { refresh: true })).jobIds, ['node:current', 'node:new']);
});

test('profile version is checked inside the queued transaction and bounded local reassessment needs no discovery', async () => {
  const f = fixture({ jobs: [job('a')] });
  const { profileVersion } = await f.call('career_match_jobs');
  await f.save([assessment('a', 100, 'not_required')], profileVersion);
  const change = f.store.update(state => { state.career.evidenceRevision++; });
  const rejected = f.save([assessment('a', 0)], profileVersion);
  await change;
  await assert.rejects(rejected, { code: 'PROFILE_CHANGED' });
  assert.equal(f.store.get().career.matching.scores['node:a'].overall, 100);
  f.setPlatformError(new Error('Offline'));
  const calls = f.calls.length;
  const currentVersion = matchingProfileVersion(f.store.get().career);
  await f.save([assessment('a', 0)], currentVersion);
  assert.equal((await f.call('career_matches')).matches[0].overall, 0);
  assert.equal((await f.call('career_recommendations')).total, 0);
  assert.equal(f.calls.length, calls);
});

test('recommendation paging counts only current suitable rows without hiding full archive coverage', async () => {
  const ids = Array.from({ length: 107 }, (_, index) => String(index).padStart(3, '0'));
  const f = fixture({ jobs: ids.map(id => job(id)) });
  const { profileVersion } = await f.call('career_match_jobs');
  for (let offset = 0; offset < ids.length; offset += 10)
    await f.save(ids.slice(offset, offset + 10).map(id => id === '106'
      ? assessment(id, 99, 'not_required', 'skip') : assessment(id, 80, 'not_required')), profileVersion);
  const first = await f.call('career_recommendations', { limit: 100 });
  assert.equal(first.total, 106);
  assert.equal(first.scored, 107);
  assert.equal(first.reviewed, 107);
  assert.equal(first.recommendations.length, 100);
  assert.equal(first.nextOffset, 100);
  assert.deepEqual(first.recommendations.map(row => row.id), ids.slice(0, 100).map(id => `node:${id}`));
  const second = await f.call('career_recommendations', { offset: first.nextOffset, limit: 100 });
  assert.equal(second.total, 106);
  assert.equal(second.nextOffset, null);
  assert.deepEqual(second.recommendations.map(row => row.id), ids.slice(100, 106).map(id => `node:${id}`));
  const beyond = await f.call('career_recommendations', { offset: 200 });
  assert.deepEqual(beyond.recommendations, []);
  assert.equal(beyond.total, 106);
  assert.equal(beyond.nextOffset, null);
  assert.equal((await f.call('career_matches')).total, 107);
});

test('token validation rejects missing or malformed inputs and every integer overall maps to its computed decision', async () => {
  const f = fixture({ jobs: Array.from({ length: 101 }, (_, value) => job(String(value))) });
  const { profileVersion } = await f.call('career_match_jobs');
  const assessments = [assessment('0', 0)];
  const invalid = [
    { policyId: ASSESSMENT_POLICY_ID, assessments },
    { profileVersion, assessments },
    { profileVersion, policyId: ASSESSMENT_POLICY_ID },
    ...[-1, 0.5, '0', null, Number.MAX_SAFE_INTEGER + 1].map(value => ({ profileVersion: value, policyId: ASSESSMENT_POLICY_ID, assessments })),
    { profileVersion, policyId: ASSESSMENT_POLICY_ID, assessments, scores: [] },
  ];
  const before = f.store.get();
  for (const args of invalid) {
    assert.equal(f.tools.get('career_match_save').validate(args), false);
    await assert.rejects(f.tools.get('career_match_save').invoke(args), { code: 'INVALID_INPUT' });
  }
  for (const args of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 0.5 }, { decision: 'skip' }]) {
    assert.equal(f.tools.get('career_recommendations').validate(args), false);
    await assert.rejects(f.tools.get('career_recommendations').invoke(args), { code: 'INVALID_INPUT' });
  }
  assert.deepEqual(f.store.get(), before);
  for (let offset = 0; offset <= 100; offset += 10)
    await f.save(Array.from({ length: Math.min(10, 101 - offset) }, (_, index) =>
      assessment(String(offset + index), offset + index, 'not_required')), profileVersion);
  const saved = f.store.get().career.matching.scores;
  assert.deepEqual(Object.values(saved).map(row => row.overall).sort((a, b) => a - b), Array.from({ length: 101 }, (_, value) => value));
  assert.equal(saved['node:59'].decision, 'skip');
  assert.equal(saved['node:60'].decision, 'recommend');
  const recommendations = await f.call('career_recommendations', { limit: 100 });
  assert.equal(recommendations.total, 41);
  assert.deepEqual(recommendations.recommendations.map(row => row.overall), Array.from({ length: 41 }, (_, index) => 100 - index));
});

test('recommendation order is overall then known publication date then ID and unstated consent never authorizes a move', async () => {
  const f = fixture();
  await f.store.update(state => {
    state.prescanPublicationRange = 'past_week';
    delete state.career.profile.preferences.willingToRelocate;
    state.career.matching = {
      jobs: { 'node:older': job('older', new Date(Date.now() - 4 * 86400000).toISOString()), 'node:new-b': job('new-b'),
        'node:new-a': job('new-a'), 'node:highest': job('highest', new Date(Date.now() - 6 * 86400000).toISOString()) },
      scores: Object.fromEntries([
        assessment('unknown', 80, 'not_required'), assessment('older', 80, 'not_required'),
        assessment('new-b', 80, 'not_required'), assessment('new-a', 80, 'not_required'),
        assessment('highest', 100, 'not_required'), assessment('move', 100, 'required'),
      ].map(row => [row.id, stored(row)])),
      pairs: {},
    };
  });
  const expected = ['node:highest', 'node:new-a', 'node:new-b', 'node:older'];
  assert.deepEqual((await f.call('career_recommendations')).recommendations.map(row => row.id), expected);
  await f.store.update(state => { state.career.profile.preferences.willingToRelocate = null; });
  assert.deepEqual((await f.call('career_recommendations')).recommendations.map(row => row.id), expected);
  assert.deepEqual(f.calls, []);
});

test('stated compensation below the saved floor must be saved as a constraints gate fail', async () => {
  const f = fixture({ jobs: [
    { ...job('low'), salary: { minimum: 85000, maximum: 85000, currency: 'EUR', period: 'year' } },
    { ...job('range'), salary: { minimum: 85000, maximum: 120000, currency: 'EUR', period: 'year' } },
    job('unstated'),
  ] });
  await f.store.update(state => Object.assign(state.career.profile.preferences, {
    salaryMinimum: 100000, salaryCurrency: 'EUR', salaryPeriod: 'year', notes: 'Salary is not critical.',
  }));
  await f.call('career_match_jobs');
  const before = f.store.get();
  for (const low of [assessment('low', 90, 'not_required'), assessment('low', 90, 'not_required', 'clarify'),
    { ...assessment('low', 90, 'not_required'), gates: { ...passing, constraints: 'flag' } },
    { ...assessment('low', 90, 'not_required'), gates: { ...passing, direction: 'fail' } }]) {
    await assert.rejects(f.save([assessment('range', 90, 'not_required'), low]),
      error => error.code === 'SALARY_BELOW_MINIMUM' && /node:low/.test(error.message) && /constraints fail/.test(error.message));
    assert.deepEqual(f.store.get(), before);
  }
  await f.save([excluded('low', 90, 'not_required'), assessment('range', 90, 'not_required'), assessment('unstated', 80, 'not_required')]);
  const low = (await f.call('career_matches')).matches.find(row => row.id === 'node:low');
  assert.deepEqual([low.decision, low.matchStatus, low.overall], ['skip', 'excluded', 90]);
  const ready = await f.call('career_recommendations');
  assert.deepEqual(ready.recommendations.map(row => row.id), ['node:range', 'node:unstated']);
  assert.equal(ready.recommendations[0].salaryEligibility.status, 'range_can_meet_minimum');
  assert.equal(ready.recommendations[1].salaryEligibility.status, 'not_stated');
});

test('a changed stated salary is filtered before paging without rewriting the saved assessment', async () => {
  const f = fixture({ jobs: [
    { ...job('a'), salary: { minimum: 110000, maximum: 120000, currency: 'EUR', period: 'year' } },
    { ...job('b'), salary: { minimum: 100000, maximum: 100000, currency: 'EUR', period: 'year' } },
  ] });
  await f.store.update(state => Object.assign(state.career.profile.preferences,
    { salaryMinimum: 100000, salaryCurrency: 'EUR', salaryPeriod: 'year' }));
  await f.call('career_match_jobs');
  await f.save([assessment('a', 99, 'not_required'), assessment('b', 80, 'not_required')]);
  await f.store.update(state => { state.career.matching.jobs['node:a'].salary.maximum = 90000; state.career.matching.jobs['node:a'].salary.minimum = 85000; });
  const before = f.store.get();
  const page = await f.call('career_recommendations', { limit: 1 });
  assert.equal(page.total, 1);
  assert.equal(page.nextOffset, null);
  assert.equal(page.recommendations[0].id, 'node:b');
  assert.equal((await f.call('career_matches')).matches.find(row => row.id === 'node:a').salaryEligibility.status, 'below_minimum');
  assert.equal(f.store.get().career.matching.scores['node:a'].overall, 99);
  assert.deepEqual(f.store.get(), before);
});

test('assessments saved under another rubric need review and are excluded until reassessed', async () => {
  const f = fixture({ jobs: [job('a')] });
  await f.call('career_match_jobs');
  await f.store.update(state => { state.career.matching.scores['node:a'] = { ...stored(assessment('a', 95, 'not_required')), policyId: 'old-policy' }; });
  const before = f.store.get();
  const old = await f.call('career_recommendations');
  assert.equal(old.total, 0);
  assert.equal(old.needsReview, 1);
  assert.equal((await f.call('career_matches')).matches[0].reviewStatus, 'needs_review');
  assert.deepEqual(f.store.get(), before);
  const current = await f.call('career_match_jobs');
  assert.deepEqual(current.jobIds, ['node:a']);
  await f.save([assessment('a', 95, 'not_required')], current.profileVersion);
  assert.equal(f.store.get().career.matching.scores['node:a'].policyId, ASSESSMENT_POLICY_ID);
  assert.equal((await f.call('career_recommendations')).total, 1);
});

test('compensation comparison uses stated units, never invented exchange rates or annual working hours', () => {
  const minimum = { salaryMinimum: 100000, salaryCurrency: 'EUR', salaryPeriod: 'year' };
  assert.equal(salaryEligibility(minimum, { maximum: 95000, currency: 'EUR', period: 'year' }).status, 'below_minimum');
  assert.equal(salaryEligibility(minimum, { stated: 100000, currency: 'EUR', period: 'year' }).status, 'range_can_meet_minimum');
  assert.equal(salaryEligibility(minimum, { minimum: 8000, maximum: 8000, currency: 'EUR', period: 'month' }).status, 'below_minimum');
  assert.equal(salaryEligibility(minimum, { minimum: 8500, maximum: 8500, currency: 'EUR', period: 'month' }).status, 'range_can_meet_minimum');
  assert.equal(salaryEligibility(minimum, { minimum: 85000, currency: 'EUR', period: 'year' }).status, 'unbounded_range');
  assert.equal(salaryEligibility(minimum, { stated: 150000, currency: 'USD', period: 'year' }).status, 'not_comparable');
  assert.equal(salaryEligibility(minimum, { stated: 100, currency: 'EUR', period: 'hour' }).status, 'not_comparable');
  assert.equal(salaryEligibility(minimum, { minimum: 120000, maximum: 85000, currency: 'EUR', period: 'year' }).status, 'not_comparable');
});

test('career context retains the end of the full saved CV', async () => {
  const f = fixture();
  const cv = 'Owned the product and delivery. '.repeat(2000) + 'Led customer discovery and coached the product team.';
  await f.store.update(state => { state.career.sources.cv.text = cv; });
  const context = await f.call('career_match_jobs');
  assert.equal(context.candidate.cv, cv);
});

test('the weekly window includes its exact boundary and excludes older, future and invalid dates', () => {
  const now = Date.parse('2026-04-01T12:00:00Z'), week = 7 * 86400000;
  assert.equal(recentPublication(new Date(now - week).toISOString(), now), true);
  assert.equal(recentPublication(new Date(now - week - 1).toISOString(), now), false);
  assert.equal(recentPublication(new Date(now).toISOString(), now), true);
  assert.equal(recentPublication(new Date(now + 1).toISOString(), now), false);
  assert.equal(recentPublication('not a date', now), false);
});

test('reassessment retains the selected month scope and replaces earlier job cache and rankings', async () => {
  const now = Date.now(), f = fixture({ jobs: [
    job('recent', new Date(now - 86400000).toISOString()),
    job('six-days', new Date(now - 6 * 86400000).toISOString()),
    job('older', new Date(now - 8 * 86400000).toISOString()),
    job('future', new Date(now + 86400000).toISOString()),
  ] });
  await f.store.update(state => { state.prescanPublicationRange = 'past_month'; });
  const first = await f.call('career_match_jobs');
  assert.deepEqual(first.jobIds, ['node:recent', 'node:six-days', 'node:older']);
  await f.save([assessment('recent', 90)], first.profileVersion);
  const reset = await f.call('career_match_jobs', { refresh: true });
  assert.deepEqual(reset.jobIds, first.jobIds);
  assert.equal(reset.scored, 0);
  assert.equal(reset.pending, 3);
  assert.notEqual(reset.profileVersion, first.profileVersion);
  assert.deepEqual(Object.keys(f.store.get().career.matching.jobs), first.jobIds);
  await assert.rejects(f.save([assessment('recent')], first.profileVersion), { code: 'PROFILE_CHANGED' });
});

test('new analysis uses the past three days while an explicit broader selection remains available', async () => {
  const now = Date.now();
  const f = fixture({ jobs: [job('recent', new Date(now - 2 * 86400000).toISOString()),
    job('older', new Date(now - 4 * 86400000).toISOString())] });
  const initial = await f.call('career_match_jobs');
  assert.deepEqual(initial.jobIds, ['node:recent']);
  await f.store.update(state => { state.prescanPublicationRange = 'all'; });
  const broader = await f.call('career_match_jobs');
  assert.deepEqual(broader.jobIds, ['node:recent', 'node:older']);
});

test('delete rankings preserves all career and account data and invalidates old writer output', async () => {
  const f = fixture();
  await f.store.update(state => {
    state.pairing = { account: 'synthetic-account' };
    state.deviceId = 'synthetic-device';
    state.career.applications.existing = { cv: 'saved draft' };
  });
  const context = await f.call('career_match_jobs');
  await f.save([assessment('a')], context.profileVersion);
  const protectedData = state => {
    const { matching, rankingVersion, ...career } = state.career;
    return { ...state, career };
  };
  const before = protectedData(f.store.get()), calls = f.calls.length;
  const deleted = await f.call('career_rankings_delete');
  assert.deepEqual(deleted, { deletedRankings: 1, deletedJobs: 3 });
  assert.deepEqual(protectedData(f.store.get()), before);
  assert.deepEqual(f.store.get().career.matching, emptyMatching);
  assert.equal(f.calls.length, calls);
  const fresh = await f.call('career_match_jobs');
  await assert.rejects(f.save([assessment('a')], context.profileVersion), { code: 'PROFILE_CHANGED' });
  await f.save([assessment('a')], fresh.profileVersion);
  assert.equal((await f.call('career_matches')).total, 1);
});

test('an in-flight details request cannot restore jobs after deleting rankings', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pendingResponse = new Promise(resolve => { release = resolve; });
  const f = fixture({ batch: async () => { entered(); return pendingResponse; } });
  await f.call('career_match_jobs');
  const pending = f.call('career_match_batch', { ids: ['node:a'] });
  const rejected = assert.rejects(pending, { code: 'RANKINGS_CHANGED' });
  await started;
  await f.call('career_rankings_delete');
  release({ jobs: [job('a')], remainingIds: [], unavailableIds: [] });
  await rejected;
  assert.deepEqual(f.store.get().career.matching, emptyMatching);
});

test('pre-scan discovery preserves existing final assessments while assigning only current catalogue jobs', async () => {
  const f = fixture({ jobs: [{ ...job('old'), ...statedTerms }], preserveFinalAssessments: true });
  const first = await f.call('career_match_jobs');
  await f.save([assessment('old', 84, 'not_required')], first.profileVersion);
  const before = f.store.get().career.matching;
  f.setCatalogue([job('new')]);
  const discovery = await f.call('career_match_jobs');
  assert.deepEqual(discovery.jobIds, ['node:new']);
  assert.equal(discovery.total, 1);
  assert.equal(discovery.pending, 1);
  assert.deepEqual(f.store.get().career.matching.scores, before.scores);
  assert.deepEqual(f.store.get().career.matching.jobs['node:old'], before.jobs['node:old']);
  const saved = await f.call('career_matches');
  assert.equal(saved.matches[0].overall, 84);
  assert.equal(saved.matches[0].city, statedTerms.city);
});

test('discovery assigns only the jobs at or above the minimum pre-filter score, honours overrides and reports the excluded count', async () => {
  const ids = ['first', 'second', 'third', 'fourth', 'reviewed', 'plain'];
  const f = fixture({ jobs: ids.map(id => job(id)) });
  const planned = await f.call('career_match_jobs');
  assert.deepEqual(planned.jobIds, ids.map(id => `node:${id}`));
  assert.equal(planned.excluded, 0);
  assert.equal(planned.minimumScore, 60);
  await f.save([assessment('reviewed', 70)], planned.profileVersion);
  const priorities = { first: 95, second: 90, third: 60, fourth: 40 };
  await f.store.update(state => {
    state.career.prescan = { profileVersion: matchingProfileVersion(state.career), prescanPolicyId: decisionProviders.openai.policyId,
      provider: 'openai', rows: Object.fromEntries(Object.entries(priorities).map(([id, priority]) =>
        [`node:${id}`, { priority, status: 'scored', publishedAt, direction: 'aligned', constraints: 'aligned', eligibility: 'aligned' }])) };
    state.career.prescanInclusion = { minimumScore: 91, overrides: { 'node:fourth': true, 'node:second': false, 'node:plain': true } };
  });
  const scoped = await f.call('career_match_jobs');
  assert.deepEqual(scoped.jobIds, ['node:first', 'node:fourth', 'node:plain']);
  assert.equal(scoped.excluded, 2);
  assert.equal(scoped.minimumScore, 91);
  assert.equal(scoped.pending, 5);
  // The boundary is inclusive: 60 passes a minimum of 60 and fails 61.
  await f.store.update(state => { state.career.prescanInclusion = { minimumScore: 60, overrides: {} }; });
  assert.deepEqual((await f.call('career_match_jobs')).jobIds, ['node:first', 'node:second', 'node:third']);
  await f.store.update(state => { state.career.prescanInclusion = { minimumScore: 61, overrides: {} }; });
  const narrowed = await f.call('career_match_jobs');
  assert.deepEqual(narrowed.jobIds, ['node:first', 'node:second']);
  assert.equal(narrowed.excluded, 3);
  await f.call('career_rankings_delete');
  const career = f.store.get().career;
  assert.equal(career.prescan, undefined);
  assert.equal(career.prescanInclusion, undefined);
  const fresh = await f.call('career_match_jobs');
  assert.deepEqual(fresh.jobIds, ids.map(id => `node:${id}`));
  assert.equal(fresh.excluded, 0);
});

/** Seven recommendable rows r1..r7 (overall 90..61) plus high-overall rows that are not current recommendations. */
async function rerankFixture(options) {
  const overall = { r1: 90, r2: 85, r3: 80, r4: 75, r5: 70, r6: 65, r7: 61 };
  const f = fixture({ jobs: [...Object.keys(overall), 'gap', 'location', 'low'].map(id => job(id)), ...options });
  const { profileVersion } = await f.call('career_match_jobs');
  await f.save([...Object.entries(overall).map(([id, value]) => assessment(id, value, 'not_required')),
    assessment('gap', 99, 'not_required', 'clarify'), assessment('location', 98, 'unclear'), assessment('low', 59, 'not_required')], profileVersion);
  return { f, profileVersion };
}
const comparison = (a, b, preferred) => ({ a: `node:${a}`, b: `node:${b}`, preferred, decisive: ['direction'], reason: 'Closer to the intended next move.' });
const ranks = async f => (await f.call('career_recommendations')).recommendations.map(row => [row.id.slice(5), row.pairwiseWins, row.pairwiseCompared]);

test('rerank pairs come only from the top current recommendations and cover every unordered pair once', async () => {
  const { f, profileVersion } = await rerankFixture();
  assert.equal(RERANK_SIZE, 6);
  const before = f.store.get();
  const result = await f.call('career_rerank_pairs');
  assert.equal(f.tools.get('career_rerank_pairs').readOnly, true);
  assert.deepEqual(f.store.get(), before);
  assert.equal(result.profileVersion, profileVersion);
  assert.equal(result.policyId, ASSESSMENT_POLICY_ID);
  assert.equal(result.rerankPolicy, RERANK_POLICY);
  assert.deepEqual(result.candidates.map(row => row.id), ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map(id => `node:${id}`));
  const saved = before.career.matching.scores['node:r1'];
  assert.deepEqual(result.candidates[0], { id: 'node:r1', title: 'Engineer r1', company: 'Company', overall: 90, band: 'strong',
    dimensions: saved.dimensions, gates: saved.gates, requirements: saved.requirements, reason: saved.reason });
  assert.equal(result.pairs.length, 15);
  assert.ok(result.pairs.every(({ a, b }) => a < b));
  assert.equal(new Set(result.pairs.map(({ a, b }) => `${a}|${b}`)).size, 15);
  assert.deepEqual({ judged: result.judged, total: result.total }, { judged: 0, total: 15 });
  const single = fixture({ jobs: [job('only')] });
  const context = await single.call('career_match_jobs');
  await single.save([assessment('only', 90, 'not_required')], context.profileVersion);
  const alone = await single.call('career_rerank_pairs');
  assert.deepEqual([alone.candidates.length, alone.pairs, alone.total], [1, [], 0]);
});

test('pairwise comparisons reorder recommendations by wins, normalise reversed input and refuse outsiders without writes', async () => {
  let document;
  const { f, profileVersion } = await rerankFixture({ exportDocument: async value => { document = value; return {}; } });
  const before = f.store.get();
  for (const [code, args] of [
    ['NOT_IN_RERANK_SET', { comparisons: [comparison('r1', 'r7', 'a')] }],
    ['NOT_IN_RERANK_SET', { comparisons: [comparison('r1', 'r2', 'a'), comparison('gap', 'r2', 'b')] }],
    ['NOT_IN_RERANK_SET', { comparisons: [comparison('location', 'r2', 'b')] }],
    ['INVALID_INPUT', { comparisons: [comparison('r1', 'r1', 'equal')] }],
    ['INVALID_INPUT', { comparisons: [{ ...comparison('r1', 'r2', 'a'), decisive: ['location'] }] }],
    ['POLICY_CHANGED', { policyId: 'old-policy', comparisons: [comparison('r1', 'r2', 'a')] }],
    ['PROFILE_CHANGED', { profileVersion: '1:0', comparisons: [comparison('r1', 'r2', 'a')] }],
  ]) {
    await assert.rejects(f.call('career_rerank_save', { profileVersion, policyId: ASSESSMENT_POLICY_ID, ...args }), { code });
    assert.deepEqual(f.store.get(), before);
  }
  const result = await f.call('career_rerank_save', { profileVersion, policyId: ASSESSMENT_POLICY_ID,
    comparisons: [comparison('r6', 'r1', 'a'), comparison('r2', 'r3', 'equal')] });
  assert.deepEqual(result, { saved: 2, remaining: 13 });
  const pairs = f.store.get().career.matching.pairs;
  assert.deepEqual(Object.keys(pairs).sort(), ['node:r1|node:r6', 'node:r2|node:r3']);
  assert.deepEqual([pairs['node:r1|node:r6'].a, pairs['node:r1|node:r6'].b, pairs['node:r1|node:r6'].preferred], ['node:r1', 'node:r6', 'b']);
  assert.equal(pairs['node:r1|node:r6'].aScoredAt, before.career.matching.scores['node:r1'].scoredAt);
  assert.equal(pairs['node:r2|node:r3'].preferred, 'equal');
  // Judged rows lead by wins even when their overall fit is lower; unjudged rows keep overall order.
  assert.deepEqual(await ranks(f), [['r6', 1, 1], ['r2', 0.5, 1], ['r3', 0.5, 1], ['r1', 0, 1],
    ['r4', undefined, undefined], ['r5', undefined, undefined], ['r7', undefined, undefined]]);
  assert.deepEqual((await f.call('career_recommendations')).rerank, { judged: 2, total: 15 });
  const remaining = await f.call('career_rerank_pairs');
  assert.equal(remaining.pairs.length, 13);
  assert.ok(!remaining.pairs.some(({ a, b }) => `${a}|${b}` === 'node:r1|node:r6' || `${a}|${b}` === 'node:r2|node:r3'));
  assert.equal((await f.call('career_matches')).matches.find(row => row.id === 'node:r6').pairwiseWins, 1);
  await f.call('career_matches_export');
  assert.equal(parseCSV(document.bytes.toString('utf8')).find(row => row.id === 'node:r6').pairwiseWins, '1');
  // Re-saving an assessment discards the comparisons that judged its previous version.
  await f.save([assessment('r6', 65, 'not_required'), assessment('r3', 80, 'not_required')], profileVersion);
  assert.deepEqual(f.store.get().career.matching.pairs, {});
  assert.deepEqual((await ranks(f)).map(([id, wins]) => [id, wins]),
    ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'].map(id => [id, undefined]));
  assert.deepEqual((await f.call('career_recommendations')).rerank, { judged: 0, total: 15 });
});

test('catalogue refresh and ranking deletion clear comparisons while ordinary discovery keeps pairs of retained jobs', async () => {
  const { f, profileVersion } = await rerankFixture();
  const save = () => f.call('career_rerank_save', { profileVersion, policyId: ASSESSMENT_POLICY_ID,
    comparisons: [comparison('r1', 'r6', 'b'), comparison('r2', 'r3', 'a')] });
  await save();
  f.setCatalogue(['r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'gap', 'location', 'low'].map(id => job(id)));
  await f.call('career_match_jobs');
  assert.deepEqual(Object.keys(f.store.get().career.matching.pairs), ['node:r2|node:r3']);
  await f.call('career_rankings_delete');
  assert.deepEqual(f.store.get().career.matching, emptyMatching);
  const second = await rerankFixture();
  await second.f.call('career_rerank_save', { profileVersion: second.profileVersion, policyId: ASSESSMENT_POLICY_ID,
    comparisons: [comparison('r1', 'r2', 'b')] });
  assert.equal(Object.keys(second.f.store.get().career.matching.pairs).length, 1);
  await second.f.call('career_match_jobs', { refresh: true });
  assert.deepEqual(second.f.store.get().career.matching.pairs, {});
});
