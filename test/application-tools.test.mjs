import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApplicationTools } from '../src/mcp/application-tools.mjs';
import { createProfileTools } from '../src/mcp/profile-tools.mjs';
import { createCareerState, hash } from '../src/mcp/state.mjs';

// Built from this repository's document engine by build:runtime. These
// regressions exercise the real source-baseline, layout and PDF implementations.
const documents = createRequire(import.meta.url)('../src/generated/document-engine.cjs');
const digest = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'career-applications-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let state = { career: createCareerState() }, queue = Promise.resolve();
  const sourceId = randomUUID(), otherSourceId = randomUUID(), factId = randomUUID();
  const sourceText = 'Jane Candidate\njane@example.test\n\nAcme | Engineer | 2018 – 2024\nBuilt reliable data services.\n\nUniversity | Computing | 2014 – 2018\nCompleted a computing degree.';
  state.career.profile.name = 'Jane Candidate';
  state.career.profile.email = 'jane@example.test';
  state.career.sources[sourceId] = { id: sourceId, name: 'Original CV', purpose: 'cv', mediaType: 'text/plain', text: sourceText, contentHash: digest(sourceText), originalBase64: Buffer.from(sourceText).toString('base64'), createdAt: new Date().toISOString() };
  const otherText = 'Maintained operational documentation.\nUnrelated private material.';
  state.career.sources[otherSourceId] = { id: otherSourceId, name: 'Other saved supporting note', purpose: 'supporting', text: otherText, contentHash: digest(otherText), mediaType: 'text/plain', createdAt: new Date().toISOString() };
  state.career.facts[factId] = { id: factId, statement: 'Built reliable data services.', kind: 'achievement', status: 'active', source: { kind: 'document', sourceId, quote: 'Built reliable data services.' }, createdAt: new Date().toISOString(), changedRevision: 0 };
  const store = {
    get: () => structuredClone(state),
    update(change) {
      const work = queue.then(async () => {
        const copy = structuredClone(state);
        await change(copy);
        state = copy;
      });
      queue = work.catch(() => {});
      return work;
    },
  };
  const job = { id: 'node:9001', shortUUID: null, title: 'Platform Engineer', company: 'Example Employer', description: 'Build reliable data services for our platform.', applyUrl: 'https://example.test/apply', contentHash: digest('catalogue-job') };
  const requests = [], exported = [];
  const platform = async (operation, args) => {
    requests.push({ operation, args });
    if (options.platform) return options.platform(operation, args, job);
    if (operation === 'job_read') return structuredClone(job);
    if (operation === 'search_jobs') return { jobs: [structuredClone(job)], nextOffset: null };
    assert.fail(`Unexpected platform operation: ${operation}`);
  };
  const exportDocument = async input => {
    exported.push(input);
    const sha256 = digest(input.bytes), extension = path.extname(input.filename), destination = path.join(directory, `${sha256}${extension}`);
    await writeFile(destination, input.bytes, { mode: 0o600 });
    return { path: destination, sha256, bytes: input.bytes.length, mediaType: input.mediaType, uri: `recruiters://exports/${sha256}${extension}` };
  };
  const tools = new Map(createApplicationTools({ store, platform, documents: options.documents ?? documents, exportDocument }).map(tool => [tool.name, tool]));
  const profileTools = new Map(createProfileTools({ store }).map(tool => [tool.name, tool]));
  const profileCall = (name, args) => profileTools.get(`career_${name}`).invoke(args);
  const call = (name, args = {}) => tools.get(`career_${name}`).invoke(args);
  const mutation = args => ({ requestId: randomUUID(), revision: state.career.revision, ...args });
  const create = args => call('application_create', mutation({ jobId: job.id, sourceId, ...args }));
  const binding = result => ({ applicationId: result.applicationId, sourceId: result.sourceId, jobHash: result.jobHash, evidenceRevision: result.evidenceRevision });
  const candidateRef = { kind: 'fact', factId };
  const saveCv = (app, args = {}) => call('application_cv_save', mutation({ ...binding(app), changes: [], evidence: [candidateRef], ...args }));
  const reviewArgs = (app, kind = 'screening', overrides = {}) => {
    const current = state.career.applications[app.applicationId];
    return { ...binding(app), cvVersion: current.cv.version, kind, score: 65,
      summary: 'Relevant implementation evidence; assess only the stated responsibility.',
      requirements: [{ jobQuote: current.job.description, priority: 'required', coverage: 'supported',
        cvQuote: current.cv.baseline.entries.find(entry => entry.text.includes('Acme')).text,
        evidence: [candidateRef], action: 'none', note: 'The CV describes implementation of reliable data services.' }],
      ...overrides };
  };
  const review = (app, kind, overrides) => call('application_review_save', mutation(reviewArgs(app, kind, overrides)));
  const reviewBoth = async app => { await review(app, 'screening'); return review(app, 'adversarial'); };
  return { store, sourceId, otherSourceId, sourceText, factId, job, requests, exported, call, profileCall, mutation, create, binding, candidateRef, saveCv, tools, reviewArgs, review, reviewBoth };
}

test('real catalogue context scopes sources and saves, edits, exports both documents without losing originals', async t => {
  const f = await fixture(t);
  const app = await f.create();
  assert.deepEqual(f.requests, [{ operation: 'job_read', args: { id: f.job.id } }]);
  const ctx = await f.call('application_context', { applicationId: app.applicationId });
  assert.equal(ctx.application.job.description, f.job.description);
  assert.deepEqual(ctx.sources.map(source => source.id), [f.sourceId]);
  assert.equal(ctx.sources[0].originalBase64, undefined);
  assert.equal(ctx.facts[0].id, f.factId);
  const entry = ctx.application.baseline.entries.find(item => item.text.includes('Acme'));
  const saved = await f.saveCv(app, { changes: [{ entryId: entry.id, text: entry.text.replace('Built reliable data services.', 'Built dependable data services.'), evidence: [f.candidateRef] }] });
  assert.equal(saved.layout.fits, true);
  await f.saveCv(app, { changes: [{ entryId: entry.id, text: entry.text.replace('Built reliable data services.', 'Delivered reliable data services.'), evidence: [f.candidateRef] }] });
  await f.call('application_letter_save', f.mutation({ ...f.binding(app), sections: [
    { id: 'greeting', kind: 'salutation', text: 'Dear hiring team,', evidence: [] },
    { id: 'experience', kind: 'body', text: 'I built reliable data services and would like to contribute to your platform.', evidence: [f.candidateRef, { kind: 'job', quote: 'Build reliable data services' }] },
    { id: 'signature', kind: 'signoff', text: 'Jane Candidate', evidence: [] },
  ] }));
  await f.reviewBoth(app);
  for (const kind of ['cv', 'cover_letter']) {
    const args = f.mutation({ ...f.binding(app), kind });
    const result = await f.call('application_export', args);
    const bytes = await readFile(result.export.path);
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    assert.equal(result.export.sha256, digest(bytes));
    assert.equal(result.export.evidenceRevision, app.evidenceRevision);
    assert.deepEqual(await f.call('application_export', args), result);
  }
  assert.equal(f.exported.length, 2, 'exact mutation replay does not republish PDFs');
  const current = (await f.call('application_read', { applicationId: app.applicationId })).application;
  assert.equal(current.cvHistory.length, 1);
  assert.equal(current.cvHistory[0].baseline.entries.find(item => item.id === entry.id).text.includes('dependable'), true);
  assert.equal(current.cv.baseline.entries.map(item => item.original).join(''), f.sourceText);
  assert.equal(Buffer.from(f.store.get().career.sources[f.sourceId].originalBase64, 'base64').toString(), f.sourceText);
});

