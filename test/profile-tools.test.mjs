import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { createProfileTools } from '../src/mcp/profile-tools.mjs';
import { createCareerState } from '../src/mcp/state.mjs';
import { needsDetail } from '../src/mcp/facts.mjs';
import { createScopedAccess } from '../src/mcp/scope.mjs';

const applicationId = randomUUID();
const applicationJob = { title: 'Wallet Engineer', company: 'Acme', description: 'Ship a wallet integration.', url: 'https://example.com/jobs/wallet' };

function fixture(dependencies = {}, initial = {}) {
  let state = { career: createCareerState(), pairing: null, ...structuredClone(initial) };
  state.career.applications[applicationId] ??= { id: applicationId, job: { ...applicationJob }, exports: [], cv: null, coverLetter: null };
  let queue = Promise.resolve();
  const store = {
    get: () => structuredClone(state),
    update(change) {
      const pending = queue.then(async () => {
        const copy = structuredClone(state);
        const result = await change(copy);
        state = copy;
        return result;
      });
      queue = pending.catch(() => {});
      return pending;
    },
  };
  const ajv = new Ajv({ strict: false, allErrors: true });
  ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  const tools = new Map(createProfileTools({ store, ...dependencies }).map(tool => [tool.name, { ...tool, validate: ajv.compile(tool.inputSchema) }]));
  const call = async (name, args = {}) => {
    if (name === 'career_interview_ask') args = { applicationId, ...args };
    const tool = tools.get(name);
    if (!tool.validate(args)) throw Object.assign(new Error(ajv.errorsText(tool.validate.errors)), { code: 'INVALID_INPUT' });
    return tool.invoke(args);
  };
  const mutation = () => ({ requestId: randomUUID(), revision: store.get().career.revision });
  const edit = (name, args) => call(name, { ...mutation(), ...args });
  return { store, tools, call, edit, mutation };
}
const fact = (kind, subject, answer, extra = {}) => ({ kind, subject, answer, ...extra });
const teamSize = (extra = {}) => fact('note', 'Team size', 'Managed up to 15 engineers', { employer: 'Nethermind', ...extra });
const importText = (f, text = 'Senior Engineer at Acme since 2019. Built the reporting platform.') =>
  f.edit('career_source_import', { method: 'text', purpose: 'cv', name: 'Original CV', text });

test('saved answers are searchable, paginated and upserted by subject and employer rather than duplicated', async () => {
  const f = fixture();
  const created = await f.edit('career_facts_save', { facts: [
    fact('capability', 'Go', 'Led it', { detail: 'Managed the team; not personal implementation.', employer: 'Acme' }),
    teamSize(), fact('language', 'Italian', 'native'), fact('yes_no', 'Travel', 'No'),
  ] });
  const page = await f.call('career_facts_list', { limit: 2 });
  assert.deepEqual(page.items.map(item => item.subject), ['Go', 'Italian']);
  assert.equal(page.items[1].answer, 'Native');
  assert.equal(page.nextOffset, 2);
  const old = created.facts[0];
  const { facts: [updated] } = await f.edit('career_facts_save', { facts: [
    fact('capability', ' go ', 'Hands-on', { detail: 'Built production services.', employer: ' acme ' }),
  ] });
  assert.equal(updated.id, old.id);
  assert.equal(updated.createdAt, old.createdAt);
  assert.equal(updated.answer, 'Hands-on');
  assert.equal((await f.call('career_facts_list')).total, 4);
  assert.equal((await f.call('career_facts_list', { kinds: ['language'] })).items[0].subject, 'Italian');
  assert.equal((await f.call('career_facts_list', { query: 'production' })).items[0].id, old.id);
  const deleted = await f.edit('career_facts_delete', { factIds: [old.id] });
  assert.equal(deleted.deleted, 1);
  assert.deepEqual((await f.call('career_facts_list')).items.map(item => item.subject), ['Italian', 'Team size', 'Travel']);
});

