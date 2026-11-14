import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createApplicationTools } from '../src/mcp/application-tools.mjs';
import { ASSESSMENT_POLICY_ID } from '../src/mcp/matching-contract.mjs';
import { matchingProfileVersion } from '../src/mcp/assessment-policy.mjs';
import { createCareerState } from '../src/mcp/state.mjs';
import { addBlock, removeBlock } from '../src/mcp/blocklist.mjs';
import { createDocumentFiles } from '../src/mcp/files.mjs';
import { readyMaster } from './helpers/ready-master.mjs';
import { assertMasterReady } from '../src/mcp/master-cv.mjs';

// Built from this repository's document engine by build:runtime, so these
// tests exercise the real layout, PDF rendering and PDF text read-back.
const documents = createRequire(import.meta.url)('../src/generated/document-engine.cjs');
const { PDFParse } = createRequire(import.meta.url)('pdf-parse');
const digest = value => createHash('sha256').update(value).digest('hex');
const pastedJob = { title: 'Senior Platform Engineer', company: 'Example Employer', description: 'Build reliable data services for our payments platform. 5+ years required.', url: 'https://example.test/jobs/1', location: 'London' };
const cvText = 'Jane Candidate\nAcme Corp. | Platform Engineer | London | Mar 2019 – Present\n- Built event-driven data services in TypeScript and Kafka.\n- Cut deployment time from 40 minutes to 8 minutes.\n- Automated releases and owned on-call reliability for payment pipelines.\n- Progressed from individual delivery to platform ownership.\n- Traced a difficult failed deployment to its dependency and restored production service.\n\nGlobex | Backend Developer | 2015 – 2019\n- Developed retail backend systems.\n- Reduced duplicate order handling through a shared service.\n- Grew from assigned fixes to independent service delivery.\n- Resolved a difficult retail outage by tracing duplicate events and restoring processing.\n\nUniversity of Synthetic Studies — BSc Computing\nItalian — Native';
const sourceId = 'a0000000-0000-4000-8000-000000000001';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'career-applications-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const career = createCareerState();
  Object.assign(career.profile, { name: 'Jane Candidate', email: 'jane@example.test', phone: '+44 20 7946 0000', location: 'London', links: ['https://example.test/jane'] });
  const at = new Date().toISOString(), facts = {};
  const fact = (fields) => {
    const id = randomUUID();
    career.facts[id] = { id, ...fields, createdAt: at, updatedAt: at };
    facts[fields.subject] = id;
  };
  fact({ kind: 'language', subject: 'Italian', answer: 'Native' });
  fact({ kind: 'capability', subject: 'Managing engineering teams', answer: 'Led it', detail: 'Managed up to 12 engineers', employer: 'Acme Corp.' });
  fact({ kind: 'capability', subject: 'Kubernetes', answer: 'None' });
  fact({ kind: 'note', subject: 'Freelance consulting', answer: 'Advised payments clients on platform architecture and improved release reliability.', employer: 'Initrode' });
  fact({ kind: 'note', subject: 'Side project', answer: 'Volunteered for Hooli open source' });
  fact({ kind: 'yes_no', subject: 'Right to work in the UK', answer: 'Yes' });
  const cvSource = sourceId, archived = randomUUID(), note = randomUUID();
  career.sources[cvSource] = { id: cvSource, name: 'Imported CV', purpose: 'cv', mediaType: 'text/plain', text: cvText, originalBase64: 'BINARY', createdAt: at };
  career.sources[archived] = { id: archived, name: 'Old CV', purpose: 'cv', archived: true, mediaType: 'text/plain', text: 'Old text: Hooli | Engineer | 2010 – 2012', createdAt: at };
  career.sources[note] = { id: note, name: 'Notes', purpose: 'supporting', mediaType: 'text/plain', text: 'Private note', createdAt: at };
  let state = { deviceId: randomUUID(), career }, queue = Promise.resolve();
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
  const ready = await readyMaster(store, { document: tailoredCv() });
  const binding = () => ({ masterVersion: assertMasterReady(state.career).version });
  const catalogue = { id: 'node:9001', shortUUID: 'short-9001', title: 'Platform Engineer', company: { name: 'Catalogue Employer' }, description: 'Operate data services.', applyUrl: 'https://example.test/apply', location: 'Remote', contentHash: digest('job') };
  const requests = [], exported = [];
  const platform = async (operation, args) => {
    requests.push({ operation, args });
    if (options.platform) return options.platform(operation, args, catalogue);
    if (operation === 'job_read') return structuredClone(catalogue);
    assert.fail(`Unexpected platform operation: ${operation}`);
  };
  const files = createDocumentFiles({ directory, store, assertAvailable() {} });
  const exportDocument = async input => { exported.push(input); return files.exportDocument(input); };
  const tools = new Map(createApplicationTools({ store, platform, documents: options.documents ?? documents, exportDocument,
    cleanupExports: files.cleanupExports, withExportTransaction: files.withExportTransaction }).map(tool => [tool.name, tool]));
  const call = (name, args = {}) => tools.get(`career_${name}`).invoke(args);
  const mutation = args => ({ requestId: randomUUID(), revision: state.career.revision, ...args });
  const create = (args = { job: pastedJob }) => call('application_create', mutation(args));
  const saveCv = (applicationId, cv, extra = {}) => call('application_cv_save', { applicationId, ...binding(), cv, ...extra });
  const saveLetter = (applicationId, paragraphs) => call('application_letter_save', { applicationId, ...binding(), paragraphs });
  const exportDraft = (applicationId, kind, format) => call('application_export', mutation({ applicationId, kind, ...(format ? { format } : {}) }));
  return { store, files, state: () => state.career, tools, call, mutation, create, saveCv, saveLetter, exportDraft, requests, exported, catalogue, facts, ready, binding, sources: { cvSource, archived, note } };
}

