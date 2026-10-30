import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBrowserForms } from '../src/browser-forms.mjs';
import { createFormTools } from '../src/mcp/form-tools.mjs';
import { createProfileTools } from '../src/mcp/profile-tools.mjs';
import { createScopedAccess } from '../src/mcp/scope.mjs';
import { CareerError, createCareerState } from '../src/mcp/state.mjs';
import { applicationContextFingerprint, upsertApplication } from '../src/application-workflow.mjs';

const field = (id, label, type = 'text', extra = {}) => ({ id, label, type, signature: `signature:${id}`, empty: true, ...extra });
const snapshot = fields => ({ requestId: randomUUID(), url: 'https://synthetic.example/apply/role', title: 'Synthetic application', fields, useApi: false });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture({ fetchImpl = async () => { throw new Error('Unexpected fetch'); }, configured = false } = {}) {
  let state = { deviceId: 'synthetic-device', prescanCredentialVersion: 0, career: createCareerState() };
  Object.assign(state.career.profile, { name: 'Synthetic Candidate', email: 'candidate@example.test', phone: '+1 555 0100', location: 'Toronto', skills: ['Data analysis'] });
  state.career.facts.language = { id: 'language', subject: 'French', answer: 'Professional', kind: 'capability' };
  state.career.sources.cv = { purpose: 'cv', text: 'PRIVATE CV NEVER SENT TO DECISIONS', originalBase64: 'PRIVATE ORIGINAL', archived: false };
  let locked = false, key = configured ? 'sk-synthetic-only-never-a-real-key' : null, queue = Promise.resolve();
  const calls = [], reads = [];
  const assertAvailable = () => { if (locked) throw new CareerError('LOCAL_LOCKED', 'Synthetic lock'); };
  const store = {
    get() { assertAvailable(); return structuredClone(state); },
    update(change) {
      const next = queue.then(async () => { assertAvailable(); const copy = structuredClone(state); await change(copy); assertAvailable(); state = copy; });
      queue = next.catch(() => {}); return next;
    },
  };
  const credentials = { read(provider) {
    reads.push(provider);
    assert.equal(provider, 'openai'); assertAvailable();
    if (!key) throw new CareerError('DECISIONS_KEY_REQUIRED', 'Synthetic key required');
    return { apiKey: key, credentialVersion: state.prescanCredentialVersion };
  } };
  const service = createBrowserForms({ store, credentials, assertAvailable, fetchImpl: (...args) => { calls.push(args); return fetchImpl(...args); } });
  const tools = new Map(createFormTools({ store }).map(tool => [tool.name, tool]));
  const bind = formId => store.update(saved => {
    const draft = saved.career.formDrafts[formId];
    const app = upsertApplication(saved.career, { title: 'Synthetic role', company: 'Synthetic employer', description: 'Use data analysis.', url: draft.url });
    draft.applicationId = app.id;
    draft.applicationContext = applicationContextFingerprint(saved.career, app);
    saved.career.revision++;
  });
  return { store, service, calls, reads, tools, bind, lock() { locked = true; service.cancelAll(); },
    rotateKey() { key = 'sk-synthetic-replacement-not-a-real-key'; state.prescanCredentialVersion++; },
    alter(change) { change(state); }, state: () => structuredClone(state) };
}
function response(body, transform = value => value) {
  return new Response(JSON.stringify(transform({ model: body.model, answers: body.questions.map(question => ({ name: question.name, type: 'choice',
    choice: question.choices[1]?.value ?? 'unknown', confidence: 0.99,
    probabilities: question.choices.map((choice, index) => ({ value: choice.value, probability: index === (question.choices.length > 1 ? 1 : 0) ? 0.99 : index === 0 ? 0.01 : 0 })) })), usage: { input_tokens: 20 } })),
  { status: 200, headers: { 'Content-Type': 'application/json' } });
}
const byCode = code => error => error.code === code;

test('construction is lazy even while vault and credentials are unavailable', () => {
  const forbidden = () => { throw new Error('Must not access'); };
  createBrowserForms({ store: { get: forbidden }, credentials: { read: forbidden }, assertAvailable: forbidden });
  createFormTools({ store: { get: forbidden } });
});

test('direct known contact answers need no key and no approval', async () => {
  const f = fixture();
  const result = await f.service.prepare(snapshot([field('name', 'Full name'), field('email', 'Email address', 'email'), field('phone', 'Telephone', 'tel'), field('unknown', 'Why this company?', 'textarea')]));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(result.fields.map(item => item.value), ['Synthetic Candidate', 'candidate@example.test', '+1 555 0100']);
  assert.equal(result.unresolved[0].id, 'unknown');
  assert.equal(result.usage, undefined);
  assert.ok(!JSON.stringify(result).includes('PRIVATE CV'));
});

test('saved-only preparation skips configured credentials and API mapping while retaining current application prose', async () => {
  const f = fixture({ configured: true });
  const args = snapshot([field('name', 'Full name'), field('motivation', 'Why this role?', 'textarea'), field('french', 'French level')]);
  const first = await f.service.prepare(args);
  await f.bind(first.formId);
  const draft = await f.tools.get('career_form_read').invoke({ formId: first.formId });
  const prose = 'I want to apply my demonstrated data analysis experience to this role.';
  await f.tools.get('career_form_answers_save').invoke({ requestId: randomUUID(), revision: draft.revision,
    formId: draft.formId, snapshot: draft.snapshot, evidenceRevision: draft.evidenceRevision, answers: [{ id: 'motivation', value: prose }] });
  const result = await f.service.prepare({ ...args, requestId: randomUUID(), formId: first.formId });
  assert.deepEqual(result.fields.map(({ id, value }) => ({ id, value })), [
    { id: 'name', value: 'Synthetic Candidate' }, { id: 'motivation', value: prose },
  ]);
  assert.deepEqual(result.unresolved.map(({ id }) => id), ['french']);
  assert.deepEqual(f.reads, [], 'useApi:false never reads even a configured secret');
  assert.deepEqual(f.calls, []);
  assert.equal(result.usage, undefined);
});

for (const change of ['identity', 'evidence', 'credential', 'lock']) test(`saved-only preparation rejects a ${change} change before releasing answers`, async () => {
  const f = fixture(), started = deferred(), release = deferred(), update = f.store.update;
  f.store.update = async callback => { started.resolve(); await release.promise; return update(callback); };
  const pending = f.service.prepare(snapshot([field('name', 'Full name')]));
  await started.promise;
  if (change === 'identity') f.alter(state => { state.deviceId = 'another-synthetic-device'; });
  if (change === 'evidence') f.alter(state => { state.career.evidenceRevision++; });
  if (change === 'credential') f.rotateKey();
  if (change === 'lock') f.lock();
  release.resolve();
  await assert.rejects(pending, byCode(change === 'lock' ? 'LOCAL_LOCKED' : 'FORM_CONTEXT_CHANGED'));
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.reads, []);
  assert.equal(f.state().career.formDrafts, undefined);
});

test('blocked application URLs cannot release prepared contacts or trigger Decisions', async () => {
  const f = fixture({ configured: true });
  const args = { ...snapshot([field('name', 'Full name')]), useApi: true };
  f.alter(state => {
    state.career.matching = { jobs: { blocked: { id: 'blocked', company: 'Flow Traders', applyUrl: args.url } }, scores: {} };
    state.career.blocklist = { employer: { kind: 'company', value: 'flow-traders' } };
  });
  await assert.rejects(f.service.prepare(args), byCode('JOB_BLOCKED'));
  assert.equal(f.calls.length, 0);
  assert.equal(f.state().career.formDrafts, undefined);
});

