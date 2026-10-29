import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createApplicationTools, CV_POLICY_ID } from '../src/mcp/application-tools.mjs';
import { renderableCv } from '../src/mcp/cv-quality.mjs';
import { ASSESSMENT_POLICY_ID } from '../src/mcp/matching-contract.mjs';
import { matchingProfileVersion } from '../src/mcp/assessment-policy.mjs';
import { createCareerState } from '../src/mcp/state.mjs';
import { addBlock, removeBlock } from '../src/mcp/blocklist.mjs';

// Built from this repository's document engine by build:runtime, so these
// tests exercise the real layout, PDF rendering and PDF text read-back.
const documents = createRequire(import.meta.url)('../src/generated/document-engine.cjs');
const { PDFParse } = createRequire(import.meta.url)('pdf-parse');
const digest = value => createHash('sha256').update(value).digest('hex');
const pastedJob = { title: 'Senior Platform Engineer', company: 'Example Employer', description: 'Build reliable data services for our payments platform. 5+ years required.', url: 'https://example.test/jobs/1', location: 'London' };
const cvText = 'Jane Candidate\nAcme Corp. | Platform Engineer | London | Mar 2019 – Present\n- Built event-driven data services in TypeScript and Kafka.\n- Cut deployment time from 40 minutes to 8 minutes.\n\nGlobex | Backend Developer | 2015 – 2019\n- Developed retail backend systems.\n\nUniversity of Synthetic Studies — BSc Computing';

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
  fact({ kind: 'note', subject: 'Freelance consulting', answer: 'Platform consulting for payments clients', employer: 'Initrode' });
  fact({ kind: 'note', subject: 'Side project', answer: 'Volunteered for Hooli open source' });
  fact({ kind: 'yes_no', subject: 'Right to work in the UK', answer: 'Yes' });
  const cvSource = randomUUID(), archived = randomUUID(), note = randomUUID();
  career.sources[cvSource] = { id: cvSource, name: 'Imported CV', purpose: 'cv', mediaType: 'text/plain', text: cvText, originalBase64: 'BINARY', createdAt: at };
  career.sources[archived] = { id: archived, name: 'Old CV', purpose: 'cv', archived: true, mediaType: 'text/plain', text: 'Old text: Hooli | Engineer | 2010 – 2012', createdAt: at };
  career.sources[note] = { id: note, name: 'Notes', purpose: 'supporting', mediaType: 'text/plain', text: 'Private note', createdAt: at };
  let state = { career }, queue = Promise.resolve();
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
  const catalogue = { id: 'node:9001', shortUUID: 'short-9001', title: 'Platform Engineer', company: { name: 'Catalogue Employer' }, description: 'Operate data services.', applyUrl: 'https://example.test/apply', location: 'Remote', contentHash: digest('job') };
  const requests = [], exported = [];
  const platform = async (operation, args) => {
    requests.push({ operation, args });
    if (options.platform) return options.platform(operation, args, catalogue);
    if (operation === 'job_read') return structuredClone(catalogue);
    assert.fail(`Unexpected platform operation: ${operation}`);
  };
  const exportDocument = async input => {
    exported.push(input);
    const sha256 = digest(input.bytes), extension = path.extname(input.filename), destination = path.join(directory, `${sha256}${extension}`);
    await writeFile(destination, input.bytes, { mode: 0o600 });
    return { path: destination, sha256, bytes: input.bytes.length, mediaType: input.mediaType, uri: `recruiters://exports/${sha256}${extension}` };
  };
  const tools = new Map(createApplicationTools({ store, platform, documents: options.documents ?? documents, exportDocument }).map(tool => [tool.name, tool]));
  const call = (name, args = {}) => tools.get(`career_${name}`).invoke(args);
  const mutation = args => ({ requestId: randomUUID(), revision: state.career.revision, ...args });
  const create = (args = { job: pastedJob }) => call('application_create', mutation(args));
  const saveCv = (applicationId, cv, extra = {}) => call('application_cv_save', mutation({ applicationId, cv, ...extra }));
  const saveLetter = (applicationId, paragraphs) => call('application_letter_save', mutation({ applicationId, paragraphs }));
  const exportDraft = (applicationId, kind, format) => call('application_export', mutation({ applicationId, kind, ...(format ? { format } : {}) }));
  return { store, state: () => state.career, tools, call, mutation, create, saveCv, saveLetter, exportDraft, requests, exported, catalogue, facts, sources: { cvSource, archived, note } };
}

