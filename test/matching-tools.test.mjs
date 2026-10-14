import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { createMatchingTools } from '../src/mcp/matching-tools.mjs';
import { createCareerState } from '../src/mcp/state.mjs';
import { ASSESSMENT_VERSION, salaryEligibility, recentPublication, matchingProfileVersion } from '../src/mcp/assessment-policy.mjs';

const publishedAt = new Date(Date.now() - 86400000).toISOString();
const job = (id, date = publishedAt) => ({ id: `node:${id}`, title: `Engineer ${id}`, company: 'Company', publishedAt: date });
const score = (id, value = 80, relocation = 'unclear', decision = value === null ? 'clarify' : value === 0 ? 'skip' : 'recommend') =>
  ({ id: `node:${id}`, score: value, reason: 'Relevant engineering experience.', relocation, decision });
const missingTerms = { salary: null, city: null, location: null, workMode: null };
const statedTerms = {
  salary: { minimum: 90000, maximum: 120000, stated: null, currency: 'EUR', period: 'year' },
  city: 'Dublin', location: 'Dublin, Ireland', workMode: 'hybrid',
};
const termsOf = ({ salary, city, location, workMode }) => ({ salary, city, location, workMode });
const fact = (subject, answer, kind = 'note') => ({ kind, subject, answer });
function fixture({ jobs = [job('a'), job('b'), job('c')], batch, emptyProfile = false, exportDocument } = {}) {
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
    if (operation === 'matching_catalogue') return { jobs: structuredClone(catalogue), total: catalogue.length };
    assert.equal(operation, 'matching_jobs');
    return batch ? batch(args) : { jobs: args.ids.map(id => ({ ...catalogue.find(job => job.id === id), ad: 'Full original ad', company: { name: 'Company' } })), remainingIds: [], unavailableIds: [] };
  };
  const ajv = new Ajv({ strict: false, allErrors: true });
  const tools = new Map(createMatchingTools({ store, platform, exportDocument }).map(tool => [tool.name, { ...tool, validate: ajv.compile(tool.inputSchema) }]));
  const call = async (name, args = {}) => {
    const tool = tools.get(name);
    if (!tool.validate(args)) throw Object.assign(new Error(ajv.errorsText(tool.validate.errors)), { code: 'INVALID_INPUT' });
    return tool.invoke(args);
  };
  return { store, calls, tools, call, setCatalogue: jobs => { catalogue = jobs; }, setPlatformError: error => { platformError = error; } };
}

