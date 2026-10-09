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
  return { store, call, edit, mutation };
}
const conversationFact = (statement = 'Built a reporting service') => ({ kind: 'experience', statement, source: { kind: 'conversation', quote: 'I built a reporting service for our team.', conversationId: 'career-interview', messageId: 'answer-1' } });

async function importText(f, text = 'Built a reporting service that saved 12 hours per week.') {
  return f.edit('career_source_import', { method: 'text', purpose: 'cv', name: 'Original CV', text });
}

test('no-CV onboarding reaches local readiness without pairing or provider credentials and preserves literal answers', async () => {
  const f = fixture({ platform: () => assert.fail('Local interview must not contact the account') });
  assert.equal((await f.call('onboarding_status')).locallyReady, false);
  await f.edit('onboarding_start', { mode: 'interview' });
  const saved = await f.edit('career_facts_add', { facts: [conversationFact()] });
  await f.edit('career_preferences_update', { patch: { roles: ['Engineer'], locations: [], requiresSponsorship: false } });
  const status = await f.call('onboarding_status');
  assert.equal(status.locallyReady, true);
  assert.equal(status.providerRequired, false);
  assert.equal(status.pairing.paired, false);
  assert.equal(status.catalogRequiresPairing, true);
  assert.equal(status.sourceCount, 0);
  assert.deepEqual(status.missing, []);
  const read = await f.call('career_facts_list');
  assert.equal(read.items[0].source.quote, conversationFact().source.quote);
  assert.equal(read.items[0].id, saved.facts[0].id);
  assert.match(status.evidencePolicy, /not independently verified/);
});

test('readiness reports pairing only from store pairing, and an uploaded CV still needs grounded facts', async () => {
  const f = fixture({}, { pairing: { account: { id: 'account-a', label: 'Candidate' }, secret: 'do-not-return' }, connections: [] });
  await importText(f);
  const status = await f.call('onboarding_status');
  assert.equal(status.mode, 'cv');
  assert.equal(status.locallyReady, false);
  assert.deepEqual(status.pairing, { paired: true, account: { id: 'account-a', label: 'Candidate' } });
  assert.equal(JSON.stringify(status).includes('do-not-return'), false);
  assert.equal(status.missing.some(item => item.field === 'background'), true);
});

test('profile explicit clears survive grounded enrichment and preference false/zero/empty values survive partial patches', async () => {
  const f = fixture();
  const { facts } = await f.edit('career_facts_add', { facts: [conversationFact()] });
  await f.edit('career_profile_update', { mode: 'explicit', patch: { name: 'Alex', headline: null, links: [] } });
  const enriched = await f.edit('career_profile_update', { mode: 'evidence', factId: facts[0].id, patch: { name: 'Wrong name', headline: 'Engineer', links: ['https://example.test'], location: 'Dublin' } });
  assert.deepEqual(enriched.saved, ['location']);
  assert.deepEqual(enriched.skipped, ['name', 'headline', 'links']);
  assert.equal(enriched.profile.headline, null);
  assert.equal(enriched.profile.name, 'Alex');
  assert.deepEqual(enriched.profile.links, []);
  await f.edit('career_preferences_update', { patch: { salaryMinimum: 0, requiresSponsorship: false, roles: [], locations: null } });
  await f.edit('career_preferences_update', { patch: { notes: 'Do not relocate' } });
  const read = await f.call('career_profile_read', { fields: ['headline'], includeHistory: true });
  assert.deepEqual(read.profile, { headline: null });
  assert.equal(read.preferences.salaryMinimum, 0);
  assert.equal(read.preferences.requiresSponsorship, false);
  assert.deepEqual(read.preferences.roles, []);
  assert.equal(read.preferences.locations, null);
  assert.equal(read.fieldSources.headline.kind, 'explicit');
  assert.equal(read.history.items.some(change => change.field === 'headline' && change.value === null), true);
});