test('duplicate subjects and conflicting renames reject the whole batch', async () => {
  const f = fixture();
  const { facts: [first, second] } = await f.edit('career_facts_save', { facts: [teamSize(), fact('note', 'Scope', 'Product delivery')] });
  const before = f.store.get();
  await assert.rejects(f.edit('career_facts_save', { facts: [
    fact('note', 'Scope', 'Replaced', { id: first.id }),
  ] }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.edit('career_facts_save', { facts: [
    fact('note', 'Scope', 'First'), fact('note', ' scope ', 'Second'),
  ] }), { code: 'INVALID_INPUT' });
  assert.deepEqual(f.store.get(), before);
  await f.edit('career_facts_save', { facts: [fact('note', 'New subject', 'New answer', { id: second.id })] });
  assert.equal((await f.call('career_facts_list', { query: 'New subject' })).items[0].id, second.id);
});

test('facts are keyed by subject and employer', async () => {
  const f = fixture();
  const { facts: [acme, globex, general] } = await f.edit('career_facts_save', { facts: [
    fact('capability', 'Kubernetes', 'Some exposure', { employer: 'Acme' }),
    fact('capability', 'Kubernetes', 'Hands-on', { detail: 'Ran the production clusters.', employer: 'Globex' }),
    fact('capability', 'Kubernetes', 'None'),
  ] });
  assert.equal(new Set([acme.id, globex.id, general.id]).size, 3);
  assert.deepEqual((await f.call('career_facts_list')).items.map(item => item.employer ?? null), [null, 'Acme', 'Globex']);
  const { facts: [replaced] } = await f.edit('career_facts_save', { facts: [fact('capability', 'kubernetes', 'Led it', { detail: 'Led the cluster migration.', employer: 'ACME' })] });
  assert.equal(replaced.id, acme.id);
  assert.equal(replaced.answer, 'Led it');
  const { facts: [unscoped] } = await f.edit('career_facts_save', { facts: [fact('capability', 'Kubernetes', 'Some exposure')] });
  assert.equal(unscoped.id, general.id);
  assert.equal((await f.call('career_facts_list')).total, 3);
  await assert.rejects(f.edit('career_facts_save', { facts: [fact('capability', 'Kubernetes', 'None', { employer: 'Globex' }), fact('capability', 'kubernetes', 'None', { employer: ' globex ' })] }),
    { code: 'INVALID_INPUT', message: 'Each subject and employer combination may appear only once per save; combine the answers into one fact.' });
  await assert.rejects(f.edit('career_facts_save', { facts: [fact('capability', 'Kubernetes', 'None', { id: general.id, employer: 'Globex' })] }),
    { code: 'INVALID_INPUT', message: 'A fact about "Kubernetes" at Globex already exists. Update that fact or delete it first.' });
});

test('saving or deleting an unknown fact id fails without changes', async () => {
  const f = fixture();
  const before = f.store.get();
  await assert.rejects(f.edit('career_facts_save', { facts: [teamSize({ id: randomUUID() })] }), { code: 'NOT_FOUND' });
  await assert.rejects(f.edit('career_facts_delete', { factIds: [randomUUID()] }), { code: 'NOT_FOUND' });
  assert.deepEqual(f.store.get(), before);
});

test('answers enforce proficiency and depth while rejecting uncertain or narrated facts atomically', async () => {
  const f = fixture();
  for (const answer of ['Speaks English', 'Good', 'Used daily at work'])
    await assert.rejects(f.edit('career_facts_save', { facts: [fact('language', 'English', answer)] }), { code: 'INVALID_INPUT' });
  for (const answer of ['CV reports 100k users', 'Proficiency not specified', 'According to LinkedIn, led a team', 'Did they manage it?'])
    await assert.rejects(f.edit('career_facts_save', { facts: [teamSize(), fact('note', 'Detail', answer)] }), { code: 'UNCLEAR_FACT' });
  await assert.rejects(f.edit('career_facts_save', { facts: [fact('capability', 'Go', 'Expert')] }), { code: 'INVALID_INPUT' });
  assert.deepEqual(f.store.get().career.facts, {});
  const result = await f.edit('career_facts_save', { facts: [
    fact('capability', 'Kubernetes', 'None'),
    fact('capability', 'Managing managers', 'Some exposure'),
    fact('language', 'English', 'Fluent'),
  ] });
  assert.deepEqual(result.facts.map(item => item.answer), ['None', 'Some exposure', 'Fluent']);
});


test('profile and preference updates set and clear values; preferences survive deleting all facts', async () => {
  const f = fixture();
  const { facts } = await f.edit('career_facts_save', { facts: [teamSize(), fact('language', 'Italian', 'Native')] });
  const profile = await f.edit('career_profile_update', { patch: { name: 'Alex', headline: 'Platform engineer', links: ['https://example.test'], roleCapabilities: ['Backend engineering'] } });
  assert.deepEqual(profile.saved, ['name', 'headline', 'links', 'roleCapabilities']);
  await f.edit('career_profile_update', { patch: { headline: null, links: [] } });
  await f.edit('career_preferences_update', { patch: { salaryMinimum: 0, requiresSponsorship: false, roles: [], locations: null } });
  await f.edit('career_preferences_update', { patch: { notes: 'Remote only' } });
  await f.edit('career_facts_delete', { factIds: facts.map(item => item.id) });

  const read = await f.call('career_profile_read');
  assert.equal(read.profile.name, 'Alex');
  assert.equal(read.profile.headline, null);
  assert.deepEqual(read.profile.links, []);
  assert.deepEqual(read.profile.roleCapabilities, ['Backend engineering']);
  assert.equal('preferences' in read.profile, false);
  assert.deepEqual(read.preferences, { salaryMinimum: 0, requiresSponsorship: false, roles: [], locations: null, notes: 'Remote only' });
  assert.equal(read.factCount, 0);
  assert.equal(read.sourceCount, 0);
  assert.equal(typeof read.matchingProfileVersion, 'string');
  for (const removed of ['fieldSources', 'staleFields', 'history']) assert.equal(removed in read, false);
  const career = f.store.get().career;
  assert.equal('fieldSources' in career.profile, false);
  assert.equal('profileHistory' in career, false);
});

test('strict schemas reject unknown fields, paths, attribution and oversized batches before side effects', async () => {
  const f = fixture({ selectSourceFile: async () => assert.fail('Invalid input must not open picker') });
  const invalid = [
    ['career_source_import', { method: 'file', path: '/private/cv.pdf' }],
    ['career_source_import', { method: 'file', text: 'bypass picker' }],
    ['career_source_import', { method: 'text', name: 'Too large', text: 'x'.repeat(100_001) }],
    ['career_profile_update', { patch: { apiKey: 'not-accepted' } }],
    ['career_profile_update', { mode: 'explicit', patch: { name: 'Alex' } }],
    ['career_preferences_update', { patch: { roles: ['Engineer'] }, source: { kind: 'conversation', quote: 'Engineer' } }],
    ['career_facts_save', { facts: Array.from({ length: 51 }, (_, index) => fact('note', `Point ${index}`, 'Value')) }],
    ['career_facts_save', { facts: [teamSize({ answer: '   ' })] }],
    ['career_facts_delete', { factIds: [] }],
  ];
  for (const [name, args] of invalid) await assert.rejects(f.edit(name, args), { code: 'INVALID_INPUT' });
  assert.equal(f.store.get().career.revision, 0);
});

test('no-CV onboarding reaches local readiness without pairing or provider credentials', async () => {
  const f = fixture({ platform: () => assert.fail('Local interview must not contact the account') });
  let status = await f.call('onboarding_status');
  assert.equal(status.locallyReady, false);
  assert.equal(status.questions[0].field, 'startingPoint');
  await f.edit('onboarding_start', { mode: 'interview' });
  status = await f.call('onboarding_status');
  assert.equal(status.questions.find(item => item.field === 'background').tool, 'career_profile_update');
  await f.edit('career_profile_update', { patch: { headline: 'Engineering manager', roleCapabilities: ['Managed engineering delivery'] } });
  await f.edit('career_preferences_update', { patch: { roles: ['Engineer'] } });
  status = await f.call('onboarding_status');
  assert.equal(status.locallyReady, true);
  assert.equal(status.providerRequired, false);
  assert.deepEqual(status.pairing, { paired: false, account: null });
  assert.equal(status.catalogRequiresPairing, true);
  assert.equal(status.sourceCount, 0);
  assert.equal(status.factCount, 0);
  assert.deepEqual(status.missing, []);
});

test('CV onboarding asks to import, then read, and is ready once the profile is saved', async () => {
  const f = fixture({}, { pairing: { account: { id: 'account-a', label: 'Candidate' }, secret: 'do-not-return' } });
  await f.edit('onboarding_start', { mode: 'cv' });
  let status = await f.call('onboarding_status');
  assert.equal(status.actions[0].tool, 'career_source_import');
  assert.deepEqual(status.questions, []);
  const { source } = await importText(f);
  status = await f.call('onboarding_status');
  assert.equal(status.locallyReady, false);
  assert.equal(status.actions[0].tool, 'career_source_read');
  assert.equal(status.actions[0].args.sourceId, source.id);
  assert.deepEqual(status.pairing, { paired: true, account: { id: 'account-a', label: 'Candidate' } });
  assert.equal(JSON.stringify(status).includes('do-not-return'), false);
  assert.equal(status.missing.some(item => item.field === 'background'), false, 'the CV is the career record');
  assert.ok(status.actions.some(item => item.field === 'profile' && item.tool === 'onboarding_commit'));

  const committed = await f.edit('onboarding_commit', {
    mode: 'cv',
    facts: [teamSize(), fact('language', 'Italian', 'Native')],
    profile: { headline: 'Senior platform engineer', roleCapabilities: ['Backend engineering'], seniority: 'Senior', skills: ['Node.js'] },
  });
  assert.equal(committed.facts.length, 2);
  assert.deepEqual(committed.saved, ['headline', 'roleCapabilities', 'seniority', 'skills']);
  assert.deepEqual(committed.preferences, {}, 'CV facts never invent future preferences');
  status = await f.call('onboarding_status');
  assert.equal(status.locallyReady, true);
  assert.deepEqual(status.missing, []);
  const reopened = fixture({}, f.store.get());
  assert.deepEqual(await reopened.call('career_profile_read'), await f.call('career_profile_read'));
});

test('onboarding commit saves a pasted source and preferences atomically, rolls back on invalid facts, and replays', async () => {
  const f = fixture();
  const input = {
    mode: 'cv', source: { name: 'CV', purpose: 'cv', text: 'Senior Engineer, Acme, 2019–present.' },
    facts: [teamSize()], profile: { headline: 'Engineer' }, preferences: { travel: 'any', salaryMinimum: 0, companySizes: [] },
  };
  const before = f.store.get();
  await assert.rejects(f.edit('onboarding_commit', { ...input, facts: [teamSize({ answer: 'CV states the candidate managed a team.' })] }), { code: 'UNCLEAR_FACT' });
  await assert.rejects(f.edit('onboarding_commit', { ...input, profile: { travel: 'any' } }), { code: 'INVALID_INPUT' });
  assert.deepEqual(f.store.get(), before);

  const args = { ...f.mutation(), ...input };
  const saved = structuredClone(await f.call('onboarding_commit', args));
  assert.equal(saved.source.name, 'CV');
  assert.equal(saved.source.text, undefined);
  assert.deepEqual(saved.saved, ['headline', 'preferences.travel', 'preferences.salaryMinimum', 'preferences.companySizes']);
  await f.edit('career_profile_update', { patch: { headline: null } });
  assert.deepEqual(await f.call('onboarding_commit', args), saved);
  await assert.rejects(f.call('onboarding_commit', { ...args, mode: 'interview' }), { code: 'REQUEST_CONFLICT' });
  assert.equal(Object.keys(f.store.get().career.sources).length, 1);
  assert.equal(Object.keys(f.store.get().career.facts).length, 1);
  assert.deepEqual(f.store.get().career.profile.preferences, { travel: 'any', salaryMinimum: 0, companySizes: [] });
});

test('source reads page exact text without returning original bytes', async () => {
  const f = fixture();
  const first = await importText(f, 'First source text.');
  await importText(f, 'Second source text.');
  const slice = await f.call('career_source_read', { sourceId: first.source.id, offset: 6, length: 6 });
  assert.equal(slice.text, 'source');
  assert.equal(slice.nextOffset, 12);
  assert.equal(slice.source.originalBase64, undefined);
  const sources = await f.call('career_sources_list', { limit: 1 });
  assert.equal(sources.total, 2);
  assert.equal(sources.nextOffset, 1);
  assert.equal(sources.items[0].text, undefined);
  await assert.rejects(f.call('career_source_read', { sourceId: first.source.id, offset: 100 }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.call('career_source_read', { sourceId: randomUUID() }), { code: 'NOT_FOUND' });
});

test('native picker and extraction are not repeated on replay; changed request reuse is rejected', async () => {
  let picks = 0, extracts = 0;
  const bytes = Buffer.from('bytes');
  const f = fixture({ selectSourceFile: async () => { picks++; return { buffer: bytes, originalname: 'cv.pdf', mimetype: 'application/pdf' }; }, extractFile: async () => { extracts++; return { text: 'Candidate CV', pageCount: 1, images: ['not-retained'] }; } });
  const args = { ...f.mutation(), method: 'file', purpose: 'cv' };
  const first = await f.call('career_source_import', args);
  assert.equal(first.source.originalRetained, true);
  await f.edit('career_preferences_update', { patch: { roles: [] } });
  assert.deepEqual(await f.call('career_source_import', args), first);
  assert.equal(picks, 1);
  assert.equal(extracts, 1);
  await assert.rejects(f.call('career_source_import', { ...args, purpose: 'supporting' }));
  assert.equal(picks, 1);
  const [stored] = Object.values(f.store.get().career.sources);
  assert.equal(stored.originalBase64, bytes.toString('base64'));
  assert.equal(JSON.stringify(stored).includes('not-retained'), false);
});

test('picker cancellation is truthful and replayable without a second native prompt', async () => {
  let picks = 0;
  const f = fixture({ selectSourceFile: async () => { picks++; return null; }, extractFile: async () => assert.fail('Cancelled selection must not extract') });
  const args = { ...f.mutation(), method: 'file' };
  const cancelled = await f.call('career_source_import', args);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.source, null);
  assert.deepEqual(await f.call('career_source_import', args), cancelled);
  assert.equal(picks, 1);
  assert.equal(Object.keys(f.store.get().career.sources).length, 0);
});

test('a revision change during native extraction prevents a stale source commit', async () => {
  let signalStarted, finish;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const extraction = new Promise(resolve => { finish = resolve; });
  const f = fixture({ selectSourceFile: async () => ({ buffer: Buffer.from('bytes'), originalname: 'cv.txt', mimetype: 'text/plain' }), extractFile: async () => { signalStarted(); return extraction; } });
  const pending = f.edit('career_source_import', { method: 'file' });
  await started;
  await f.edit('career_preferences_update', { patch: { locations: ['London'] } });
  finish({ text: 'Late extracted source' });
  await assert.rejects(pending, { code: 'REVISION_CONFLICT' });
  assert.equal(Object.keys(f.store.get().career.sources).length, 0);
  assert.deepEqual(f.store.get().career.profile.preferences.locations, ['London']);
});

test('concurrent retries share the native import and reject changed request content before a second prompt', async () => {
  let finish, picks = 0;
  const selection = new Promise(resolve => { finish = resolve; });
  const f = fixture({ selectSourceFile: async () => { picks++; return selection; }, extractFile: async () => ({ text: 'Unchanged CV text' }) });
  const args = { ...f.mutation(), method: 'file', purpose: 'cv' };
  const first = f.call('career_source_import', args);
  const retry = f.call('career_source_import', args);
  await assert.rejects(f.call('career_source_import', { ...args, purpose: 'supporting' }), { code: 'REQUEST_CONFLICT' });
  finish({ buffer: Buffer.from('original'), originalname: 'cv.txt', mimetype: 'text/plain' });
  const [saved, replay] = await Promise.all([first, retry]);
  assert.deepEqual(replay, saved);
  assert.equal(picks, 1);
  assert.equal(Object.keys(f.store.get().career.sources).length, 1);
});

test('fact writes enforce optimistic revision and request replay without recreating deleted data', async () => {
  const f = fixture();
  const args = { ...f.mutation(), facts: [teamSize()] };
  const saved = await f.call('career_facts_save', args);
  await assert.rejects(f.call('career_facts_save', { ...args, requestId: randomUUID() }), { code: 'REVISION_CONFLICT' });
  await f.edit('career_facts_delete', { factIds: [saved.facts[0].id] });
  assert.deepEqual(await f.call('career_facts_save', args), saved);
  assert.deepEqual(f.store.get().career.facts, {});
  await assert.rejects(f.call('career_facts_save', { ...args, facts: [teamSize({ answer: 'Different' })] }), { code: 'REQUEST_CONFLICT' });
});

test('chat interviews preserve partial question numbers and do not re-ask known negative answers', async () => {
  const f = fixture();
  const pending = await f.call('career_interview_ask', { questions: [
    { subject: 'Kubernetes', prompt: 'Your Kubernetes experience?', kind: 'capability' },
    { subject: 'Italian', prompt: 'Your Italian level?', kind: 'language' },
  ] });
  assert.equal((await f.call('career_facts_list')).total, 0);
  const first = await f.call('career_interview_answer', { interviewId: pending.interviewId, reply: '1d' });
  assert.equal(first.saved[0].answer, 'None');
  assert.deepEqual(first.unanswered, [2]);
  const reopened = fixture({}, f.store.get());
  const second = await reopened.call('career_interview_answer', { interviewId: pending.interviewId, reply: '2a' });
  assert.equal(second.saved[0].subject, 'Italian');
  assert.equal(second.saved[0].answer, 'Native');
  assert.deepEqual(second.unanswered, []);
  const repeat = await reopened.call('career_interview_ask', { questions: [{ subject: ' kubernetes ', prompt: 'Experience?', kind: 'capability' }] });
  assert.equal(repeat.mode, 'none');
  assert.equal(repeat.alreadyKnown[0].answer, 'None');
  assert.deepEqual(reopened.store.get().career.interviews, {});
});

test('short chat answers save optional examples and invalid replies save nothing', async () => {
  const f = fixture();
  const pending = await f.call('career_interview_ask', { questions: [
    { subject: 'Experimentation', prompt: 'Experimentation experience?', kind: 'capability', allowDetail: true },
    { subject: 'Travel', prompt: 'Can you travel?', kind: 'yes_no' },
  ] });
  const before = f.store.get();
  await assert.rejects(f.call('career_interview_answer', { interviewId: pending.interviewId, reply: '1z 2b' }), { code: 'INVALID_INPUT' });
  assert.deepEqual(f.store.get(), before);
  const result = await f.call('career_interview_answer', { interviewId: pending.interviewId, reply: '1 b: Tested checkout flows; 2 b' });
  assert.equal(result.saved[0].answer, 'Hands-on');
  assert.equal(result.saved[0].detail, 'Tested checkout flows');
  assert.equal(result.saved[1].answer, 'No');
});

test('form interviews save explicit selections and retain pending questions on decline or transport failure', async () => {
  let response = { action: 'accept', content: { q1: 'Led it', q1_detail: 'Managed a delivery team.' } }, asked;
  const f = fixture({ interaction: { canElicit: () => true, elicit: async request => { asked = request; if (response instanceof Error) throw response; return response; } } });
  const input = { questions: [{ subject: 'Management', prompt: 'Management experience?', kind: 'capability', allowDetail: true }] };
  const result = await f.call('career_interview_ask', input);
  assert.equal(result.saved[0].answer, 'Led it');
  assert.equal(result.saved[0].detail, 'Managed a delivery team.');
  assert.equal(Object.hasOwn(asked.requestedSchema.properties.q1, 'default'), false);
  const before = f.store.get();
  response = { action: 'decline' };
  assert.equal((await f.call('career_interview_ask', { questions: [{ ...input.questions[0], subject: 'Another subject' }] })).declined, true);
  assert.deepEqual(f.store.get().career.facts, before.career.facts);
  assert.equal(Object.values(f.store.get().career.interviews).length, 1);
  response = new Error('Connection lost');
  await assert.rejects(f.call('career_interview_ask', { questions: [{ ...input.questions[0], subject: 'Third subject' }] }), /Connection lost/);
  assert.deepEqual(f.store.get().career.facts, before.career.facts);
  assert.equal(Object.values(f.store.get().career.interviews).length, 2);
});

const capabilityQuestion = { subject: 'Wallet integration', prompt: 'What is your wallet integration experience?', kind: 'capability',
  context: 'The role needs someone to ship a wallet connection.' };

test('shallow positive answers retain context, deepen after reload, and reuse the completed answer', async () => {
  const f = fixture();
  const asked = await f.call('career_interview_ask', { questions: [capabilityQuestion] });
  const partial = await f.call('career_interview_answer', { interviewId: asked.interviewId, reply: '1b' });
  assert.equal(partial.saved[0].question, capabilityQuestion.prompt);
  assert.equal(partial.saved[0].context, capabilityQuestion.context);
  assert.equal(needsDetail(partial.saved[0]), true);
  assert.deepEqual(partial.unanswered, [1]);
  assert.equal(partial.followUps[0].stage, 'detail');
  assert.ok(f.store.get().career.interviews[asked.interviewId]);
  const reopened = fixture({}, f.store.get());
  const answer = 'I built the wallet connection for Checkout and shipped it to production.';
  const complete = await reopened.call('career_interview_answer', { interviewId: asked.interviewId, reply: answer });
  const saved = complete.saved[0];
  assert.equal(saved.detail, answer);
  assert.deepEqual(saved.followUps, [{ question: partial.followUps[0].prompt, answer, context: capabilityQuestion.context, applicationId }]);
  assert.equal(saved.applicationId, applicationId);
  assert.equal(saved.question, capabilityQuestion.prompt);
  assert.equal(needsDetail(saved), false);
  assert.deepEqual(complete.unanswered, []);
  assert.equal((await reopened.call('career_interview_ask', { questions: [capabilityQuestion] })).mode, 'none');
  const { facts: [direct] } = await reopened.edit('career_facts_save', { facts: [{ id: saved.id, kind: saved.kind,
    subject: saved.subject, answer: saved.answer, detail: saved.detail }] });
  assert.equal(direct.question, saved.question);
  assert.equal(direct.context, saved.context);
  assert.equal(direct.applicationId, applicationId);
  assert.deepEqual(direct.followUps, saved.followUps);
  assert.equal((await reopened.call('career_facts_list', { query: 'role needs' })).items[0].id, saved.id);
});

test('explicit related fact reuse and deepening never rewrite historical questions or subjects', async () => {
  const f = fixture();
  const { facts: [old] } = await f.edit('career_facts_save', { facts: [fact('capability', 'Payments', 'Led it',
    { detail: 'Managed the checkout team.', question: 'What was your payments role?', context: 'Payments delivery' })] });
  const question = { ...capabilityQuestion, factId: old.id };
  const known = await f.call('career_interview_ask', { questions: [question] });
  assert.equal(known.mode, 'none');
  assert.equal(known.alreadyKnown[0].id, old.id);
  const followUp = 'Which wallet shipped, and what did you personally change?';
  const asked = await f.call('career_interview_ask', { questions: [{ ...question, followUp }] });
  assert.equal(asked.followUps[0].prompt, followUp);
  const { saved: [updated] } = await f.call('career_interview_answer', { interviewId: asked.interviewId,
    reply: 'I implemented WalletConnect in Checkout and released the integration.' });
  assert.equal(updated.id, old.id);
  assert.equal(updated.subject, old.subject);
  assert.equal(updated.question, old.question);
  assert.equal(updated.context, old.context);
  assert.equal(updated.followUps[0].question, followUp);
  assert.equal(updated.followUps[0].context, capabilityQuestion.context);
  assert.equal(updated.followUps[0].applicationId, applicationId);
  assert.equal((await f.call('career_facts_list')).total, 1);
  const historical = await f.edit('career_facts_save', { facts: [fact('capability', 'Legacy', 'Hands-on')] });
  const detail = await f.call('career_interview_ask', { questions: [{ ...capabilityQuestion, factId: historical.facts[0].id }] });
  const result = await f.call('career_interview_answer', { interviewId: detail.interviewId, reply: 'I built a checkout service at Acme.' });
  assert.equal(Object.hasOwn(result.saved[0], 'question'), false);
  assert.equal(Object.hasOwn(result.saved[0], 'context'), false);
});

test('mixed partial rounds retain original numbers and invalid explanations never disappear silently', async () => {
  const f = fixture();
  const asked = await f.call('career_interview_ask', { questions: [capabilityQuestion,
    { subject: 'Italian', prompt: 'Italian level?', kind: 'language' }] });
  let before = f.store.get();
  await assert.rejects(f.call('career_interview_answer', { interviewId: asked.interviewId,
    reply: '1b: According to the CV, built wallets; 2a' }), { code: 'UNCLEAR_FACT' });
  assert.deepEqual(f.store.get(), before);
  const first = await f.call('career_interview_answer', { interviewId: asked.interviewId, reply: '1b' });
  assert.deepEqual(first.unanswered, [1, 2]);
  before = f.store.get();
  await assert.rejects(f.call('career_interview_answer', { interviewId: asked.interviewId, reply: '1a; 2a' }), { code: 'INVALID_INPUT' });
  assert.deepEqual(f.store.get(), before);
  const next = await f.call('career_interview_answer', { interviewId: asked.interviewId, reply: '2a' });
  assert.deepEqual(next.unanswered, [1]);
  const skipped = await f.call('career_interview_answer', { interviewId: asked.interviewId, reply: 'skip' });
  assert.deepEqual(skipped.skipped, [1]);
  assert.deepEqual(skipped.saved, []);
  assert.equal(needsDetail((await f.call('career_facts_list', { query: 'Wallet' })).items[0]), true);
  const again = await f.call('career_interview_ask', { questions: [capabilityQuestion] });
  const cancelled = await f.call('career_interview_answer', { interviewId: again.interviewId, reply: 'cancel' });
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(cancelled.saved, []);
});

test('stale or deleted facts reject detail replies and concurrent choices do not overwrite', async () => {
  for (const remove of [false, true]) {
    const f = fixture();
    const asked = await f.call('career_interview_ask', { questions: [capabilityQuestion] });
    const partial = await f.call('career_interview_answer', { interviewId: asked.interviewId, reply: '1a' });
    const saved = partial.saved[0];
    if (remove) await f.edit('career_facts_delete', { factIds: [saved.id] });
    else await f.edit('career_facts_save', { facts: [{ ...fact(saved.kind, saved.subject, 'None'), id: saved.id }] });
    const before = f.store.get();
    await assert.rejects(f.call('career_interview_answer', { interviewId: asked.interviewId,
      reply: 'I built the wallet adapter and shipped it.' }), { code: remove ? 'NOT_FOUND' : 'FACT_CHANGED' });
    assert.deepEqual(f.store.get(), before);
  }
  const f = fixture();
  const asked = await f.call('career_interview_ask', { questions: [capabilityQuestion] });
  await f.edit('career_facts_save', { facts: [fact('capability', capabilityQuestion.subject, 'None')] });
  await assert.rejects(f.call('career_interview_answer', { interviewId: asked.interviewId, reply: '1a' }), { code: 'FACT_CHANGED' });
});

test('native forms ask at most one detail round and cancellation retains the partial answer', async () => {
  for (const decline of [false, true]) {
    const requests = [];
    const f = fixture({ interaction: { canElicit: () => true, elicit: async request => {
      requests.push(request);
      if (requests.length === 1) return { action: 'accept', content: { q1: 'Hands-on' } };
      return decline ? { action: 'cancel' } : { action: 'accept', content: { q1: 'I built and shipped the checkout wallet adapter.' } };
    } } });
    const result = await f.call('career_interview_ask', { questions: [capabilityQuestion] });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].requestedSchema.properties.q1.enum, undefined);
    assert.equal(result.saved.length, 1);
    assert.equal(needsDetail(result.saved[0]), decline);
    assert.deepEqual(result.unanswered, decline ? [1] : []);
    if (decline) {
      assert.equal(result.declined, true);
      assert.equal(result.followUps.length, 1);
      assert.equal(result.saved[0].followUps, undefined);
    } else assert.equal(result.saved[0].followUps.length, 1);
  }
});

