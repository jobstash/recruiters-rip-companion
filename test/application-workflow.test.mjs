import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApplicationWorkflow, createApplicationPreparationTools, applicationContextFingerprint, applicationQuestionKey, applicationUrlIdentity } from '../src/application-workflow.mjs';
import { createApplicationTools } from '../src/mcp/application-tools.mjs';
import { createBrowserForms } from '../src/browser-forms.mjs';
import { createFormTools, validFormValue, validateFormSnapshot } from '../src/mcp/form-tools.mjs';
import { createScopedAccess } from '../src/mcp/scope.mjs';
import { CareerError, createCareerState } from '../src/mcp/state.mjs';

const role = 'a6bff5dd-1a4e-48ca-9421-f61fb85d1011';
const advert = `https://example.pinpointhq.com/postings/${role}`;
const apply = `${advert}/applications/new`;
const job = { title: 'Platform engineer', company: 'Example', description: 'Build reliable data services.', url: advert };
const field = (id = 'summary', extra = {}) => ({ id, label: 'Personal summary', type: 'textarea', signature: `sig:${id}`, empty: true, maxLength: 200, ...extra });
const page = (url = apply, fields = [field()]) => ({ url, title: 'Apply for Platform engineer', fields, actions: [] });
function fixture({ validateExport = async () => true, assertAvailable = () => {} } = {}) {
  let state = { deviceId: 'synthetic-device', career: createCareerState() }, queue = Promise.resolve();
  state.career.profile.name = 'Synthetic Candidate';
  state.career.sources.cv = { purpose: 'cv', text: 'Built reliable services at Example.', archived: false };
  const store = { get: () => structuredClone(state), update(change) {
    const next = queue.then(async () => { const copy = structuredClone(state); await change(copy); state = copy; });
    queue = next.catch(() => {}); return next;
  } };
  const workflow = createApplicationWorkflow({ store, assertAvailable, validateExport });
  const tools = new Map([...createApplicationTools({ store }), ...createFormTools({ store }),
    ...createApplicationPreparationTools({ workflow, openInBrowser: async url => opened.push(url) })].map(tool => [tool.name, tool]));
  const opened = [];
  const forms = createBrowserForms({ store, assertAvailable() {}, credentials: { read() { assert.fail('Keyless preparation must not read credentials.'); } },
    fetchImpl() { assert.fail('No inference is used in this test.'); } });
  const call = (name, args) => tools.get(name).invoke(args);
  const mutation = extra => ({ requestId: randomUUID(), revision: state.career.revision, ...extra });
  const create = input => call('career_application_create', mutation({ job: input ?? job }));
  const resolve = (extra = {}) => workflow.resolve({ requestId: randomUUID(), page: page(), jobs: [], context: { original: { url: advert, title: job.title, text: job.description, complete: true } }, ...extra });
  async function documents(applicationId, extra = {}) {
    await store.update(saved => {
      const app = saved.career.applications[applicationId], fingerprint = applicationContextFingerprint(saved.career, app);
      for (const kind of ['cv', 'cover_letter']) {
        app[kind === 'cv' ? 'cv' : 'coverLetter'] = { version: 1, contextFingerprint: fingerprint };
        if (kind === 'cover_letter') app.coverLetter.paragraphs = ['Dear Example team,', 'I build reliable services and would like to contribute to your team.'];
        app.exports.push({ kind, format: 'pdf', uri: `recruiters://documents/${kind === 'cv' ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}.pdf`,
          documentVersion: 1, contextFingerprint: fingerprint, textValidation: { passed: true }, ...extra });
      }
    });
  }
  async function answer(view, value = 'I build reliable services for this team.') {
    const read = await call('career_form_read', { formId: view.formId });
    return call('career_form_answers_save', mutation({ formId: read.formId, snapshot: read.snapshot, evidenceRevision: read.evidenceRevision,
      answers: [{ id: read.fields[0].id, value }] }));
  }
  return { store, workflow, call, mutation, create, resolve, documents, answer, forms, opened };
}

test('agent-led and browser-led entries converge on one application and reuse its current exports', async () => {
  const f = fixture(), created = await f.create();
  await f.documents(created.applicationId);
  await f.call('career_application_open', { applicationId: created.applicationId });
  assert.deepEqual(f.opened, [advert]);
  const view = await f.resolve();
  assert.equal(view.applicationId, created.applicationId);
  const context = await f.call('career_application_context', { applicationId: created.applicationId });
  assert.equal(context.forms[0].formId, view.formId);
  assert.equal(context.forms[0].writingFields[0].id, 'summary');
  assert.equal(context.forms[0].contextCurrent, true);
  assert.ok(view.documents.every(document => document.ready));
  assert.equal(view.state, 'drafts', 'writing is not ready just because documents exist');
  await f.answer(view);
  const before = f.store.get();
  const ready = await f.workflow.status({ bindingId: view.bindingId });
  assert.equal(ready.state, 'ready');
  assert.deepEqual(f.store.get(), before, 'metadata polling has no persisted side effects');
  assert.ok(!JSON.stringify(ready).includes('I build reliable'));
  assert.ok(!JSON.stringify(ready).includes('recruiters://'));
  await f.answer(view);
  await f.forms.prepare({ requestId: randomUUID(), ...page(), useApi: false });
  assert.equal((await f.workflow.status({ bindingId: view.bindingId })).answerVersion, ready.answerVersion, 'same prose and re-preparation never trigger a refresh loop');
  const recreated = await f.create();
  assert.equal(recreated.applicationId, created.applicationId);
  assert.equal(Object.keys(f.store.get().career.applications).length, 1);
  assert.equal((await f.workflow.document({ bindingId: view.bindingId, kind: 'cv' })).uri, 'recruiters://documents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf');
});