test('canonical IDs pin distinct complete jobs despite missing or duplicate public aliases', async t => {
  const jobs = ['node:9001', 'node:9002', 'node:9003'].map((id, index) => {
    const description = `  Original ad for ${id}\n${'Complete requirements and conditions. '.repeat(6000)}\nFinal condition.  \n\nSecond original ad for ${id}.`;
    return { id, shortUUID: index === 0 ? null : 'duplicate-public-id', title: 'Platform Engineer', company: 'Example Employer', description, contentHash: digest(description) };
  });
  const f = await fixture(t, { platform(operation, args) {
    assert.equal(operation, 'job_read');
    return structuredClone(jobs.find(job => job.id === args.id));
  } });
  for (const job of jobs) {
    assert.deepEqual(await f.call('job_read', { id: job.id }), job);
    const app = await f.create({ jobId: job.id });
    const context = await f.call('application_context', { applicationId: app.applicationId });
    assert.deepEqual(context.application.job, job);
    assert.equal(app.jobHash, job.contentHash);
    assert.equal(context.application.sourceId, f.sourceId);
  }
  assert.equal(Object.keys(f.store.get().career.applications).length, jobs.length);
});

test('application selection preserves unambiguous public reads but never accepts a different returned job ID', async t => {
  const legacy = await fixture(t, { platform(operation, args, job) {
    assert.equal(operation, 'job_read');
    assert.equal(args.id, 'unique-public-id');
    return { ...job, id: args.id, shortUUID: args.id };
  } });
  const app = await legacy.create({ jobId: 'unique-public-id' });
  const context = await legacy.call('application_context', { applicationId: app.applicationId });
  assert.equal(context.application.job.id, 'unique-public-id');
  for (const returnedId of ['duplicate-public-id', 'node:9002']) {
    const f = await fixture(t, { platform: (_operation, _args, job) => ({ ...job, id: returnedId }) });
    const before = f.store.get();
    await assert.rejects(f.create(), { code: 'INVALID_JOB' });
    assert.deepEqual(f.store.get(), before);
  }
});

test('source/job conflicts and ungrounded references reject without altering saved work', async t => {
  const f = await fixture(t), app = await f.create();
  const before = f.store.get();
  await assert.rejects(f.saveCv(app, { sourceId: f.otherSourceId }), { code: 'BINDING_CONFLICT' });
  await assert.rejects(f.saveCv(app, { jobHash: digest('another job') }), { code: 'BINDING_CONFLICT' });
  await assert.rejects(f.saveCv(app, { evidence: [{ kind: 'source', sourceId: f.otherSourceId, quote: 'Unrelated private material.' }] }), { code: 'INVALID_EVIDENCE' });
  await assert.rejects(f.saveCv(app, { evidence: [{ kind: 'source', sourceId: f.sourceId, quote: 'Invented qualification' }] }), { code: 'INVALID_EVIDENCE' });
  assert.deepEqual(f.store.get(), before);
});

test('dated history and full baseline ordering cannot be removed by a tailored rewrite', async t => {
  const f = await fixture(t), app = await f.create();
  const ctx = await f.call('application_context', { applicationId: app.applicationId });
  const entry = ctx.application.baseline.entries.find(item => item.text.includes('Acme'));
  await assert.rejects(f.saveCv(app, { changes: [{ entryId: entry.id, text: 'Built reliable data services.', evidence: [f.candidateRef] }] }), { code: 'CAREER_CONTINUITY' });
  await assert.rejects(f.saveCv(app, { order: [entry.id] }), /every current entry exactly once/);
  await assert.rejects(f.saveCv(app, { changes: [{ entryId: 'not-a-source-entry', text: 'Added a job.', evidence: [f.candidateRef] }] }), /current CV source entry/);
});

test('evidence edits invalidate exports; explicit refresh archives old wording rather than silently revalidating it', async t => {
  const f = await fixture(t), app = await f.create();
  await f.saveCv(app);
  await f.store.update(state => { state.career.facts[f.factId].status = 'retracted'; state.career.evidenceRevision++; state.career.revision++; });
  await assert.rejects(f.call('application_export', f.mutation({ ...f.binding(app), kind: 'cv' })), { code: 'SOURCE_STALE' });
  assert.equal(f.exported.length, 0);
  const ctx = await f.call('application_context', { applicationId: app.applicationId });
  assert.equal(ctx.application.stale, true);
  assert.equal(ctx.facts[0].status, 'retracted');
  const { evidenceRevision, ...refreshBinding } = f.binding(app);
  const refresh = await f.call('application_refresh', f.mutation(refreshBinding));
  assert.equal(refresh.evidenceRevision, evidenceRevision + 1);
  const current = (await f.call('application_read', { applicationId: app.applicationId })).application;
  assert.equal(current.cv, null);
  assert.equal(current.cvHistory.length, 1);
  await assert.rejects(f.call('application_export', f.mutation({ ...f.binding(app), evidenceRevision: refresh.evidenceRevision, kind: 'cv' })), { code: 'MISSING_DRAFT' });
});

test('immutable source pins detect unexpected text edits even without an evidence revision bump', async t => {
  const f = await fixture(t), app = await f.create();
  await f.saveCv(app);
  await f.store.update(state => { state.career.sources[f.sourceId].text += '\nChanged source'; });
  await assert.rejects(f.call('application_export', f.mutation({ ...f.binding(app), kind: 'cv' })), { code: 'SOURCE_STALE' });
  assert.equal(f.exported.length, 0);
});

test('fact mutation during real PDF rendering cannot publish a current export', async t => {
  let rendered, proceed;
  const rendering = new Promise(resolve => { rendered = resolve; });
  const resume = new Promise(resolve => { proceed = resolve; });
  const f = await fixture(t, { documents: { ...documents, async renderCareerCvPdf(input) {
    const pdf = await documents.renderCareerCvPdf(input);
    rendered();
    await resume;
    return pdf;
  } } });
  const app = await f.create();
  await f.saveCv(app);
  await f.reviewBoth(app);
  const exporting = f.call('application_export', f.mutation({ ...f.binding(app), kind: 'cv' }));
  await rendering;
  await f.store.update(state => { state.career.evidenceRevision++; state.career.revision++; });
  proceed();
  await assert.rejects(exporting, { code: 'REVISION_CONFLICT' });
  assert.equal(f.exported.length, 0);
});

