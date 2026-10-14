import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { createProfileTools } from '../src/mcp/profile-tools.mjs';
import { createCareerState } from '../src/mcp/state.mjs';

function fixture(dependencies = {}, initial = {}) {
  let state = { career: createCareerState(), pairing: null, ...structuredClone(initial) };
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

test('saved answers are searchable, paginated and upserted by subject rather than duplicated', async () => {
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
    fact('capability', ' go ', 'Hands-on', { detail: 'Built production services.' }),
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
  assert.equal(status.questions.find(item => item.field === 'background').tool, 'career_facts_save');
  await f.edit('career_facts_save', { facts: [teamSize()] });
  await f.edit('career_preferences_update', { patch: { roles: ['Engineer'] } });
  status = await f.call('onboarding_status');
  assert.equal(status.locallyReady, true);
  assert.equal(status.providerRequired, false);
  assert.deepEqual(status.pairing, { paired: false, account: null });
  assert.equal(status.catalogRequiresPairing, true);
  assert.equal(status.sourceCount, 0);
  assert.equal(status.factCount, 1);
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

test('form interviews save explicit selections only; declining and transport failures save nothing', async () => {
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
  assert.deepEqual(f.store.get(), before);
  response = new Error('Connection lost');
  await assert.rejects(f.call('career_interview_ask', { questions: [{ ...input.questions[0], subject: 'Third subject' }] }), /Connection lost/);
  assert.deepEqual(f.store.get(), before);
});