test('current introduction copies the exact saved job-specific paragraphs synchronously without exposing prose in metadata', async () => {
  const f = fixture(), created = await f.create(), view = await f.resolve(), copied = [];
  const paragraphs = ['Dear Example team,', 'I build reliable services and would like to contribute to your data platform.'];
  await f.call('career_application_letter_save', f.mutation({ applicationId: created.applicationId, paragraphs }));
  const before = f.store.get();
  const status = await f.workflow.status({ bindingId: view.bindingId });
  assert.deepEqual(status.introduction, { ready: true });
  assert.equal(status.documents.some(document => document.ready), false, 'copying text does not claim a PDF is exported');
  assert.ok(!JSON.stringify(status).includes(paragraphs[1]));
  assert.ok(!JSON.stringify(status).includes('recruiters://'));
  assert.deepEqual(f.workflow.copyIntroduction({ bindingId: view.bindingId }, text => copied.push(text)), { copied: true });
  assert.deepEqual(copied, [paragraphs.join('\n\n')], 'clipboard write finishes before its receipt is returned');
  assert.deepEqual(f.store.get(), before, 'copying never creates a second introduction artifact');
  assert.throws(() => f.workflow.copyIntroduction({ bindingId: view.bindingId }, () => { throw new Error('Clipboard unavailable'); }), /Clipboard unavailable/);
});

test('changed career evidence or original advert makes introduction metadata and copying unavailable', async () => {
  for (const change of [
    state => { state.career.sources.cv.text += ' Changed evidence.'; },
    state => { state.career.evidenceRevision++; },
    (state, id) => { state.career.applications[id].job.description = 'A different current role.'; },
    (state, id) => { delete state.career.applications[id].coverLetter.contextFingerprint; },
  ]) {
    const f = fixture(), created = await f.create(), view = await f.resolve(), copied = [];
    await f.documents(created.applicationId);
    await f.store.update(state => change(state, created.applicationId));
    assert.deepEqual((await f.workflow.status({ bindingId: view.bindingId })).introduction, { ready: false });
    const before = f.store.get();
    assert.throws(() => f.workflow.copyIntroduction({ bindingId: view.bindingId }, text => copied.push(text)), { code: 'INTRODUCTION_NOT_CURRENT' });
    assert.deepEqual(copied, []);
    assert.deepEqual(f.store.get(), before);
  }
});

test('empty or oversized introductions are unavailable, never truncated for copying', async () => {
  const f = fixture(), created = await f.create(), view = await f.resolve();
  await f.documents(created.applicationId);
  for (const paragraphs of [null, [], ['Only one paragraph'], ['Dear team,', '  '], ['Dear team,', 'x'.repeat(1501)], Array(13).fill('Paragraph'), ['Dear team,', 42]]) {
    await f.store.update(state => { state.career.applications[created.applicationId].coverLetter.paragraphs = paragraphs; });
    assert.deepEqual((await f.workflow.status({ bindingId: view.bindingId })).introduction, { ready: false });
    assert.throws(() => f.workflow.copyIntroduction({ bindingId: view.bindingId }, () => assert.fail('Invalid text cannot reach the clipboard')), { code: 'INTRODUCTION_NOT_CURRENT' });
  }
});

test('an unknown, unbound or wrong-job binding cannot copy another application’s introduction', async () => {
  const f = fixture(), first = await f.create(), firstView = await f.resolve();
  await f.documents(first.applicationId);
  const unrelated = await f.resolve({ page: page('https://example.pinpointhq.com/apply'), context: {} });
  assert.deepEqual(unrelated.introduction, { ready: false });
  assert.throws(() => f.workflow.copyIntroduction({ bindingId: randomUUID() }, () => assert.fail('Unknown binding copied')), { code: 'NOT_FOUND' });
  assert.throws(() => f.workflow.copyIntroduction({ bindingId: unrelated.bindingId }, () => assert.fail('Unbound application copied')), { code: 'INTRODUCTION_NOT_CURRENT' });
  const otherJob = { ...job, url: advert.replace(role, '54bab9d0-9c78-4405-8cea-3e1a2ae11b4c') };
  const second = await f.create(otherJob), paragraphs = ['Dear other team,', 'This introduction is for the other exact application.'];
  await f.call('career_application_letter_save', f.mutation({ applicationId: second.applicationId, paragraphs }));
  const secondView = await f.resolve({ page: page(`${otherJob.url}/applications/new`), context: {} });
  const copied = [];
  assert.deepEqual(f.workflow.copyIntroduction({ bindingId: secondView.bindingId }, text => copied.push(text)), { copied: true });
  assert.deepEqual(copied, [paragraphs.join('\n\n')]);
  await f.store.update(state => { state.career.applicationBindings[firstView.bindingId].applicationId = second.applicationId; });
  assert.deepEqual((await f.workflow.status({ bindingId: firstView.bindingId })).introduction, { ready: false });
  assert.throws(() => f.workflow.copyIntroduction({ bindingId: firstView.bindingId }, () => assert.fail('Wrong-job binding copied')), { code: 'INTRODUCTION_NOT_CURRENT' });
});