test('a company blocked during Decisions preparation prevents values being released', async () => {
  const entered = deferred(), finish = deferred();
  const f = fixture({ configured: true, fetchImpl: async (_url, init) => {
    entered.resolve();
    await finish.promise;
    return response(JSON.parse(init.body));
  } });
  const args = { ...snapshot([field('q', 'French level')]), useApi: true };
  f.alter(state => {
    state.career.matching = { jobs: { target: { id: 'target', company: 'Flow Traders', applyUrl: args.url } }, scores: {} };
  });
  const pending = f.service.prepare(args);
  await entered.promise;
  f.alter(state => { state.career.blocklist = { employer: { kind: 'company', value: 'flow-traders' } }; });
  finish.resolve();
  await assert.rejects(pending, byCode('JOB_BLOCKED'));
  assert.equal(f.calls.length, 1);
  assert.equal(Object.values(f.state().career.formDrafts)[0].profileCollection, undefined);
});

test('protected, unsupported and populated fields stay unresolved even with a known value', async () => {
  const fields = [field('gender', 'Gender'), field('consent', 'I agree to terms'), field('ssn', 'Social Security Number'), field('birth', 'Date of birth', 'date'),
    field('email', 'Email', 'email', { empty: false }), field('custom', 'Full name', 'text', { manualOnly: true })];
  const f = fixture(); const result = await f.service.prepare(snapshot(fields));
  assert.equal(result.fields.length, 0);
  assert.equal(result.unresolved.length, fields.length);
});

test('agent reads captured schema and stages long answers with revision receipts without changing evidence', async () => {
  const f = fixture(), args = snapshot([field('email', 'Email', 'email'), field('motivation', 'Why this role?', 'textarea')]);
  const first = await f.service.prepare(args);
  await f.bind(first.formId);
  const read = await f.tools.get('career_form_read').invoke({ formId: first.formId });
  const before = f.state().career;
  const save = { requestId: randomUUID(), revision: read.revision, formId: read.formId, snapshot: read.snapshot, evidenceRevision: read.evidenceRevision,
    answers: [{ id: 'motivation', value: 'I want to apply my demonstrated data analysis experience.' }] };
  const receipt = await f.tools.get('career_form_answers_save').invoke(save);
  assert.deepEqual(await f.tools.get('career_form_answers_save').invoke(save), receipt);
  assert.equal(receipt.revision, read.revision + 1);
  const second = await f.service.prepare({ ...args, requestId: randomUUID(), formId: first.formId });
  assert.equal(second.fields.find(item => item.id === 'motivation').value, save.answers[0].value);
  assert.equal(second.fields.find(item => item.id === 'motivation').source, 'agent');
  assert.deepEqual(f.state().career.profile, before.profile);
  assert.deepEqual(f.state().career.facts, before.facts);
  assert.equal(f.state().career.evidenceRevision, before.evidenceRevision);
});

test('staging rejects stale revision, snapshot, evidence and protected or invented option values', async () => {
  const fields = [field('answer', 'French level', 'select', { options: [{ value: 'professional', label: 'Professional' }, { value: 'none', label: 'None' }] }), field('consent', 'Consent')];
  const f = fixture(), prepared = await f.service.prepare(snapshot(fields));
  const read = await f.tools.get('career_form_read').invoke({ formId: prepared.formId });
  const base = { requestId: randomUUID(), revision: read.revision, formId: read.formId, snapshot: read.snapshot, evidenceRevision: read.evidenceRevision, answers: [{ id: 'answer', value: 'professional' }] };
  await assert.rejects(f.tools.get('career_form_answers_save').invoke({ ...base, snapshot: 'wrong' }), byCode('FORM_CONTEXT_CHANGED'));
  await assert.rejects(f.tools.get('career_form_answers_save').invoke({ ...base, revision: base.revision + 1 }), byCode('REVISION_CONFLICT'));
  await assert.rejects(f.tools.get('career_form_answers_save').invoke({ ...base, answers: [{ id: 'answer', value: 'expert' }] }), byCode('INVALID_INPUT'));
  await assert.rejects(f.tools.get('career_form_answers_save').invoke({ ...base, answers: [{ id: 'consent', value: 'yes' }] }), byCode('INVALID_INPUT'));
  f.alter(state => { state.career.evidenceRevision++; });
  await assert.rejects(f.tools.get('career_form_answers_save').invoke(base), byCode('FORM_CONTEXT_CHANGED'));
});

test('changed evidence drops staged values and re-preparing the exact snapshot requires new agent answers', async () => {
  const f = fixture(), args = snapshot([field('q', 'Why this role?', 'textarea')]);
  const first = await f.service.prepare(args);
  await f.bind(first.formId);
  const read = await f.tools.get('career_form_read').invoke({ formId: first.formId });
  await f.tools.get('career_form_answers_save').invoke({ requestId: randomUUID(), revision: read.revision, formId: read.formId, snapshot: read.snapshot,
    evidenceRevision: read.evidenceRevision, answers: [{ id: 'q', value: 'Original agent answer' }] });
  f.alter(state => { state.career.profile.headline = 'New direction'; state.career.evidenceRevision++; });
  const result = await f.service.prepare({ ...args, requestId: randomUUID() });
  assert.equal(result.fields.length, 0);
  assert.equal(result.unresolved.length, 1);
  assert.deepEqual(f.state().career.formDrafts[result.formId].answers, {});
});

test('navigation and control-signature changes cannot reuse a supplied formId', async () => {
  const f = fixture(), args = snapshot([field('email', 'Email', 'email')]), first = await f.service.prepare(args);
  await assert.rejects(f.service.prepare({ ...args, requestId: randomUUID(), formId: first.formId, url: `${args.url}/other` }), byCode('FORM_CONTEXT_CHANGED'));
  await assert.rejects(f.service.prepare({ ...args, requestId: randomUUID(), formId: first.formId, fields: [field('email', 'Email', 'email', { signature: 'changed' })] }), byCode('FORM_CONTEXT_CHANGED'));
});

test('explicit API mode dispatches bounded requests without exposing the key or CV', async () => {
  const f = fixture({ configured: true, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/decisions');
    assert.equal(init.redirect, 'error');
    assert.ok(Buffer.byteLength(init.body) <= 240000);
    const body = JSON.parse(init.body);
    assert.ok(body.questions.length <= 7);
    assert.ok(body.questions.every(question => question.choices[0].value === 'unknown'));
    assert.ok(!init.body.includes('PRIVATE CV'));
    return response(body);
  } });
  const result = await f.service.prepare({ ...snapshot(Array.from({ length: 9 }, (_, index) => field(`q${index}`, `Known answer ${index}`))), useApi: true });
  assert.equal(f.calls.length, 2);
  assert.equal(result.usage.requests, 2);
  assert.equal(result.usage.inputTokens, 40);
  assert.equal(result.usage.inputUsdPerMillion, 0.1);
  assert.ok(!JSON.stringify(result).includes('sk-synthetic'));
  assert.ok(!JSON.stringify(f.state().career).includes('sk-synthetic'));
});