test('candidate brief combines the CV with additional answers without exporting source bytes or profile contacts', async () => {
  const f = fixture();
  const result = await f.call('career_match_jobs');
  assert.deepEqual(result.jobIds, ['node:a', 'node:b', 'node:c']);
  assert.equal(result.jobs, undefined);
  assert.deepEqual(result.candidate.facts.map(fact => fact.subject), ['Internal tooling', 'Reporting services']);
  assert.equal(result.candidate.cv, 'Software engineer at Acme, 2019–2023. Built reporting services.');
  assert.equal(result.candidate.preferences.willingToRelocate, false);
  assert.equal(result.candidate.preferences.salaryMinimum, 0);
  assert.equal(result.candidate.location, 'Dublin');
  for (const secret of ['PRIVATE NAME', 'private@example.test', '+353 123 456 789', 'https://private.test', 'PRIVATE FULL CV', 'PRIVATE PDF'])
    assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual({ total: result.total, scored: result.scored, pending: result.pending, batchSize: result.batchSize, workers: result.workers },
    { total: 3, scored: 0, pending: 3, batchSize: 10, workers: 8 });
  assert.deepEqual(f.calls, [{ operation: 'matching_catalogue', args: {} }]);
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

test('eight concurrent score batches merge atomically and saved matches are readable before completion', async () => {
  const f = fixture({ jobs: Array.from({ length: 81 }, (_, index) => job(String(index))) });
  await f.call('career_match_jobs');
  await Promise.all(Array.from({ length: 8 }, (_, worker) => f.call('career_match_save', {
    profileVersion: '0:0',
    scores: Array.from({ length: 10 }, (_, index) => score(String(worker * 10 + index), worker * 10 + index)),
  })));
  const result = await f.call('career_matches', { limit: 100 });
  assert.equal(result.matches.length, 80);
  assert.equal(result.scored, 80);
  assert.equal(result.pending, 1);
  assert.equal(result.unavailable, 0);
  assert.equal(result.matches[0].id, 'node:79');
  assert.equal(Object.keys(f.store.get().career.matching.scores).length, 80);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.get().career.revision, 0);
});

test('one invalid or unknown row rejects an entire batch and leaves prior scores intact', async () => {
  const f = fixture();
  await f.call('career_match_jobs');
  await f.call('career_match_save', { profileVersion: '0:0', scores: [score('a', 40)] });
  for (const scores of [[score('a', 90), score('unknown')], [score('b'), score('a', 100.5)], [score('b'), score('b')]]) {
    await assert.rejects(f.tools.get('career_match_save').invoke({ profileVersion: '0:0', scores }));
    assert.deepEqual(Object.keys(f.store.get().career.matching.scores), ['node:a']);
    assert.equal(f.store.get().career.matching.scores['node:a'].score, 40);
  }
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
  await f.call('career_match_save', { profileVersion: '0:0', scores: [score('a', 90), { ...score('c', null), reason: 'Original advertisement is unavailable.' }] });
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
  await f.call('career_match_save', { profileVersion: '0:0', scores: [score('a', null)] });
  const unavailable = await f.call('career_matches');
  assert.deepEqual({ ...unavailable, matches: unavailable.matches.map(row => [row.id, row.score]) },
    { view: 'assessment_archive', matches: [['node:a', null]], total: 1, assessmentVersion: ASSESSMENT_VERSION, nextOffset: null,
      scored: 0, pending: 0, unavailable: 1, reviewed: 1, needsReview: 0 });
  const empty = fixture({ jobs: [] });
  const catalogue = await empty.call('career_match_jobs');
  assert.deepEqual(catalogue.jobIds, []);
  assert.equal(catalogue.total, 0);
  assert.equal(catalogue.pending, 0);
  assert.deepEqual(await empty.call('career_matches'), { view: 'assessment_archive', matches: [], total: 0, assessmentVersion: ASSESSMENT_VERSION,
    nextOffset: null, scored: 0, pending: 0, unavailable: 0, reviewed: 0, needsReview: 0 });
});

test('unaccounted-for backend IDs are errors rather than invented unavailable jobs', async () => {
  const f = fixture({ batch: () => ({ jobs: [], remainingIds: [], unavailableIds: [] }) });
  await f.call('career_match_jobs');
  await assert.rejects(f.call('career_match_batch', { ids: ['node:a'] }), { code: 'INVALID_BATCH' });
  await assert.rejects(f.call('career_match_batch', { ids: ['node:unknown'] }), { code: 'UNKNOWN_JOB' });
  assert.equal(f.calls.length, 2);
});

test('eligibility precedes fit without filtering records or changing saved assessments when willingness changes', async () => {
  const f = fixture({ jobs: [
    { ...job('ny'), title: 'New York office role', city: 'New York', workMode: 'onsite' },
    { ...job('compatible'), title: 'Compatible role', city: 'Dublin', workMode: 'hybrid' },
    job('unclear'), job('zero'), job('unavailable'),
  ] });
  await f.call('career_match_jobs');
  await f.call('career_match_save', { profileVersion: '0:0', scores: [
    score('ny', 88, 'required'), score('compatible', 79, 'not_required'), score('unclear', 95, 'unclear'),
    score('zero', 0, 'not_required'), score('unavailable', null, 'not_required'),
  ] });
  const saved = f.store.get().career.matching;
  const ranked = async () => {
    const result = await f.call('career_matches');
    assert.equal(result.total, 5);
    assert.equal(result.scored, 4);
    assert.equal(result.unavailable, 1);
    assert.equal(result.nextOffset, null);
    assert.deepEqual(f.store.get().career.matching, saved);
    for (const row of result.matches)
      for (const field of ['score', 'decision', 'reason', 'relocation', 'scoredAt'])
        assert.deepEqual(row[field], saved.scores[row.id][field]);
    return result.matches.map(row => [row.id, row.score, row.matchStatus]);
  };
  const noRelocation = [
    ['node:compatible', 79, 'eligible'], ['node:unclear', 95, 'needs_location_confirmation'],
    ['node:ny', 88, 'incompatible_location'], ['node:zero', 0, 'zero_fit'], ['node:unavailable', null, 'unavailable'],
  ];
  assert.deepEqual(await ranked(), noRelocation);
  await assert.rejects(f.call('career_matches', { includeRelocation: true }), { code: 'INVALID_INPUT' });
  await f.store.update(state => { state.career.profile.preferences.willingToRelocate = true; });
  assert.deepEqual(await ranked(), [
    ['node:ny', 88, 'requires_relocation'], ['node:compatible', 79, 'eligible'],
    ['node:unclear', 95, 'needs_location_confirmation'], ['node:zero', 0, 'zero_fit'], ['node:unavailable', null, 'unavailable'],
  ]);
  for (const willingness of [undefined, null]) {
    await f.store.update(state => {
      if (willingness === undefined) delete state.career.profile.preferences.willingToRelocate;
      else state.career.profile.preferences.willingToRelocate = willingness;
    });
    assert.deepEqual(await ranked(), [
      ['node:compatible', 79, 'eligible'], ['node:unclear', 95, 'needs_location_confirmation'],
      ['node:ny', 88, 'needs_location_confirmation'], ['node:zero', 0, 'zero_fit'], ['node:unavailable', null, 'unavailable'],
    ]);
  }
  await f.store.update(state => { state.career.profile.preferences.willingToRelocate = false; });
  assert.deepEqual(await ranked(), noRelocation);
  assert.equal(f.calls.length, 1);
});

test('ordinary refresh replaces rankings while retaining the current candidate context', async () => {
  const f = fixture({ jobs: [job('a')] });
  await f.call('career_match_jobs');
  await f.call('career_match_save', { profileVersion: '0:0', scores: [score('a', 50)] });
  f.setCatalogue([job('a'), job('b')]);
  assert.deepEqual((await f.call('career_match_jobs')).jobIds, ['node:b']);
  await f.store.update(state => { state.career.profile.skills.push('Rust'); });
  const refreshed = await f.call('career_match_jobs', { refresh: true });
  assert.deepEqual(refreshed.jobIds, ['node:a', 'node:b']);
  assert.deepEqual(refreshed.candidate.skills, ['JavaScript', 'Rust']);
  assert.deepEqual((await f.call('career_matches')).matches, []);
  await f.call('career_match_save', { profileVersion: refreshed.profileVersion, scores: [score('a', 95)] });
  const saved = (await f.call('career_matches')).matches[0];
  assert.equal(saved.score, 95);
  assert.equal(saved.title, 'Engineer a');
  assert.equal(saved.company, 'Company');
  assert.ok(Number.isFinite(Date.parse(saved.scoredAt)));
});

test('rank ties sort by publication date then ID and paging total remains unpaged', async () => {
  const f = fixture({ jobs: [job('a', new Date(Date.now() - 2 * 86400000).toISOString()), job('c'), job('b')] });
  await f.call('career_match_jobs');
  await f.call('career_match_save', { profileVersion: '0:0', scores: [score('a'), score('c'), score('b')] });
  assert.deepEqual((await f.call('career_matches')).matches.map(row => row.id), ['node:b', 'node:c', 'node:a']);
  const result = await f.call('career_matches', { offset: 1, limit: 1 });
  assert.deepEqual(result.matches.map(row => row.id), ['node:c']);
  assert.equal(result.total, 3);
  assert.equal(result.nextOffset, 2);
  assert.equal((await f.call('career_matches', { offset: 2, limit: 1 })).nextOffset, null);
  assert.equal((await f.call('career_matches', { offset: 20 })).nextOffset, null);
});


test('expired feed access leaves local scores and profile available without contacting the platform', async () => {
  const f = fixture();
  await f.call('career_match_jobs');
  await f.call('career_match_save', { profileVersion: '0:0', scores: [score('a', 91)] });
  const before = f.store.get();
  f.setPlatformError(Object.assign(new Error('Active subscription required'), { code: 'SUBSCRIPTION_REQUIRED' }));
  await assert.rejects(f.call('career_match_jobs'), { code: 'SUBSCRIPTION_REQUIRED' });
  await assert.rejects(f.call('career_match_batch', { ids: ['node:b'] }), { code: 'SUBSCRIPTION_REQUIRED' });
  assert.deepEqual(f.store.get(), before);
  const requests = f.calls.length;
  const saved = await f.call('career_matches');
  assert.deepEqual(saved.matches.map(row => [row.id, row.score]), [['node:a', 91]]);
  // Already obtained data can still be assessed and saved locally after access expires.
  await f.call('career_match_save', { profileVersion: '0:0', scores: [score('b', 80)] });
  assert.equal((await f.call('career_matches')).total, 2);
  assert.deepEqual(f.store.get().career.profile, before.career.profile);
  assert.equal(f.calls.length, requests);
});

test('schemas and direct invokes reject invalid inputs without writes or provider calls', async () => {
  const f = fixture();
  await f.call('career_match_jobs');
  const invalid = [
    ['career_match_jobs', { refresh: 'yes' }], ['career_match_jobs', { requestId: 'old-workflow' }],
    ['career_match_batch', {}], ['career_match_batch', { ids: [] }], ['career_match_batch', { ids: ['node:a', 'node:a'] }],
    ['career_match_batch', { ids: Array.from({ length: 11 }, (_, i) => `node:${i}`) }],
    ['career_match_save', { scores: [] }], ['career_match_save', { scores: [score('a', -1)] }],
    ['career_match_save', { scores: [score('a', 101)] }], ['career_match_save', { scores: [score('a', 0.5)] }],
    ['career_match_save', { scores: [score('a', '90')] }], ['career_match_save', { scores: [score('a', 90, 'maybe')] }],
    ['career_match_save', { scores: [{ ...score('a'), reason: 'x'.repeat(401) }] }],
    ['career_match_save', { scores: [{ ...score('a'), title: 'Invented metadata' }] }],
    ['career_match_save', { scores: [{ ...score('a'), matchStatus: 'eligible' }] }],
    ...Object.entries(statedTerms).map(([field, value]) =>
      ['career_match_save', { scores: [{ ...score('a'), [field]: value }] }]),
    ['career_matches', { limit: 0 }], ['career_matches', { limit: 101 }], ['career_matches', { offset: -1 }],
    ['career_matches', { offset: 0.5 }], ['career_matches', { includeRelocation: 'true' }],
    ['career_matches_export', { limit: 100 }], ['career_matches_export', { includeRelocation: false }],
  ];
  const before = f.store.get();
  for (const [name, args] of invalid) {
    const input = name === 'career_match_save' ? { profileVersion: '0:0', ...args } : args;
    assert.equal(f.tools.get(name).validate(input), false, `${name}: schema accepted ${JSON.stringify(input)}`);
    await assert.rejects(f.tools.get(name).invoke(input), { code: 'INVALID_INPUT' });
  }
  assert.deepEqual(f.store.get(), before);
  assert.equal(f.calls.length, 1);
  await f.call('career_match_save', { profileVersion: '0:0', scores: [{ ...score('a', 0), reason: 'x'.repeat(400) }, score('b', 100), score('c', null)] });
  assert.equal((await f.call('career_matches')).scored, 2);
});

test('catalogue replacement keeps current terms and assessments, removes absent jobs and retains saved work offline', async () => {
  const f = fixture({ jobs: [{ ...job('a'), ...statedTerms }, job('b'),
    { ...job('c'), salary: { stated: 0 }, location: 'Ireland' }] });
  const discovery = await f.call('career_match_jobs');
  await f.call('career_match_save', { profileVersion: discovery.profileVersion,
    scores: [score('a', 90), score('b', 80), score('c', 70)] });
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
    assert.deepEqual(saved.matches.map(row => row.score), [90, 80]);
    assert.equal(f.calls.length, requests);
    assert.deepEqual(f.store.get(), before);
  }
  f.setPlatformError(undefined);
  f.setCatalogue([]);
  await f.call('career_match_jobs');
  assert.deepEqual(f.store.get().career.matching, { jobs: {}, scores: {} });
});