test('host preference persists without an account, application binding or host launch', async () => {
  const f = fixture(), before = f.store.get();
  assert.deepEqual(await f.workflow.setHost({ host: 'claude' }), { host: 'claude' });
  assert.equal(f.store.get().browserPreferences.applicationHost, 'claude');
  assert.deepEqual(f.store.get().career, before.career);
  assert.equal(f.store.get().pairing, undefined);
  const reopened = createApplicationWorkflow({ store: f.store });
  assert.deepEqual(await reopened.setHost({ host: 'codex' }), { host: 'codex' });
  assert.equal(f.store.get().browserPreferences.applicationHost, 'codex');
  for (const host of ['other', '', null, undefined]) await assert.rejects(reopened.setHost({ host }), { code: 'INVALID_INPUT' });
  assert.equal(f.store.get().browserPreferences.applicationHost, 'codex');
  assert.deepEqual(f.opened, []);
});

test('locked or changed local sessions cannot save host preferences or copy introductions', async () => {
  const f = fixture(), created = await f.create(), view = await f.resolve();
  await f.documents(created.applicationId);
  let locked = false, epoch = 0;
  const assertAvailable = () => { if (locked) throw new CareerError('LOCAL_LOCKED', 'Synthetic locked storage'); };
  const scoped = createScopedAccess(f.store, { assertAvailable, epoch: () => epoch });
  const workflow = createApplicationWorkflow({ store: scoped.store, assertAvailable: scoped.assertAvailable });
  await workflow.setHost({ host: 'claude' });
  const before = f.store.get();
  locked = true;
  await assert.rejects(workflow.setHost({ host: 'codex' }), { code: 'LOCAL_LOCKED' });
  assert.throws(() => workflow.copyIntroduction({ bindingId: view.bindingId }, () => assert.fail('Locked introduction copied')), { code: 'LOCAL_LOCKED' });
  locked = false; epoch++;
  await assert.rejects(workflow.setHost({ host: 'codex' }), { code: 'IDENTITY_CHANGED' });
  assert.throws(() => workflow.copyIntroduction({ bindingId: view.bindingId }, () => assert.fail('Old-session introduction copied')), { code: 'IDENTITY_CHANGED' });
  assert.deepEqual(f.store.get(), before);
});

test('web-led complete capture creates once; incomplete capture persists exact context until explicit bind', async () => {
  const f = fixture();
  const complete = await f.resolve({ jobs: [{ ...job, complete: true, applyUrl: apply }] });
  assert.ok(complete.applicationId);
  assert.equal((await f.create()).applicationId, complete.applicationId);
  const other = fixture();
  const view = await other.resolve({ context: { original: { url: advert, title: job.title, text: '', complete: false }, jobLinks: [{ url: advert, title: job.title }] } });
  assert.equal(view.applicationId, null);
  assert.equal(view.state, 'needs_job');
  const preparation = await other.workflow.prepare({ bindingId: view.bindingId, host: 'claude' });
  await other.workflow.launched({ preparationId: preparation.preparationId, host: 'claude', mode: 'cli' });
  const launched = await other.workflow.status({ bindingId: view.bindingId });
  assert.equal(launched.state, 'needs_job');
  assert.equal(launched.handoff.state, 'awaiting_agent');
  assert.equal(launched.handoff.mode, 'cli');
  const read = await other.call('career_application_preparation_read', { preparationId: preparation.preparationId });
  assert.equal(read.context.original.url, advert);
  assert.equal(read.form.fields[0].maxLength, 200);
  assert.match(read.instructions, /retrieve the exact linked original advert/);
  assert.match(read.instructions, /personal summary/);
  const recreatedWorkflow = createApplicationWorkflow({ store: other.store });
  assert.equal((await recreatedWorkflow.readPreparation({ preparationId: preparation.preparationId })).preparationId, preparation.preparationId);
  const created = await other.create();
  await other.call('career_application_preparation_bind', { preparationId: preparation.preparationId, applicationId: created.applicationId });
  assert.equal((await other.workflow.status({ bindingId: view.bindingId })).applicationId, created.applicationId);
  assert.equal(Object.keys(other.store.get().career.applications).length, 1);
});