for (const [name, transform] of [
  ['missing probability coverage', data => { data.answers[0].probabilities.pop(); return data; }],
  ['probability sum', data => { data.answers[0].probabilities[0].probability = 0.8; return data; }],
  ['invented choice', data => { data.answers[0].choice = 'invented-answer'; return data; }],
  ['duplicate answer', data => { data.answers[1].name = data.answers[0].name; return data; }],
  ['wrong model', data => ({ ...data, model: 'writing-model' })],
  ['invalid usage', data => ({ ...data, usage: { input_tokens: -1 } })],
]) test(`API rejects ${name} without retry or fabricated output`, async () => {
  const f = fixture({ configured: true, fetchImpl: async (_url, init) => response(JSON.parse(init.body), transform) });
  await assert.rejects(f.service.prepare({ ...snapshot([field('q', 'French level'), field('q2', 'Known skill')]), useApi: true }), byCode('FORM_INVALID_RESPONSE'));
  assert.equal(f.calls.length, 1);
});

for (const refusal of [true, false]) test(`API ${refusal ? 'refusal' : 'uncertainty'} remains unresolved`, async () => {
  const f = fixture({ configured: true, fetchImpl: async (_url, init) => response(JSON.parse(init.body), data => {
    if (refusal) data.answers = data.answers.map(answer => ({ name: answer.name, type: 'refusal' }));
    else data.answers.forEach(answer => { answer.confidence = 0.4; });
    return data;
  }) });
  const result = await f.service.prepare({ ...snapshot([field('q', 'French level')]), useApi: true });
  assert.equal(result.fields.length, 0);
  assert.equal(result.unresolved.length, 1);
});

for (const change of ['cancel', 'profile', 'key', 'lock']) test(`${change} during fetch discards stale API results and stops later chunks`, async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ configured: true, fetchImpl: async (_url, init) => { entered.resolve(init); await gate.promise; return response(JSON.parse(init.body)); } });
  const args = { ...snapshot(Array.from({ length: 8 }, (_, index) => field(`q${index}`, `Known answer ${index}`))), useApi: true };
  const pending = f.service.prepare(args);
  await entered.promise;
  if (change === 'cancel') f.service.cancel(args.requestId);
  if (change === 'profile') f.alter(state => { state.career.evidenceRevision++; });
  if (change === 'key') f.rotateKey();
  if (change === 'lock') f.lock();
  gate.resolve();
  await assert.rejects(pending);
  assert.equal(f.calls.length, 1);
});

test('native validation rejects extra private values, credential URLs, duplicate fields and oversized snapshots', async () => {
  const f = fixture();
  for (const args of [
    { ...snapshot([field('email', 'Email', 'email', { value: 'PRIVATE ENTERED VALUE' })]) },
    { ...snapshot([]), url: 'https://user:password@synthetic.example/apply' },
    snapshot([field('same', 'Email'), field('same', 'Phone')]),
    snapshot(Array.from({ length: 65 }, (_, index) => field(`${index}`, 'Label'))),
    { ...snapshot([]), apiKey: 'sk-private' },
  ]) await assert.rejects(f.service.prepare(args), byCode('INVALID_INPUT'));
});

test('known contact choices use only actual option values while unknown eligibility has no default', async () => {
  const f = fixture();
  const result = await f.service.prepare(snapshot([
    field('city', 'Current location', 'select', { options: [{ value: '', label: 'Choose' }, { value: 'toronto-code', label: 'Toronto' }] }),
    field('eligibility', 'Are you authorized to work here?', 'radio', { required: true, options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] }),
  ]));
  assert.deepEqual(result.fields.map(({ id, value }) => ({ id, value })), [{ id: 'city', value: 'toronto-code' }]);
  assert.equal(result.unresolved[0].id, 'eligibility');
});

test('API mapping can only release an actual closed-set option, not factual prose', async () => {
  const f = fixture({ configured: true, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body), bank = JSON.parse(body.input[1].content).knownAnswers;
    assert.ok(bank.some(item => item.label === 'French' && item.value === 'Professional'));
    assert.ok(!JSON.stringify(bank).includes('PRIVATE CV'));
    return response(body);
  } });
  const result = await f.service.prepare({ ...snapshot([field('french', 'French proficiency', 'select', {
    options: [{ value: 'professional-code', label: 'Professional' }, { value: 'none-code', label: 'None' }],
  })]), useApi: true });
  assert.equal(result.fields[0].value, 'professional-code');
  assert.equal(result.fields[0].confidence, 0.99);
});

test('API explicit unknown stays unresolved even when high confidence', async () => {
  const f = fixture({ configured: true, fetchImpl: async (_url, init) => response(JSON.parse(init.body), data => {
    for (const answer of data.answers) {
      answer.choice = 'unknown';
      answer.probabilities.forEach(item => { item.probability = item.value === 'unknown' ? 1 : 0; });
    }
    return data;
  }) });
  const result = await f.service.prepare({ ...snapshot([field('q', 'Unknown screening answer')]), useApi: true });
  assert.equal(result.fields.length, 0);
  assert.equal(result.unresolved.length, 1);
});

test('API refuses oversized response streams and never retries provider errors', async () => {
  for (const fetchImpl of [
    async () => new Response('x', { headers: { 'Content-Length': `${2 * 1024 * 1024}` } }),
    async () => new Response('not JSON'),
    async () => new Response('PRIVATE PROVIDER FAILURE', { status: 500 }),
  ]) {
    const f = fixture({ configured: true, fetchImpl });
    await assert.rejects(f.service.prepare({ ...snapshot([field('q', 'French level')]), useApi: true }), error => {
      assert.ok(!error.message.includes('PRIVATE PROVIDER'));
      return ['FORM_INVALID_RESPONSE', 'FORM_PROVIDER_ERROR'].includes(error.code);
    });
    assert.equal(f.calls.length, 1);
  }
});

test('blank select placeholders preserve the snapshot and do not block unrelated valid contact values', async () => {
  const f = fixture();
  const args = snapshot([
    field('city', 'Current location', 'select', { options: [{ value: '', label: '' }, { value: 'toronto-code', label: 'Toronto' }] }),
    field('question', 'French level', 'select', { options: [{ value: '', label: '' }, { value: 'professional', label: 'Professional' }] }),
    field('email', 'Email', 'email'),
  ]);
  const result = await f.service.prepare(args);
  assert.deepEqual(result.fields.map(({ id, value }) => ({ id, value })), [
    { id: 'city', value: 'toronto-code' }, { id: 'email', value: 'candidate@example.test' },
  ]);
  const read = await f.tools.get('career_form_read').invoke({ formId: result.formId });
  assert.deepEqual(read.fields[0].options[0], { value: '', label: '' });
  await assert.rejects(f.tools.get('career_form_answers_save').invoke({
    requestId: randomUUID(), revision: read.revision, formId: read.formId, snapshot: read.snapshot,
    evidenceRevision: read.evidenceRevision, answers: [{ id: 'question', value: '' }],
  }), byCode('INVALID_INPUT'));
});