test('scoped pending language interviews reload without narrative followups', async () => {
  const f = fixture();
  const id = randomUUID();
  await f.store.update(state => { (state.career.interviews ??= {})[id] = { id, applicationId, job: applicationJob, createdAt: new Date().toISOString(), questions: [
    { number: 3, subject: 'French', prompt: 'French level?', kind: 'language',
      options: ['Native', 'Fluent', 'Professional', 'Conversational', 'Basic'] },
  ] }; });
  const reopened = fixture({}, f.store.get());
  assert.equal(reopened.store.get().career.interviews[id].applicationId, applicationId);
  const result = await reopened.call('career_interview_answer', { interviewId: id, reply: '3b' });
  assert.equal(result.saved[0].answer, 'Fluent');
  assert.deepEqual(result.unanswered, []);
});

test('elicitation cannot commit after local lock or identity epoch changes', async () => {
  for (const code of ['LOCAL_LOCKED', 'IDENTITY_CHANGED']) {
    const f = fixture({}, { deviceId: 'device-a' });
    let locked = false, generation = 1;
    const scoped = createScopedAccess(f.store, { epoch: () => generation,
      assertAvailable: () => { if (locked) throw Object.assign(new Error('Locked'), { code: 'LOCAL_LOCKED' }); } });
    const tools = createProfileTools({ store: scoped.store, interaction: { canElicit: () => true,
      elicit: async () => {
        if (code === 'LOCAL_LOCKED') locked = true;
        else generation++;
        return { action: 'accept', content: { q1: 'Hands-on', q1_detail: 'I shipped the wallet adapter.' } };
      } } });
    await assert.rejects(tools.find(tool => tool.name === 'career_interview_ask').invoke({ applicationId, questions: [capabilityQuestion] }), { code });
    assert.deepEqual(f.store.get().career.facts, {});
  }
});