test('a prepared application binds agent-written essays and Yes/No choices, so keyless preparation shows them ready', async () => {
  const f = fixture(), created = await f.create();
  const yesNo = label => ({ label, type: 'radio', options: [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }] });
  const fields = [
    field('project', { label: 'Share a data project you built end-to-end that changed a business decision. Briefly cover the question, your approach (tools, data), and the outcome.' }),
    field('lead', yesNo('Do you have at least 1+ years of experience in leadership?')),
    field('crypto', { label: 'Briefly describe your experience and knowledge of web3/crypto. What areas have you worked in or explored (e.g. DeFi, bridges, DEXs, wallets, on-chain data), and in what capacity?' }),
    field('web3', yesNo('Do you have professional working experience at a web3/crypto company?')),
    field('game', { label: 'Tell us about a mobile game you shipped.' }),
    field('authorized', yesNo('Are you legally authorized to work in the location for which you are applying?')),
  ];
  const view = await f.resolve({ page: page(apply, fields) });
  assert.equal(view.applicationId, created.applicationId);
  assert.deepEqual(view.writing.map(item => item.fieldId), ['project', 'crypto', 'game'], 'choices are not routed as writing');
  const { preparationId } = await f.workflow.prepare({ bindingId: view.bindingId, host: 'codex' });
  const read = await f.call('career_application_preparation_read', { preparationId });
  assert.deepEqual(read.form.fields.map(item => item.id), fields.map(item => item.id));
  assert.match(read.instructions, /answer every empty captured field/);
  assert.match(read.instructions, /Yes\/No/);
  await f.call('career_form_answers_save', f.mutation({ formId: read.form.formId, snapshot: read.form.snapshot, evidenceRevision: read.form.evidenceRevision, answers: [
    { id: 'project', value: 'Built a churn model that moved retention budget.' }, { id: 'lead', value: 'Yes' },
    { id: 'crypto', value: 'Analysed on-chain bridge volumes at Example.' }, { id: 'web3', value: 'Yes' }] }));
  const prepared = await f.forms.prepare({ requestId: randomUUID(), ...page(apply, fields), useApi: false });
  assert.deepEqual(prepared.fields.map(item => [item.id, item.value, item.source]), [
    ['project', 'Built a churn model that moved retention budget.', 'agent'], ['lead', 'Yes', 'agent'],
    ['crypto', 'Analysed on-chain bridge volumes at Example.', 'agent'], ['web3', 'Yes', 'agent']]);
  assert.deepEqual(prepared.unresolved.map(item => [item.id, item.reason]), [
    ['game', 'Ask your connected agent to write this answer for this application.'],
    ['authorized', 'Confirm eligibility for this application with your connected agent or complete manually.']]);
  const status = await f.workflow.status({ bindingId: view.bindingId });
  assert.deepEqual(status.writing.map(item => [item.fieldId, item.ready]), [['project', true], ['crypto', true], ['game', false]]);
});

test('an agent answer to a generic question is kept like the user’s own, without staling documents or assessments', async () => {
  const f = fixture(), created = await f.create();
  const notice = field('notice', { label: 'What is your current notice period?', type: 'text' });
  const view = await f.resolve({ page: page(apply, [notice]) });
  await f.documents(created.applicationId);
  const read = await f.call('career_form_read', { formId: view.formId }), evidenceRevision = f.store.get().career.evidenceRevision;
  const save = value => f.call('career_form_answers_save', f.mutation({ formId: read.formId, snapshot: read.snapshot, evidenceRevision: read.evidenceRevision, answers: [{ id: 'notice', value }] }));
  await save('One month');
  await save('Three months');
  const career = f.store.get().career;
  assert.deepEqual(Object.values(career.facts).map(fact => [fact.subject, fact.answer]), [['Notice period', 'One month']], 'an existing generic fact is never overwritten by the agent');
  assert.equal(career.evidenceRevision, evidenceRevision, 'saved assessments stay current');
  assert.equal((await f.workflow.status({ bindingId: view.bindingId })).state, 'ready');
  const elsewhere = await f.forms.prepare({ requestId: randomUUID(), ...page('https://jobs.example.test/other/apply', [notice]), useApi: false });
  assert.equal(elsewhere.fields[0].value, 'One month');
  assert.match(elsewhere.fields[0].source, /^fact:/);
});

test('ambiguous saved URLs and same-host titles cannot select another application package', async () => {
  const f = fixture(), created = await f.create();
  await f.documents(created.applicationId);
  const unrelated = await f.resolve({ page: page('https://example.pinpointhq.com/apply'), context: {} });
  assert.equal(unrelated.applicationId, null);
  await f.store.update(state => {
    const clone = structuredClone(state.career.applications[created.applicationId]); clone.id = randomUUID();
    state.career.applications[clone.id] = clone;
  });
  const ambiguous = await f.resolve();
  assert.equal(ambiguous.applicationId, null);
  assert.ok(ambiguous.documents.every(document => !document.ready));
  await assert.rejects(f.create(), { code: 'AMBIGUOUS_APPLICATION' });
  const request = await f.workflow.prepare({ bindingId: unrelated.bindingId, host: 'codex' });
  await assert.rejects(f.workflow.bindPreparation({ preparationId: request.preparationId, applicationId: created.applicationId }), { code: 'APPLICATION_MISMATCH' });
});