test('autocomplete cannot turn reference or manager contacts into applicant contact values, even in API mode', async () => {
  const f = fixture();
  const args = { ...snapshot([
    field('reference', 'Reference email', 'email', { autocomplete: 'email' }),
    field('manager', 'Your manager phone number', 'tel', { autocomplete: 'tel' }),
    field('emergency', 'Emergency contact name', 'text', { autocomplete: 'name' }),
    field('applicant', 'Your email address', 'email', { autocomplete: 'email' }),
  ]), useApi: true };
  const result = await f.service.prepare(args);
  assert.deepEqual(result.fields.map(({ id, value }) => ({ id, value })), [{ id: 'applicant', value: 'candidate@example.test' }]);
  assert.deepEqual(result.unresolved.map(({ id }) => id), ['reference', 'manager', 'emergency']);
  assert.equal(f.calls.length, 0);
  const read = await f.tools.get('career_form_read').invoke({ formId: result.formId });
  await f.tools.get('career_form_answers_save').invoke({
    requestId: randomUUID(), revision: read.revision, formId: read.formId, snapshot: read.snapshot,
    evidenceRevision: read.evidenceRevision, answers: [{ id: 'reference', value: 'explicit-reference@example.test' }],
  });
  const reloaded = await f.service.prepare({ ...args, requestId: randomUUID() });
  assert.equal(reloaded.fields.find(item => item.id === 'reference').value, 'explicit-reference@example.test');
  assert.equal(reloaded.fields.find(item => item.id === 'reference').source, 'agent');
});

test('fact bank retains original qualifiers and excludes unbound application-specific facts', async () => {
  const f = fixture({ configured: true, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body), bank = JSON.parse(body.input[1].content).knownAnswers;
    const relocation = bank.find(item => item.source === 'fact:relocation');
    assert.equal(relocation.value, 'Yes');
    assert.deepEqual(relocation.qualifiers, {
      question: 'Would you relocate to Toronto?', context: 'Toronto only', detail: 'Only within Ontario',
      followUps: [{ answer: 'Not outside Ontario' }],
    });
    assert.ok(!bank.some(item => item.source === 'fact:application-answer'));
    assert.ok(!init.body.includes('APPLICATION-SCOPED PRIVATE ANSWER'));
    assert.ok(body.input[0].content.includes('Preserve every fact qualifier'));
    return response(body, data => {
      for (const answer of data.answers) {
        answer.choice = 'unknown';
        answer.probabilities.forEach(item => { item.probability = item.value === 'unknown' ? 1 : 0; });
      }
      return data;
    });
  } });
  f.alter(state => {
    state.career.facts.relocation = { id: 'relocation', subject: 'Relocation', answer: 'Yes',
      question: 'Would you relocate to Toronto?', context: 'Toronto only', detail: 'Only within Ontario',
      followUps: [{ answer: 'Not outside Ontario' }] };
    state.career.facts.application = { id: 'application-answer', subject: 'Availability', answer: 'APPLICATION-SCOPED PRIVATE ANSWER', applicationId: 'another-application' };
  });
  const result = await f.service.prepare({ ...snapshot([field('relocation', 'Willing to relocate anywhere?', 'select', {
    options: [{ value: '', label: '' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
  })]), useApi: true });
  assert.equal(result.fields.length, 0);
  assert.equal(result.unresolved.length, 1);
});

test('preferred contact method is available for explicit staging while Contact me consent remains protected', async () => {
  const f = fixture();
  const args = snapshot([
    field('method', 'Preferred contact method', 'radio', { options: [{ value: 'email', label: 'Email' }, { value: 'phone', label: 'Phone' }] }),
    field('contact-permission', 'Contact me about other opportunities', 'radio', { options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] }),
  ]);
  const prepared = await f.service.prepare(args);
  const read = await f.tools.get('career_form_read').invoke({ formId: prepared.formId });
  const save = { requestId: randomUUID(), revision: read.revision, formId: read.formId, snapshot: read.snapshot,
    evidenceRevision: read.evidenceRevision, answers: [{ id: 'method', value: 'email' }] };
  const saved = await f.tools.get('career_form_answers_save').invoke(save);
  await assert.rejects(f.tools.get('career_form_answers_save').invoke({
    ...save, requestId: randomUUID(), revision: saved.revision, answers: [{ id: 'contact-permission', value: 'yes' }],
  }), byCode('INVALID_INPUT'));
  const result = await f.service.prepare({ ...args, requestId: randomUUID() });
  assert.deepEqual(result.fields.map(({ id, value }) => ({ id, value })), [{ id: 'method', value: 'email' }]);
  assert.equal(result.unresolved.find(item => item.id === 'contact-permission').reason, 'Protected or unsupported field; complete manually.');
});

test('form tools expose read and staging without a browser mutation capability', async () => {
  const f = fixture();
  const calls = [];
  const browser = {
    status: formId => calls.push(['status', formId]) && true,
    fill: () => assert.fail('Form tools must not write browser controls'),
    submit: () => assert.fail('Form tools must not activate browser controls'),
  };
  const tools = new Map(createFormTools({ store: f.store, browser }).map(tool => [tool.name, tool]));
  assert.deepEqual([...tools.keys()], ['career_form_read', 'career_form_answers_save']);
  const args = { ...snapshot([field('name', 'Full name'), field('why', 'Why do you want this role?', 'textarea')]),
    actions: [{ id: 'action-4', label: 'Submit application', kind: 'submit', signature: 'signature:action-4' }, { id: 'action-7', label: 'Next', kind: 'next', signature: 'signature:action-7' }] };
  const prepared = await f.service.prepare(args);
  await f.bind(prepared.formId);
  const read = await tools.get('career_form_read').invoke({ formId: prepared.formId });
  assert.deepEqual(read.actions.map(({ id, kind }) => ({ id, kind })), [{ id: 'action-4', kind: 'submit' }, { id: 'action-7', kind: 'next' }]);
  assert.deepEqual(read.browser, { attached: true });
  await tools.get('career_form_answers_save').invoke({ requestId: randomUUID(), revision: read.revision, formId: read.formId, snapshot: read.snapshot, evidenceRevision: read.evidenceRevision, answers: [{ id: 'why', value: 'Because the role matches my saved experience.' }] });
  assert.equal((await tools.get('career_form_read').invoke({ formId: read.formId })).answers.why.value, 'Because the role matches my saved experience.');
  assert.deepEqual(calls, [['status', read.formId], ['status', read.formId]]);
  // Without Chrome attached, inspection still returns the saved form truthfully.
  const detached = new Map(createFormTools({ store: f.store }).map(tool => [tool.name, tool]));
  assert.deepEqual((await detached.get('career_form_read').invoke({ formId: read.formId })).browser.attached, false);
  // Inspected actions remain validated read-only context.
  await assert.rejects(f.service.prepare({ ...snapshot([field('name', 'Full name')]), actions: [{ id: 'a', label: 'Submit', kind: 'delete', signature: 's' }] }), byCode('INVALID_INPUT'));
});

const submitAction = { id: 'send', label: 'Send application', kind: 'submit', signature: 'signature:send' };
const actionTools = (store, browser) => new Map(createFormTools({ store, browser }).map(tool => [tool.name, tool]));
const prepareActionForm = f => f.service.prepare({ ...snapshot([field('email', 'Email', 'email'), field('answer', 'Why this role?', 'textarea')]), actions: [submitAction] });

const blockFormJob = (state, formId, kind = 'company') => {
  const job = state.career.applications[state.career.formDrafts[formId].applicationId].job;
  if (kind === 'job') job.id ??= 'synthetic-blocked-job';
  state.career.blocklist = { synthetic: { kind, value: kind === 'job' ? job.id : job.company, label: 'Synthetic block' } };
};