test('multiple detail replies are numbered, atomic, and retain earlier exchanges when deepened', async () => {
  const f = fixture();
  const asked = await f.call('career_interview_ask', { questions: [capabilityQuestion,
    { subject: 'Operations', prompt: 'Operations experience?', kind: 'capability' }] });
  const partial = await f.call('career_interview_answer', { interviewId: asked.interviewId, reply: '1a 2b' });
  assert.equal(partial.followUps.length, 2);
  const before = f.store.get();
  await assert.rejects(f.call('career_interview_answer', { interviewId: asked.interviewId,
    reply: '1: I shipped the wallet adapter.; 2: According to the CV, led operations.' }), { code: 'UNCLEAR_FACT' });
  assert.deepEqual(f.store.get(), before);
  const complete = await f.call('career_interview_answer', { interviewId: asked.interviewId,
    reply: '1: I shipped the wallet adapter.; 2: I configured alerts for Checkout and reduced outages.' });
  assert.deepEqual(complete.unanswered, []);
  const original = complete.saved[0];
  const deeper = await f.call('career_interview_ask', { questions: [{ ...capabilityQuestion,
    factId: original.id, followUp: 'What did you change in the adapter?' }] });
  const result = await f.call('career_interview_answer', { interviewId: deeper.interviewId, reply: 'I implemented the account reconnect logic.' });
  assert.equal(result.saved[0].followUps.length, 2);
  assert.deepEqual(result.saved[0].followUps[0], original.followUps[0]);
});