const cited = (text, cv) => ({ text, support: { cv } });
const fromFacts = (text, ...facts) => ({ text, support: { facts } });
const acmeHeader = 'Acme Corp. | Platform Engineer | London | Mar 2019 – Present';
const tailoredCv = facts => ({
  headline: 'Senior Platform Engineer — payments data services',
  summary: 'Platform engineer building reliable data services for payments. Shortened delivery cycles and keeps production systems dependable.',
  highlights: [cited('Cut deployment time from 40 minutes to 8 minutes.', ['Cut deployment time from 40 minutes to 8 minutes.'])],
  experience: [
    { employer: 'ACME Corp', role: 'Platform Engineer', location: 'London', startDate: 'Mar 2019', endDate: 'Present',
      bullets: [
        cited('Built event-driven data services in TypeScript and Kafka since 2019.', ['- Built event-driven data services in TypeScript and Kafka.', acmeHeader]),
        cited('Automated releases, reducing deployment time from 40 minutes to 8 minutes.', ['Cut deployment time from 40 minutes to 8 minutes.']),
        cited('Owned on-call reliability for payment pipelines.', [acmeHeader]),
        fromFacts('Led a team of 12 engineers.', facts['Managing engineering teams']),
      ] },
    { employer: 'Globex', role: 'Backend Developer', startDate: '2015', endDate: '2019', bullets: [cited('Developed retail backend systems.', ['•  developed   RETAIL backend systems.'])] },
    { employer: 'INITRODE', role: 'Platform Consultant', startDate: '2014', endDate: '2015', bullets: [fromFacts('Advised payments clients on platform architecture.', facts['Freelance consulting'])] },
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
  assert.equal(context.cv, cvText, 'the saved CV is the career record; archived CVs are excluded');
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
    requirements: [{ requirement: 'Operate data services', importance: 'essential', evidence: 'demonstrated', cvQuote: 'Built event-driven data services in TypeScript and Kafka.' }],
    reason: 'Directly continues the data services work.' };
  await f.store.update(state => {
    state.career.matching = { scores: { 'node:9001': { id: 'node:9001', status: 'assessed', relocation: 'not_required', ...assessment,
      profileVersion: matchingProfileVersion(state.career), policyId: ASSESSMENT_POLICY_ID, scoredAt: new Date().toISOString(), host: null } } };
  });
  assert.deepEqual((await f.call('application_context', { applicationId })).assessment, assessment);
  await f.store.update(state => { state.career.matching.scores['node:9001'].policyId = 'stale-policy'; });
  assert.equal((await f.call('application_context', { applicationId })).assessment, null);
});

test('cv_save rejects invented employers, unsupported numbers and narrated or third-person wording without saving', async t => {
  const f = await fixture(t);
  const { applicationId } = await f.create();
  const revision = f.state().revision;
  const variant = change => { const cv = tailoredCv(f.facts); change(cv); return cv; };
  await assert.rejects(f.saveCv(applicationId, variant(cv => { cv.experience[1].employer = 'Initech'; })),
    error => error.code === 'UNKNOWN_EMPLOYER' && /Initech/.test(error.message));
  await assert.rejects(f.saveCv(applicationId, variant(cv => { cv.experience[1].employer = 'Hooli'; })),
    { code: 'UNKNOWN_EMPLOYER' }, 'neither an archived CV nor a fact answer names a CV employer');
  await assert.rejects(f.saveCv(applicationId, variant(cv => { cv.experience[0].bullets.push(cited('Improved throughput by 25%.', [acmeHeader])); })),
    error => error.code === 'UNSUPPORTED_NUMBER' && /experience\[0\]\.bullets\[4\]: 25%/.test(error.message));
  await assert.rejects(f.saveCv(applicationId, variant(cv => { cv.experience[0].bullets[3].text = 'Led a team of 15 engineers.'; })),
    error => error.code === 'UNSUPPORTED_NUMBER' && /15/.test(error.message));
  await assert.rejects(f.saveCv(applicationId, variant(cv => { cv.summary = 'Engineer with 5+ years in payments.'; })),
    error => error.code === 'UNSUPPORTED_NUMBER' && /5\+/.test(error.message), 'numbers in the job advert are not candidate data');
  await assert.rejects(f.saveCv(applicationId, variant(cv => { cv.summary = 'She led platform teams across payments.'; })),
    error => error.code === 'CV_TONE' && /She led/.test(error.message));
  await assert.rejects(f.saveCv(applicationId, variant(cv => { cv.summary = 'Platform engineer; the candidate builds data services.'; })), { code: 'CV_TONE' });
  await assert.rejects(f.saveCv(applicationId, variant(cv => { cv.experience[0].bullets[0].text = 'The CV states ownership of data services.'; })),
    error => error.code === 'UNCLEAR_FACT' && /experience\[0\]\.bullets\[0\]/.test(error.message));
  await assert.rejects(f.saveCv(applicationId, variant(cv => { cv.highlights = [cited('Led an unknown number of migrations.', [acmeHeader])]; })), { code: 'UNCLEAR_FACT' });
  await assert.rejects(f.saveCv(applicationId, variant(cv => { cv.headline = 'Platform engineer?'; })), { code: 'UNCLEAR_FACT' });
  assert.equal(f.state().revision, revision);
  assert.equal(f.state().applications[applicationId].cv, null);
});