for (const bound of [false, true]) for (const kind of ['company', 'job']) test(`${kind} blocks prevent ${bound ? 'bound' : 'URL-matched'} form reads and answer staging`, async () => {
  const f = fixture(), prepared = await prepareActionForm(f);
  await f.bind(prepared.formId);
  const read = await f.tools.get('career_form_read').invoke({ formId: prepared.formId });
  f.alter(state => {
    blockFormJob(state, prepared.formId, kind);
    if (!bound) { delete state.career.formDrafts[prepared.formId].applicationId; delete state.career.formDrafts[prepared.formId].applicationContext; }
  });
  const before = f.state();
  const tools = actionTools(f.store, { status: () => assert.fail('Blocked form must not reach Chrome') });
  for (const [name, args] of [
    ['career_form_read', { formId: prepared.formId }],
    ['career_form_answers_save', { requestId: randomUUID(), revision: read.revision, formId: read.formId, snapshot: read.snapshot, evidenceRevision: read.evidenceRevision,
      answers: [{ id: 'answer', value: 'Synthetic answer must stay unwritten.' }] }],
  ]) await assert.rejects(tools.get(name).invoke(args), byCode('JOB_BLOCKED'));
  assert.deepEqual(f.state(), before);
});

test('a new block while awaiting attachment prevents form result release', async () => {
  const f = fixture(), prepared = await prepareActionForm(f), entered = deferred(), gate = deferred();
  await f.bind(prepared.formId);
  const browser = { async status() { entered.resolve(); await gate.promise; return true; } };
  const pending = actionTools(f.store, browser).get('career_form_read').invoke({ formId: prepared.formId });
  await entered.promise;
  f.alter(state => blockFormJob(state, prepared.formId));
  gate.resolve();
  await assert.rejects(pending, byCode('JOB_BLOCKED'));
});

test('a newly blocked job cannot replay saved answer receipts', async () => {
  const f = fixture(), prepared = await prepareActionForm(f);
  await f.bind(prepared.formId);
  const read = await f.tools.get('career_form_read').invoke({ formId: prepared.formId });
  const save = { requestId: randomUUID(), revision: read.revision, formId: read.formId, snapshot: read.snapshot, evidenceRevision: read.evidenceRevision,
    answers: [{ id: 'answer', value: 'Known synthetic experience.' }] };
  await f.tools.get('career_form_answers_save').invoke(save);
  f.alter(state => blockFormJob(state, prepared.formId));
  const before = f.state();
  await assert.rejects(f.tools.get('career_form_answers_save').invoke(save), byCode('JOB_BLOCKED'));
  assert.deepEqual(f.state(), before);
});

test('queued answer receipt replay rechecks a block committed while waiting for storage', async () => {
  const f = fixture(), prepared = await prepareActionForm(f);
  await f.bind(prepared.formId);
  const read = await f.tools.get('career_form_read').invoke({ formId: prepared.formId });
  const save = { requestId: randomUUID(), revision: read.revision, formId: read.formId, snapshot: read.snapshot, evidenceRevision: read.evidenceRevision,
    answers: [{ id: 'answer', value: 'Known synthetic experience.' }] };
  await f.tools.get('career_form_answers_save').invoke(save);
  const entered = deferred(), gate = deferred();
  const block = f.store.update(async state => { entered.resolve(); await gate.promise; blockFormJob(state, prepared.formId); });
  await entered.promise;
  const replay = f.tools.get('career_form_answers_save').invoke(save);
  gate.resolve();
  await block;
  await assert.rejects(replay, byCode('JOB_BLOCKED'));
});

for (const change of ['evidence', 'answers', 'action', 'identity', 'pairing', 'session', 'lock']) {
  test(`${change} during attachment check prevents form result release`, async () => {
    const f = fixture(), prepared = await prepareActionForm(f), entered = deferred(), gate = deferred();
    let epoch = 0;
    const scoped = createScopedAccess(f.store, { assertAvailable: () => f.store.get(), epoch: () => epoch });
    const browser = { async status() {
      entered.resolve(); await gate.promise;
      return true;
    } };
    const pending = actionTools(scoped.store, browser).get('career_form_read').invoke({ formId: prepared.formId });
    await entered.promise;
    if (change === 'evidence') f.alter(state => { state.career.profile.name = 'Changed while checking attachment'; state.career.evidenceRevision++; });
    if (change === 'answers') f.alter(state => { state.career.formDrafts[prepared.formId].answers.answer = { value: 'Changed answer', source: 'agent' }; });
    if (change === 'action') f.alter(state => { state.career.formDrafts[prepared.formId].actions[0].signature = 'changed-signature'; });
    if (change === 'identity') f.alter(state => { state.deviceId = 'different-device'; });
    if (change === 'pairing') f.alter(state => { state.pairing = { origin: 'https://synthetic.example', account: { id: 'different-account' } }; });
    if (change === 'session') epoch++;
    if (change === 'lock') f.lock();
    gate.resolve(true);
    const code = change === 'lock' ? 'LOCAL_LOCKED' : ['identity', 'pairing', 'session'].includes(change) ? 'IDENTITY_CHANGED' : 'FORM_CONTEXT_CHANGED';
    await assert.rejects(pending, byCode(code));
  });
}

test('form reads await live Chrome status rather than treating its pending promise as attached', async () => {
  const f = fixture(), prepared = await prepareActionForm(f), entered = deferred(), gate = deferred();
  let settled = false;
  const tools = actionTools(f.store, { async status(formId) {
    assert.equal(formId, prepared.formId); entered.resolve(); return gate.promise;
  } });
  const pending = tools.get('career_form_read').invoke({ formId: prepared.formId }).then(result => { settled = true; return result; });
  await entered.promise;
  assert.equal(settled, false);
  gate.resolve(false);
  assert.equal((await pending).browser.attached, false);
});

test('form reads discard stale career evidence while awaiting Chrome status', async () => {
  const f = fixture(), prepared = await prepareActionForm(f), entered = deferred(), gate = deferred();
  const tools = actionTools(f.store, { async status() { entered.resolve(); return gate.promise; } });
  const pending = tools.get('career_form_read').invoke({ formId: prepared.formId });
  await entered.promise;
  f.alter(state => { state.career.evidenceRevision++; });
  gate.resolve(true);
  await assert.rejects(pending, byCode('FORM_CONTEXT_CHANGED'));
});