test('batch terms refresh saved display metadata without storing ads, company graphs or changing scores', async () => {
  const updatedTerms = { salary: { minimum: null, maximum: null, stated: 55, currency: null, period: null },
    city: null, location: 'Europe', workMode: 'remote' };
  const response = {
    jobs: [
      { ...job('a'), ...updatedTerms, locationEvidence: ['Advertised role location: Europe'], ad: 'Full original ad', company: { name: 'Company', graph: ['Do not persist'] } },
      { ...job('b'), ad: 'Terms are not stated', company: { name: 'Company' } },
    ],
    remainingIds: ['node:c'], unavailableIds: ['node:d'],
  };
  const f = fixture({ jobs: ['a', 'b', 'c', 'd'].map(id => ({ ...job(id), ...statedTerms })), batch: () => response });
  await f.call('career_match_jobs');
  await f.call('career_match_save', { profileVersion: '0:0', scores: ['a', 'b', 'c', 'd'].map(id => score(id)) });
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
  await f.call('career_match_save', { profileVersion: '0:0', scores: [score('a', 95), score('b', 90)] });
  f.setPlatformError(Object.assign(new Error('Offline'), { code: 'OFFLINE' }));
  const requests = f.calls.length;
  assert.deepEqual((await f.call('career_matches')).matches.map(termsOf),
    [updatedTerms, missingTerms, statedTerms, statedTerms]);
  assert.equal(f.calls.length, requests);
  assert.deepEqual(f.calls, [
    { operation: 'matching_catalogue', args: {} },
    { operation: 'matching_jobs', args: { ids: ['node:a', 'node:b', 'node:c', 'node:d'] } },
  ]);
});