test('no-CV baseline records only attributed facts and rejects corrected interview history', async t => {
  const f = await fixture(t), experienceId = randomUUID();
  await f.store.update(state => {
    state.career.facts[experienceId] = { id: experienceId, kind: 'experience', statement: 'I worked as Engineer at Acme from 2018 to 2024.', employer: 'Acme', role: 'Engineer', startDate: '2018', endDate: '2024', status: 'active', source: { kind: 'conversation', quote: 'I worked as Engineer at Acme from 2018 to 2024.' }, createdAt: new Date().toISOString(), changedRevision: 0 };
  });
  const app = await f.create({ sourceId: undefined });
  assert.notEqual(app.sourceId, f.sourceId);
  assert.equal(app.evidenceRevision, 1);
  const ctx = await f.call('application_context', { applicationId: app.applicationId });
  const source = ctx.sources.find(item => item.id === app.sourceId);
  assert.equal(source.provenance.kind, 'attributed_facts');
  assert.equal(source.purpose, 'interview');
  assert.deepEqual(Object.keys(source.provenance.factPins).sort(), [f.factId, experienceId].sort());
  assert.equal(source.text.includes('University'), false, 'history absent from attributed facts is never invented from unrelated CV text');
  await f.saveCv(app, { evidence: [{ kind: 'fact', factId: experienceId }, f.candidateRef] });
  await f.reviewBoth(app);
  await f.call('application_export', f.mutation({ ...f.binding(app), kind: 'cv' }));
  await f.store.update(state => { state.career.facts[experienceId].status = 'superseded'; state.career.evidenceRevision++; state.career.revision++; });
  const { evidenceRevision, ...refreshBinding } = f.binding(app);
  await assert.rejects(f.call('application_refresh', f.mutation(refreshBinding)), { code: 'SOURCE_STALE' });
  assert.equal(f.store.get().career.sources[app.sourceId].text, source.text);
});

test('no-CV creation without attributed facts fails instead of manufacturing a resume', async t => {
  const f = await fixture(t);
  await f.store.update(state => { state.career.facts = {}; });
  const before = f.store.get();
  await assert.rejects(f.create({ sourceId: undefined }), { code: 'MISSING_EVIDENCE' });
  assert.deepEqual(f.store.get(), before);
});

test('long relevant layouts remain readable beyond two pages without truncation or a page cap', async t => {
  const f = await fixture(t), app = await f.create();
  const ctx = await f.call('application_context', { applicationId: app.applicationId });
  const entry = ctx.application.baseline.entries.find(item => item.text.includes('Acme'));
  const long = `${entry.text}\n${'Built reliable data services with careful operational documentation. '.repeat(230)}`;
  const saved = await f.saveCv(app, { changes: [{ entryId: entry.id, text: long, evidence: [f.candidateRef] }] });
  assert.equal(saved.layout.fits, true);
  assert.equal(saved.layout.fontSize, 11);
  assert.equal(saved.layout.maxPages, null);
  assert.ok(saved.layout.pages > 2);
  assert.equal(f.store.get().career.applications[app.applicationId].cv.baseline.entries.find(item => item.id === entry.id).text, long);
  await f.reviewBoth(app);
  const result = await f.call('application_export', f.mutation({ ...f.binding(app), kind: 'cv' }));
  const bytes = await readFile(result.export.path);
  const extracted = await documents.extractFile({ buffer: bytes, size: bytes.length, originalname: 'long.pdf', mimetype: 'application/pdf' });
  assert.match(extracted.text, /University/);
  assert.equal((extracted.text.match(/careful\s+operational\s+documentation/g) ?? []).length, 230);
  assert.equal(f.exported.length, 1);
});

test('optional questions link candidate answers through facts, with refresh required after interview changes', async t => {
  const f = await fixture(t), app = await f.create(), questionId = randomUUID(), answerId = randomUUID();
  await f.call('application_questions_save', f.mutation({ ...f.binding(app), questions: [{ id: questionId, question: 'Have you operated data pipelines?', reason: 'The job concerns data services.' }] }));
  await f.store.update(state => {
    state.career.facts[answerId] = { id: answerId, statement: 'I operated batch data pipelines.', kind: 'skill', status: 'active', source: { kind: 'conversation', quote: 'I operated batch data pipelines.', conversationId: 'chat-1', messageId: 'answer-1' }, createdAt: new Date().toISOString(), changedRevision: state.career.revision + 1 };
    state.career.evidenceRevision++;
    state.career.revision++;
  });
  await assert.rejects(f.call('application_question_answer', f.mutation({ ...f.binding(app), questionId, factIds: [answerId] })), { code: 'SOURCE_STALE' });
  const { evidenceRevision, ...refreshBinding } = f.binding(app);
  const refreshed = await f.call('application_refresh', f.mutation(refreshBinding));
  const answered = await f.call('application_question_answer', f.mutation({ ...f.binding(app), evidenceRevision: refreshed.evidenceRevision, questionId, factIds: [answerId] }));
  assert.deepEqual(answered.question.factIds, [answerId]);
  assert.equal(f.store.get().career.facts[answerId].source.quote, 'I operated batch data pipelines.');
});


test('refresh cannot turn profile values derived from retracted facts into current document headings', async t => {
  const f = await fixture(t);
  await f.store.update(state => {
    state.career.profile.fieldSources.name = { kind: 'fact', factId: f.factId };
  });
  const app = await f.create();
  await f.saveCv(app);
  await f.reviewBoth(app);
  const exported = await f.call('application_export', f.mutation({ ...f.binding(app), kind: 'cv' }));
  await f.store.update(state => {
    state.career.facts[f.factId].status = 'retracted';
    state.career.evidenceRevision++;
    state.career.revision++;
  });
  const current = (await f.call('application_read', { applicationId: app.applicationId })).application;
  assert.equal(current.exports[0].current, false);
  assert.equal(current.exports[0].sha256, exported.export.sha256, 'historical export remains recoverable');
  const { evidenceRevision, ...refreshBinding } = f.binding(app);
  await assert.rejects(f.call('application_refresh', f.mutation(refreshBinding)), { code: 'SOURCE_STALE' });
  await f.store.update(state => {
    state.career.profile.fieldSources.name = { kind: 'explicit' };
    state.career.evidenceRevision++;
    state.career.revision++;
  });
  await f.call('application_refresh', f.mutation(refreshBinding));
  assert.equal(f.store.get().career.applications[app.applicationId].cv, null);
});