test('explicit missing basics save once and reuse across differently labelled forms without splitting names', async () => {
  const f = fixture();
  const first = await f.service.prepare({ ...snapshot([
    field('given', 'First name', 'text', { autocomplete: 'given-name', required: true }),
    field('family', 'Last name', 'text', { autocomplete: 'family-name' }), field('preferred', 'Preferred name'),
    field('street', 'Address line 1'), field('town', 'Town'), field('post', 'Postcode'),
    field('country', 'Country', 'select', { options: [{ value: '', label: 'Choose' }, { value: 'CA', label: 'Canada' }] }),
  ]), useApi: true });
  assert.deepEqual(first.api, { configured: false, used: false });
  assert.equal(first.fields.length, 0);
  assert.deepEqual(first.questions.map(question => question.key), ['firstName', 'lastName', 'preferredName', 'addressLine1', 'city', 'postalCode', 'country']);
  assert.equal(first.questions[0].label, 'First name');
  assert.equal(first.questions[0].required, true);
  assert.deepEqual(first.questions.at(-1).options, [{ value: 'Canada', label: 'Canada' }]);
  const values = { firstName: 'Alex', lastName: 'River', preferredName: 'Al', addressLine1: '10 Example Road', city: 'Toronto', postalCode: 'M5V 1A1', country: 'Canada' };
  const input = { requestId: randomUUID(), formId: first.formId, snapshot: first.snapshot, values };
  const before = f.state().career, saved = await f.service.saveDetails(input);
  assert.ok(Object.keys(values).every(key => saved.saved.includes(key)));
  assert.deepEqual(await f.service.saveDetails(input), saved);
  assert.equal(f.state().career.evidenceRevision, before.evidenceRevision + 1);
  assert.equal(f.state().career.profile.name, 'Alex River');
  assert.equal(f.state().career.profile.email, before.profile.email);
  assert.deepEqual(f.state().career.facts, before.facts);
  const second = await f.service.prepare({ ...snapshot([
    field('first', 'Given name'), field('last', 'Surname'), field('nick', 'Name you go by'),
    field('address', 'Street address'), field('city', 'City'), field('zip', 'ZIP code'),
    field('residence', 'Country of residence', 'select', { options: [{ value: 'canada-other-code', label: 'Canada' }] }),
  ]), url: 'https://second.synthetic.example/careers/apply' });
  assert.deepEqual(second.fields.map(item => item.value), ['Alex', 'River', 'Al', '10 Example Road', 'Toronto', 'M5V 1A1', 'canada-other-code']);
  assert.deepEqual(second.questions, []);
});

test('partial explicit details preserve unrelated fields and full name ambiguity', async () => {
  const f = fixture();
  const prepared = await f.service.prepare(snapshot([field('given', 'First name'), field('family', 'Last name'), field('phone', 'Phone number')]));
  const before = f.state().career.profile;
  await f.service.saveDetails({ requestId: randomUUID(), formId: prepared.formId, snapshot: prepared.snapshot, values: { firstName: 'Alex' } });
  const profile = f.state().career.profile;
  assert.equal(profile.firstName, 'Alex');
  assert.equal(profile.lastName, null);
  assert.equal(profile.name, before.name);
  assert.equal(profile.phone, before.phone);
  const next = await f.service.prepare(snapshot([field('first', 'First name'), field('last', 'Last name')]));
  assert.deepEqual(next.questions.map(question => question.key), ['lastName']);
  assert.equal(next.fields[0].value, 'Alex');
});

test('missing credentials still release known values and questions without inference', async () => {
  const f = fixture();
  const result = await f.service.prepare({ ...snapshot([field('email', 'Email'), field('first', 'First name'), field('q', 'French level')]), useApi: true });
  assert.equal(result.fields[0].value, 'candidate@example.test');
  assert.deepEqual(result.questions.map(question => question.key), ['firstName']);
  assert.deepEqual(result.api, { configured: false, used: false });
  assert.equal(f.calls.length, 0);
});

test('profile saving rejects unrequested, already known, protected and malformed values atomically', async () => {
  const f = fixture(), prepared = await f.service.prepare(snapshot([
    field('first', 'First name'), field('gender', 'Gender'), field('birth', 'Date of birth'), field('email', 'Email'),
    field('sponsor', 'Will you need sponsorship in the United States?'), field('consent', 'Consent'),
  ]));
  assert.deepEqual(prepared.questions.map(question => question.key), ['firstName']);
  const before = f.state();
  for (const values of [{ gender: 'Other' }, { name: 'Changed' }, { email: 'new@example.test' }, { firstName: '' },
    { firstName: null }, { firstName: 'Alex', postalCode: '12345' }, { requiresSponsorship: 'Yes' }, { firstName: 'x'.repeat(151) }]) {
    await assert.rejects(f.service.saveDetails({ requestId: randomUUID(), formId: prepared.formId, snapshot: prepared.snapshot, values }), byCode('INVALID_INPUT'));
    assert.deepEqual(f.state(), before);
  }
});

for (const change of ['profile', 'revision', 'identity', 'answers', 'snapshot', 'reprepare']) test(`profile saving rejects stale ${change} binding`, async () => {
  const f = fixture(), args = snapshot([field('first', 'First name')]), prepared = await f.service.prepare(args);
  const input = { requestId: randomUUID(), formId: prepared.formId, snapshot: prepared.snapshot, values: { firstName: 'Alex' } };
  if (change === 'profile') f.alter(state => { state.career.profile.email = 'changed@example.test'; });
  if (change === 'revision') f.alter(state => { state.career.evidenceRevision++; });
  if (change === 'identity') f.alter(state => { state.deviceId = 'another-device'; });
  if (change === 'answers') f.alter(state => { state.career.formDrafts[prepared.formId].answers.first = { value: 'Other' }; });
  if (change === 'snapshot') input.snapshot = '0'.repeat(64);
  if (change === 'reprepare') await f.service.prepare({ ...args, requestId: randomUUID() });
  await assert.rejects(f.service.saveDetails(input), byCode('FORM_CONTEXT_CHANGED'));
  assert.equal(f.state().career.profile.firstName, null);
});

test('profile receipt survives service recreation and refuses changed-content replay', async () => {
  const f = fixture(), prepared = await f.service.prepare(snapshot([field('first', 'First name')]));
  const input = { requestId: randomUUID(), formId: prepared.formId, snapshot: prepared.snapshot, values: { firstName: 'Alex' } };
  const result = await f.service.saveDetails(input), state = f.state();
  const restarted = createBrowserForms({ store: f.store, assertAvailable() {}, credentials: {} });
  assert.deepEqual(await restarted.saveDetails(input), result);
  assert.deepEqual(f.state(), state);
  await assert.rejects(restarted.saveDetails({ ...input, values: { firstName: 'Different' } }), byCode('REQUEST_CONFLICT'));
  await assert.rejects(restarted.saveDetails({ ...input, requestId: randomUUID() }), byCode('FORM_CONTEXT_CHANGED'));
});

test('API leaves ambiguous name parts explicit and unsupported controls manual', async () => {
  const f = fixture({ configured: true, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(body.questions.every(question => !question.choices.some(choice => choice.description.includes('"value":"Synthetic Candidate"'))));
    return chosenResponse(body, () => 'unknown');
  } });
  const result = await f.service.prepare({ ...snapshot([
    field('first', 'First name'), field('last', 'Last name'), field('nick', 'Preferred name'),
    field('country', 'Country', 'text', { manualOnly: true }), field('protected', 'Nationality'),
  ]), useApi: true });
  assert.equal(f.calls.length, 1);
  assert.equal(result.fields.length, 0);
  assert.deepEqual(result.questions.map(question => question.key), ['firstName', 'lastName', 'preferredName', 'country']);
  assert.deepEqual(result.api, { configured: true, used: true });
});

test('credential failures other than missing configuration are not suppressed', async () => {
  const f = fixture();
  const service = createBrowserForms({ store: f.store, assertAvailable() {},
    credentials: { read() { throw new CareerError('CREDENTIAL_CORRUPT', 'Cannot read credential'); } } });
  await assert.rejects(service.prepare({ ...snapshot([field('first', 'First name')]), useApi: true }), byCode('CREDENTIAL_CORRUPT'));
});