test('cv_save binds every highlight and bullet to its own cited CV quotes and facts', async t => {
  const f = await fixture(t);
  const { applicationId } = await f.create();
  const revision = f.state().revision;
  const variant = change => { const cv = tailoredCv(f.facts); change(cv); return cv; };
  await assert.rejects(f.saveCv(applicationId, variant(cv => {
    cv.experience[0].bullets[0] = cited('Built event-driven data services, cutting deployment time to 8 minutes.', ['Built event-driven data services in TypeScript and Kafka.']);
  })), error => error.code === 'UNSUPPORTED_NUMBER' && /^experience\[0\]\.bullets\[0\]: 8 ?minutes must appear in the cited evidence/.test(error.message),
  'a number elsewhere in the CV does not support a claim that cites other evidence');
  await assert.rejects(f.saveCv(applicationId, variant(cv => { cv.experience[1].bullets[0] = fromFacts('Led a team of 12 engineers.', f.facts['Managing engineering teams']); })),
    error => error.code === 'MISATTRIBUTED_FACT' && error.message === 'experience[1].bullets[0]: fact "Managing engineering teams" belongs to Acme Corp., not Globex.');
  await assert.rejects(f.saveCv(applicationId, variant(cv => { cv.experience[0].bullets[0].support.cv = ['Built event driven services using TypeScript and Kafka.']; })),
    error => error.code === 'UNKNOWN_QUOTE' && /^experience\[0\]\.bullets\[0\]: this quote is not in the saved CV: "Built event driven services/.test(error.message));
  await assert.rejects(f.saveCv(applicationId, variant(cv => { cv.highlights[0].support.cv = ['Hooli | Engineer | 2010 – 2012']; })),
    { code: 'UNKNOWN_QUOTE' }, 'archived CVs are not the career record');
  await assert.rejects(f.saveCv(applicationId, variant(cv => { cv.highlights[0] = fromFacts('Advised payments clients.', randomUUID()); })), { code: 'UNKNOWN_FACT' });
  assert.equal(f.state().revision, revision);
  assert.equal(f.state().applications[applicationId].cv, null);
  const cv = variant(cv => { cv.highlights.push(fromFacts('Led a team of 12 engineers at Acme Corp.', f.facts['Managing engineering teams'])); });
  assert.equal((await f.saveCv(applicationId, cv)).cvVersion, 1, 'highlights may cite facts from any employer');
});

test('a valid cited CV saves with layout and notes, keeps history, and exports PDFs with claim text but no support', async t => {
  const f = await fixture(t);
  const { applicationId } = await f.create();
  const saved = await f.saveCv(applicationId, tailoredCv(f.facts));
  assert.equal(saved.cvVersion, 1);
  assert.deepEqual(saved.layout, { pages: 1, fits: true });
  assert.deepEqual(saved.issues, []);
  const stored = f.state().applications[applicationId].cv;
  assert.equal(stored.policyId, CV_POLICY_ID);
  assert.match(stored.contextFingerprint, /^[0-9a-f]{64}$/);
  assert.match(CV_POLICY_ID, /^[0-9a-f]{16}$/);
  assert.deepEqual(stored.document, tailoredCv(f.facts), 'stored drafts keep each claim\'s support');
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
    const expectedText = documents.renderCareerCvText({ document: renderableCv(app.cv.document), heading: { name: 'Jane Candidate', contact: 'jane@example.test · +44 20 7946 0000 · London · https://example.test/jane' } });
    assert.equal((await documents.validateCareerPdfText({ bytes, expectedText })).passed, true);
    const text = await pdfText(bytes), flat = text.replace(/\s+/g, ' ');
    for (const value of ['Jane Candidate', 'ACME Corp', 'Cut deployment time from 40 minutes to 8 minutes.', 'Led a team of 12 engineers.', 'Advised payments clients on platform architecture.', 'Italian (native)', 'Key achievements'])
      assert.ok(flat.includes(value), value);
    for (const value of [acmeHeader, f.facts['Managing engineering teams'], f.facts['Freelance consulting'], 'support', '[object Object]'])
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
  await assert.rejects(f.exportDraft(applicationId, 'cv', 'txt'), { code: 'APPLICATION_CONTEXT_CHANGED' });
  await f.saveCv(applicationId, tailoredCv(f.facts));
  const { export: record } = await f.exportDraft(applicationId, 'cv', 'txt');
  const text = await readFile(record.path, 'utf8');
  assert.equal(record.mediaType, 'text/plain');
  assert.equal(record.textValidation, null);
  assert.ok(text.startsWith('Jane Candidate\nSenior Platform Engineer — payments data services\nnew@example.test · +44 20 7946 0000 · London\n'));
  assert.equal(text, documents.renderCareerCvText({ document: renderableCv(f.state().applications[applicationId].cv.document), heading: { name: 'Jane Candidate', contact: 'new@example.test · +44 20 7946 0000 · London' } }));
});

test('quality notes are returned for the host without blocking the save', async t => {
  const f = await fixture(t);
  await f.store.update(state => { state.career.profile.email = null; });
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
  await assert.rejects(f.saveLetter(applicationId, [letter[0], 'I improved reliability by 30% at Acme Corp.']),
    error => error.code === 'UNSUPPORTED_NUMBER' && /paragraphs\[1\]: 30%/.test(error.message));
  await assert.rejects(f.saveLetter(applicationId, [letter[0], 'According to my profile I build data services.']), { code: 'UNCLEAR_FACT' });
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

test('tool schemas accept a structured CV and reject malformed documents and removed tools', async t => {
  const f = await fixture(t);
  assert.deepEqual([...f.tools.keys()].sort(), ['career_application_context', 'career_application_create', 'career_application_cv_save',
    'career_application_export', 'career_application_letter_save', 'career_application_read', 'career_applications_delete',
    'career_applications_list', 'career_job_read']);
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(f.tools.get('career_application_cv_save').inputSchema);
  const args = { requestId: randomUUID(), revision: 0, applicationId: randomUUID(), cv: tailoredCv(f.facts), presentation: { template: 'modern', paper: 'LETTER' } };
  assert.equal(validate(args), true, JSON.stringify(validate.errors));
  const claim = { text: 'Built data services.', support: { cv: ['Built event-driven data services in TypeScript and Kafka.'] } };
  const invalid = [
    cv => { cv.experience[0].bullets = Array.from({ length: 11 }, () => structuredClone(claim)); },
    cv => { cv.experience = []; },
    cv => { delete cv.summary; },
    cv => { cv.languages[0].proficiency = 'good'; },
    cv => { cv.sections = []; },
    cv => { cv.highlights = Array.from({ length: 7 }, () => structuredClone(claim)); },
    cv => { cv.experience[0].bullets[0] = 'Built data services.'; },
    cv => { cv.highlights[0] = 'Cut deployment time.'; },
    cv => { delete cv.experience[0].bullets[0].support; },
    cv => { cv.experience[0].bullets[0].support = {}; },
    cv => { cv.experience[0].bullets[0].support = { cv: [] }; },
    cv => { cv.experience[0].bullets[0].support = { cv: ['One.', 'Two.', 'Three.', 'Four.'] }; },
    cv => { cv.experience[0].bullets[0].support = { facts: ['not-a-uuid'] }; },
    cv => { const id = randomUUID(); cv.experience[0].bullets[0].support = { facts: [id, id] }; },
    cv => { cv.experience[0].bullets[0].support.notes = 'Extra'; },
    cv => { cv.experience[0].bullets[0].support.cv = ['x'.repeat(301)]; },
  ];
  for (const change of invalid) {
    const copy = structuredClone(args);
    change(copy.cv);
    assert.equal(validate(copy), false);
  }
  const letterSchema = ajv.compile(f.tools.get('career_application_letter_save').inputSchema);
  assert.equal(letterSchema({ requestId: randomUUID(), revision: 0, applicationId: randomUUID(), paragraphs: ['Only one paragraph.'] }), false);
});

test('CV numbers can use actual follow-up answers but not numbers suggested in questions or context', async t => {
  const f = await fixture(t);
  await f.store.update(state => {
    const fact = Object.values(state.career.facts).find(item => item.subject === 'Managing engineering teams');
    fact.question = 'Did you manage 99 engineers?';
    fact.context = 'The vacancy describes a 77-person organisation.';
    fact.followUps = [{ question: 'How many engineers did you personally manage?', answer: 'Managed 18 engineers.' }];
  });
  const { applicationId } = await f.create();
  const cv = tailoredCv(f.facts);
  cv.experience[0].bullets[3].text = 'Managed 18 engineers.';
  await f.saveCv(applicationId, cv);
  assert.equal(f.state().applications[applicationId].cv.document.experience[0].bullets[3].text, 'Managed 18 engineers.');
  for (const count of [99, 77]) {
    cv.experience[0].bullets[3].text = `Managed ${count} engineers.`;
    await assert.rejects(f.saveCv(applicationId, cv), { code: 'UNSUPPORTED_NUMBER' });
  }
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
  const cvArgs = f.mutation({ applicationId, cv: tailoredCv(f.facts) });
  await f.call('application_cv_save', cvArgs);
  const letterArgs = f.mutation({ applicationId, paragraphs: letter });
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
    ['application_letter_save', f.mutation({ applicationId, paragraphs: ['Dear team,', 'New draft'] })]])
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