test('document grounding rejects a fabricated quote atomically without saving valid siblings', async () => {
  const f = fixture();
  const { source } = await importText(f);
  const before = f.store.get();
  await assert.rejects(f.edit('career_facts_add', { facts: [
    { kind: 'achievement', statement: 'Saved 12 hours weekly', source: { kind: 'document', sourceId: source.id, quote: 'saved 12 hours per week' } },
    { kind: 'achievement', statement: 'Saved a million dollars', source: { kind: 'document', sourceId: source.id, quote: 'saved a million dollars' } },
  ] }), error => error.code === 'INVALID_INPUT');
  assert.deepEqual(f.store.get(), before);
});

test('correction and retraction retain source bytes and fact lineage while invalidating dependent evidence', async () => {
  const bytes = Buffer.from('CV bytes retained literally');
  const f = fixture({ selectSourceFile: async () => ({ buffer: bytes, originalname: 'career.pdf', mimetype: 'application/pdf' }), extractFile: async () => ({ text: 'I saved 12 hours weekly.', pageCount: 1, images: ['not-retained'], provenance: { codec: 'pdf' } }) });
  const imported = await f.edit('career_source_import', { method: 'file', purpose: 'cv' });
  const sourceBefore = f.store.get().career.sources[imported.source.id];
  const added = await f.edit('career_facts_add', { facts: [{ kind: 'achievement', statement: 'Saved 12 hours weekly', source: { kind: 'document', sourceId: imported.source.id, quote: '12 hours weekly' } }] });
  const oldId = added.facts[0].id;
  await f.edit('career_profile_update', { mode: 'evidence', factId: oldId, patch: { headline: 'Reporting specialist' } });
  const corrected = await f.edit('career_fact_correct', { factId: oldId, reason: 'Candidate clarified the estimate', replacement: { kind: 'achievement', statement: 'Saved around 10 hours weekly', source: { kind: 'conversation', quote: 'Actually, it was around 10 hours per week.' } } });
  assert.equal(corrected.previous.status, 'superseded');
  assert.equal(corrected.fact.supersedes, oldId);
  assert.deepEqual(corrected.affectedProfileFields, ['headline']);
  assert.equal(corrected.fact.changedRevision, corrected.revision);
  assert.deepEqual((await f.call('career_profile_read')).staleFields, ['headline']);
  const retracted = await f.edit('career_facts_retract', { factIds: [corrected.fact.id], reason: 'Candidate cannot substantiate the estimate' });
  assert.equal(retracted.evidenceRevision, corrected.evidenceRevision + 1);
  assert.equal((await f.call('career_facts_list')).total, 0);
  const all = await f.call('career_facts_list', { status: 'all' });
  assert.equal(all.total, 2);
  assert.equal(all.items.find(fact => fact.id === oldId).source.quote, '12 hours weekly');
  assert.deepEqual(f.store.get().career.sources[imported.source.id], sourceBefore);
  assert.equal(sourceBefore.originalBase64, bytes.toString('base64'));
  assert.equal(JSON.stringify(sourceBefore).includes('not-retained'), false);
  await assert.rejects(f.edit('career_fact_correct', { factId: oldId, reason: 'stale edit', replacement: conversationFact() }), error => error.code === 'SOURCE_STALE');
});

test('native picker and extraction are not repeated on mutation replay; changed request reuse is rejected', async () => {
  let picks = 0, extracts = 0;
  const f = fixture({ selectSourceFile: async () => { picks++; return { buffer: Buffer.from('bytes'), originalname: 'cv.txt', mimetype: 'text/plain' }; }, extractFile: async () => { extracts++; return { text: 'Candidate evidence' }; } });
  const args = { ...f.mutation(), method: 'file', purpose: 'cv' };
  const first = await f.call('career_source_import', args);
  await f.edit('career_preferences_update', { patch: { roles: [] } });
  assert.deepEqual(await f.call('career_source_import', args), first);
  assert.equal(picks, 1);
  assert.equal(extracts, 1);
  await assert.rejects(f.call('career_source_import', { ...args, purpose: 'supporting' }));
  assert.equal(picks, 1);
  assert.equal(Object.keys(f.store.get().career.sources).length, 1);
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
  assert.equal(f.store.get().career.evidenceRevision, 0);
});