const tailoredCv = () => ({
  headline: 'Senior Platform Engineer — payments data services',
  summary: 'Platform engineer building reliable data services for payments. Shortened delivery cycles and keeps production systems dependable.',
  highlights: ['Cut deployment time from 40 minutes to 8 minutes.'],
  experience: [
    { employer: 'ACME Corp', role: 'Platform Engineer', location: 'London', startDate: 'Mar 2019', endDate: 'Present',
      bullets: [
        'Built event-driven data services in TypeScript and Kafka since 2019.',
        'Automated releases, reducing deployment time from 40 minutes to 8 minutes.',
        'Owned on-call reliability for payment pipelines.',
        'Led a team of 12 engineers.',
      ] },
    { employer: 'Globex', role: 'Backend Developer', startDate: '2015', endDate: '2019', bullets: ['Developed retail backend systems.'] },
    { employer: 'INITRODE', role: 'Platform Consultant', startDate: '2014', endDate: '2015', bullets: ['Advised payments clients on platform architecture.'] },
  ],
  education: [{ institution: 'University of Synthetic Studies', qualification: 'BSc Computing' }],
  skills: [{ label: 'Engineering', items: ['TypeScript', 'Kafka', 'Data services'] }],
  languages: [{ language: 'Italian', proficiency: 'native' }],
});
const letter = [
  'Dear Example Employer hiring team,',
  'Your payments platform depends on reliable data services, which is the work I have focused on at Acme Corp.',
  'At Acme I cut deployment time from 40 minutes to 8 minutes, which would let your team ship payment changes with confidence.',
  'Kind regards,\nJane Candidate',
];
const pdfText = async bytes => {
  const parser = new PDFParse({ data: Uint8Array.from(bytes) });
  try { return (await parser.getText({ pageJoiner: '' })).text; } finally { await parser.destroy(); }
};

test('a pasted advert creates an application and its context carries everything needed to write', async t => {
  const f = await fixture(t);
  const created = await f.create();
  assert.deepEqual(f.requests, [], 'a pasted advert needs no catalogue read');
  assert.deepEqual(created.job, pastedJob);
  const context = await f.call('application_context', { applicationId: created.applicationId });
  assert.deepEqual(context.job, pastedJob);
  assert.equal(context.application.id, created.applicationId);
  assert.deepEqual(Object.keys(context.facts).sort(), ['capability', 'language', 'note', 'yes_no']);
  assert.deepEqual(context.facts.capability.map(({ subject, answer, detail }) => ({ subject, answer, detail })),
    [{ subject: 'Kubernetes', answer: 'None', detail: undefined }, { subject: 'Managing engineering teams', answer: 'Led it', detail: 'Managed up to 12 engineers' }]);
  assert.equal(context.originalSources[0].text, cvText, 'originals remain separate evidence, never master prose');
  assert.equal(context.master.version, 1);
  assert.equal(context.applicationId, created.applicationId);
  assert.equal(context.masterVersion, context.master.version);
  for (const key of ['contextFingerprint', 'requirements', 'requirementsSchema', 'roles', 'review', 'masterEvidenceFingerprint', 'sourceSetFingerprint'])
    assert.equal(Object.hasOwn(context, key), false);
  assert.equal(Object.hasOwn(context.master, 'sourceIds'), false);
  assert.equal(context.profile.email, 'jane@example.test');
  assert.equal(Object.hasOwn(context.profile, 'preferences'), false);
  assert.deepEqual(context.presentation.current, { template: 'classic', paper: 'A4' });
  assert.equal(context.assessment, null, 'a pasted advert has no saved match assessment');
  assert.doesNotMatch(JSON.stringify(context), /BINARY|Private note|Old text/);
  const list = await f.call('applications_list');
  assert.equal(list.total, 1);
  assert.equal(list.applications[0].job.company, 'Example Employer');
  assert.equal(list.applications[0].cvVersion, null);
});