test('score submissions cannot replace catalogue display terms', async () => {
  const f = fixture({ jobs: [{ ...job('a'), ...statedTerms }] });
  await f.call('career_match_jobs');
  await f.call('career_match_save', { profileVersion: '0:0', scores: [score('a')] });
  const before = f.store.get();
  for (const [field, value] of Object.entries(missingTerms)) {
    const args = { profileVersion: '0:0', scores: [{ ...score('a', 99), [field]: value }] };
    assert.equal(f.tools.get('career_match_save').validate(args), false);
    await assert.rejects(f.tools.get('career_match_save').invoke(args), { code: 'INVALID_INPUT' });
  }
  assert.deepEqual(f.store.get(), before);
  assert.deepEqual(termsOf((await f.call('career_matches')).matches[0]), statedTerms);
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
  await f.store.update(state => {
    state.career.matching = {
      jobs: Object.fromEntries(ids.filter((_, index) => index % 7 !== 0).map(id => [job(id).id,
        { ...job(id, '2020-01-02T00:00:00.000Z'), ...statedTerms }])),
      scores: Object.fromEntries(ids.map((id, index) => [score(id).id,
        score(id, index % 11 === 0 ? null : index % 101, ['required', 'unclear', 'not_required'][index % 3])])),
    };
  });
  const saved = f.store.get().career.matching, expectedIds = ids.map(id => `node:${id}`);
  const priority = { eligible: 0, requires_relocation: 0, needs_location_confirmation: 1,
    incompatible_location: 2, zero_fit: 3, unavailable: 4 };
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
    const firstNull = rows.findIndex(row => row.score === null);
    assert.ok(firstNull > 0);
    assert.equal(rows[firstNull - 1].score, 0);
    assert.ok(rows.slice(firstNull).every(row => row.score === null));
    assert.equal(rows[0].matchStatus === 'eligible' || willingness && rows[0].matchStatus === 'requires_relocation', true);
    for (let index = 1; index < rows.length; index++) {
      const previous = rows[index - 1], current = rows[index];
      assert.ok(priority[previous.matchStatus] <= priority[current.matchStatus]);
      if (priority[previous.matchStatus] === priority[current.matchStatus])
        assert.ok((previous.score ?? 0) >= (current.score ?? 0));
    }
    for (const row of rows) {
      const assessment = saved.scores[row.id];
      assert.equal(row.score, assessment.score);
      assert.equal(row.relocation, assessment.relocation);
      assert.equal(row.reason, assessment.reason);
      const expectedStatus = assessment.score === null ? 'unavailable' : assessment.score === 0 ? 'zero_fit' :
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
    assert.deepEqual(parseCSV(exported.bytes.toString('utf8')).map(row => [row.id, row.matchStatus]),
      rows.map(row => [row.id, row.matchStatus]));
    const csvRows = parseCSV(exported.bytes.toString('utf8'));
    assert.ok(csvRows.some(row => row.score === '0'));
    assert.equal(csvRows.filter(row => row.score === '').length, result.unavailable);
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
      'node:a': { ...score('a', 0, 'required'), reason: ' \n=SUM(1,2)' },
      'node:b': { ...score('b', null), reason: 'Unavailable,\nnot assessed' },
    } };
  });
  await f.call('career_matches_export');
  const [a, b] = parseCSV(document.bytes.toString('utf8'));
  for (const field of ['title', 'company', 'city', 'location', 'workMode', 'reason', 'salaryPeriod']) assert.ok(a[field].startsWith("'"), field);
  assert.equal(a.title, '\'=HYPERLINK("https://bad.test","click")');
  assert.equal(a.score, '0'); assert.equal(b.score, '');
  assert.equal(a.matchStatus, 'zero_fit'); assert.equal(b.matchStatus, 'unavailable');
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