test('explicit profile header edits and clears reach real PDFs while source headers remain recoverable', async t => {
  const f = await fixture(t);
  await f.store.update(state => {
    const source = state.career.sources[f.sourceId];
    source.text = source.text.replace('jane@example.test\n\n', 'jane@example.test\nLONDON\n\n');
    source.contentHash = digest(source.text);
    source.originalBase64 = Buffer.from(source.text).toString('base64');
    state.career.profile.location = 'LONDON';
  });
  const original = f.store.get().career.sources[f.sourceId];
  await f.profileCall('profile_update', f.mutation({
    mode: 'explicit', patch: { name: 'Janet Current', email: 'current@example.test', location: 'Amsterdam' },
  }));
  const app = await f.create();
  await f.saveCv(app);
  await f.reviewBoth(app);
  let result = await f.call('application_export', f.mutation({ ...f.binding(app), kind: 'cv' }));
  let bytes = await readFile(result.export.path);
  let extracted = await documents.extractFile({ buffer: bytes, size: bytes.length, originalname: 'current.pdf', mimetype: 'application/pdf' });
  assert.match(extracted.text, /Janet Current/);
  assert.match(extracted.text, /current@example\.test/);
  assert.match(extracted.text, /Amsterdam/);
  assert.doesNotMatch(extracted.text, /Jane Candidate|jane@example\.test|LONDON/);
  await f.profileCall('profile_update', f.mutation({ mode: 'explicit', patch: { name: null, email: null, location: null } }));
  const { evidenceRevision, ...refreshBinding } = f.binding(app);
  const refreshed = await f.call('application_refresh', f.mutation(refreshBinding));
  const current = { ...app, evidenceRevision: refreshed.evidenceRevision };
  await f.saveCv(current);
  await f.reviewBoth(current);
  result = await f.call('application_export', f.mutation({ ...f.binding(current), kind: 'cv' }));
  bytes = await readFile(result.export.path);
  extracted = await documents.extractFile({ buffer: bytes, size: bytes.length, originalname: 'cleared.pdf', mimetype: 'application/pdf' });
  assert.doesNotMatch(extracted.text, /Jane Candidate|Janet Current|jane@example\.test|current@example\.test|LONDON|Amsterdam/);
  assert.match(extracted.text, /Acme/);
  assert.match(extracted.text, /University/);
  assert.deepEqual(f.store.get().career.sources[f.sourceId], original);
});

test('attributable multi-step career corrections replace wrong source dates without dropping history', async t => {
  const f = await fixture(t);
  const originalLine = 'Acme | Engineer | 2018 – 2024';
  const added = await f.profileCall('facts_add', f.mutation({ facts: [{
    kind: 'experience', statement: 'Worked at Acme as Engineer from 2018 to 2024.',
    employer: 'Acme', role: 'Engineer', startDate: '2018', endDate: '2024',
    source: { kind: 'document', sourceId: f.sourceId, quote: originalLine },
  }] }));
  const originalFact = added.facts[0];
  const app = await f.create();
  await f.saveCv(app, { evidence: [f.candidateRef, { kind: 'fact', factId: originalFact.id }] });
  const first = await f.profileCall('fact_correct', f.mutation({
    factId: originalFact.id, reason: 'Candidate corrected the start year.',
    replacement: { kind: 'experience', statement: 'Worked at Acme as Engineer from 2019 to 2024.',
      employer: 'Acme', role: 'Engineer', startDate: '2019', endDate: '2024',
      source: { kind: 'conversation', quote: 'My Acme start year was 2019, not 2018.' } },
  }));
  const second = await f.profileCall('fact_correct', f.mutation({
    factId: first.fact.id, reason: 'Candidate corrected the end year too.',
    replacement: { kind: 'experience', statement: 'Worked at Acme as Engineer from 2019 to 2025.',
      employer: 'Acme', role: 'Engineer', startDate: '2019', endDate: '2025',
      source: { kind: 'conversation', quote: 'I remained at Acme until 2025.' } },
  }));
  const { evidenceRevision, ...refreshBinding } = f.binding(app);
  const refreshed = await f.call('application_refresh', f.mutation(refreshBinding));
  const current = { ...app, evidenceRevision: refreshed.evidenceRevision };
  const ctx = await f.call('application_context', { applicationId: app.applicationId });
  assert.equal(ctx.factHistory.some(fact => fact.id === originalFact.id && fact.source.quote === originalLine), true);
  const entry = ctx.application.baseline.entries.find(item => item.text.includes(originalLine));
  const correctedText = entry.text.replace(originalLine, 'Acme | Engineer | 2019 – 2025');
  const correctionRef = { kind: 'fact', factId: second.fact.id };
  await assert.rejects(f.saveCv(current, {
    changes: [{ entryId: entry.id, text: correctedText, evidence: [f.candidateRef] }],
  }), { code: 'CAREER_CONTINUITY' });
  await assert.rejects(f.saveCv(current, {
    changes: [{ entryId: entry.id, text: `${correctedText}\n${originalLine}`, evidence: [correctionRef] }],
    evidence: [correctionRef],
  }), { code: 'CAREER_CONTINUITY' });
  await f.saveCv(current, {
    changes: [{ entryId: entry.id, text: correctedText, evidence: [correctionRef] }],
    evidence: [f.candidateRef, correctionRef],
  });
  await f.reviewBoth(current);
  const result = await f.call('application_export', f.mutation({ ...f.binding(current), kind: 'cv' }));
  const bytes = await readFile(result.export.path);
  const extracted = await documents.extractFile({ buffer: bytes, size: bytes.length, originalname: 'corrected.pdf', mimetype: 'application/pdf' });
  assert.match(extracted.text, /2019\s*[–-]\s*2025/);
  assert.match(extracted.text, /University/);
  assert.doesNotMatch(extracted.text, /2018\s*[–-]\s*2024/);
  const state = f.store.get().career;
  assert.equal(state.sources[f.sourceId].text, f.sourceText);
  assert.equal(state.applications[app.applicationId].cv.baseline.entries.find(item => item.id === entry.id).original, entry.text);
  assert.equal(state.applications[app.applicationId].cvHistory.length, 1);
});

test('a fresh career fact cannot authorize changing dates without exact document supersession', async t => {
  const f = await fixture(t);
  const added = await f.profileCall('facts_add', f.mutation({ facts: [{
    kind: 'experience', statement: 'Worked at Acme as Engineer from 2019 to 2024.',
    employer: 'Acme', role: 'Engineer', startDate: '2019', endDate: '2024',
    source: { kind: 'conversation', quote: 'I worked at Acme from 2019 to 2024.' },
  }] }));
  const app = await f.create();
  const ctx = await f.call('application_context', { applicationId: app.applicationId });
  const entry = ctx.application.baseline.entries.find(item => item.text.includes('Acme'));
  const ref = { kind: 'fact', factId: added.facts[0].id };
  await assert.rejects(f.saveCv(app, {
    changes: [{ entryId: entry.id, text: entry.text.replace('2018 – 2024', '2019 – 2024'), evidence: [ref] }],
    evidence: [ref],
  }), { code: 'CAREER_CONTINUITY' });
});

