import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { CAREER_GAP_PRIVATE_TEXT, careerGapContext, resolveCareerGaps, savedCareerGap, setCareerGap } from '../src/mcp/career-gap.mjs';
import { createApplicationTools } from '../src/mcp/application-tools.mjs';
import { applicationContextFingerprint } from '../src/application-workflow.mjs';
import { validateBackupCareer } from '../src/backup.mjs';
import { createDocumentFiles } from '../src/mcp/files.mjs';
import { createCareerState } from '../src/mcp/state.mjs';

const documents = createRequire(import.meta.url)('../src/generated/document-engine.cjs');
const now = new Date('2026-11-11T12:00:00Z');
const on = (overrides = {}) => ({ enabled: true, mode: 'private', text: '', minMonths: 3, fromYear: 2016, toYear: 2026, ...overrides });
const career = setting => ({ ...createCareerState(), ...(setting ? { careerGap: setting } : {}) });
const resolve = (setting, gaps) => resolveCareerGaps(career(setting), gaps, now);

test('career gap detection is off until saved, with a three-month minimum over the past ten years', () => {
  assert.deepEqual(savedCareerGap(createCareerState(), now), { enabled: false, mode: 'private', text: '', minMonths: 3, fromYear: 2016, toYear: 2026 });
  assert.deepEqual(savedCareerGap({ careerGap: { enabled: true } }, now).enabled, false, 'an incomplete saved setting never switches detection on');
  assert.equal(careerGapContext(createCareerState()), null);
  assert.throws(() => resolve(undefined, [{ start: '2020-01', end: '2021-01' }]), { code: 'CAREER_GAPS_OFF' });
  assert.throws(() => resolve(on({ enabled: false }), [{ start: '2020-01', end: '2021-01' }]), { code: 'CAREER_GAPS_OFF' });
  assert.equal(resolve(undefined, undefined), undefined, 'a CV without gap periods needs no setting');
});

test('saving validates every choice and changes the profile revision only for a real change', () => {
  const state = createCareerState();
  assert.deepEqual(setCareerGap(state, on({ mode: 'custom', text: '  Cared for a parent  ' })), on({ mode: 'custom', text: 'Cared for a parent' }));
  assert.equal(state.revision, 1);
  setCareerGap(state, on({ mode: 'custom', text: 'Cared for a parent' }));
  assert.equal(state.revision, 1, 'saving the same setting again leaves host revisions valid');
  for (const invalid of [on({ minMonths: 2 }), on({ minMonths: 121 }), on({ minMonths: 3.5 }), on({ fromYear: 2027, toYear: 2026 }), on({ fromYear: 1949 }),
    on({ toYear: 2101 }), on({ mode: 'custom', text: '   ' }), on({ mode: 'other' }), on({ text: 'two\nlines' }), on({ text: 'x'.repeat(201) }),
    on({ enabled: 'yes' }), { ...on(), employer: 'Example LLC' }, { enabled: true }, null, []])
    assert.throws(() => setCareerGap(state, invalid), { code: 'INVALID_INPUT' }, JSON.stringify(invalid));
  assert.deepEqual(state.careerGap, on({ mode: 'custom', text: 'Cared for a parent' }));
  assert.equal(state.revision, 1);
});

test('periods render in the candidate’s wording, most recent first, and only when long enough and in range', () => {
  assert.deepEqual(resolve(on(), [{ start: '2018-03', end: '2019-01' }, { start: '2025-06', end: 'present' }]), [
    { label: CAREER_GAP_PRIVATE_TEXT, startDate: 'Jun 2025', endDate: 'Present' },
    { label: CAREER_GAP_PRIVATE_TEXT, startDate: 'Mar 2018', endDate: 'Jan 2019' },
  ]);
  assert.deepEqual(resolve(on({ mode: 'custom', text: 'Cared for a parent' }), [{ start: '2019', end: '2021' }]),
    [{ label: 'Cared for a parent', startDate: '2019', endDate: '2021' }]);
  assert.deepEqual(resolve(on(), [{ start: '2019-03', end: '2019-06' }]).length, 1, 'exactly the minimum counts');
  assert.throws(() => resolve(on(), [{ start: '2019-03', end: '2019-05' }]), error => error.code === 'CAREER_GAP_TOO_SHORT' && /2 months/.test(error.message));
  assert.throws(() => resolve(on({ minMonths: 12 }), [{ start: '2019-03', end: '2020-02' }]), { code: 'CAREER_GAP_TOO_SHORT' });
  assert.throws(() => resolve(on(), [{ start: '2019', end: '2020' }]), error => error.code === 'CAREER_GAP_TOO_SHORT' && /shortest reading/.test(error.message),
    'December 2019 to January 2020 is all that year-only dates establish');
  assert.throws(() => resolve(on(), [{ start: '2021-06', end: '2020-01' }]), { code: 'CAREER_GAP_TOO_SHORT' });
  assert.throws(() => resolve(on(), [{ start: '2012-01', end: '2015-06' }]), { code: 'CAREER_GAP_OUT_OF_RANGE' });
  assert.throws(() => resolve(on({ toYear: 2020 }), [{ start: '2021-01', end: '2022-01' }]), { code: 'CAREER_GAP_OUT_OF_RANGE' });
  assert.deepEqual(resolve(on(), [{ start: '2014-06', end: '2016-02' }]).length, 1, 'a gap that reaches into the range counts');
});