test('ties use known publication dates then IDs with unknown metadata deterministic and null scores last', async () => {
  const f = fixture();
  await f.store.update(state => {
    state.career.matching = {
      jobs: { 'node:dated': job('dated', '2020-01-01T00:00:00Z'),
        'node:unknown-b': { ...job('unknown-b'), publishedAt: null },
        'node:null-dated': job('null-dated', '2026-01-01T00:00:00Z') },
      scores: Object.fromEntries([
        score('unknown-b', 0), score('unknown-a', 0), score('dated', 0),
        score('null-unknown', null), score('null-dated', null),
      ].map(row => [row.id, row])),
    };
  });
  const expected = ['node:dated', 'node:unknown-a', 'node:unknown-b', 'node:null-dated', 'node:null-unknown'];
  assert.deepEqual((await f.call('career_matches')).matches.map(row => row.id), expected);
  assert.deepEqual((await f.call('career_matches')).matches.map(row => row.id), expected);
  assert.deepEqual(f.calls, []);
});

test('recommendations never pad with location-compatible skips, unresolved scope, unavailable or unreviewed rows', async () => {
  const ids = ['weak', 'scope', 'perfect', 'move', 'location', 'unavailable', 'zero', 'legacy', 'no-decision'];
  let document;
  const f = fixture({ jobs: ids.map(id => job(id)), exportDocument: async value => { document = value; return {}; } });
  const { profileVersion } = await f.call('career_match_jobs');
  assert.equal(profileVersion, '0:0');
  await f.call('career_match_save', { profileVersion, scores: [
    score('weak', 52, 'not_required', 'skip'), score('scope', 51, 'not_required', 'clarify'),
    score('perfect', 100, 'not_required'), score('move', 100, 'required'), score('location', 99, 'unclear'),
    score('unavailable', null, 'not_required'), score('zero', 0, 'not_required'),
  ] });
  await f.store.update(state => {
    state.career.matching.scores['node:legacy'] = score('legacy', 100, 'not_required');
    const { decision, ...old } = score('no-decision', 100, 'not_required');
    state.career.matching.scores['node:no-decision'] = { ...old, profileVersion };
  });
  f.setPlatformError(new Error('No paid or network reads allowed'));
  const before = f.store.get(), calls = f.calls.length;
  const recommendations = await f.call('career_recommendations');
  assert.equal(f.tools.get('career_recommendations').readOnly, true);
  assert.deepEqual(recommendations.recommendations.map(row => [row.id, row.score]), [['node:perfect', 100]]);
  assert.equal(recommendations.total, 1);
  assert.equal(recommendations.reviewed, 7);
  assert.equal(recommendations.needsReview, 2);
  const archive = await f.call('career_matches');
  assert.equal(archive.view, 'assessment_archive');
  assert.equal(archive.total, ids.length);
  assert.equal(archive.matches.find(row => row.id === 'node:weak').decision, 'skip');
  assert.equal(archive.matches.find(row => row.id === 'node:legacy').reviewStatus, 'needs_review');
  assert.equal(archive.matches.find(row => row.id === 'node:no-decision').decision, null);
  assert.ok(archive.matches.every(row => !Object.hasOwn(row, 'profileVersion')));
  await f.call('career_matches_export');
  const exported = parseCSV(document.bytes.toString('utf8'));
  assert.equal(exported.length, ids.length);
  assert.ok(exported.every(row => !Object.hasOwn(row, 'profileVersion')));
  assert.ok(exported.some(row => row.score === '100' && row.decision === 'recommend'));
  assert.ok(exported.some(row => row.score === '0' && row.decision === 'skip'));
  assert.deepEqual(f.store.get(), before);
  assert.equal(f.calls.length, calls);
  // Relocation status is a separate final filter, never a score penalty.
  await f.store.update(state => { state.career.profile.preferences.willingToRelocate = true; });
  assert.deepEqual((await f.call('career_recommendations')).recommendations.map(row => row.id), ['node:move', 'node:perfect']);
});

