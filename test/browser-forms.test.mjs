import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBrowserForms } from '../src/browser-forms.mjs';
import { createFormTools } from '../src/mcp/form-tools.mjs';
import { CareerError, createCareerState } from '../src/mcp/state.mjs';

const field = (id, label, type = 'text', extra = {}) => ({ id, label, type, signature: `signature:${id}`, empty: true, ...extra });
const snapshot = fields => ({ requestId: randomUUID(), url: 'https://synthetic.example/apply/role', title: 'Synthetic application', fields, useApi: false });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture({ authorize = async () => true, fetchImpl = async () => { throw new Error('Unexpected fetch'); }, configured = false } = {}) {
  let state = { deviceId: 'synthetic-device', prescanCredentialVersion: 0, career: createCareerState() };
  Object.assign(state.career.profile, { name: 'Synthetic Candidate', email: 'candidate@example.test', phone: '+1 555 0100', location: 'Toronto', skills: ['Data analysis'] });
  state.career.facts.language = { id: 'language', subject: 'French', answer: 'Professional', kind: 'capability' };
  state.career.sources.cv = { purpose: 'cv', text: 'PRIVATE CV NEVER SENT TO DECISIONS', originalBase64: 'PRIVATE ORIGINAL', archived: false };
  let locked = false, key = configured ? 'sk-synthetic-only-never-a-real-key' : null, queue = Promise.resolve();
  const approvals = [], calls = [];
  const assertAvailable = () => { if (locked) throw new CareerError('LOCAL_LOCKED', 'Synthetic lock'); };
  const store = {
    get() { assertAvailable(); return structuredClone(state); },
    update(change) {
      const next = queue.then(async () => { assertAvailable(); const copy = structuredClone(state); await change(copy); assertAvailable(); state = copy; });
      queue = next.catch(() => {}); return next;
    },
  };
  const credentials = { read(provider) {
    assert.equal(provider, 'openai'); assertAvailable();
    if (!key) throw new CareerError('PRESCAN_KEY_REQUIRED', 'Synthetic key required');
    return { apiKey: key, credentialVersion: state.prescanCredentialVersion };
  } };
  const service = createBrowserForms({ store, credentials, assertAvailable, authorize: input => { approvals.push(input); return authorize(input); },
    fetchImpl: (...args) => { calls.push(args); return fetchImpl(...args); } });
  const tools = new Map(createFormTools({ store }).map(tool => [tool.name, tool]));
  return { store, service, approvals, calls, tools, lock() { locked = true; service.cancelAll(); },
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
  createBrowserForms({ store: { get: forbidden }, credentials: { read: forbidden }, authorize: forbidden, assertAvailable: forbidden });
  createFormTools({ store: { get: forbidden } });
});

test('direct known contact answers need no key and are released only after native approval', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ authorize: input => { entered.resolve(input); return gate.promise; } });
  const args = snapshot([field('name', 'Full name'), field('email', 'Email address', 'email'), field('phone', 'Telephone', 'tel'), field('unknown', 'Why this company?', 'textarea')]);
  const pending = f.service.prepare(args);
  const approval = await entered.promise;
  assert.equal(approval.destination, 'https://synthetic.example');
  assert.equal(approval.useApi, false);
  assert.ok(approval.data.some(item => item.value === 'candidate@example.test'));
  assert.equal(f.state().career.formDrafts, undefined);
  assert.equal(f.calls.length, 0);
  gate.resolve(true);
  const result = await pending;
  assert.deepEqual(result.fields.map(item => item.value), ['Synthetic Candidate', 'candidate@example.test', '+1 555 0100']);
  assert.equal(result.unresolved[0].id, 'unknown');
  assert.equal(result.usage, undefined);
  assert.ok(!JSON.stringify(result).includes('PRIVATE CV'));
});

test('denied approval releases nothing, stores nothing and dispatches nothing', async () => {
  const f = fixture({ configured: true, authorize: async () => false });
  await assert.rejects(f.service.prepare({ ...snapshot([field('email', 'Email', 'email'), field('q', 'French level')]), useApi: true }), byCode('FORM_NOT_AUTHORIZED'));
  assert.equal(f.calls.length, 0);
  assert.equal(f.state().career.formDrafts, undefined);
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
  const first = await f.service.prepare(args), read = await f.tools.get('career_form_read').invoke({ formId: first.formId });
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

test('explicit API mode approves provider, model, data and separate billing before bounded dispatch', async () => {
  const f = fixture({ configured: true, fetchImpl: async (url, init) => {
    assert.equal(f.approvals.length, 1);
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
  assert.equal(f.approvals[0].provider, 'openai');
  assert.equal(f.approvals[0].model, 'gpt-6-luna');
  assert.equal(f.approvals[0].separateBilling, true);
  assert.equal(f.approvals[0].inputUsdPerMillion, 0.1);
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

for (const change of ['cancel', 'cancelAll', 'profile', 'key', 'identity', 'lock']) test(`${change} during native approval stops release and future API dispatch`, async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ configured: true, authorize: () => { entered.resolve(); return gate.promise; } });
  const args = { ...snapshot([field('q', 'French level')]), useApi: true }, pending = f.service.prepare(args);
  await entered.promise;
  if (change === 'cancel') f.service.cancel(args.requestId);
  if (change === 'cancelAll') f.service.cancelAll();
  if (change === 'profile') f.alter(state => { state.career.profile.name = 'Changed'; state.career.evidenceRevision++; });
  if (change === 'key') f.rotateKey();
  if (change === 'identity') f.alter(state => { state.deviceId = 'different-device'; });
  if (change === 'lock') f.lock();
  gate.resolve(true);
  await assert.rejects(pending);
  assert.equal(f.calls.length, 0);
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
  assert.equal(f.approvals.length, 0);
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
  const read = f.tools.get('career_form_read').invoke({ formId: result.formId });
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
  const read = f.tools.get('career_form_read').invoke({ formId: result.formId });
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
  const approvedFact = f.approvals[0].data.find(item => item.source === 'fact:relocation');
  assert.equal(approvedFact.qualifiers.context, 'Toronto only');
});

test('preferred contact method is available for explicit staging while Contact me consent remains protected', async () => {
  const f = fixture();
  const args = snapshot([
    field('method', 'Preferred contact method', 'radio', { options: [{ value: 'email', label: 'Email' }, { value: 'phone', label: 'Phone' }] }),
    field('contact-permission', 'Contact me about other opportunities', 'radio', { options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] }),
  ]);
  const prepared = await f.service.prepare(args);
  const read = f.tools.get('career_form_read').invoke({ formId: prepared.formId });
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