test('partial date quotes cannot authorize retaining contradictory superseded career lines', async t => {
  const f = await fixture(t);
  const added = await f.profileCall('facts_add', f.mutation({ facts: [{
    kind: 'experience', statement: 'Worked at Acme as Engineer from 2018 to 2024.',
    employer: 'Acme', role: 'Engineer', startDate: '2018', endDate: '2024',
    source: { kind: 'document', sourceId: f.sourceId, quote: '2018' },
  }] }));
  const corrected = await f.profileCall('fact_correct', f.mutation({
    factId: added.facts[0].id, reason: 'Correct start year.',
    replacement: { kind: 'experience', statement: 'Worked at Acme as Engineer from 2019 to 2024.',
      employer: 'Acme', role: 'Engineer', startDate: '2019', endDate: '2024',
      source: { kind: 'conversation', quote: 'My start year was 2019.' } },
  }));
  const app = await f.create();
  const ctx = await f.call('application_context', { applicationId: app.applicationId });
  const entry = ctx.application.baseline.entries.find(item => item.text.includes('Acme'));
  const ref = { kind: 'fact', factId: corrected.fact.id };
  await assert.rejects(f.saveCv(app, {
    changes: [{ entryId: entry.id, text: `${entry.text}\nAcme | Engineer | 2019 – 2024`, evidence: [ref] }],
    evidence: [ref],
  }), { code: 'CAREER_CONTINUITY' });
});

test('CV export needs distinct review kinds and a final current-draft pass; replays cannot manufacture passes', async t => {
  const f = await fixture(t), app = await f.create();
  await f.saveCv(app);
  const release = () => f.call('application_export', f.mutation({ ...f.binding(app), kind: 'cv' }));
  await assert.rejects(release(), { code: 'CV_REVIEW_REQUIRED' });
  const args = f.mutation(f.reviewArgs(app));
  const first = await f.call('application_review_save', args);
  assert.equal(first.reviewReadiness.ready, false);
  assert.deepEqual(await f.call('application_review_save', args), first);
  const duplicate = await f.review(app, 'screening');
  assert.equal(duplicate.duplicate, true);
  assert.equal(f.store.get().career.applications[app.applicationId].reviews.length, 1);
  await assert.rejects(release(), { code: 'CV_REVIEW_REQUIRED' });
  const final = await f.review(app, 'adversarial');
  assert.equal(final.reviewReadiness.ready, true);
  await f.saveCv(app);
  await assert.rejects(release(), { code: 'CV_REVIEW_REQUIRED' });
  await assert.rejects(f.review(app, 'adversarial', { cvVersion: 1 }), { code: 'CV_REVIEW_STALE' });
  await f.review(app, 'adversarial', { score: 0 });
  await release();
  assert.equal(f.exported.length, 1, 'no score threshold is imposed');
  assert.deepEqual(f.requests, [{ operation: 'job_read', args: { id: f.job.id } }], 'private sources, drafts and reviews never upload');
});

test('review coverage must quote the actual job and current CV, reference scoped candidate facts and retain earlier gaps', async t => {
  const f = await fixture(t), app = await f.create();
  await f.saveCv(app);
  const requirement = f.reviewArgs(app).requirements[0];
  for (const patch of [
    { jobQuote: 'Invented requirement' }, { cvQuote: 'Built invented projects' },
    { cvQuote: '' }, { evidence: [] }, { evidence: [{ kind: 'job', quote: f.job.description }] },
    { coverage: 'unknown', action: 'none' },
  ]) {
    await assert.rejects(f.review(app, 'screening', { requirements: [{ ...requirement, ...patch }] }),
      error => ['INVALID_REVIEW', 'INVALID_EVIDENCE'].includes(error.code));
  }
  await f.review(app, 'screening', { requirements: [{ ...requirement, action: 'revise', note: 'Make personal implementation clearer.' }] });
  await assert.rejects(f.review(app, 'adversarial', { requirements: [{ ...requirement, jobQuote: 'data services' }] }), { code: 'INVALID_REVIEW' });
  await f.review(app, 'adversarial', { requirements: [{ ...requirement, action: 'revise', note: 'The same rewrite is still actionable.' }] });
  await assert.rejects(f.call('application_export', f.mutation({ ...f.binding(app), kind: 'cv' })), { code: 'CV_REVIEW_REQUIRED' });
  const ctx = await f.call('application_context', { applicationId: app.applicationId });
  const entry = ctx.application.cv.baseline.entries.find(item => item.text.includes('Acme'));
  await f.saveCv(app, { changes: [{ entryId: entry.id, text: entry.text.replace('Built reliable', 'Implemented reliable'), evidence: [f.candidateRef] }] });
  await assert.rejects(f.review(app, 'adversarial', { requirements: [{ ...requirement, cvQuote: 'Built reliable data services.' }] }), { code: 'INVALID_REVIEW' });
  await f.review(app, 'adversarial');
  await f.call('application_export', f.mutation({ ...f.binding(app), kind: 'cv' }));
});

test('honest unresolvable requirements do not block release or leak review commentary into the PDF', async t => {
  const f = await fixture(t), app = await f.create();
  await f.saveCv(app);
  const requirements = [{ jobQuote: f.job.description, priority: 'required', coverage: 'unmet', cvQuote: '', evidence: [],
    action: 'unresolvable', note: 'Known unmet: this broader platform remit is not established by the candidate evidence.' }];
  await f.review(app, 'screening', { requirements, score: null });
  const final = await f.review(app, 'adversarial', { requirements, score: null });
  assert.equal(final.reviewReadiness.ready, true);
  assert.equal(final.reviewReadiness.unresolvableGaps.length, 1);
  const result = await f.call('application_export', f.mutation({ ...f.binding(app), kind: 'cv' }));
  const bytes = await readFile(result.export.path);
  const extracted = await documents.extractFile({ buffer: bytes, size: bytes.length, originalname: 'honest.pdf', mimetype: 'application/pdf' });
  assert.match(extracted.text, /Built reliable data services/);
  assert.doesNotMatch(extracted.text, /Known unmet|unresolvable|candidate evidence|screening|adversarial/);
});