test('changed evidence suppresses old recommendations and requeues the current weekly catalogue', async () => {
  const f = fixture({ jobs: [job('old'), job('current')] });
  const { profileVersion } = await f.call('career_match_jobs');
  await f.call('career_match_save', { profileVersion, scores: [score('old', 100, 'not_required'), score('current', 80, 'not_required')] });
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
  assert.deepEqual(archive.matches.map(row => row.score), [100, 80]);
  assert.ok(archive.matches.every(row => row.reviewStatus === 'needs_review'));
  const before = f.store.get();
  await assert.rejects(f.call('career_match_save', { profileVersion, scores: [score('old', 0), score('current', 0)] }),
    { code: 'PROFILE_CHANGED' });
  assert.deepEqual(f.store.get(), before);
  const planned = await f.call('career_match_jobs');
  assert.equal(planned.profileVersion, '1:0');
  assert.deepEqual(planned.jobIds, ['node:current', 'node:new']);
  assert.equal(planned.pending, 1);
  assert.equal(planned.needsReview, 1);
  await f.call('career_match_save', { profileVersion: planned.profileVersion, scores: [score('current', 0)] });
  assert.deepEqual((await f.call('career_match_jobs')).jobIds, ['node:new']);
  assert.deepEqual((await f.call('career_match_jobs', { refresh: true })).jobIds, ['node:current', 'node:new']);
});

test('profile version is checked inside the queued transaction and bounded local reassessment needs no discovery', async () => {
  const f = fixture({ jobs: [job('a')] });
  const { profileVersion } = await f.call('career_match_jobs');
  await f.call('career_match_save', { profileVersion, scores: [score('a', 100, 'not_required')] });
  const change = f.store.update(state => { state.career.evidenceRevision++; });
  const rejected = f.call('career_match_save', { profileVersion, scores: [score('a', 0)] });
  await change;
  await assert.rejects(rejected, { code: 'PROFILE_CHANGED' });
  assert.equal(f.store.get().career.matching.scores['node:a'].score, 100);
  f.setPlatformError(new Error('Offline'));
  const calls = f.calls.length;
  const currentVersion = matchingProfileVersion(f.store.get().career);
  await f.call('career_match_save', { profileVersion: currentVersion, scores: [score('a', 0)] });
  assert.equal((await f.call('career_matches')).matches[0].score, 0);
  assert.equal((await f.call('career_recommendations')).total, 0);
  assert.equal(f.calls.length, calls);
});