test('a revision change during native extraction prevents stale source commit', async () => {
  let signalStarted, finish;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const extraction = new Promise(resolve => { finish = resolve; });
  const f = fixture({ selectSourceFile: async () => ({ buffer: Buffer.from('bytes'), originalname: 'cv.txt', mimetype: 'text/plain' }), extractFile: async () => { signalStarted(); return extraction; } });
  const pending = f.edit('career_source_import', { method: 'file' });
  await started;
  await f.edit('career_preferences_update', { patch: { locations: ['London'] } });
  finish({ text: 'Late extracted source' });
  await assert.rejects(pending, error => error.code === 'REVISION_CONFLICT');
  assert.equal(Object.keys(f.store.get().career.sources).length, 0);
  assert.deepEqual(f.store.get().career.profile.preferences.locations, ['London']);
});

test('competing evidence mutations serialize with one conflict and no lost update', async () => {
  const f = fixture();
  const revision = f.store.get().career.revision;
  const result = await Promise.allSettled([
    f.call('career_facts_add', { requestId: randomUUID(), revision, facts: [conversationFact('First candidate statement')] }),
    f.call('career_facts_add', { requestId: randomUUID(), revision, facts: [conversationFact('Second candidate statement')] }),
  ]);
  assert.equal(result.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(result.find(item => item.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  assert.equal(Object.keys(f.store.get().career.facts).length, 1);
});

test('scoped reads page exact immutable text and do not disclose binary originals or unrelated facts', async () => {
  const f = fixture();
  const first = await importText(f, 'First source evidence.');
  const second = await importText(f, 'Second source evidence.');
  await f.edit('career_facts_add', { facts: [
    { kind: 'skill', statement: 'First fact', source: { kind: 'document', sourceId: first.source.id, quote: 'First source' } },
    { kind: 'education', statement: 'Second fact', source: { kind: 'document', sourceId: second.source.id, quote: 'Second source' } },
  ] });
  const slice = await f.call('career_source_read', { sourceId: first.source.id, offset: 6, length: 6 });
  assert.equal(slice.text, 'source');
  assert.equal(slice.nextOffset, 12);
  assert.equal(slice.source.originalBase64, undefined);
  const facts = await f.call('career_facts_list', { sourceId: second.source.id, kinds: ['education'], limit: 1 });
  assert.equal(facts.total, 1);
  assert.equal(facts.items[0].statement, 'Second fact');
  const sources = await f.call('career_sources_list', { limit: 1 });
  assert.equal(sources.nextOffset, 1);
  assert.equal(sources.items[0].text, undefined);
  await assert.rejects(f.call('career_source_read', { sourceId: first.source.id, offset: 100 }), error => error.code === 'INVALID_INPUT');
});


test('strict bounded schemas reject paths, provider fields, oversized batches and ambiguous evidence before side effects', async () => {
  const f = fixture({ selectSourceFile: async () => assert.fail('Invalid input must not open picker') });
  const invalid = [
    ['career_source_import', { method: 'file', path: '/private/cv.pdf' }],
    ['career_source_import', { method: 'file', text: 'bypass picker' }],
    ['career_source_import', { method: 'text', name: 'Too large', text: 'x'.repeat(100_001) }],
    ['career_profile_update', { mode: 'explicit', patch: { apiKey: 'not-accepted' } }],
    ['career_facts_add', { facts: Array.from({ length: 51 }, (_, index) => conversationFact(`Statement ${index}`)) }],
    ['career_facts_add', { facts: [{ ...conversationFact(), source: { kind: 'conversation', sourceId: randomUUID(), quote: 'Ambiguous attribution' } }] }],
  ];
  for (const [name, args] of invalid) await assert.rejects(f.edit(name, args), error => error.code === 'INVALID_INPUT');
  assert.equal(f.store.get().career.revision, 0);
});

test('concurrent retries share the native import and reject changed request content before a second prompt', async () => {
  let finish, picks = 0;
  const selection = new Promise(resolve => { finish = resolve; });
  const f = fixture({ selectSourceFile: async () => { picks++; return selection; }, extractFile: async () => ({ text: 'Unchanged candidate evidence' }) });
  const args = { ...f.mutation(), method: 'file', purpose: 'cv' };
  const first = f.call('career_source_import', args);
  const retry = f.call('career_source_import', args);
  await assert.rejects(f.call('career_source_import', { ...args, purpose: 'supporting' }), error => error.code === 'REQUEST_CONFLICT');
  finish({ buffer: Buffer.from('original'), originalname: 'cv.txt', mimetype: 'text/plain' });
  const [saved, replay] = await Promise.all([first, retry]);
  assert.deepEqual(replay, saved);
  assert.equal(picks, 1);
  assert.equal(Object.keys(f.store.get().career.sources).length, 1);
});

test('fact and profile receipts retain their exact saved state after later corrections', async () => {
  const f = fixture();
  const factArgs = { ...f.mutation(), facts: [conversationFact()] };
  const added = await f.call('career_facts_add', factArgs);
  const originalFactResult = structuredClone(added);
  const profileArgs = { ...f.mutation(), mode: 'explicit', patch: { name: 'Original name' } };
  const savedProfile = structuredClone(await f.call('career_profile_update', profileArgs));
  await f.edit('career_profile_update', { mode: 'explicit', patch: { name: 'Corrected name' } });
  await f.edit('career_fact_correct', { factId: added.facts[0].id, reason: 'Corrected by candidate', replacement: conversationFact('Corrected statement') });
  assert.deepEqual(await f.call('career_facts_add', factArgs), originalFactResult);
  assert.deepEqual(await f.call('career_profile_update', profileArgs), savedProfile);
  assert.equal(f.store.get().career.profile.name, 'Corrected name');
});


const cvCheckpoint = () => ({
  mode: 'cv',
  source: { name: 'CV', purpose: 'cv', text: 'Senior engineer. Built a reporting service and managed six engineers.' },
  facts: [{
    kind: 'experience', statement: 'Senior engineer building reporting services and managing engineers',
    source: { kind: 'imported_document', quote: 'Senior engineer. Built a reporting service and managed six engineers.' },
  }],
  profile: [{ factIndex: 0, patch: { roleCapabilities: ['Software engineer', 'Engineering manager'], seniority: 'Senior', skills: ['Reporting services', 'People management'] } }],
});

test('CV-first status returns import/read/extraction actions instead of preference or seniority questions', async () => {
  const f = fixture();
  await f.edit('onboarding_start', { mode: 'cv' });
  let status = await f.call('onboarding_status');
  assert.equal(status.locallyReady, false);
  assert.equal(status.actions[0].tool, 'career_source_import');
  assert.deepEqual(status.questions, []);
  const { source } = await importText(f);
  status = await f.call('onboarding_status');
  assert.equal(status.actions[0].tool, 'career_source_read');
  assert.equal(status.actions[0].args.sourceId, source.id);
  assert.equal(status.actions.some(action => action.tool === 'onboarding_commit'), true);
  assert.deepEqual(status.questions, []);
  assert.equal(status.missing.some(item => item.field === 'preferences'), false);
  await f.edit('career_facts_add', { facts: [{ kind: 'experience', statement: 'Built reporting services', source: { kind: 'document', sourceId: source.id, quote: 'Built a reporting service' } }] });
  status = await f.call('onboarding_status');
  assert.equal(status.locallyReady, false, 'Facts without a persisted usable profile must not claim completion');
  assert.equal(status.missing.some(item => item.field === 'profile'), true);
});


test('atomic CV checkpoint persists sources facts capability defaults and authoritative readback without preferences', async () => {
  const f = fixture();
  const args = { ...f.mutation(), ...cvCheckpoint() };
  const saved = await f.call('onboarding_commit', args);
  assert.equal(saved.revision, 1);
  assert.equal(saved.receipt.requestId, args.requestId);
  assert.equal(saved.receipt.revision, saved.revision);
  assert.equal(saved.persistence.sourceCount, 1);
  assert.equal(saved.persistence.activeFactCount, 1);
  assert.deepEqual(saved.saved, ['roleCapabilities', 'seniority', 'skills']);
  const read = await f.call('career_profile_read');
  assert.deepEqual(read.persistence, saved.persistence);
  assert.equal(read.profile.seniority, 'Senior');
  assert.deepEqual(read.preferences, {}, 'CV capability inference cannot invent future preferences');
  assert.equal(read.fieldSources.roleCapabilities.factId, saved.facts[0].id);
  assert.equal(saved.facts[0].source.sourceId, saved.source.id);
  const status = await f.call('onboarding_status');
  assert.equal(status.locallyReady, true);
  assert.deepEqual(status.missing, []);
  assert.deepEqual(status.persistence, read.persistence);
  const reopened = fixture({}, f.store.get());
  assert.deepEqual(await reopened.call('career_profile_read'), read);
  assert.deepEqual(await reopened.call('onboarding_status'), status);
});

test('checkpoint rollback covers source facts profile preferences history and receipts on grounding or reference failures', async () => {
  const f = fixture();
  for (const alter of [
    input => { input.facts[0].source.quote = 'Invented passage'; },
    input => { input.profile[0].factIndex = 1; },
    input => { input.preferences = { patch: { travel: 'any' }, source: { kind: 'conversation', quote: '   ' } }; },
    input => { delete input.source; },
  ]) {
    const input = cvCheckpoint();
    alter(input);
    const before = f.store.get();
    await assert.rejects(f.edit('onboarding_commit', input), error => error.code === 'INVALID_INPUT');
    assert.deepEqual(f.store.get(), before);
  }
});

test('checkpoint replay returns original saved receipt after later changes without duplicate evidence', async () => {
  const f = fixture();
  const args = { ...f.mutation(), ...cvCheckpoint() };
  const saved = structuredClone(await f.call('onboarding_commit', args));
  await f.edit('career_profile_update', { mode: 'explicit', patch: { seniority: null } });
  const before = f.store.get();
  assert.deepEqual(await f.call('onboarding_commit', args), saved);
  assert.deepEqual(f.store.get(), before);
  await assert.rejects(f.call('onboarding_commit', { ...args, mode: 'interview' }), error => error.code === 'REQUEST_CONFLICT');
  assert.equal(Object.keys(f.store.get().career.sources).length, 1);
  assert.equal(Object.keys(f.store.get().career.facts).length, 1);
});

test('explicit structured answers preserve unrestricted zero false and literal provenance separately from capabilities', async () => {
  const f = fixture();
  const patch = {
    companySizes: [], companyStages: [], responsibilityModes: ['hands_on', 'managerial'],
    directReports: 'preferred', travel: 'any',
    employmentTypes: ['permanent', 'contract', 'temporary', 'internship', 'part_time', 'other'],
    availability: 'immediate', emphasis: 'vacancy_specific', technologies: [], domains: [],
    salaryMinimum: 0, requiresSponsorship: false, willingToRelocate: false, roles: [], locations: null,
  };
  const source = { kind: 'conversation', quote: 'Any company size or stage. Hands-on or management both work; direct reports preferred. Any travel and employment type. Available immediately. Tailor emphasis to each vacancy; no extra technology or domain preferences. No salary minimum; no sponsorship needed; not relocating.', conversationId: 'onboarding', messageId: 'answer' };
  const saved = await f.edit('onboarding_commit', { ...cvCheckpoint(), preferences: { patch, source } });
  await f.edit('career_preferences_update', { patch: { notes: 'Keep prior answers' }, source: { kind: 'conversation', quote: 'Keep prior answers' } });
  const read = await f.call('career_profile_read', { includeHistory: true });
  for (const [field, value] of Object.entries(patch)) {
    assert.deepEqual(read.preferences[field], value);
    assert.deepEqual(read.fieldSources[`preferences.${field}`].answer, source);
  }
  assert.equal(saved.saved.includes('preferences.travel'), true);
  assert.equal(read.history.items.some(item => item.field === 'preferences.travel' && item.source.answer.quote === source.quote), true);
  assert.deepEqual(read.profile.roleCapabilities, ['Software engineer', 'Engineering manager']);
  assert.equal((await f.call('onboarding_status')).locallyReady, true);
});

test('grounded checkpoint enrichment preserves prior explicit overrides clears and unrestricted roles', async () => {
  const f = fixture();
  await f.edit('career_profile_update', { mode: 'explicit', patch: { seniority: null, roleCapabilities: [], skills: ['Chosen wording'] } });
  await f.edit('career_preferences_update', { patch: { roles: [], salaryMinimum: 0, requiresSponsorship: false } });
  const saved = await f.edit('onboarding_commit', cvCheckpoint());
  assert.deepEqual(saved.saved, []);
  assert.deepEqual(saved.skipped, ['roleCapabilities', 'seniority', 'skills']);
  assert.equal(saved.profile.seniority, null);
  assert.deepEqual(saved.profile.roleCapabilities, []);
  assert.deepEqual(saved.profile.skills, ['Chosen wording']);
  assert.deepEqual(saved.profile.preferences.roles, []);
  assert.equal(saved.profile.preferences.salaryMinimum, 0);
  assert.equal(saved.profile.preferences.requiresSponsorship, false);
  assert.equal((await f.call('onboarding_status')).locallyReady, true);
});

test('existing-source checkpoint uses exact CV grounding and rejects unrelated background or stale capability readiness', async () => {
  const f = fixture();
  const { source } = await importText(f);
  const unrelated = await f.edit('career_facts_add', { facts: [conversationFact()] });
  await f.edit('career_profile_update', { mode: 'evidence', factId: unrelated.facts[0].id, patch: { headline: 'Engineer' } });
  assert.equal((await f.call('onboarding_status')).locallyReady, false);
  const committed = await f.edit('onboarding_commit', {
    mode: 'cv',
    facts: [{ kind: 'experience', statement: 'Built reporting service', source: { kind: 'document', sourceId: source.id, quote: 'Built a reporting service' } }],
    profile: [{ factIndex: 0, patch: { roleCapabilities: ['Reporting engineer'] } }],
  });
  assert.equal(committed.source, null);
  assert.equal(committed.persistence.sourceCount, 1);
  assert.equal((await f.call('onboarding_status')).locallyReady, true);
  await f.edit('career_facts_retract', { factIds: [committed.facts[0].id], reason: 'Withdrawn by candidate' });
  assert.equal((await f.call('career_profile_read')).staleFields.includes('roleCapabilities'), true);
  assert.equal((await f.call('onboarding_status')).locallyReady, false);
});

test('capability evidence accepts saved fact references but cannot write inferred sensitive preferences', async () => {
  const f = fixture();
  const { facts } = await f.edit('career_facts_add', { facts: [conversationFact()] });
  const saved = await f.edit('onboarding_commit', { mode: 'interview', profile: [{ factId: facts[0].id, patch: { roleCapabilities: ['Engineer'] } }] });
  assert.equal(saved.persistence.activeFactCount, 1);
  assert.equal((await f.call('onboarding_status')).locallyReady, true);
  for (const patch of [{ salaryMinimum: 0 }, { willingToRelocate: true }, { requiresSponsorship: false }, { availability: 'immediate' }, { travel: 'any' }]) {
    await assert.rejects(f.edit('onboarding_commit', { mode: 'interview', profile: [{ factId: facts[0].id, patch }] }), error => error.code === 'INVALID_INPUT');
  }
  await assert.rejects(f.edit('onboarding_commit', { mode: 'interview', preferences: { patch: { travel: 'any' }, source: { kind: 'document', sourceId: randomUUID(), quote: 'Passport' } } }), error => error.code === 'INVALID_INPUT');
  assert.deepEqual((await f.call('career_profile_read')).preferences, {});
});