test('changed original or CV evidence invalidates saved documents and staged answers without deleting history', async () => {
  const f = fixture(), created = await f.create(), view = await f.resolve();
  await f.documents(created.applicationId); await f.answer(view);
  const changed = await f.create({ ...job, description: 'Operate a different payments system.' });
  assert.equal(changed.applicationId, created.applicationId);
  let status = await f.workflow.status({ bindingId: view.bindingId });
  assert.equal(status.state, 'needs_refresh');
  assert.equal(status.writing[0].ready, false);
  assert.ok(status.documents.every(document => !document.ready));
  await assert.rejects(f.workflow.document({ bindingId: view.bindingId, kind: 'cv' }), { code: 'DOCUMENT_NOT_CURRENT' });
  await assert.rejects(f.call('career_application_open', { applicationId: created.applicationId }), { code: 'DOCUMENT_NOT_CURRENT' });
  await f.documents(created.applicationId);
  await f.store.update(state => { state.career.sources.cv.text += ' Updated career evidence.'; });
  status = await f.workflow.status({ bindingId: view.bindingId });
  assert.equal(status.state, 'needs_refresh');
  assert.equal(f.store.get().career.applications[created.applicationId].exports.length, 4);
});

test('application answers reuse exact normalized questions only', async () => {
  const f = fixture(), created = await f.create(), view = await f.resolve();
  await f.answer(view);
  const nextPage = page(apply, [field('new-dom-id', { label: '  PERSONAL   summary ' })]);
  const rebound = await f.resolve({ page: nextPage });
  assert.equal(rebound.writing[0].ready, true);
  const prepared = await f.forms.prepare({ requestId: randomUUID(), ...nextPage, useApi: false });
  assert.equal(prepared.fields[0].value, 'I build reliable services for this team.');
  assert.equal(prepared.fields[0].id, 'new-dom-id');
  const secondJob = { ...job, url: advert.replace(role, '54bab9d0-9c78-4405-8cea-3e1a2ae11b4c') };
  const second = await f.create(secondJob);
  assert.notEqual(second.applicationId, created.applicationId);
  const secondPage = page(`${secondJob.url}/applications/new`);
  const separate = await f.resolve({ page: secondPage, context: {} });
  assert.equal(separate.writing[0].ready, false);
  const noLeak = await f.forms.prepare({ requestId: randomUUID(), ...secondPage, useApi: false });
  assert.deepEqual(noLeak.fields, []);
  assert.notEqual(applicationQuestionKey(field()), applicationQuestionKey(field('summary', { maxLength: 100 })));
  assert.notEqual(applicationQuestionKey(field('q', { type: 'select', options: [{ value: 'yes', label: 'Yes' }] })),
    applicationQuestionKey(field('q', { type: 'select', options: [{ value: 'no', label: 'No' }] })));
});

test('legacy drafts, unvalidated exports and missing files never count as current', async () => {
  let exists = true;
  const f = fixture({ validateExport: async () => exists }), created = await f.create(), view = await f.resolve({ page: page(apply, []) });
  await f.documents(created.applicationId);
  assert.equal((await f.workflow.status({ bindingId: view.bindingId })).state, 'ready');
  exists = false;
  assert.equal((await f.workflow.status({ bindingId: view.bindingId })).documents[0].ready, false);
  exists = true;
  await f.store.update(state => { delete state.career.applications[created.applicationId].cv.contextFingerprint; });
  assert.equal((await f.workflow.status({ bindingId: view.bindingId })).state, 'needs_refresh');
  await f.documents(created.applicationId, { textValidation: { passed: false }, format: 'txt' });
  await f.store.update(state => { state.career.applications[created.applicationId].exports = state.career.applications[created.applicationId].exports.slice(-2); });
  assert.ok((await f.workflow.status({ bindingId: view.bindingId })).documents.every(document => !document.ready));
});

test('ATS role identities preserve job isolation and maxLength bounds staged form values', () => {
  assert.equal(applicationUrlIdentity(advert), applicationUrlIdentity(apply));
  assert.equal(applicationUrlIdentity('https://boards.greenhouse.io/example/jobs/123'), applicationUrlIdentity('https://boards.greenhouse.io/example?gh_jid=123'));
  assert.equal(applicationUrlIdentity(`https://jobs.lever.co/example/${role}`), applicationUrlIdentity(`https://jobs.lever.co/example/${role}/apply`));
  assert.notEqual(applicationUrlIdentity('https://example.test/jobs/1'), applicationUrlIdentity('https://example.test/jobs/2'));
  assert.equal(validFormValue(field('s', { maxLength: 4 }), '1234'), true);
  assert.equal(validFormValue(field('s', { maxLength: 4 }), '12345'), false);
  for (const maxLength of [-1, 1.5, 10001, '20']) assert.throws(() => validateFormSnapshot(page(apply, [field('s', { maxLength })])), { code: 'INVALID_INPUT' });
  assert.equal(validFormValue(field('s', { maxLength: 0 }), 'x'), false);
});