test('recommendation paging counts only current suitable rows without hiding full archive coverage', async () => {
  const ids = Array.from({ length: 107 }, (_, index) => String(index).padStart(3, '0'));
  const f = fixture({ jobs: ids.map(id => job(id)) });
  const { profileVersion } = await f.call('career_match_jobs');
  for (let offset = 0; offset < ids.length; offset += 10)
    await f.call('career_match_save', { profileVersion,
      scores: ids.slice(offset, offset + 10).map(id => score(id, id === '106' ? 99 : 80,
        'not_required', id === '106' ? 'skip' : 'recommend')) });
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

test('decision and version validation rejects incoherent or missing inputs without clamping any integer fit score', async () => {
  const f = fixture({ jobs: Array.from({ length: 101 }, (_, value) => job(String(value))) });
  const { profileVersion } = await f.call('career_match_jobs');
  const { decision, ...legacy } = score('0', 0);
  const invalid = [
    { scores: [score('0', 0)] },
    ...[-1, 0.5, '0', null, Number.MAX_SAFE_INTEGER + 1].map(value => ({ profileVersion: value, scores: [score('0', 0)] })),
    ...[score('0', null, 'unclear', 'recommend'), score('0', null, 'unclear', 'skip'),
      score('0', 0, 'unclear', 'recommend'), score('0', 0, 'unclear', 'clarify'),
      score('0', 80, 'unclear', 'maybe'), legacy].map(row => ({ profileVersion, scores: [row] })),
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
    await f.call('career_match_save', { profileVersion,
      scores: Array.from({ length: Math.min(10, 101 - offset) }, (_, index) =>
        score(String(offset + index), offset + index, 'not_required')) });
  const saved = f.store.get().career.matching.scores;
  assert.deepEqual(Object.values(saved).map(row => row.score).sort((a, b) => a - b), Array.from({ length: 101 }, (_, value) => value));
  const recommendations = await f.call('career_recommendations', { limit: 100 });
  assert.equal(recommendations.total, 100);
  assert.deepEqual(recommendations.recommendations.map(row => row.score), Array.from({ length: 100 }, (_, index) => 100 - index));
});

test('recommendation order is score then known publication date then ID and unstated consent never authorizes a move', async () => {
  const f = fixture();
  await f.store.update(state => {
    delete state.career.profile.preferences.willingToRelocate;
    state.career.matching = {
      jobs: { 'node:older': job('older', new Date(Date.now() - 4 * 86400000).toISOString()), 'node:new-b': job('new-b'),
        'node:new-a': job('new-a'), 'node:highest': job('highest', new Date(Date.now() - 6 * 86400000).toISOString()) },
      scores: Object.fromEntries([
        score('unknown', 80, 'not_required'), score('older', 80, 'not_required'),
        score('new-b', 80, 'not_required'), score('new-a', 80, 'not_required'),
        score('highest', 100, 'not_required'), score('move', 100, 'required'),
      ].map(row => [row.id, { ...row, profileVersion: '0:0', assessmentVersion: ASSESSMENT_VERSION }])),
    };
  });
  const expected = ['node:highest', 'node:new-a', 'node:new-b', 'node:older'];
  assert.deepEqual((await f.call('career_recommendations')).recommendations.map(row => row.id), expected);
  await f.store.update(state => { state.career.profile.preferences.willingToRelocate = null; });
  assert.deepEqual((await f.call('career_recommendations')).recommendations.map(row => row.id), expected);
  assert.deepEqual(f.calls, []);
});

test('stated compensation below the saved floor cannot be recommended or saved as a clarification', async () => {
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
  for (const decision of ['recommend', 'clarify']) {
    await assert.rejects(f.call('career_match_save', { profileVersion: '0:0',
      scores: [score('range', 90, 'not_required'), score('low', 90, 'not_required', decision)] }),
    { code: 'SALARY_BELOW_MINIMUM' });
    assert.deepEqual(f.store.get(), before);
  }
  await f.call('career_match_save', { profileVersion: '0:0',
    scores: [score('low', 0, 'not_required'), score('range', 90, 'not_required'), score('unstated', 80, 'not_required')] });
  const ready = await f.call('career_recommendations');
  assert.deepEqual(ready.recommendations.map(row => row.id), ['node:range', 'node:unstated']);
  assert.equal(ready.recommendations[0].salaryEligibility.status, 'range_can_meet_minimum');
  assert.equal(ready.recommendations[1].salaryEligibility.status, 'not_stated');
});

test('a changed stated salary is filtered before paging without rewriting the saved model score', async () => {
  const f = fixture({ jobs: [
    { ...job('a'), salary: { minimum: 110000, maximum: 120000, currency: 'EUR', period: 'year' } },
    { ...job('b'), salary: { minimum: 100000, maximum: 100000, currency: 'EUR', period: 'year' } },
  ] });
  await f.store.update(state => Object.assign(state.career.profile.preferences,
    { salaryMinimum: 100000, salaryCurrency: 'EUR', salaryPeriod: 'year' }));
  await f.call('career_match_jobs');
  await f.call('career_match_save', { profileVersion: '0:0', scores: [score('a', 99, 'not_required'), score('b', 80, 'not_required')] });
  await f.store.update(state => { state.career.matching.jobs['node:a'].salary.maximum = 90000; state.career.matching.jobs['node:a'].salary.minimum = 85000; });
  const before = f.store.get();
  const page = await f.call('career_recommendations', { limit: 1 });
  assert.equal(page.total, 1);
  assert.equal(page.nextOffset, null);
  assert.equal(page.recommendations[0].id, 'node:b');
  assert.equal((await f.call('career_matches')).matches.find(row => row.id === 'node:a').salaryEligibility.status, 'below_minimum');
  assert.equal(f.store.get().career.matching.scores['node:a'].score, 99);
  assert.deepEqual(f.store.get(), before);
});

test('old-rule judgments require reranking even when candidate facts did not change', async () => {
  const f = fixture({ jobs: [job('a')] });
  await f.call('career_match_jobs');
  await f.store.update(state => { state.career.matching.scores['node:a'] = { ...score('a', 95, 'not_required'), profileVersion: '0:0', assessmentVersion: ASSESSMENT_VERSION - 1 }; });
  const before = f.store.get();
  const old = await f.call('career_recommendations');
  assert.equal(old.total, 0);
  assert.equal(old.needsReview, 1);
  assert.equal((await f.call('career_matches')).matches[0].reviewStatus, 'needs_review');
  assert.deepEqual(f.store.get(), before);
  const current = await f.call('career_match_jobs');
  assert.deepEqual(current.jobIds, ['node:a']);
  await f.call('career_match_save', { profileVersion: current.profileVersion, scores: [score('a', 95, 'not_required')] });
  assert.equal(f.store.get().career.matching.scores['node:a'].assessmentVersion, ASSESSMENT_VERSION);
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

test('reassessment selects only the past week and discards earlier job cache and rankings', async () => {
  const now = Date.now(), f = fixture({ jobs: [
    job('recent', new Date(now - 86400000).toISOString()),
    job('six-days', new Date(now - 6 * 86400000).toISOString()),
    job('too-old', new Date(now - 8 * 86400000).toISOString()),
    job('future', new Date(now + 86400000).toISOString()),
  ] });
  const first = await f.call('career_match_jobs');
  assert.deepEqual(first.jobIds, ['node:recent', 'node:six-days']);
  await f.call('career_match_save', { profileVersion: first.profileVersion, scores: [score('recent', 90)] });
  const reset = await f.call('career_match_jobs', { refresh: true });
  assert.deepEqual(reset.jobIds, first.jobIds);
  assert.equal(reset.publicationWindow.days, 7);
  assert.equal(reset.scored, 0);
  assert.equal(reset.pending, 2);
  assert.notEqual(reset.profileVersion, first.profileVersion);
  assert.deepEqual(Object.keys(f.store.get().career.matching.jobs), first.jobIds);
  await assert.rejects(f.call('career_match_save', { profileVersion: first.profileVersion, scores: [score('recent')] }), { code: 'PROFILE_CHANGED' });
});

test('delete rankings preserves all career and account data and invalidates old writer output', async () => {
  const f = fixture();
  await f.store.update(state => {
    state.pairing = { account: 'synthetic-account' };
    state.deviceId = 'synthetic-device';
    state.career.applications.existing = { cv: 'saved draft' };
  });
  const context = await f.call('career_match_jobs');
  await f.call('career_match_save', { profileVersion: context.profileVersion, scores: [score('a')] });
  const protectedData = state => {
    const { matching, rankingVersion, ...career } = state.career;
    return { ...state, career };
  };
  const before = protectedData(f.store.get()), calls = f.calls.length;
  const deleted = await f.call('career_rankings_delete');
  assert.deepEqual(deleted, { deletedRankings: 1, deletedJobs: 3 });
  assert.deepEqual(protectedData(f.store.get()), before);
  assert.deepEqual(f.store.get().career.matching, { jobs: {}, scores: {} });
  assert.equal(f.calls.length, calls);
  const fresh = await f.call('career_match_jobs');
  await assert.rejects(f.call('career_match_save', { profileVersion: context.profileVersion, scores: [score('a')] }), { code: 'PROFILE_CHANGED' });
  await f.call('career_match_save', { profileVersion: fresh.profileVersion, scores: [score('a')] });
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
  assert.deepEqual(f.store.get().career.matching, { jobs: {}, scores: {} });
});