test('personal summary is application writing, never a reusable profile question or API mapping', async () => {
  const f = fixture({ configured: true });
  f.alter(state => { state.career.profile.personalSummary = 'Legacy generic summary must not leak.'; });
  const prepared = await f.service.prepare({ ...snapshot([
    field('summary', 'Personal Summary This section is optional. Use it to tell us a little more about yourself.', 'textarea'),
    field('motivation', 'Why do you want to work for this company?', 'textarea'),
  ]), useApi: true });
  assert.deepEqual(prepared.questions, []);
  assert.deepEqual(prepared.fields, []);
  assert.equal(f.calls.length, 0);
  assert.ok(!JSON.stringify(prepared).includes('Legacy generic summary'));
  await assert.rejects(f.service.saveDetails({ requestId: randomUUID(), formId: prepared.formId, snapshot: prepared.snapshot,
    values: { personalSummary: 'I build accessible software.' } }), byCode('INVALID_INPUT'));
});

test('profile saving checks identity inside the atomic transaction, not only before a queued mutation', async () => {
  const f = fixture(), prepared = await f.service.prepare(snapshot([field('first', 'First name')]));
  const gate = deferred(), entered = deferred();
  const change = f.store.update(async state => { entered.resolve(); await gate.promise; state.deviceId = 'new-identity'; });
  await entered.promise;
  const pending = f.service.saveDetails({ requestId: randomUUID(), formId: prepared.formId, snapshot: prepared.snapshot, values: { firstName: 'Alex' } });
  gate.resolve();
  await change;
  await assert.rejects(pending, byCode('FORM_CONTEXT_CHANGED'));
  assert.equal(f.state().career.profile.firstName, null);
});

for (const requiresSponsorship of [true, false]) test(`general sponsorship explicitly saves ${requiresSponsorship} and reuses the same MCP preference`, async () => {
  const f = fixture();
  f.alter(state => { state.career.profile.preferences.willingToRelocate = false; });
  const prepared = await f.service.prepare(snapshot([
    field('sponsor', 'Do you now or in the future require visa sponsorship?', 'radio',
      { required: true, options: [{ value: 'yes-code', label: 'Yes' }, { value: 'no-code', label: 'No' }] }),
    field('us', 'Will you require visa sponsorship in the United States?', 'radio',
      { options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] }),
  ]));
  assert.deepEqual(prepared.questions, [{ key: 'requiresSponsorship', label: 'Do you now or in the future require visa sponsorship?',
    type: 'boolean', required: true, options: [{ value: true, label: 'Yes' }, { value: false, label: 'No' }] }]);
  assert.equal(prepared.fields.length, 0);
  const input = { requestId: randomUUID(), formId: prepared.formId, snapshot: prepared.snapshot, values: { requiresSponsorship } };
  for (const invalid of ['Yes', 'No', null, 0]) await assert.rejects(f.service.saveDetails({ ...input, values: { requiresSponsorship: invalid } }), byCode('INVALID_INPUT'));
  const saved = await f.service.saveDetails(input);
  assert.deepEqual(saved, { saved: ['requiresSponsorship'] });
  assert.deepEqual(await f.service.saveDetails(input), saved);
  const profileTools = new Map(createProfileTools({ store: f.store }).map(tool => [tool.name, tool]));
  const read = await profileTools.get('career_profile_read').invoke();
  assert.equal(read.preferences.requiresSponsorship, requiresSponsorship);
  assert.equal(read.preferences.willingToRelocate, false);
  const next = await f.service.prepare({ ...snapshot([
    field('general', 'Requires employer sponsorship', 'select', { options: [{ value: 'y', label: 'Yes' }, { value: 'n', label: 'No' }] }),
    field('specific', 'Do you require visa sponsorship from Acme?', 'select', { options: [{ value: 'y', label: 'Yes' }, { value: 'n', label: 'No' }] }),
  ]), useApi: true });
  assert.deepEqual(next.fields.map(({ id, value, source }) => ({ id, value, source })), [
    { id: 'general', value: requiresSponsorship ? 'y' : 'n', source: 'profile.preferences.requiresSponsorship' },
  ]);
  assert.deepEqual(next.questions, []);
  assert.deepEqual(next.unresolved.map(item => item.id), ['specific']);
  assert.equal(f.calls.length, 0);
});

test('jurisdiction-specific sponsorship alone cannot save a global preference', async () => {
  const f = fixture(), prepared = await f.service.prepare(snapshot([
    field('specific', 'Do you require sponsorship to work in Canada?', 'select', { options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] }),
  ]));
  assert.deepEqual(prepared.questions, []);
  await assert.rejects(f.service.saveDetails({ requestId: randomUUID(), formId: prepared.formId, snapshot: prepared.snapshot,
    values: { requiresSponsorship: false } }), byCode('INVALID_INPUT'));
  assert.equal(f.state().career.profile.preferences.requiresSponsorship, undefined);
});

function chosenResponse(body, choose) {
  return response(body, data => {
    data.answers.forEach((answer, index) => {
      answer.choice = choose(body.questions[index], body);
      answer.confidence = 0.99;
      answer.probabilities.forEach(item => { item.probability = item.value === answer.choice ? 1 : 0; });
    });
    return data;
  });
}
function chooseExact(question, value) {
  return question.choices.find(choice => choice.value !== 'unknown' && JSON.parse(choice.description).value === value)?.value ?? 'unknown';
}
const syntheticCv = `Alex River
Software engineer
alex.river@example.test | +1 (416) 555-0199
https://www.linkedin.com/in/alex-river
https://github.com/alex-river

Experience
Example Systems, Senior Engineer, 2020–2025
Built internal reporting tools and led a small engineering team.
Education
Example University, Computer Science
References
Morgan Employer, manager
morgan.employer@example.test | +1 (212) 555-0148`;
function cvFixture(options = {}, text = syntheticCv) {
  const f = fixture({ configured: true, ...options });
  f.alter(state => {
    Object.assign(state.career.profile, { name: null, email: null, phone: null, location: null });
    state.career.sources.cv.text = text;
  });
  return f;
}

test('current CV reaches Decisions before missing questions and yields exact applicant contact excerpts', async () => {
  const selections = ['Alex', 'River', 'alex.river@example.test', '+1 (416) 555-0199', 'https://www.linkedin.com/in/alex-river'];
  const f = cvFixture({ fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body), bank = JSON.parse(body.input[1].content).knownAnswers;
    assert.ok(bank.length <= 64);
    const excerpts = bank.filter(item => item.source === 'cv:cv');
    assert.ok(excerpts.length > 0 && excerpts.length <= 40);
    for (const item of excerpts) {
      assert.equal(syntheticCv.slice(item.qualifiers.start, item.qualifiers.end), item.value);
      assert.ok(syntheticCv.includes(item.qualifiers.context));
    }
    assert.ok(!excerpts.some(item => item.value === 'morgan.employer@example.test'));
    assert.ok(!excerpts.some(item => item.value === '+1 (212) 555-0148'));
    assert.ok(!init.body.includes('PRIVATE ORIGINAL'));
    assert.equal(body.questions.length, 5);
    return chosenResponse(body, question => chooseExact(question, selections[Number(question.name.slice(6))]));
  } });
  const before = f.state().career.profile;
  const result = await f.service.prepare({ ...snapshot([
    field('first', 'First name'), field('last', 'Last name'), field('email', 'Email', 'email'),
    field('phone', 'Phone', 'tel'), field('linkedin', 'LinkedIn profile', 'url'), field('nickname', 'Preferred name'),
    field('address', 'Address line 1'), field('summary', 'Personal summary'), field('sponsor', 'Requires sponsorship'),
  ]), useApi: true });
  assert.deepEqual(result.fields.map(item => item.value), selections);
  assert.ok(result.fields.every(item => item.source === 'cv:cv'));
  assert.deepEqual(result.questions.map(item => item.key), ['preferredName', 'addressLine1', 'requiresSponsorship']);
  assert.deepEqual(result.api, { configured: true, used: true });
  assert.deepEqual(f.state().career.profile, before);
});