test('narrative answers require a saved exact job, even when a legacy unbound draft exists', async () => {
  const f = fixture(), view = await f.resolve({ context: {} });
  await assert.rejects(f.answer(view), { code: 'APPLICATION_REQUIRED' });
  await f.store.update(state => {
    state.career.formDrafts[view.formId].answers.summary = { value: 'Old application prose', source: 'agent' };
  });
  const result = await f.forms.prepare({ requestId: randomUUID(), ...page(), useApi: false });
  assert.deepEqual(result.fields, []);
  assert.equal((await f.workflow.status({ bindingId: view.bindingId })).writing[0].ready, false);
});

test('recapturing the local original invalidates documents even before application_create is called again', async () => {
  const f = fixture(), id = `local:${'c'.repeat(64)}`;
  await f.store.update(state => { state.career.jobs = { [id]: { id, ...job, applyUrl: apply, complete: true, updatedAt: '2026-01-01T00:00:00Z' } }; });
  const created = await f.call('career_application_create', f.mutation({ jobId: id }));
  const view = await f.resolve({ context: {} });
  await f.documents(created.applicationId);
  await f.store.update(state => { state.career.jobs[id].description = 'The full original now requires different experience.'; });
  assert.equal((await f.workflow.status({ bindingId: view.bindingId })).state, 'needs_refresh');
  const context = await f.call('career_application_context', { applicationId: created.applicationId });
  assert.equal(context.job.description, 'The full original now requires different experience.');
});

test('an ambiguous list of links is not resolved by choosing the only previously saved job', async () => {
  const f = fixture();
  await f.create();
  const view = await f.resolve({ page: page('https://example.test/application'), context: { jobLinks: [
    { url: advert, title: job.title }, { url: 'https://example.test/jobs/another', title: job.title },
  ] } });
  assert.equal(view.applicationId, null);
});

test('status and document lookup reject concurrent evidence changes during file validation', async () => {
  let changed = false, f;
  f = fixture({ validateExport: async () => {
    if (!changed) { changed = true; await f.store.update(state => { state.career.profile.name = 'Changed during validation'; state.career.evidenceRevision++; }); }
    return true;
  } });
  const created = await f.create(), view = await f.resolve();
  await f.documents(created.applicationId);
  await assert.rejects(f.workflow.status({ bindingId: view.bindingId }), { code: 'APPLICATION_CONTEXT_CHANGED' });
  assert.ok((await f.workflow.status({ bindingId: view.bindingId })).documents.every(document => !document.ready));
  await f.documents(created.applicationId);
  changed = false;
  await assert.rejects(f.workflow.document({ bindingId: view.bindingId, kind: 'cv' }), { code: 'DOCUMENT_NOT_CURRENT' });
});

test('a generic destination claiming a different unsaved advert cannot reuse the first package', async () => {
  const f = fixture(), generic = 'https://example.test/apply';
  const firstJob = { ...job, url: 'https://example.test/jobs/first', applyUrl: generic };
  const first = await f.create(firstJob);
  await f.documents(first.applicationId);
  const secondJob = { ...job, url: 'https://example.test/jobs/second', applyUrl: generic };
  const view = await f.resolve({ page: page(generic), jobs: [{ ...secondJob, complete: true }], context: {
    original: { url: secondJob.url, title: job.title, text: job.description, complete: true },
  } });
  assert.equal(view.applicationId, null);
  assert.ok(view.documents.every(document => !document.ready));
  assert.equal(Object.keys(f.store.get().career.applications).length, 1);
  assert.equal(f.store.get().career.applications[first.applicationId].job.applyUrl, generic);
});

test('equivalent HTML and captured text preserve the saved original, fingerprints and current PDFs', async () => {
  const f = fixture();
  const html = '<p>Build <strong>reliable</strong> data services.</p><p>Work with R&amp;D&nbsp;teams.</p>';
  const text = 'Build reliable data services.\n\nWork with R&D teams.';
  const created = await f.create({ ...job, description: html });
  await f.documents(created.applicationId);
  const before = f.store.get().career.applications[created.applicationId];
  const view = await f.resolve({ page: page(apply, []), context: { original: { url: advert, title: job.title, text, complete: true } } });
  assert.equal(view.state, 'ready');
  assert.equal(f.store.get().career.applications[created.applicationId].job.description, html);
  assert.equal(f.store.get().career.applications[created.applicationId].cv.contextFingerprint, before.cv.contextFingerprint);
  const recreated = await f.create({ ...job, description: `  ${text.replaceAll(' ', '  ')}  ` });
  assert.equal(recreated.applicationId, created.applicationId);
  assert.equal((await f.workflow.status({ bindingId: view.bindingId })).state, 'ready');
  const changed = await f.resolve({ page: page(apply, []), context: { original: {
    url: advert, title: job.title, text: text.replace('reliable', 'regulated'), complete: true,
  } } });
  assert.equal(changed.state, 'needs_refresh');
});