test('the host supplies periods only: wording, employers and malformed or future dates are rejected', () => {
  for (const gaps of [[{ start: '2020-01', end: '2021-01', label: 'Quantitative analyst' }], [{ start: '2020-01', end: '2021-01', employer: 'Example LLC' }],
    [{ start: 'Jan 2020', end: '2021-01' }], [{ start: '2020-13', end: '2021-01' }], [{ start: '2020-01' }], [{ start: '2027-01', end: 'present' }],
    [{ start: '2025-01', end: '2027-01' }], [{ start: '2020-01', end: '2021-01' }, { start: '2020-01', end: '2021-01' }], [], [null], 'present',
    Array.from({ length: 6 }, (_, index) => ({ start: `${2016 + index}-01`, end: `${2016 + index}-09` }))])
    assert.throws(() => resolve(on(), gaps), { code: 'INVALID_INPUT' }, JSON.stringify(gaps));
});

test('only an enabled setting changes application fingerprints and reaches the host', () => {
  const app = { id: 'app', job: { title: 'Role', company: 'Company', description: 'Synthetic role' } };
  const off = applicationContextFingerprint(career(), app);
  assert.equal(applicationContextFingerprint(career(on({ enabled: false, minMonths: 9 })), app), off, 'profiles that never enable it keep their documents');
  const enabled = applicationContextFingerprint(career(on()), app);
  assert.notEqual(enabled, off);
  for (const change of [{ minMonths: 4 }, { fromYear: 2017 }, { toYear: 2025 }, { mode: 'custom', text: 'Sabbatical' }])
    assert.notEqual(applicationContextFingerprint(career(on(change)), app), enabled, JSON.stringify(change));
  const context = careerGapContext(career(on({ minMonths: 6, mode: 'custom', text: 'Sabbatical' })));
  assert.deepEqual({ text: context.text, minMonths: context.minMonths, fromYear: context.fromYear, toYear: context.toYear }, { text: 'Sabbatical', minMonths: 6, fromYear: 2016, toYear: 2026 });
  assert.match(context.instruction, /6 or more months later/);
  assert.match(context.instruction, /2016–2026/);
  assert.match(context.instruction, /never employment/);
});

test('backups keep the setting and saved gap entries, and reject an unsupported setting', () => {
  const saved = career(on());
  saved.applications.app = { id: 'app', job: { title: 'Role' }, createdAt: 'now', updatedAt: 'now', cvHistory: [], coverLetterHistory: [], exports: [],
    cv: { version: 1, document: { headline: 'Engineer', summary: 'Builds services.', experience: [],
      careerGaps: [{ label: CAREER_GAP_PRIVATE_TEXT, startDate: 'Mar 2018', endDate: 'Jan 2019' }] } } };
  assert.equal(validateBackupCareer(structuredClone(saved)).careerGap.enabled, true);
  assert.throws(() => validateBackupCareer({ ...structuredClone(saved), careerGap: on({ minMonths: 1 }) }), /career gap setting is unsupported/);
  const broken = structuredClone(saved);
  broken.applications.app.cv.document.careerGaps[0].label = { employer: 'Example LLC' };
  assert.throws(() => validateBackupCareer(broken), /label must be text/);
});

const cvText = 'Jane Candidate\nAcme Corp. | Platform Engineer | London | Mar 2021 – Present\n- Built event-driven data services in TypeScript and Kafka.\n\nGlobex | Backend Developer | 2015 – Jun 2019\n- Developed retail backend systems.';
const cited = (text, cv) => ({ text, support: { cv } });
const tailored = (extra = {}) => ({
  headline: 'Platform Engineer — data services',
  summary: 'Platform engineer building dependable data services.',
  experience: [
    { employer: 'Acme Corp', role: 'Platform Engineer', startDate: 'Mar 2021', endDate: 'Present', bullets: [cited('Built event-driven data services in TypeScript and Kafka.', ['Built event-driven data services in TypeScript and Kafka.'])] },
    { employer: 'Globex', role: 'Backend Developer', startDate: '2015', endDate: 'Jun 2019', bullets: [cited('Developed retail backend systems.', ['Developed retail backend systems.'])] },
  ],
  ...extra,
});
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'career-gap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const initial = createCareerState(), source = randomUUID();
  Object.assign(initial.profile, { name: 'Jane Candidate', email: 'jane@example.test' });
  initial.sources[source] = { id: source, name: 'Imported CV', purpose: 'cv', mediaType: 'text/plain', text: cvText, createdAt: now.toISOString() };
  let state = { deviceId: randomUUID(), career: initial };
  const store = { get: () => structuredClone(state), async update(change) { const copy = structuredClone(state); await change(copy); state = copy; } };
  const files = createDocumentFiles({ directory, store, assertAvailable() {} });
  const tools = new Map(createApplicationTools({ store, platform: async () => assert.fail('No platform call expected'), documents,
    exportDocument: files.exportDocument, cleanupExports: files.cleanupExports, withExportTransaction: files.withExportTransaction }).map(tool => [tool.name, tool]));
  const call = (name, args) => tools.get(`career_${name}`).invoke(args);
  const mutation = args => ({ requestId: randomUUID(), revision: state.career.revision, ...args });
  const { applicationId } = await call('application_create', mutation({ job: { title: 'Platform Engineer', company: 'Example Employer', description: 'Operate data services.', url: 'https://example.test/jobs/1' } }));
  return { tools, call, mutation, applicationId, career: () => state.career,
    set: setting => store.update(saved => { setCareerGap(saved.career, setting); }),
    saveCv: cv => call('application_cv_save', mutation({ applicationId, cv })),
    exportCv: async format => { const { export: record } = await call('application_export', mutation({ applicationId, kind: 'cv', format })); return record; } };
}
const gap = { start: '2019-06', end: '2021-03' };