test('unanswered material questions and ask-candidate review actions prevent release without fabricated answers', async t => {
  const f = await fixture(t), app = await f.create(), questionId = randomUUID();
  await f.saveCv(app);
  await f.reviewBoth(app);
  await f.call('application_questions_save', f.mutation({ ...f.binding(app), questions: [{ id: questionId,
    question: 'Did you own production operations?', reason: 'Clarify operational responsibility.' }] }));
  const release = () => f.call('application_export', f.mutation({ ...f.binding(app), kind: 'cv' }));
  await assert.rejects(release(), { code: 'CV_REVIEW_REQUIRED' });
  const requirement = { ...f.reviewArgs(app).requirements[0], coverage: 'partial', action: 'ask_candidate', note: 'Clarify ownership.' };
  await f.review(app, 'adversarial', { requirements: [requirement] });
  await f.call('application_questions_save', f.mutation({ ...f.binding(app), questions: [] }));
  await assert.rejects(release(), { code: 'CV_REVIEW_REQUIRED' });
  await f.review(app, 'adversarial', { requirements: [{ ...requirement, action: 'unresolvable', note: 'Candidate cannot establish additional operational ownership; do not claim it.' }] });
  await release();
});

test('stale evidence invalidates both passes after explicit refresh while preserving review history', async t => {
  const f = await fixture(t), app = await f.create();
  await f.saveCv(app);
  await f.reviewBoth(app);
  await f.profileCall('facts_add', f.mutation({ facts: [{ kind: 'skill', statement: 'Used SQL.',
    source: { kind: 'conversation', quote: 'I used SQL.', conversationId: 'another-conversation' } }] }));
  await assert.rejects(f.review(app, 'adversarial'), { code: 'SOURCE_STALE' });
  await assert.rejects(f.call('application_export', f.mutation({ ...f.binding(app), kind: 'cv' })), { code: 'SOURCE_STALE' });
  const refreshed = await f.call('application_refresh', f.mutation({ applicationId: app.applicationId, sourceId: app.sourceId, jobHash: app.jobHash }));
  const current = { ...app, evidenceRevision: refreshed.evidenceRevision };
  await f.saveCv(current);
  const onePass = await f.review(current, 'adversarial');
  assert.deepEqual(onePass.reviewReadiness.kinds, ['adversarial']);
  assert.equal(onePass.reviewReadiness.ready, false);
  await assert.rejects(f.call('application_export', f.mutation({ ...f.binding(current), kind: 'cv' })), { code: 'CV_REVIEW_REQUIRED' });
  await f.review(current, 'screening');
  await f.call('application_export', f.mutation({ ...f.binding(current), kind: 'cv' }));
  assert.equal(f.store.get().career.applications[app.applicationId].reviews.length, 4);
});

for (const changedScope of [true, false]) {
  test(`${changedScope ? 'changed selected evidence' : 'same-scope explicit'} refresh requires both fresh review kinds without reviving old receipts or dropping gaps`, async t => {
    const f = await fixture(t);
    const added = await f.profileCall('facts_add', f.mutation({ facts: [{
      kind: 'skill', statement: 'Maintained operational documentation.',
      source: { kind: 'document', sourceId: f.otherSourceId, quote: 'Maintained operational documentation.' },
    }] }));
    const additionalFactId = added.facts[0].id;
    const app = await f.create();
    await f.saveCv(app);
    const gap = { jobQuote: 'our platform', priority: 'preferred', coverage: 'unknown', cvQuote: '', evidence: [],
      action: 'unresolvable', note: 'Experience with this particular platform is not established; do not invent it.' };
    const requirements = [...f.reviewArgs(app).requirements, gap];
    await f.review(app, 'screening', { requirements });
    const oldArgs = f.mutation(f.reviewArgs(app, 'adversarial', { requirements }));
    const oldReceipt = await f.call('application_review_save', oldArgs);
    assert.equal(oldReceipt.reviewReadiness.ready, true);
    const before = f.store.get().career;
    const oldReviews = before.applications[app.applicationId].reviews;
    const refreshArgs = f.mutation({ applicationId: app.applicationId, sourceId: app.sourceId, jobHash: app.jobHash,
      ...(changedScope ? { factIds: [additionalFactId] } : {}) });
    const refreshed = await f.call('application_refresh', refreshArgs);
    assert.equal(refreshed.evidenceRevision, app.evidenceRevision);
    assert.equal(f.store.get().career.evidenceRevision, before.evidenceRevision, 'selecting existing evidence does not mutate global facts');
    assert.deepEqual(f.store.get().career.facts, before.facts);
    let current = (await f.call('application_read', { applicationId: app.applicationId })).application;
    assert.equal(current.cv, null);
    assert.deepEqual(current.additionalFactIds, changedScope ? [additionalFactId] : []);
    assert.deepEqual(current.reviews, oldReviews.map(review => ({ ...review, invalidated: true })));
    assert.deepEqual(current.reviewReadiness.kinds, []);
    assert.equal(current.reviewReadiness.ready, false);
    const ctx = await f.call('application_context', { applicationId: app.applicationId });
    assert.equal(ctx.facts.some(fact => fact.id === additionalFactId), changedScope);

    const draft = await f.saveCv(app);
    assert.equal(draft.cvVersion, oldReceipt.review.cvVersion + 1);
    const release = () => f.call('application_export', f.mutation({ ...f.binding(app), kind: 'cv' }));
    await assert.rejects(release(), { code: 'CV_REVIEW_REQUIRED' });
    const beforeReplay = f.store.get();
    assert.deepEqual(await f.call('application_review_save', oldArgs), oldReceipt, 'old receipt replay stays historical');
    assert.deepEqual(f.store.get(), beforeReplay, 'replaying a ready receipt cannot revive invalidated passes');
    await assert.rejects(f.call('application_review_save', f.mutation({ ...oldArgs, requestId: randomUUID(), revision: beforeReplay.career.revision })),
      { code: 'CV_REVIEW_STALE' });
    await assert.rejects(f.review(app, 'adversarial'), { code: 'INVALID_REVIEW' });
    const freshArgs = f.mutation(f.reviewArgs(app, 'adversarial', { requirements }));
    const onePass = await f.call('application_review_save', freshArgs);
    assert.equal(onePass.duplicate, false);
    assert.notEqual(onePass.review.id, oldReceipt.review.id);
    assert.deepEqual(onePass.reviewReadiness.kinds, ['adversarial']);
    assert.equal(onePass.reviewReadiness.ready, false);
    assert.deepEqual(onePass.reviewReadiness.unresolvableGaps, [gap]);
    assert.deepEqual(await f.call('application_review_save', freshArgs), onePass);
    const duplicate = await f.review(app, 'adversarial', { requirements });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.review.id, onePass.review.id);
    assert.equal(duplicate.reviewReadiness.ready, false);
    await assert.rejects(release(), { code: 'CV_REVIEW_REQUIRED' });

    const beforeRefreshReplay = f.store.get();
    assert.deepEqual(await f.call('application_refresh', refreshArgs), refreshed);
    assert.deepEqual(f.store.get(), beforeRefreshReplay, 'refresh receipt replay cannot reset the new draft or invalidate fresh reviews');
    const both = await f.review(app, 'screening', { requirements });
    assert.equal(both.reviewReadiness.ready, true);
    assert.deepEqual(both.reviewReadiness.unresolvableGaps, [gap]);
    await release();
    current = (await f.call('application_read', { applicationId: app.applicationId })).application;
    assert.equal(current.reviews.length, 4);
    assert.deepEqual(current.reviews.slice(0, 2), oldReviews.map(review => ({ ...review, invalidated: true })));
    assert.equal(current.reviews.slice(2).every(review => !review.invalidated), true);
    assert.equal(f.exported.length, 1);
  });
}