test('custom-domain localized Pinpoint routes resolve only the exact same-origin role token', async () => {
  const f = fixture(), original = `https://careers.zebedee.io/en/postings/${role}`;
  const created = await f.create({ ...job, url: original });
  await f.documents(created.applicationId);
  const view = await f.resolve({ page: page(`${original}/applications/new`, []), context: {} });
  assert.equal(view.applicationId, created.applicationId);
  assert.equal(view.state, 'ready');
  assert.equal(applicationUrlIdentity(original), applicationUrlIdentity(`https://careers.zebedee.io/postings/${role}/applications/new`));
  assert.notEqual(applicationUrlIdentity(original), applicationUrlIdentity(`https://unrelated.example/en/postings/${role}/applications/new`));
  assert.notEqual(applicationUrlIdentity(original), applicationUrlIdentity(`https://careers.zebedee.io:8443/en/postings/${role}/applications/new`));
  assert.notEqual(applicationUrlIdentity(original), applicationUrlIdentity('https://careers.zebedee.io/en/postings/another/applications/new'));
});

test('a saved complete local original resolves without a new page capture or platform request', async () => {
  const f = fixture(), id = `local:${'d'.repeat(64)}`;
  await f.store.update(state => { state.career.jobs = { [id]: { id, ...job, complete: true, applyUrl: apply } }; });
  const view = await f.resolve({ context: {} });
  assert.ok(view.applicationId);
  assert.equal(f.store.get().career.applications[view.applicationId].job.id, id);
  assert.equal((await f.create()).applicationId, view.applicationId);
});

test('saved different originals sharing a generic apply URL remain ambiguous', async () => {
  const f = fixture(), generic = 'https://example.test/apply';
  await f.store.update(state => {
    state.career.jobs = Object.fromEntries(['first', 'second'].map(id => [id, {
      ...job, id: `local:${id}`, url: `https://example.test/jobs/${id}`, complete: true, applyUrl: generic,
    }]));
  });
  const view = await f.resolve({ page: page(generic), context: {} });
  assert.equal(view.applicationId, null);
  assert.equal(Object.keys(f.store.get().career.applications).length, 0);
});

test('blocked packages reject preparation, open and receipt replay while retaining drafts and bindings', async () => {
  const f = fixture(), created = await f.create({ ...job, company: 'Flow Traders' });
  await f.documents(created.applicationId);
  const input = { requestId: randomUUID(), page: page(), jobs: [], context: { original: { url: advert, title: job.title, text: job.description, complete: true } } };
  const view = await f.workflow.resolve(input);
  const preparation = await f.workflow.prepare({ bindingId: view.bindingId, host: 'claude' });
  await f.store.update(state => { state.career.blocklist = { company: { kind: 'company', value: 'flow-traders' } }; });
  const before = f.store.get();
  for (const operation of [
    () => f.workflow.status({ bindingId: view.bindingId }),
    () => f.workflow.prepare({ bindingId: view.bindingId, host: 'claude' }),
    () => f.workflow.launched({ preparationId: preparation.preparationId, host: 'claude', mode: 'desktop' }),
    () => f.workflow.readPreparation({ preparationId: preparation.preparationId }),
    () => f.workflow.bindPreparation({ preparationId: preparation.preparationId, applicationId: created.applicationId }),
    () => f.workflow.document({ bindingId: view.bindingId, kind: 'cv' }),
    () => f.call('career_application_open', { applicationId: created.applicationId }),
    () => f.workflow.resolve(input),
  ]) await assert.rejects(operation, { code: 'JOB_BLOCKED' });
  assert.throws(() => f.workflow.jobUrl({ bindingId: view.bindingId }), { code: 'JOB_BLOCKED' });
  assert.throws(() => f.workflow.copyIntroduction({ bindingId: view.bindingId }, () => assert.fail('Blocked introduction copied')), { code: 'JOB_BLOCKED' });
  assert.deepEqual(f.opened, []);
  assert.deepEqual(f.store.get(), before);
});

test('a fresh blocked capture cannot create a browser-led package or overwrite an existing one', async () => {
  const f = fixture();
  await f.store.update(state => { state.career.blocklist = { company: { kind: 'company', value: 'flow-traders' } }; });
  await assert.rejects(f.resolve({ jobs: [{ ...job, company: 'Flow Traders', complete: true }] }), { code: 'JOB_BLOCKED' });
  assert.deepEqual(f.store.get().career.applications, {});
  assert.equal(f.store.get().career.applicationBindings, undefined);
  const allowed = await f.resolve({ jobs: [{ ...job, complete: true }] });
  assert.ok(allowed.applicationId);
});