test('existing full profile name offers exact contiguous parts without assigning their order', async () => {
  const f = fixture({ configured: true, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    for (const question of body.questions) {
      assert.notEqual(chooseExact(question, 'Synthetic'), 'unknown');
      assert.notEqual(chooseExact(question, 'Candidate'), 'unknown');
      assert.equal(chooseExact(question, 'Synthetic Candidate'), 'unknown');
    }
    return chosenResponse(body, question => chooseExact(question, question.name === 'field_0' ? 'Synthetic' : 'Candidate'));
  } });
  const result = await f.service.prepare({ ...snapshot([field('first', 'First name'), field('last', 'Last name')]), useApi: true });
  assert.deepEqual(result.fields.map(item => item.value), ['Synthetic', 'Candidate']);
  assert.ok(result.fields.every(item => item.source === 'profile.name'));
});

for (const bad of ['full name', 'wrong labeled part']) test(`provider cannot select ${bad} for a name-part field`, async () => {
  const text = bad === 'full name' ? syntheticCv : 'First name: Alex\nLast name: River\nalex.river@example.test';
  const f = cvFixture({ fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body), bank = JSON.parse(body.input[1].content).knownAnswers;
    const wrong = bank.find(item => item.value === (bad === 'full name' ? 'Alex River' : 'River'));
    assert.ok(wrong);
    assert.ok(!body.questions[0].choices.some(choice => choice.value === wrong.id));
    return chosenResponse(body, () => wrong.id);
  } }, text);
  await assert.rejects(f.service.prepare({ ...snapshot([field('first', 'First name')]), useApi: true }), byCode('FORM_INVALID_RESPONSE'));
  assert.equal(f.state().career.profile.firstName, null);
});

test('same derived fragment cannot fill both first and last name', async () => {
  const f = cvFixture({ fetchImpl: async (_url, init) => chosenResponse(JSON.parse(init.body), question => chooseExact(question, 'Alex')) });
  const result = await f.service.prepare({ ...snapshot([field('first', 'First name'), field('last', 'Last name')]), useApi: true });
  assert.deepEqual(result.fields, []);
  assert.deepEqual(result.questions.map(item => item.key), ['firstName', 'lastName']);
});

test('explicit profile contacts remain authoritative over CV candidates and are never overwritten', async () => {
  const f = cvFixture();
  f.alter(state => { Object.assign(state.career.profile, { firstName: 'Explicit', lastName: 'Person', email: 'saved@example.test' }); });
  const before = f.state().career.profile;
  const result = await f.service.prepare({ ...snapshot([field('first', 'First name'), field('last', 'Last name'), field('email', 'Email')]), useApi: true });
  assert.deepEqual(result.fields.map(item => item.value), ['Explicit', 'Person', 'saved@example.test']);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.state().career.profile, before);
});

test('CV contact extraction is never direct and uncertainty still asks for explicit details', async () => {
  const f = cvFixture({ fetchImpl: async (_url, init) => chosenResponse(JSON.parse(init.body), () => 'unknown') });
  const args = snapshot([field('first', 'First name'), field('email', 'Email')]);
  const direct = await f.service.prepare(args);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(direct.fields, []);
  const uncertain = await f.service.prepare({ ...args, requestId: randomUUID(), useApi: true });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(uncertain.fields, []);
  assert.deepEqual(uncertain.questions.map(item => item.key), ['firstName', 'email']);
});

test('reference-only, archived and non-CV sources never supply applicant contacts', async () => {
  const f = cvFixture({}, 'References\nMorgan Employer\nmorgan.employer@example.test\n+1 (212) 555-0148');
  f.alter(state => {
    state.career.sources.archived = { purpose: 'cv', archived: true, text: syntheticCv };
    state.career.sources.notes = { purpose: 'notes', archived: false, text: syntheticCv };
  });
  const result = await f.service.prepare({ ...snapshot([field('first', 'First name'), field('email', 'Email')]), useApi: true });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(result.fields, []);
  assert.deepEqual(result.questions.map(item => item.key), ['firstName', 'email']);
});

test('changing CV evidence discards previous extraction and requires fresh Decisions calls', async () => {
  let expected = 'alex.river@example.test';
  const f = cvFixture({ fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    if (expected !== 'alex.river@example.test') assert.ok(!init.body.includes('alex.river@example.test'));
    return chosenResponse(body, question => chooseExact(question, expected));
  } });
  const args = { ...snapshot([field('email', 'Email')]), useApi: true };
  const first = await f.service.prepare(args);
  assert.equal(first.fields[0].value, expected);
  expected = 'updated@example.test';
  f.alter(state => { state.career.sources.cv.text = syntheticCv.replace('alex.river@example.test', expected); });
  const second = await f.service.prepare({ ...args, requestId: randomUUID() });
  assert.equal(second.fields[0].value, expected);
  assert.notEqual(first.snapshot, second.snapshot);
  assert.equal(f.calls.length, 2);
  assert.equal(f.state().career.profile.email, null);
});

test('CV changes while Decisions is pending invalidate the response without releasing contacts', async () => {
  const gate = deferred(), entered = deferred();
  const f = cvFixture({ fetchImpl: async (_url, init) => {
    entered.resolve(); await gate.promise;
    return chosenResponse(JSON.parse(init.body), question => chooseExact(question, 'alex.river@example.test'));
  } });
  const pending = f.service.prepare({ ...snapshot([field('email', 'Email')]), useApi: true });
  await entered.promise;
  f.alter(state => { state.career.sources.cv.text = 'New CV without contact information'; });
  gate.resolve();
  await assert.rejects(pending, byCode('FORM_CONTEXT_CHANGED'));
});

test('saved full name constrains semantic name-part selection ahead of a conflicting CV header', async () => {
  const f = cvFixture({ fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    for (const question of body.questions) {
      assert.equal(chooseExact(question, 'Alex'), 'unknown');
      assert.equal(chooseExact(question, 'River'), 'unknown');
    }
    return chosenResponse(body, question => chooseExact(question, question.name === 'field_0' ? 'Saved' : 'Person'));
  } });
  f.alter(state => { state.career.profile.name = 'Saved Person'; });
  const result = await f.service.prepare({ ...snapshot([field('first', 'First name'), field('last', 'Last name')]), useApi: true });
  assert.deepEqual(result.fields.map(item => item.value), ['Saved', 'Person']);
});

test('explicit employer contact excerpts are excluded from applicant choices', async () => {
  const f = cvFixture({}, 'Experience\nExample Systems\nEmployer contact\njobs@example.test\n+1 (212) 555-0188');
  const result = await f.service.prepare({ ...snapshot([field('email', 'Email'), field('phone', 'Phone')]), useApi: true });
  assert.deepEqual(result.fields, []);
  assert.deepEqual(result.questions.map(item => item.key), ['email', 'phone']);
  assert.equal(f.calls.length, 0);
});
