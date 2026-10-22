import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApplicationWorkflow, createApplicationPreparationTools, applicationContextFingerprint, applicationQuestionKey, applicationUrlIdentity } from '../src/application-workflow.mjs';
import { createApplicationTools } from '../src/mcp/application-tools.mjs';
import { createBrowserForms } from '../src/browser-forms.mjs';
import { createFormTools, validFormValue, validateFormSnapshot } from '../src/mcp/form-tools.mjs';
import { createCareerState } from '../src/mcp/state.mjs';

const role = 'a6bff5dd-1a4e-48ca-9421-f61fb85d1011';
const advert = `https://example.pinpointhq.com/postings/${role}`;
const apply = `${advert}/applications/new`;
const job = { title: 'Platform engineer', company: 'Example', description: 'Build reliable data services.', url: advert };
const field = (id = 'summary', extra = {}) => ({ id, label: 'Personal summary', type: 'textarea', signature: `sig:${id}`, empty: true, maxLength: 200, ...extra });
const page = (url = apply, fields = [field()]) => ({ url, title: 'Apply for Platform engineer', fields, actions: [] });
function fixture({ validateExport = async () => true } = {}) {
  let state = { deviceId: 'synthetic-device', career: createCareerState() }, queue = Promise.resolve();
  state.career.profile.name = 'Synthetic Candidate';
  state.career.sources.cv = { purpose: 'cv', text: 'Built reliable services at Example.', archived: false };
  const store = { get: () => structuredClone(state), update(change) {
    const next = queue.then(async () => { const copy = structuredClone(state); await change(copy); state = copy; });
    queue = next.catch(() => {}); return next;
  } };
  const workflow = createApplicationWorkflow({ store, assertAvailable() {}, validateExport });
  const tools = new Map([...createApplicationTools({ store }), ...createFormTools({ store }),
    ...createApplicationPreparationTools({ workflow, openInChrome: async url => opened.push(url) })].map(tool => [tool.name, tool]));
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
        app.exports.push({ kind, format: 'pdf', uri: `recruiters://exports/${kind === 'cv' ? 'a'.repeat(64) : 'b'.repeat(64)}.pdf`,
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
  assert.equal((await f.workflow.document({ bindingId: view.bindingId, kind: 'cv' })).uri, `recruiters://exports/${'a'.repeat(64)}.pdf`);
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
  await other.workflow.launched({ preparationId: preparation.preparationId, host: 'claude' });
  const launched = await other.workflow.status({ bindingId: view.bindingId });
  assert.equal(launched.state, 'needs_job');
  assert.equal(launched.handoff.state, 'awaiting_agent');
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

test('one generic apply URL cannot merge different exact original adverts or leak the first package', async () => {
  const f = fixture(), generic = 'https://example.test/apply';
  const firstJob = { ...job, url: 'https://example.test/jobs/first', applyUrl: generic };
  const first = await f.create(firstJob);
  await f.documents(first.applicationId);
  const secondJob = { ...job, url: 'https://example.test/jobs/second', applyUrl: generic };
  const view = await f.resolve({ page: page(generic), jobs: [{ ...secondJob, complete: true }], context: {
    original: { url: secondJob.url, title: job.title, text: job.description, complete: true },
  } });
  assert.notEqual(view.applicationId, first.applicationId);
  assert.ok(view.applicationId);
  assert.ok(view.documents.every(document => !document.ready));
  assert.equal(Object.keys(f.store.get().career.applications).length, 2);
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