test('a catalogue job is read and mapped; mismatched or ambiguous requests are rejected', async t => {
  const f = await fixture(t);
  const created = await f.create({ jobId: 'node:9001' });
  assert.deepEqual(f.requests, [{ operation: 'job_read', args: { id: 'node:9001' } }]);
  assert.deepEqual(created.job, { id: 'node:9001', title: 'Platform Engineer', company: 'Catalogue Employer', description: 'Operate data services.', url: 'https://example.test/apply', location: 'Remote' });
  await assert.rejects(f.create({ jobId: 'node:9001', job: pastedJob }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.create({}), { code: 'INVALID_INPUT' });
  const wrong = await fixture(t, { platform: (operation, args, job) => ({ ...job, id: 'node:other', shortUUID: null }) });
  await assert.rejects(wrong.create({ jobId: 'node:9001' }), { code: 'INVALID_JOB' });
});

test('the context carries the current saved match assessment of a catalogue job, never a stale one', async t => {
  const f = await fixture(t);
  const { applicationId } = await f.create({ jobId: 'node:9001' });
  const assessment = { overall: 72, band: 'good', decision: 'recommend',
    gates: { direction: 'pass', constraints: 'pass', eligibility: 'pass' },
    dimensions: { direction: 80, capability: 70, scope: 60, preferences: 70 },
    reason: 'Directly continues the data services work.' };
  await f.store.update(state => {
    state.career.matching = { scores: { 'node:9001': { id: 'node:9001', status: 'assessed', relocation: 'not_required', ...assessment,
      profileVersion: matchingProfileVersion(state.career), policyId: ASSESSMENT_POLICY_ID, scoredAt: new Date().toISOString(), host: null } } };
  });
  assert.deepEqual((await f.call('application_context', { applicationId })).assessment, assessment);
  await f.store.update(state => { state.career.matching.scores['node:9001'].policyId = 'stale-policy'; });
  assert.equal((await f.call('application_context', { applicationId })).assessment, null);
});

test('plain CV saves accept semantic wording and unspecified dates without literal or metric proof', async t => {
  const f = await fixture(t), { applicationId } = await f.create();
  const cv = tailoredCv();
  cv.experience[0].employer = 'Acme Corporation';
  cv.experience[0].role = 'Platform engineering';
  cv.experience[0].startDate = '';
  cv.experience[0].bullets[0] = 'Reduced deployment time by 80%.';
  cv.summary = 'She led platform teams. According to my profile, I build data services.';
  assert.equal((await f.saveCv(applicationId, cv)).cvVersion, 1);
  assert.deepEqual(f.state().applications[applicationId].cv.document, cv);
  assert.equal((await f.saveLetter(applicationId, [letter[0], 'According to my profile, I reduced deployment time by 80%.'])).letterVersion, 1);
});

test('masterVersion guards both plain saves without model mutation bookkeeping', async t => {
  const f = await fixture(t), { applicationId } = await f.create(), masterVersion = f.binding().masterVersion;
  await readyMaster(f.store);
  const before = f.state();
  await assert.rejects(f.call('application_cv_save', { applicationId, masterVersion, cv: tailoredCv() }), { code: 'APPLICATION_CONTEXT_CHANGED' });
  await assert.rejects(f.call('application_letter_save', { applicationId, masterVersion, paragraphs: letter }), { code: 'APPLICATION_CONTEXT_CHANGED' });
  assert.deepEqual(f.state(), before);
  assert.equal((await f.saveCv(applicationId, tailoredCv())).cvVersion, 1);
  assert.equal((await f.saveLetter(applicationId, letter)).letterVersion, 1);
});

test('a plain CV saves with layout and notes, keeps history, and exports readable PDFs', async t => {
  const f = await fixture(t);
  const { applicationId } = await f.create();
  const saved = await f.saveCv(applicationId, tailoredCv(f.facts));
  assert.equal(saved.cvVersion, 1);
  assert.deepEqual(saved.layout, { pages: 1, fits: true });
  assert.deepEqual(saved.issues, []);
  const stored = f.state().applications[applicationId].cv;
  assert.match(stored.contextFingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(stored.document, tailoredCv(), 'stored drafts keep plain strings');
  for (const template of ['classic', 'modern']) {
    const presentation = { template, paper: template === 'classic' ? 'A4' : 'LETTER' };
    const result = await f.saveCv(applicationId, tailoredCv(f.facts), { presentation });
    const app = f.state().applications[applicationId];
    assert.equal(app.cv.version, result.cvVersion);
    assert.deepEqual(app.cv.presentation, presentation);
    const args = f.mutation({ applicationId, kind: 'cv' });
    const exported = await f.call('application_export', args);
    assert.deepEqual(await f.call('application_export', args), exported, 'an exact replay does not republish');
    const bytes = await readFile(exported.export.path);
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    assert.equal(exported.export.sha256, digest(bytes));
    assert.equal(exported.export.documentVersion, result.cvVersion);
    assert.equal(exported.export.contextFingerprint, app.cv.contextFingerprint);
    assert.equal(exported.export.textValidation.passed, true);
    const expectedText = documents.renderCareerCvText({ document: app.cv.document, heading: { name: 'Jane Candidate', contact: 'jane@example.test · +44 20 7946 0000 · London · https://example.test/jane' } });
    assert.equal((await documents.validateCareerPdfText({ bytes, expectedText })).passed, true);
    const text = await pdfText(bytes), flat = text.replace(/\s+/g, ' ');
    for (const value of ['Jane Candidate', 'ACME Corp', 'Cut deployment time from 40 minutes to 8 minutes.', 'Led a team of 12 engineers.', 'Advised payments clients on platform architecture.', 'Italian (native)', 'Key achievements'])
      assert.ok(flat.includes(value), value);
    for (const value of [f.facts['Managing engineering teams'], f.facts['Freelance consulting'], 'support', '[object Object]'])
      assert.equal(flat.includes(value), false, value);
  }
  const app = f.state().applications[applicationId];
  assert.equal(app.cvHistory.length, 2);
  assert.deepEqual(app.cvHistory.map(draft => draft.version), [1, 2]);
  assert.equal(app.exports.length, 2);
  assert.equal(f.exported.length, 2);
});

test('the CV header is rendered from the current profile and TXT export equals the text rendering', async t => {
  const f = await fixture(t);
  const { applicationId } = await f.create();
  await f.saveCv(applicationId, tailoredCv(f.facts));
  await f.store.update(state => { state.career.profile.email = 'new@example.test'; state.career.profile.links = []; });
  await readyMaster(f.store);
  await assert.rejects(f.exportDraft(applicationId, 'cv', 'txt'), { code: 'APPLICATION_CONTEXT_CHANGED' });
  await f.saveCv(applicationId, tailoredCv(f.facts));
  const { export: record } = await f.exportDraft(applicationId, 'cv', 'txt');
  const text = await readFile(record.path, 'utf8');
  assert.equal(record.mediaType, 'text/plain');
  assert.equal(record.textValidation, null);
  assert.ok(text.startsWith('Jane Candidate\nSenior Platform Engineer — payments data services\nnew@example.test · +44 20 7946 0000 · London\n'));
  assert.equal(text, documents.renderCareerCvText({ document: f.state().applications[applicationId].cv.document, heading: { name: 'Jane Candidate', contact: 'new@example.test · +44 20 7946 0000 · London' } }));
});

test('quality notes are returned for the host without blocking the save', async t => {
  const f = await fixture(t);
  await f.store.update(state => { state.career.profile.email = null; });
  await readyMaster(f.store);
  const { applicationId } = await f.create();
  const cv = tailoredCv(f.facts);
  cv.experience[1].bullets = [cv.experience[1].bullets[0], structuredClone(cv.experience[1].bullets[0])];
  const saved = await f.saveCv(applicationId, cv);
  assert.equal(saved.cvVersion, 1);
  assert.ok(saved.issues.some(issue => issue.startsWith('header:') && /email/.test(issue)));
  assert.ok(saved.issues.some(issue => issue.startsWith('experience[1].bullets[1]:') && /appears 2 times/.test(issue)));
});

test('cover letters are checked, saved with history and exported as PDF and TXT', async t => {
  const f = await fixture(t);
  const { applicationId } = await f.create();
  await assert.rejects(f.exportDraft(applicationId, 'cover_letter'), { code: 'MISSING_DRAFT' });
  assert.equal((await f.saveLetter(applicationId, letter.slice(0, 3))).letterVersion, 1);
  assert.equal((await f.saveLetter(applicationId, letter)).letterVersion, 2);
  const app = f.state().applications[applicationId];
  assert.deepEqual(app.coverLetter.paragraphs, letter);
  assert.match(app.coverLetter.contextFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(app.coverLetterHistory.length, 1);
  const pdf = await f.exportDraft(applicationId, 'cover_letter');
  assert.equal(pdf.export.textValidation.passed, true);
  assert.equal(pdf.export.contextFingerprint, app.coverLetter.contextFingerprint);
  const text = (await pdfText(await readFile(pdf.export.path))).replace(/\s+/g, ' ');
  assert.ok(text.includes('Cover letter — Senior Platform Engineer — Example Employer'));
  assert.ok(text.includes('cut deployment time from 40 minutes to 8 minutes'));
  const txt = await f.exportDraft(applicationId, 'cover_letter', 'txt');
  assert.equal(await readFile(txt.export.path, 'utf8'), ['Cover letter — Senior Platform Engineer — Example Employer', ...letter].join('\n\n') + '\n');
});

test('applications are deleted explicitly and missing IDs are reported', async t => {
  const f = await fixture(t);
  const first = await f.create(), second = await f.create({ job: { ...pastedJob, title: 'Staff Engineer', url: 'https://example.test/jobs/2' } });
  await assert.rejects(f.call('applications_delete', f.mutation({ applicationIds: [first.applicationId, randomUUID()] })), { code: 'NOT_FOUND' });
  assert.equal(Object.keys(f.state().applications).length, 2);
  assert.deepEqual((await f.call('applications_delete', f.mutation({ applicationIds: [first.applicationId, second.applicationId] }))).deleted, 2);
  assert.equal((await f.call('applications_list')).total, 0);
  assert.throws(() => f.call('application_read', { applicationId: first.applicationId }), { code: 'NOT_FOUND' });
});

test('application progress moves one valid step at a time and is read with the application', async t => {
  const f = await fixture(t);
  const { applicationId } = await f.create();
  const set = args => f.call('application_progress_set', f.mutation({ applicationId, ...args }));
  assert.deepEqual((await f.call('applications_list')).applications[0].progress, { stage: 'prepared', history: [] });
  await assert.rejects(set({ stage: 'interviewing' }), { code: 'INVALID_PROGRESS' });
  await assert.rejects(set({ undo: true }), { code: 'INVALID_PROGRESS' });
  await assert.rejects(set({ stage: 'applied', undo: true }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.call('application_progress_set', f.mutation({ applicationId: randomUUID(), stage: 'applied' })), { code: 'NOT_FOUND' });
  const revision = f.state().revision;
  assert.deepEqual((await set({ stage: 'applied', date: '2025-10-21' })).progress, { stage: 'applied', history: [{ stage: 'applied', at: '2025-10-21' }] });
  assert.equal(f.state().revision, revision + 1);
  assert.equal((await set({ stage: 'interviewing', date: '2025-10-24' })).progress.round, 1);
  assert.equal((await set({ stage: 'interviewing', date: '2025-10-30' })).progress.round, 2);
  await assert.rejects(set({ stage: 'hired' }), { code: 'INVALID_PROGRESS' });
  await assert.rejects(set({ stage: 'offer', date: '2025-10-29' }), { code: 'INVALID_PROGRESS' });
  const rejected = (await set({ stage: 'rejected', date: '2025-11-02' })).progress;
  assert.deepEqual([rejected.stage, rejected.atStage, rejected.round], ['rejected', 'interviewing', 2]);
  assert.deepEqual((await f.call('application_read', { applicationId })).application.progress, rejected);
  assert.deepEqual((await f.call('applications_list')).applications[0].progress, rejected);
  assert.deepEqual((await set({ undo: true })).progress.stage, 'interviewing');
  assert.equal((await set({ date: '2025-10-31' })).progress.history.at(-1).at, '2025-10-31');
  // Applications saved before progress existed read as prepared.
  await f.store.update(state => { delete state.career.applications[applicationId].progress; });
  assert.deepEqual((await f.call('application_read', { applicationId })).application.progress, { stage: 'prepared', history: [] });
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(f.tools.get('career_application_progress_set').inputSchema);
  const base = { requestId: randomUUID(), revision: 0, applicationId };
  for (const args of [{ stage: 'applied' }, { stage: 'interviewing', date: '2025-10-21' }, { undo: true }, { date: '2025-10-21' }])
    assert.equal(validate({ ...base, ...args }), true, JSON.stringify(validate.errors));
  for (const args of [{ stage: 'prepared' }, { stage: 'ghosted' }, { stage: 'applied', date: '21 Oct 2025' }, { undo: false }, { stage: 'applied', note: 'x' }])
    assert.equal(validate({ ...base, ...args }), false, JSON.stringify(args));
});

test('MCP interview scheduling preserves history, validates dates and honors mutation retries and revision conflicts', async t => {
  const f = await fixture(t), { applicationId } = await f.create();
  const set = args => f.call('application_progress_set', f.mutation({ applicationId, ...args }));
  await assert.rejects(set({ nextInterviewAt: '2099-05-17' }), { code: 'INVALID_PROGRESS' });
  await set({ stage: 'applied', date: '2025-10-21' });
  const request = f.mutation({ applicationId, stage: 'interviewing', date: '2025-10-24', nextInterviewAt: '2099-05-17' });
  const first = await f.call('application_progress_set', request), revision = f.state().revision;
  assert.equal(first.progress.nextInterviewAt, '2099-05-17');
  assert.equal(first.progress.history.at(-1).at, '2025-10-24');
  assert.deepEqual(await f.call('application_progress_set', request), first);
  assert.equal(f.state().revision, revision);
  await assert.rejects(f.call('application_progress_set', { ...request, nextInterviewAt: '2099-05-18' }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(f.call('application_progress_set', { ...request, requestId: randomUUID() }), { code: 'REVISION_CONFLICT' });
  const before = structuredClone(f.state());
  for (const nextInterviewAt of ['2099-02-29', '2099-04-31', '2099-05-17T00:00:00Z', '', 123, false]) {
    await assert.rejects(set({ nextInterviewAt }), { code: 'INVALID_INPUT' });
    assert.deepEqual(f.state(), before);
  }
  await set({ nextInterviewAt: '2099-05-18' });
  await set({ date: '2025-10-25' });
  const read = (await f.call('application_read', { applicationId })).application.progress;
  assert.equal(read.nextInterviewAt, '2099-05-18');
  assert.equal(read.round, 1);
  assert.equal(read.history.length, 2);
  assert.deepEqual((await f.call('applications_list')).applications[0].progress, read);
  // Saving an unrelated application field must not erase its interview schedule.
  await f.store.update(state => { state.career.applications[applicationId].formAnswers = { saved: { value: 'Answer' } }; });
  assert.equal((await f.call('application_read', { applicationId })).application.progress.nextInterviewAt, '2099-05-18');
  await set({ nextInterviewAt: null });
  assert.equal(Object.hasOwn(f.state().applications[applicationId].progress, 'nextInterviewAt'), false);
  await set({ nextInterviewAt: '2099-05-19' });
  await set({ stage: 'interviewing' });
  assert.equal(f.state().applications[applicationId].progress.round, 2);
  assert.equal(f.state().applications[applicationId].progress.nextInterviewAt, undefined);
  await set({ nextInterviewAt: '2099-05-20' });
  await set({ stage: 'offer' });
  assert.equal(f.state().applications[applicationId].progress.nextInterviewAt, undefined);
  await assert.rejects(set({ nextInterviewAt: null }), { code: 'INVALID_PROGRESS' });
  const ajv = new Ajv({ strict: false }); addFormats(ajv);
  const tool = f.tools.get('career_application_progress_set'), validate = ajv.compile(tool.inputSchema);
  for (const nextInterviewAt of ['2099-05-17', null]) assert.equal(validate(f.mutation({ applicationId, nextInterviewAt })), true);
  for (const nextInterviewAt of ['May 17', 123, false]) assert.equal(validate(f.mutation({ applicationId, nextInterviewAt })), false);
});

test('tool schemas accept a structured CV and reject malformed documents and removed tools', async t => {
  const f = await fixture(t);
  assert.deepEqual([...f.tools.keys()].sort(), ['career_application_context', 'career_application_create', 'career_application_cv_save',
    'career_application_export', 'career_application_letter_save', 'career_application_progress_set', 'career_application_read',
    'career_applications_delete', 'career_applications_list', 'career_job_read']);
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(f.tools.get('career_application_cv_save').inputSchema);
  const { applicationId } = await f.create();
  const args = { applicationId, ...f.binding(), cv: tailoredCv(), presentation: { template: 'modern', paper: 'LETTER' } };
  assert.equal(validate(args), true, JSON.stringify(validate.errors));
  const invalid = [
    cv => { delete cv.summary; },
    cv => { cv.sections = []; },
    cv => { cv.experience[0].bullets[0] = { text: 'Built data services.' }; },
    cv => { cv.highlights[0] = { text: 'Cut deployment time.' }; },
    cv => { cv.experience[0].roleId = randomUUID(); },
    cv => { cv.experience[0].startDate = null; },
  ];
  for (const change of invalid) {
    const copy = structuredClone(args);
    change(copy.cv);
    assert.equal(validate(copy), false);
  }
  const letterSchema = ajv.compile(f.tools.get('career_application_letter_save').inputSchema);
  assert.equal(letterSchema({ applicationId, ...f.binding(), paragraphs: letter }), true);
  for (const field of ['requestId', 'revision', 'contextFingerprint', 'requirements', 'evidence']) {
    assert.equal(validate({ ...args, [field]: 'removed' }), false);
    assert.equal(letterSchema({ applicationId, ...f.binding(), paragraphs: letter, [field]: 'removed' }), false);
  }
  assert.equal(letterSchema({ requestId: randomUUID(), revision: 0, applicationId: randomUUID(), paragraphs: ['Only one paragraph.'] }), false);
});


test('creating the same exact job reuses drafts; a changed original invalidates their export', async t => {
  const f = await fixture(t), created = await f.create();
  await f.saveCv(created.applicationId, tailoredCv(f.facts));
  await f.saveLetter(created.applicationId, letter);
  const reused = await f.create({ job: { ...pastedJob, url: `${pastedJob.url}?utm_source=test` } });
  assert.equal(reused.applicationId, created.applicationId);
  assert.equal(f.state().applications[created.applicationId].cv.version, 1);
  await f.exportDraft(created.applicationId, 'cv', 'txt');
  const changed = await f.create({ job: { ...pastedJob, description: 'Lead the payments platform team.' } });
  assert.equal(changed.applicationId, created.applicationId);
  await assert.rejects(f.exportDraft(created.applicationId, 'cv', 'txt'), { code: 'APPLICATION_CONTEXT_CHANGED' });
  await assert.rejects(f.exportDraft(created.applicationId, 'cover_letter', 'txt'), { code: 'APPLICATION_CONTEXT_CHANGED' });
  assert.equal(f.state().applications[created.applicationId].cv.version, 1, 'stale history is retained rather than silently rebound');
});

test('catalogue reads and application creation reject company slugs, display names and stale direct IDs', async t => {
  const f = await fixture(t);
  f.catalogue.company.name = 'Flow Traders';
  await f.store.update(state => {
    state.career.matching = { jobs: { 'node:9001': { id: 'node:9001', title: 'Engineer', company: 'flow-traders' } }, scores: {}, pairs: {} };
    addBlock(state.career, { id: 'node:9001', kind: 'company' });
  });
  await assert.rejects(f.call('job_read', { id: 'node:9001' }), { code: 'JOB_BLOCKED' });
  await assert.rejects(f.create({ jobId: 'node:9001' }), { code: 'JOB_BLOCKED' });
  assert.equal(f.requests.length, 0);
  await assert.rejects(f.create({ jobId: 'short-9001' }), { code: 'JOB_BLOCKED' });
  await assert.rejects(f.create({ job: { ...pastedJob, company: 'FLOW_TRADERS' } }), { code: 'JOB_BLOCKED' });
  assert.equal(Object.keys(f.state().applications).length, 0);
  const allowed = await f.create();
  assert.equal(allowed.job.company, pastedJob.company);
  await f.store.update(state => {
    state.career.blocklist = {};
    addBlock(state.career, { id: 'node:9001', kind: 'job' });
    delete state.career.matching.jobs['node:9001'];
  });
  await assert.rejects(f.call('job_read', { id: 'node:9001' }), { code: 'JOB_BLOCKED' });
  await assert.rejects(f.create({ jobId: 'node:9001' }), { code: 'JOB_BLOCKED' });
});

test('blocking a saved application stops drafts, context and receipt replays without deleting saved work', async t => {
  const f = await fixture(t);
  const createArgs = f.mutation({ jobId: 'node:9001' });
  const { applicationId } = await f.call('application_create', createArgs);
  const cvArgs = { applicationId, ...f.binding(), cv: tailoredCv() };
  await f.call('application_cv_save', cvArgs);
  const letterArgs = { applicationId, ...f.binding(), paragraphs: letter };
  await f.call('application_letter_save', letterArgs);
  const exportArgs = f.mutation({ applicationId, kind: 'cover_letter', format: 'txt' });
  await f.call('application_export', exportArgs);
  let entry;
  await f.store.update(state => { entry = addBlock(state.career, { id: 'node:9001', kind: 'company' }); });
  const before = f.state().applications[applicationId], exported = f.exported.length;
  assert.equal((await f.call('applications_list')).total, 0);
  for (const name of ['application_read', 'application_context'])
    assert.throws(() => f.call(name, { applicationId }), { code: 'JOB_BLOCKED' });
  for (const [name, args] of [['application_create', createArgs], ['application_cv_save', cvArgs],
    ['application_letter_save', letterArgs], ['application_export', exportArgs],
    ['application_letter_save', { applicationId, ...f.binding(), paragraphs: ['Dear team,', 'New draft'] }]])
    await assert.rejects(f.call(name, args), { code: 'JOB_BLOCKED' });
  assert.deepEqual(f.state().applications[applicationId], before);
  assert.equal(f.exported.length, exported, 'no blocked export is published');
  await f.store.update(state => { removeBlock(state.career, entry.id); });
  assert.equal((await f.call('application_create', createArgs)).applicationId, applicationId);
  assert.deepEqual((await f.call('application_read', { applicationId })).application, before);
});

test('blocks arriving during an advert fetch prevent reads and application creation', async t => {
  for (const operation of ['job_read', 'application_create']) {
    let release, started;
    const waiting = new Promise(resolve => { started = resolve; });
    const response = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, { platform: async () => { started(); return response; } });
    const pending = operation === 'job_read' ? f.call(operation, { id: 'node:9001' }) : f.create({ jobId: 'node:9001' });
    await waiting;
    await f.store.update(state => { state.career.blocklist = { company: { kind: 'company', value: 'flow-traders' } }; });
    release({ ...f.catalogue, company: { name: 'Flow Traders' } });
    await assert.rejects(pending, { code: 'JOB_BLOCKED' });
    assert.deepEqual(f.state().applications, {});
  }
});

test('a block arriving during layout cannot save the already-rendered CV', async t => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const measured = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { documents: { measureCareerCvLayout: async () => { started(); return measured; } } });
  const { applicationId } = await f.create({ jobId: 'node:9001' });
  const pending = f.saveCv(applicationId, tailoredCv(f.facts));
  await waiting;
  await f.store.update(state => { addBlock(state.career, { id: 'node:9001', kind: 'job' }); });
  release({ fits: true, pages: 1 });
  await assert.rejects(pending, { code: 'JOB_BLOCKED' });
  assert.equal(f.state().applications[applicationId].cv, null);
});

test('a concurrent career edit during layout prevents a stale CV save', async t => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const measured = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { documents: { measureCareerCvLayout: async () => { started(); return measured; } } });
  const { applicationId } = await f.create();
  const pending = f.saveCv(applicationId, tailoredCv());
  await waiting;
  await f.store.update(state => { state.career.profile.location = 'Paris'; state.career.revision++; });
  release({ fits: true, pages: 1 });
  await assert.rejects(pending, { code: 'REVISION_CONFLICT' });
  assert.equal(f.state().applications[applicationId].cv, null);
});

test('tailoring requires a ready master and preserves its content and version', async t => {
  const f = await fixture(t), { applicationId } = await f.create();
  const original = structuredClone(f.state().masterCv);
  await f.saveCv(applicationId, tailoredCv(f.facts));
  await f.saveLetter(applicationId, letter);
  await f.exportDraft(applicationId, 'cv', 'txt');
  assert.deepEqual(f.state().masterCv, original);
  await f.store.update(state => { state.career.sources[sourceId].archived = true; });
  assert.throws(() => f.call('application_context', { applicationId }), { code: 'MASTER_NOT_READY' });
  await assert.rejects(f.exportDraft(applicationId, 'cv', 'txt'), { code: 'MASTER_NOT_READY' });
  const before = f.state();
  await assert.rejects(f.call('application_letter_save', { applicationId, masterVersion: 1, paragraphs: letter }), { code: 'MASTER_NOT_READY' });
  assert.deepEqual(f.state(), before);
});


test('source membership and ready master version changes invalidate export and old receipts', async t => {
  const f = await fixture(t), { applicationId } = await f.create();
  await f.saveCv(applicationId, tailoredCv(f.facts));
  const args = f.mutation({ applicationId, kind: 'cv', format: 'txt' });
  await f.call('application_export', args);
  await readyMaster(f.store);
  await assert.rejects(f.call('application_export', args), { code: 'APPLICATION_CONTEXT_CHANGED' });
  await assert.rejects(f.exportDraft(applicationId, 'cv', 'txt'), { code: 'APPLICATION_CONTEXT_CHANGED' });
  await f.store.update(state => { const id = randomUUID(); state.career.sources[id] = { id, purpose: 'cv', text: 'Additional original evidence.' }; });
  await assert.rejects(f.exportDraft(applicationId, 'cv', 'txt'), { code: 'MASTER_NOT_READY' });
});

test('pending application clarification blocks export', async t => {
  const f = await fixture(t), { applicationId } = await f.create();
  await f.saveCv(applicationId, tailoredCv());
  await f.exportDraft(applicationId, 'cv', 'txt');
  await f.store.update(state => { const id = randomUUID(); state.career.interviews ??= {}; state.career.interviews[id] = { id, status: 'pending', applicationId, questions: [] }; });
  await assert.rejects(f.exportDraft(applicationId, 'cv', 'txt'), { code: 'APPLICATION_CLARIFICATION_PENDING' });
});

test('full HTML advert text and plain tailored wording retain original whitespace', async t => {
  const f = await fixture(t);
  const { applicationId } = await f.create({ job: { ...pastedJob, description: '<p>Use <b>data  services</b> &amp; Kafka.</p>' } });
  const context = await f.call('application_context', { applicationId });
  assert.ok(context.jobText.includes('data  services & Kafka.'));
  assert.equal(context.job.description, '<p>Use <b>data  services</b> &amp; Kafka.</p>');
  const cv = tailoredCv();
  cv.experience[0].bullets[0] = 'Built event-driven data  services in TypeScript and Kafka.';
  await f.saveCv(applicationId, cv);
  const saved = f.state().applications[applicationId].cv;
  assert.ok(saved.document.experience[0].bullets[0].includes('data  services'));
  const exported = await f.exportDraft(applicationId, 'cv', 'txt');
  assert.ok((await readFile(exported.export.path, 'utf8')).includes('data  services'));
});