test('needsDetail is structural and contextual fields accept actual questions with bounded lengths', async () => {
  for (const detail of [undefined, '', '  ', ' hands-ON ', ' wallets '])
    assert.equal(needsDetail(fact('capability', 'Wallets', 'Hands-on', { detail })), true);
  assert.equal(needsDetail(fact('capability', 'Wallets', 'Hands-on', { detail: 'Used it' })), false);
  assert.equal(needsDetail(fact('capability', 'Wallets', 'None')), false);
  assert.equal(needsDetail(fact('yes_no', 'Travel', 'Yes')), false);
  const f = fixture();
  const saved = await f.edit('career_facts_save', { facts: [fact('capability', 'Wallets', 'Hands-on',
    { question: 'Which wallet?', context: 'Can you ship this integration?', detail: 'A'.repeat(1500) })] });
  assert.equal(saved.facts[0].detail.length, 1500);
  for (const extra of [{ question: 'a'.repeat(301) }, { context: 'a'.repeat(601) }, { detail: 'a'.repeat(1501) }])
    await assert.rejects(f.edit('career_facts_save', { facts: [fact('capability', 'Other', 'Hands-on', extra)] }), { code: 'INVALID_INPUT' });
});

test('fact reset clears every fact and interview while preserving source, profile, account and drafts', async () => {
  const f = fixture({}, { pairing: { account: { id: 'account-a' } }, deviceId: 'device-a' });
  await importText(f);
  await f.edit('career_profile_update', { patch: { headline: 'Engineer', roleCapabilities: ['Wallet integrations'] } });
  await f.edit('career_preferences_update', { patch: { locations: ['London'] } });
  await f.store.update(state => {
    state.career.applications[applicationId].cv = { version: 2, content: 'Saved tailored CV' };
    state.career.applications[applicationId].coverLetter = { version: 1, content: 'Saved cover letter' };
    state.career.matching = { saved: ['job-a'] };
  });
  await f.edit('career_facts_save', { facts: [teamSize()] });
  const asked = await f.call('career_interview_ask', { questions: [capabilityQuestion] });
  await f.call('career_interview_answer', { interviewId: asked.interviewId, reply: '1a' });
  const before = f.store.get();
  const request = f.mutation();
  const result = await f.call('career_facts_reset', request);
  assert.equal(result.deletedFacts, 2);
  assert.equal(result.deletedInterviews, 1);
  const after = f.store.get();
  assert.deepEqual(after.career.facts, {});
  assert.deepEqual(after.career.interviews, {});
  assert.equal(after.career.evidenceRevision, before.career.evidenceRevision + 1);
  assert.equal(after.career.revision, before.career.revision + 1);
  for (const field of ['sources', 'profile', 'applications', 'matching'])
    assert.deepEqual(after.career[field], before.career[field]);
  assert.deepEqual(after.pairing, before.pairing);
  assert.equal(after.deviceId, before.deviceId);
  await assert.rejects(f.call('career_interview_answer', { interviewId: asked.interviewId, reply: 'I shipped the adapter.' }), { code: 'NOT_FOUND' });
  assert.deepEqual(f.store.get(), after);
  assert.deepEqual(await f.call('career_facts_reset', request), result);
  await assert.rejects(f.call('career_facts_reset', { ...request, requestId: randomUUID() }), { code: 'REVISION_CONFLICT' });
});