test('CV tone diagnostics require rewrites, preserve original prose and allow legitimate reports', async t => {
  const f = await fixture(t), app = await f.create();
  const ctx = await f.call('application_context', { applicationId: app.applicationId });
  const entry = ctx.application.baseline.entries.find(item => item.text.includes('Acme'));
  for (const wording of ['CV reports 7+ years.', 'Reports7years of experience.', 'Candidate claims platform ownership.',
    'Reportedly built reliable services.', 'She managed the platform.', 'According to the source, built services.',
    'Allegedly led platform delivery.', 'Purportedly managed the platform.', 'Self-reported 7 years of experience.',
    'Self-reported experience building platforms.', '• Purportedly developed data services.']) {
    await assert.rejects(f.saveCv(app, { changes: [{ entryId: entry.id, text: `${entry.text}\n${wording}`, evidence: [f.candidateRef] }] }),
      error => error.code === 'CV_TONE' && error.message.includes(entry.id) && error.message.includes('Rewrite'));
  }
  assert.equal(f.store.get().career.applications[app.applicationId].cv, null);
  assert.equal(f.store.get().career.sources[f.sourceId].text, f.sourceText);
  const savedFacts = await f.profileCall('facts_add', f.mutation({ facts: [{ kind: 'achievement',
    statement: 'Managed direct reports and delivered financial reports. Analyzed self-reported survey data.', source: { kind: 'conversation',
      quote: 'I managed direct reports and delivered financial reports. I analyzed self-reported survey data.' } }] }));
  const refreshed = await f.call('application_refresh', f.mutation({ applicationId: app.applicationId, jobHash: app.jobHash, sourceId: app.sourceId }));
  const current = { ...app, evidenceRevision: refreshed.evidenceRevision };
  await f.saveCv(current, { changes: [{ entryId: entry.id, text: `${entry.text}\nManaged direct reports and delivered financial reports.\nAnalyzed self-reported survey data.`,
    evidence: [{ kind: 'fact', factId: savedFacts.facts[0].id }] }] });
  await f.reviewBoth(current);
  await f.call('application_export', f.mutation({ ...f.binding(current), kind: 'cv' }));
  await f.store.update(state => { state.career.applications[app.applicationId].cv.baseline.entries.find(item => item.id === entry.id).text += '\nCandidate reports 7 years.'; });
  await assert.rejects(f.call('application_export', f.mutation({ ...f.binding(current), kind: 'cv' })), { code: 'CV_TONE' });
});

test('full local corpus and new-conversation answers can be explicitly refreshed into another CV without losing private source history', async t => {
  const f = await fixture(t), app = await f.create(), questionId = randomUUID();
  await f.saveCv(app);
  await f.reviewBoth(app);
  await f.call('application_questions_save', f.mutation({ ...f.binding(app), questions: [{ id: questionId,
    question: 'Did you improve batch service reliability?', reason: 'A relevant operational outcome is missing.' }] }));
  const other = await f.profileCall('facts_add', f.mutation({ facts: [{ kind: 'skill', statement: 'Maintained documentation.',
    source: { kind: 'document', sourceId: f.otherSourceId, quote: 'Maintained operational documentation.' } }] }));
  const conversation = await f.profileCall('facts_add', f.mutation({ facts: [{ kind: 'achievement', statement: 'Reduced batch failures by 30%.',
    source: { kind: 'conversation', quote: 'I reduced batch failures by 30%.', conversationId: 'new-conversation', messageId: 'confirmed-answer' } }] }));
  const corrected = await f.profileCall('fact_correct', f.mutation({ factId: other.facts[0].id, reason: 'Restore the more precise wording from the saved document.',
    replacement: { kind: 'skill', statement: 'Maintained operational documentation.',
      source: { kind: 'document', sourceId: f.otherSourceId, quote: 'Maintained operational documentation.' } } }));
  const currentContext = await f.call('application_context', { applicationId: app.applicationId });
  assert.equal(currentContext.application.stale, true);
  assert.ok(currentContext.corpus.tools.includes('career_facts_list'));
  assert.match(currentContext.reviewCriteria.dimensions, /Direct|direct/);
  assert.match(currentContext.reviewCriteria.dimensions, /keyword matching/);
  assert.doesNotMatch(JSON.stringify(currentContext.reviewCriteria), /isolated FIT stage|OUTPUT CONTRACT/);
  const found = await f.profileCall('facts_list', { query: 'operational documentation' });
  assert.equal(found.items[0].id, corrected.fact.id);
  const factIds = [corrected.fact.id, conversation.facts[0].id];
  await assert.rejects(f.call('application_question_answer', f.mutation({ ...f.binding(app), questionId, factIds: [conversation.facts[0].id] })), { code: 'SOURCE_STALE' });
  const refreshed = await f.call('application_refresh', f.mutation({ applicationId: app.applicationId, jobHash: app.jobHash, sourceId: app.sourceId, factIds }));
  const current = { ...app, evidenceRevision: refreshed.evidenceRevision };
  const ctx = await f.call('application_context', { applicationId: app.applicationId });
  assert.ok(ctx.sources.some(source => source.id === f.otherSourceId));
  assert.ok(ctx.factHistory.some(fact => fact.id === other.facts[0].id && fact.source.quote === 'Maintained operational documentation.'));
  assert.deepEqual(ctx.application.additionalFactIds, factIds);
  await f.call('application_question_answer', f.mutation({ ...f.binding(current), questionId, factIds: [conversation.facts[0].id] }));
  const entry = ctx.application.baseline.entries.find(item => item.text.includes('Acme'));
  await f.saveCv(current, { changes: [{ entryId: entry.id,
    text: `${entry.text}\nReduced batch failures by 30%.\nMaintained operational documentation.`,
    evidence: factIds.map(factId => ({ kind: 'fact', factId })) }] });
  await f.reviewBoth(current);
  const result = await f.call('application_export', f.mutation({ ...f.binding(current), kind: 'cv' }));
  const bytes = await readFile(result.export.path);
  const extracted = await documents.extractFile({ buffer: bytes, size: bytes.length, originalname: 'reused.pdf', mimetype: 'application/pdf' });
  assert.match(extracted.text, /Reduced batch failures by 30%/);
  assert.match(extracted.text, /Maintained operational documentation/);
  assert.doesNotMatch(extracted.text, /Unrelated private material|new-conversation|confirmed-answer|candidate.report|source.quote/);
  const secondApp = await f.create({ factIds });
  const secondContext = await f.call('application_context', { applicationId: secondApp.applicationId });
  assert.ok(secondContext.facts.some(fact => fact.id === conversation.facts[0].id));
  assert.equal(f.store.get().career.sources[f.sourceId].text, f.sourceText);
  const history = await f.profileCall('facts_list', { ids: [other.facts[0].id, corrected.fact.id], status: 'all' });
  assert.equal(history.total, 2);
  assert.equal(f.store.get().career.facts[conversation.facts[0].id].source.conversationId, 'new-conversation');
  assert.ok(f.requests.every(request => request.operation === 'job_read' && Object.keys(request.args).length === 1));
});