test('a generated CV mentions no gap and accepts no gap periods while detection is off', async t => {
  const f = await fixture(t);
  assert.equal(Object.hasOwn(await f.call('application_context', { applicationId: f.applicationId }), 'careerGap'), false);
  await assert.rejects(f.saveCv(tailored({ careerGaps: [gap] })), { code: 'CAREER_GAPS_OFF' });
  await f.saveCv(tailored());
  const text = await readFile((await f.exportCv('txt')).path, 'utf8');
  assert.doesNotMatch(text, /Career gap/);
});

test('with detection on, the CV gains a labelled Career gap section in the candidate’s wording and survives PDF export', async t => {
  const f = await fixture(t);
  await f.set(on());
  const context = await f.call('application_context', { applicationId: f.applicationId });
  assert.equal(context.careerGap.text, CAREER_GAP_PRIVATE_TEXT);
  const ajv = new Ajv({ strict: false }); addFormats(ajv);
  const validate = ajv.compile(f.tools.get('career_application_cv_save').inputSchema);
  assert.equal(validate(f.mutation({ applicationId: f.applicationId, cv: tailored({ careerGaps: [gap] }) })), true, JSON.stringify(validate.errors));
  for (const careerGaps of [[{ ...gap, label: 'Quantitative analyst' }], [{ start: 'Jun 2019', end: '2021-03' }], []])
    assert.equal(validate(f.mutation({ applicationId: f.applicationId, cv: tailored({ careerGaps }) })), false, JSON.stringify(careerGaps));

  await assert.rejects(f.saveCv(tailored({ careerGaps: [{ start: '2021-01', end: '2021-03' }] })), { code: 'CAREER_GAP_TOO_SHORT' });
  assert.equal(f.career().applications[f.applicationId].cv, null);
  await f.saveCv(tailored({ careerGaps: [gap] }));
  assert.deepEqual(f.career().applications[f.applicationId].cv.document.careerGaps, [{ label: CAREER_GAP_PRIVATE_TEXT, startDate: 'Jun 2019', endDate: 'Mar 2021' }]);
  const text = await readFile((await f.exportCv('txt')).path, 'utf8');
  assert.match(text, /\nGlobex\nBackend Developer\n2015 – Jun 2019\n• Developed retail backend systems\.\n\nCareer gap\n\nCareer gap period - private reasons\nJun 2019 – Mar 2021\n/,
    'the gap is its own section after Experience, never an experience entry');
  assert.equal((await f.exportCv('pdf')).textValidation.passed, true);
});

test('changing the wording makes earlier documents stale, and the next CV carries the candidate’s own words', async t => {
  const f = await fixture(t);
  await f.set(on());
  await f.saveCv(tailored({ careerGaps: [gap] }));
  await f.exportCv('txt');
  await f.set(on({ mode: 'custom', text: 'Cared for a family member full time' }));
  await assert.rejects(f.exportCv('txt'), { code: 'APPLICATION_CONTEXT_CHANGED' });
  await f.saveCv(tailored({ careerGaps: [gap] }));
  assert.match(await readFile((await f.exportCv('txt')).path, 'utf8'), /\nCareer gap\n\nCared for a family member full time\nJun 2019 – Mar 2021\n/);
  await f.set(on({ enabled: false }));
  await assert.rejects(f.exportCv('txt'), { code: 'APPLICATION_CONTEXT_CHANGED' }, 'turning detection off retires documents that show a gap');
  await assert.rejects(f.saveCv(tailored({ careerGaps: [gap] })), { code: 'CAREER_GAPS_OFF' });
});

test('a host working from an older profile revision must reread after the candidate changes the setting', async t => {
  const f = await fixture(t);
  const stale = f.mutation({ applicationId: f.applicationId, cv: tailored() });
  await f.set(on());
  await assert.rejects(f.call('application_cv_save', stale), { code: 'REVISION_CONFLICT' });
});