test('interview requires a known complete saved application before storing state or opening a form', async () => {
  let elicited = 0;
  const f = fixture({ interaction: { canElicit: () => true, elicit: async () => { elicited++; return null; } } });
  const before = f.store.get();
  await assert.rejects(f.call('career_interview_ask', { applicationId: undefined, questions: [capabilityQuestion] }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.call('career_interview_ask', { applicationId: randomUUID(), questions: [capabilityQuestion] }), { code: 'NOT_FOUND' });
  assert.equal(elicited, 0);
  assert.deepEqual(f.store.get(), before);
  await f.store.update(state => { delete state.career.applications[applicationId].job.description; });
  const incomplete = f.store.get();
  await assert.rejects(f.call('career_interview_ask', { questions: [capabilityQuestion] }), { code: 'INVALID_INPUT' });
  assert.equal(elicited, 0);
  assert.deepEqual(f.store.get(), incomplete);
});

test('a different application deepens a fact without replacing its original application or requirement context', async () => {
  const f = fixture();
  const asked = await f.call('career_interview_ask', { questions: [capabilityQuestion] });
  assert.equal(asked.applicationId, applicationId);
  assert.deepEqual(asked.job, { title: applicationJob.title, company: applicationJob.company, url: applicationJob.url });
  const { saved: [original] } = await f.call('career_interview_answer', { interviewId: asked.interviewId,
    reply: '1b: I built and shipped the checkout wallet connection.' });
  const otherApplicationId = randomUUID();
  await f.store.update(state => { state.career.applications[otherApplicationId] = {
    id: otherApplicationId, job: { title: 'Protocol Engineer', company: 'Other', description: 'Implement wallet signing.' },
  }; });
  const requirement = 'This listing needs signing implementation.';
  const next = await f.call('career_interview_ask', { applicationId: otherApplicationId,
    questions: [{ ...capabilityQuestion, factId: original.id, context: requirement, followUp: 'What signing changes did you personally ship?' }] });
  assert.equal(next.applicationId, otherApplicationId);
  const result = await f.call('career_interview_answer', { interviewId: next.interviewId, reply: 'I implemented the signing request handler.' });
  const saved = result.saved[0];
  assert.equal(saved.applicationId, applicationId);
  assert.equal(saved.question, original.question);
  assert.equal(saved.context, original.context);
  assert.equal(saved.followUps[0].applicationId, otherApplicationId);
  assert.equal(saved.followUps[0].context, requirement);
  assert.equal((await f.call('career_facts_list', { query: requirement })).items[0].id, original.id);
});

test('single detail explanations starting with numbers are preserved verbatim, not parsed as choices', async () => {
  for (const reply of ['3 engineers worked on Checkout; I implemented the wallet adapter.', '2 clients shipped the integration after I fixed reconnect logic.']) {
    const f = fixture();
    const asked = await f.call('career_interview_ask', { questions: [capabilityQuestion] });
    await f.call('career_interview_answer', { interviewId: asked.interviewId, reply: '1b' });
    await assert.rejects(f.call('career_interview_answer', { interviewId: asked.interviewId, reply: '1a' }), { code: 'INVALID_INPUT' });
    const result = await f.call('career_interview_answer', { interviewId: asked.interviewId, reply });
    assert.equal(result.saved[0].detail, reply);
    assert.equal(result.saved[0].followUps[0].answer, reply);
  }
});