test('tailored wording and presentation save directly without an approval queue', async t => {
  const f = await fixture(t), app = await f.create();
  assert.equal(f.tools.has('career_application_suggestions_save'), false);
  assert.equal(f.tools.has('career_application_suggestions_resolve'), false);
  const entries = f.store.get().career.applications[app.applicationId].baseline.entries;
  const role = entries.find(entry => entry.text.includes('Acme'));
  const education = entries.find(entry => entry.text.includes('University'));
  const saved = await f.saveCv(app, {
    presentation: { template: 'modern', paper: 'LETTER' },
    changes: [
      { entryId: role.id, text: role.text.replace('Built reliable', 'Delivered reliable'), evidence: [f.candidateRef] },
      { entryId: education.id, text: education.text.replace('Completed a computing degree.', 'Earned a computing degree.'), evidence: [{ kind: 'source', sourceId: f.sourceId, quote: education.text }] },
    ],
  });
  assert.equal(saved.cvVersion, 1);
  const current = (await f.call('application_read', { applicationId: app.applicationId })).application;
  assert.equal(current.suggestions, undefined);
  assert.deepEqual(current.cv.presentation, { template: 'modern', paper: 'LETTER' });
  assert.match(current.cv.baseline.entries.find(entry => entry.id === role.id).text, /Delivered reliable/);
  assert.match(current.cv.baseline.entries.find(entry => entry.id === education.id).text, /Earned a computing degree/);
  assert.equal(f.store.get().career.facts[f.factId].statement, 'Built reliable data services.');
});

test('an invented number is omitted by rejecting the save, while a saved number applies directly', async t => {
  const f = await fixture(t), app = await f.create();
  const entry = f.store.get().career.applications[app.applicationId].baseline.entries.find(entry => entry.text.includes('Acme'));
  const before = f.store.get();
  await assert.rejects(f.saveCv(app, { changes: [{ entryId: entry.id, text: `${entry.text}\nReduced failures by 37%.`, evidence: [f.candidateRef] }] }),
    error => error.code === 'INVALID_EVIDENCE' && /Leave out unsupported numbers/.test(error.message));
  assert.deepEqual(f.store.get(), before);
  const fact = await f.profileCall('facts_add', f.mutation({ facts: [{ kind: 'achievement', statement: 'Reduced failures by 37%.',
    source: { kind: 'conversation', quote: 'I reduced failures by 37%.' } }] }));
  const refreshed = await f.call('application_refresh', f.mutation({ applicationId: app.applicationId, jobHash: app.jobHash, sourceId: app.sourceId }));
  await f.saveCv({ ...app, evidenceRevision: refreshed.evidenceRevision }, { changes: [{ entryId: entry.id, text: `${entry.text}\nReduced failures by 37%.`,
    evidence: [{ kind: 'fact', factId: fact.facts[0].id }] }] });
  assert.match(f.store.get().career.applications[app.applicationId].cv.baseline.entries.find(item => item.id === entry.id).text, /37%/);
});

test('chosen presentation survives refresh and is not offered as a candidate decision', async t => {
  const f = await fixture(t), app = await f.create();
  await f.saveCv(app, { presentation: { template: 'modern', paper: 'LETTER' } });
  await f.call('application_refresh', f.mutation({ applicationId: app.applicationId, sourceId: app.sourceId, jobHash: app.jobHash }));
  await f.saveCv(app);
  const current = f.store.get().career.applications[app.applicationId].cv;
  assert.deepEqual(current.presentation, { template: 'modern', paper: 'LETTER' });
  assert.equal(current.layout.paper, 'LETTER');
  const context = await f.call('application_context', { applicationId: app.applicationId });
  assert.match(context.customization.instructions, /Do not stage alternatives/);
  assert.equal(context.application.suggestions, undefined);
});

test('presentation and TXT export preserve wording, review gates and separate stale requirement coverage', async t => {
  const f = await fixture(t), app = await f.create();
  await f.saveCv(app);
  await assert.rejects(f.call('application_export', f.mutation({ ...f.binding(app), kind: 'cv', format: 'txt' })), { code: 'CV_REVIEW_REQUIRED' });
  await f.reviewBoth(app);
  const before = f.store.get().career.applications[app.applicationId].cv;
  let checks = await f.call('application_cv_check', { applicationId: app.applicationId });
  assert.equal(checks.requirementCoverage.state, 'current');
  await f.saveCv(app, { presentation: { template: 'modern', paper: 'LETTER' } });
  const after = f.store.get().career.applications[app.applicationId].cv;
  assert.deepEqual(after.baseline, before.baseline);
  assert.deepEqual(after.presentation, { template: 'modern', paper: 'LETTER' });
  assert.equal(after.layout.paper, 'LETTER');
  checks = await f.call('application_cv_check', { applicationId: app.applicationId });
  assert.equal(checks.requirementCoverage.state, 'stale');
  assert.equal(checks.reviewReadiness.ready, false);
  await f.review(app, 'adversarial');
  const exported = await f.call('application_export', f.mutation({ ...f.binding(app), kind: 'cv', format: 'txt' }));
  const text = await readFile(exported.export.path, 'utf8');
  assert.equal(text, documents.renderCareerCvText(after));
  assert.equal(exported.export.mediaType, 'text/plain');
  assert.equal(exported.export.textValidation, null);
  assert.equal(exported.export.visualInspection, 'not_applicable');
  assert.doesNotMatch(text, /factId|sourceId|evidenceRevision/);
});

test('PDF export refuses actual lost text before publishing while keeping the draft', async t => {
  const f = await fixture(t, { documents: { ...documents,
    renderCareerCvPdf: () => documents.renderCareerPdf('Jane Candidate', ['This broken renderer omitted the career history.']),
  } });
  const app = await f.create();
  await f.saveCv(app);
  await f.reviewBoth(app);
  const before = f.store.get();
  await assert.rejects(f.call('application_export', f.mutation({ ...f.binding(app), kind: 'cv' })), { code: 'EXPORT_CORRUPT' });
  assert.deepEqual(f.store.get(), before);
  assert.deepEqual(f.exported, []);
});