test('URL-only preparation bindings become blocked when their known job is blocked', async () => {
  const f = fixture();
  const view = await f.resolve({ context: { original: { url: advert, title: job.title, text: '', complete: false } } });
  const preparation = await f.workflow.prepare({ bindingId: view.bindingId, host: 'claude' });
  await f.store.update(state => {
    state.career.matching = { jobs: { 'node:1': { id: 'node:1', title: job.title, company: job.company, applyUrl: advert } } };
    state.career.blocklist = { direct: { kind: 'job', value: 'node:1' } };
  });
  await assert.rejects(f.workflow.readPreparation({ preparationId: preparation.preparationId }), { code: 'JOB_BLOCKED' });
  assert.equal(Object.keys(f.store.get().career.applications).length, 0);
});

test('document validation cannot release readiness or open a package blocked during the await', async () => {
  for (const operation of ['status', 'document', 'open']) {
    let active = false, release, started;
    const waiting = new Promise(resolve => { started = resolve; });
    const validated = new Promise(resolve => { release = resolve; });
    const f = fixture({ validateExport: async () => {
      if (active) { started(); await validated; }
      return true;
    } });
    const created = await f.create();
    await f.documents(created.applicationId);
    const view = await f.resolve();
    active = true;
    const pending = operation === 'open' ? f.call('career_application_open', { applicationId: created.applicationId })
      : operation === 'document' ? f.workflow.document({ bindingId: view.bindingId, kind: 'cv' }) : f.workflow.status({ bindingId: view.bindingId });
    await waiting;
    await f.store.update(state => { state.career.blocklist = { company: { kind: 'company', value: 'example' } }; });
    release();
    await assert.rejects(pending, { code: 'JOB_BLOCKED' });
    assert.deepEqual(f.opened, []);
    assert.equal(f.store.get().career.applications[created.applicationId].exports.length, 2);
  }
});

test('an allowed bound application stays usable when a blocked role shares its generic form URL', async () => {
  const f = fixture(), generic = 'https://example.test/apply';
  const blocked = await f.create({ ...job, company: 'Blocked Company', url: 'https://example.test/jobs/blocked', applyUrl: generic });
  const allowed = await f.create({ ...job, company: 'Allowed Company', url: 'https://example.test/jobs/allowed', applyUrl: generic });
  await f.documents(allowed.applicationId);
  const view = await f.resolve({ page: page(generic), context: { original: {
    url: 'https://example.test/jobs/allowed', title: job.title, text: job.description, complete: true,
  } } });
  assert.equal(view.applicationId, allowed.applicationId);
  await f.store.update(state => {
    state.career.applications[blocked.applicationId].job.id = 'node:blocked';
    state.career.blocklist = { direct: { kind: 'job', value: 'node:blocked' } };
  });
  assert.equal((await f.workflow.status({ bindingId: view.bindingId })).applicationId, allowed.applicationId);
  assert.ok((await f.workflow.prepare({ bindingId: view.bindingId, host: 'claude' })).preparationId);
});

test('foreign canonical claims cannot bind, release answers or replace an existing destination', async () => {
  for (const trustedJob of [job, { ...job, url: 'https://employer.example/jobs/123', applyUrl: 'https://authorized-ats.example/apply' }]) {
    const f = fixture(), created = await f.create(trustedJob);
    const trustedPage = page(trustedJob.applyUrl ?? apply);
    const trusted = await f.resolve({ page: trustedPage, context: {} });
    assert.equal(trusted.applicationId, created.applicationId, 'pre-recorded cross-origin ATS stays authorized');
    await f.documents(created.applicationId); await f.answer(trusted, 'SYNTHETIC APPLICATION PRIVATE ANSWER');
    const before = f.store.get().career.applications[created.applicationId];
    const hostilePage = page('https://attacker.example/apply');
    const hostile = await f.resolve({ page: hostilePage,
      jobs: [{ ...trustedJob, complete: true, applyUrl: hostilePage.url }],
      context: { original: { url: trustedJob.url, title: job.title, text: job.description, complete: true },
        jobLinks: [{ url: trustedJob.url, title: 'View job description' }] } });
    assert.equal(hostile.applicationId, null);
    assert.ok(hostile.documents.every(item => !item.ready));
    assert.equal(hostile.introduction.ready, false);
    assert.deepEqual(f.store.get().career.applications[created.applicationId], before);
    const prepared = await f.forms.prepare({ requestId: randomUUID(), ...hostilePage, useApi: false });
    assert.deepEqual(prepared.fields, []);
    assert.throws(() => f.workflow.copyIntroduction({ bindingId: hostile.bindingId }, () => assert.fail('Foreign page copied private prose')), { code: 'INTRODUCTION_NOT_CURRENT' });
    const request = await f.workflow.prepare({ bindingId: hostile.bindingId, host: 'codex' });
    await assert.rejects(f.workflow.bindPreparation({ preparationId: request.preparationId, applicationId: created.applicationId }), { code: 'APPLICATION_MISMATCH' });
    await f.call('career_application_open', { applicationId: created.applicationId });
    assert.deepEqual(f.opened, [trustedPage.url]);
  }
});
