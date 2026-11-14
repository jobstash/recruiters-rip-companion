import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CAREER_GAP_ACTIVITY, CAREER_GAP_PRIVATE_TEXT, careerGapContext, resolveCareerGaps, savedCareerGap, setCareerGap } from '../src/mcp/career-gap.mjs';
import { createApplicationTools } from '../src/mcp/application-tools.mjs';
import { applicationContextFingerprint } from '../src/application-workflow.mjs';
import { validateBackupCareer } from '../src/backup.mjs';
import { createDocumentFiles } from '../src/mcp/files.mjs';
import { createCareerState } from '../src/mcp/state.mjs';
import { readyMaster } from './helpers/ready-master.mjs';
import { sourceSet, assertMasterReady } from '../src/mcp/master-cv.mjs';

const documents = createRequire(import.meta.url)('../src/generated/document-engine.cjs');
const now = new Date('2026-11-11T12:00:00Z');
const on = (overrides = {}) => ({ enabled: true, activity: CAREER_GAP_ACTIVITY, place: '', description: CAREER_GAP_PRIVATE_TEXT, minMonths: 3, fromYear: 2016, toYear: 2026, ...overrides });
const career = setting => ({ ...createCareerState(), ...(setting ? { careerGap: setting } : {}) });
const resolve = (setting, gaps) => resolveCareerGaps(career(setting), gaps, now);

test('career gap detection is off until saved, with a three-month minimum over the past ten years and a plain default entry', () => {
  assert.deepEqual(savedCareerGap(createCareerState(), now),
    { enabled: false, activity: 'Career break', place: '', description: 'Career gap period - private reasons', minMonths: 3, fromYear: 2016, toYear: 2026 });
  assert.deepEqual(savedCareerGap({ careerGap: { enabled: true } }, now).enabled, false, 'an incomplete saved setting never switches detection on');
  assert.equal(careerGapContext(createCareerState()), null);
  assert.throws(() => resolve(undefined, [{ start: '2020-01', end: '2021-01' }]), { code: 'CAREER_GAPS_OFF' });
  assert.throws(() => resolve(on({ enabled: false }), [{ start: '2020-01', end: '2021-01' }]), { code: 'CAREER_GAPS_OFF' });
  assert.equal(resolve(undefined, undefined), undefined, 'a CV without gap periods needs no setting');
});

test('saving validates every choice and changes the profile revision only for a real change', () => {
  const state = createCareerState();
  const own = { activity: '  Parental leave ', place: ' Lisbon, Portugal  ', description: '  Cared for a newborn  ' };
  const trimmed = on({ activity: 'Parental leave', place: 'Lisbon, Portugal', description: 'Cared for a newborn' });
  assert.deepEqual(setCareerGap(state, on(own)), trimmed);
  assert.equal(state.revision, 1);
  setCareerGap(state, trimmed);
  assert.equal(state.revision, 1, 'saving the same setting again leaves host revisions valid');
  assert.deepEqual(setCareerGap(createCareerState(), on({ place: '', description: '' })), on({ place: '', description: '' }), 'only the activity is required');
  for (const invalid of [on({ minMonths: 2 }), on({ minMonths: 121 }), on({ minMonths: 3.5 }), on({ fromYear: 2027, toYear: 2026 }), on({ fromYear: 1949 }),
    on({ toYear: 2101 }), on({ activity: '   ' }), on({ activity: 'x'.repeat(81) }), on({ place: 'x'.repeat(81) }), on({ description: 'x'.repeat(201) }),
    on({ activity: 'two\nlines' }), on({ place: 'two\nlines' }), on({ description: 'two\nlines' }), on({ place: 7 }),
    on({ enabled: 'yes' }), { ...on(), employer: 'Example LLC' }, { ...on(), role: 'Analyst' }, { enabled: true }, null, []])
    assert.throws(() => setCareerGap(state, invalid), { code: 'INVALID_INPUT' }, JSON.stringify(invalid));
  assert.deepEqual(state.careerGap, trimmed);
  assert.equal(state.revision, 1);
});


test('periods become entries in the candidate’s words, most recent first, and only when long enough and in range', () => {
  assert.deepEqual(resolve(on(), [{ start: '2018-03', end: '2019-01' }, { start: '2025-06', end: 'present' }]), [
    { activity: 'Career break', description: CAREER_GAP_PRIVATE_TEXT, startDate: 'Jun 2025', endDate: 'Present' },
    { activity: 'Career break', description: CAREER_GAP_PRIVATE_TEXT, startDate: 'Mar 2018', endDate: 'Jan 2019' },
  ]);
  assert.deepEqual(resolve(on({ activity: 'Sabbatical', place: 'Lisbon, Portugal', description: '' }), [{ start: '2019', end: '2021' }]),
    [{ activity: 'Sabbatical', place: 'Lisbon, Portugal', startDate: '2019', endDate: '2021' }], 'empty parts are left out of the entry');
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

test('the host supplies periods only: an activity, place, description, employer, or malformed or future dates are rejected', () => {
  for (const gaps of [[{ start: '2020-01', end: '2021-01', activity: 'Quantitative analyst' }], [{ start: '2020-01', end: '2021-01', place: 'Example LLC' }],
    [{ start: '2020-01', end: '2021-01', description: 'Led a team of 12' }], [{ start: '2020-01', end: '2021-01', employer: 'Example LLC' }],
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
  for (const change of [{ minMonths: 4 }, { fromYear: 2017 }, { toYear: 2025 }, { activity: 'Sabbatical' }, { place: 'Lisbon' }, { description: 'Travelled' }, { description: '' }])
    assert.notEqual(applicationContextFingerprint(career(on(change)), app), enabled, JSON.stringify(change));
  const context = careerGapContext(career(on({ minMonths: 6, activity: 'Sabbatical', place: 'Lisbon', description: 'Travelled and studied' })));
  const { instruction, ...binding } = context;
  assert.deepEqual(binding, { activity: 'Sabbatical', place: 'Lisbon', description: 'Travelled and studied', minMonths: 6, fromYear: 2016, toYear: 2026 });
  assert.match(instruction, /6 or more months later/);
  assert.match(instruction, /2016–2026/);
  assert.match(instruction, /activity "Sabbatical", place "Lisbon", description "Travelled and studied"/);
  // The entry sits among the roles, but the host must never treat it as one.
  assert.match(instruction, /never employment: do not add it to cv\.experience yourself, give it an employer, job title, duties or achievements, count it as work experience/);
  assert.doesNotMatch(careerGapContext(career(on({ place: '', description: '' }))).instruction, /place "|description "/);
});

test('backups keep current gap settings and entries and reject unsupported values', () => {
  const saved = career(on());
  const document = careerGaps => ({ headline: 'Engineer', summary: 'Builds services.', experience: [], careerGaps });
  saved.applications.app = { id: 'app', job: { title: 'Role' }, createdAt: 'now', updatedAt: 'now', cvHistory: [], coverLetterHistory: [], exports: [],
    cv: { version: 1, document: document([{ activity: 'Sabbatical', place: 'Lisbon', description: 'Travelled', startDate: 'Mar 2018', endDate: 'Jan 2019' }, { activity: 'Career break', startDate: '2014', endDate: '2016' }]) } };
  assert.equal(validateBackupCareer(structuredClone(saved)).careerGap.enabled, true);
  assert.throws(() => validateBackupCareer({ ...structuredClone(saved), careerGap: on({ minMonths: 1 }) }), /career gap setting is unsupported/);
  for (const [key, value, message] of [['activity', { employer: 'Example LLC' }, /activity must be text/], ['place', 7, /place must be text/], ['description', [], /description must be text/]]) {
    const broken = structuredClone(saved);
    broken.applications.app.cv.document.careerGaps[0][key] = value;
    assert.throws(() => validateBackupCareer(broken), message);
  }
  const missing = structuredClone(saved);
  delete missing.applications.app.cv.document.careerGaps[1].activity;
  assert.throws(() => validateBackupCareer(missing), /activity must be text/);
});

// The lines of the Experience section of a rendered CV, one entry per array item.
const experience = text => text.trimEnd().split('\n\nExperience\n\n')[1].split(/\n\n(?:Skills|Languages|Education|Certifications)\n/)[0].split('\n\n').map(entry => entry.split('\n'));
const render = cv => documents.renderCareerCvText({ document: { headline: 'Engineer', summary: 'Builds services.', ...cv }, heading: { name: 'Jane Candidate' } });
const role = (employer, startDate, endDate) => ({ employer, role: 'Engineer', startDate, endDate, bullets: [] });

test('a gap is laid out like a role and sits among the roles where its dates fall', () => {
  const roles = [role('Acme', 'Mar 2021', 'Present'), role('Globex', '2015', 'Jun 2019'), role('Initech', '06/2010', '2012-02')];
  const between = { activity: 'Sabbatical', place: 'Lisbon, Portugal', description: 'Travelled and studied Portuguese', startDate: 'Jun 2019', endDate: 'Mar 2021' };
  const older = { activity: 'Career break', description: 'Career gap period - private reasons', startDate: 'Feb 2012', endDate: '2015' };
  assert.deepEqual(experience(render({ experience: roles, careerGaps: [between, older] })), [
    ['Acme', 'Engineer', 'Mar 2021 – Present'],
    // Place where an employer stands, activity where a job title stands, then dates and the description as a bullet.
    ['Lisbon, Portugal', 'Sabbatical', 'Jun 2019 – Mar 2021', '• Travelled and studied Portuguese'],
    ['Globex', 'Engineer', '2015 – Jun 2019'],
    // Without a place, the activity leads the entry.
    ['Career break', 'Feb 2012 – 2015', '• Career gap period - private reasons'],
    ['Initech', 'Engineer', '06/2010 – 2012-02'],
  ]);
  const text = render({ experience: roles, careerGaps: [between] });
  assert.doesNotMatch(text, /Career gap/, 'there is no separate gap section or heading');
  assert.equal(text.match(/\nExperience\n/g).length, 1);
});

test('open, year-only, oldest and undated cases still land in reading order', () => {
  const open = { activity: 'Career break', startDate: 'Jun 2026', endDate: 'Present' };
  assert.deepEqual(experience(render({ experience: [role('Acme', 'Mar 2021', 'Jun 2026'), role('Globex', '2015', '2019')], careerGaps: [open, { activity: 'Study', startDate: '2019', endDate: '2021' }] })).map(entry => entry[0]),
    ['Career break', 'Acme', 'Study', 'Globex'], 'a gap that is still open comes first; a year-only gap sits after the role that began later');
  assert.deepEqual(experience(render({ experience: [role('Acme', '2021', 'Present')], careerGaps: [{ activity: 'Career break', startDate: '2018', endDate: '2021' }] })).map(entry => entry[0]),
    ['Acme', 'Career break'], 'a gap with no earlier role listed goes last');
  // A role whose dates cannot be read keeps its place; the gap is placed against the roles that can.
  assert.deepEqual(experience(render({ experience: [role('Acme', 'Mar 2021', 'Present'), role('Mystery', 'Spring', 'Summer'), role('Globex', '2015', 'Jun 2019')],
    careerGaps: [{ activity: 'Career break', startDate: 'Jun 2019', endDate: 'Mar 2021' }] })).map(entry => entry[0]), ['Acme', 'Mystery', 'Career break', 'Globex']);
});

const cvText = 'Jane Candidate\nAcme Corp | Platform Engineer | Mar 2021 | Present\nBuilt event-driven data services in TypeScript and Kafka.\n\nGlobex | Backend Developer | 2015 | Jun 2019\nDeveloped retail backend systems.';
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'career-gap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const initial = createCareerState(), sourceId = randomUUID();
  Object.assign(initial.profile, { name: 'Jane Candidate', email: 'jane@example.test' });
  initial.sources[sourceId] = { id: sourceId, name: 'Imported CV', purpose: 'cv', mediaType: 'text/plain', text: cvText, createdAt: now.toISOString() };
  let state = { deviceId: randomUUID(), career: initial };
  const store = { get: () => structuredClone(state), async update(change) { const copy = structuredClone(state); await change(copy); state = copy; } };
  const ref = quote => ({ ...sourceSet(initial)[0], quote });
  const roles = [
    { id: randomUUID(), employer: 'Acme Corp', title: 'Platform Engineer', startDate: 'Mar 2021', endDate: 'Present', sourceRefs: [ref(cvText.slice(0, cvText.indexOf('Globex')).trim())] },
    { id: randomUUID(), employer: 'Globex', title: 'Backend Developer', startDate: '2015', endDate: 'Jun 2019', sourceRefs: [ref(cvText.slice(cvText.indexOf('Globex')))] },
  ];
  const document = { headline: 'Platform Engineer', summary: 'Built dependable data services.', experience: roles.map(role => ({
    roleId: role.id, employer: role.employer, role: role.title, startDate: role.startDate, endDate: role.endDate,
    bullets: [{ id: randomUUID(), text: role.sourceRefs[0].quote.split('\n').at(-1), support: { sources: role.sourceRefs } }],
  })) };
  const ready = await readyMaster(store, { roles, document });
  const files = createDocumentFiles({ directory, store, assertAvailable() {} });
  const tools = new Map(createApplicationTools({ store, platform: async () => assert.fail('No platform call expected'), documents,
    exportDocument: files.exportDocument, cleanupExports: files.cleanupExports, withExportTransaction: files.withExportTransaction }).map(tool => [tool.name, tool]));
  const call = (name, args) => tools.get(`career_${name}`).invoke(args);
  const mutation = args => ({ requestId: randomUUID(), revision: state.career.revision, ...args });
  const { applicationId } = await call('application_create', mutation({ job: { title: 'Platform Engineer', company: 'Example Employer', description: 'Operate data services.', url: 'https://example.test/jobs/1' } }));
  const cvArgs = () => ({ applicationId, masterVersion: assertMasterReady(state.career).version,
    contextFingerprint: applicationContextFingerprint(state.career, state.career.applications[applicationId]), evidence: ready.evidence,
    cv: structuredClone(assertMasterReady(state.career).document),
    requirements: [{ id: randomUUID(), phrase: 'data services', priority: 'crucial', kind: 'skill', status: 'supported', roleIds: [roles[0].id],
      support: { sources: roles[0].sourceRefs }, rationale: 'Directly evidenced service delivery.' }] });
  return { tools, call, mutation, applicationId, store, cvArgs, career: () => state.career,
    set: setting => store.update(saved => { setCareerGap(saved.career, setting); }),
    refresh: () => readyMaster(store),
    saveCv: (cv = cvArgs().cv) => call('application_cv_save', mutation({ ...cvArgs(), cv })),
    exportCv: async format => { const { export: record } = await call('application_export', mutation({ applicationId, kind: 'cv', format })); return record; } };
}

test('disabled gaps stay absent in immutable master tailoring and TXT export', async t => {
  const f = await fixture(t);
  assert.equal(Object.hasOwn(await f.call('application_context', { applicationId: f.applicationId }), 'careerGap'), false);
  await f.saveCv();
  assert.doesNotMatch(await readFile((await f.exportCv('txt')).path, 'utf8'), /Career (gap|break)/);
});

test('enabled canonical gaps survive master tailoring and PDF export without agent-provided periods', async t => {
  const f = await fixture(t);
  await f.set(on());
  await f.refresh();
  const before = structuredClone(f.career().masterCv);
  const cv = f.cvArgs().cv;
  delete cv.careerGaps;
  await f.saveCv(cv);
  assert.deepEqual(f.career().masterCv, before);
  assert.deepEqual(f.career().applications[f.applicationId].cv.document.careerGaps, before.current.document.careerGaps);
  assert.deepEqual(experience(await readFile((await f.exportCv('txt')).path, 'utf8'))[1],
    ['Career break', 'Jun 2019 – Mar 2021', '• Career gap period - private reasons']);
  assert.equal((await f.exportCv('pdf')).textValidation.passed, true);
});

test('gap setting changes require a current master and retire old exports', async t => {
  const f = await fixture(t);
  await f.set(on()); await f.refresh(); await f.saveCv(); await f.exportCv('txt');
  await f.set(on({ activity: 'Family care', place: 'Porto, Portugal', description: 'Cared for a family member full time' }));
  await assert.rejects(f.exportCv('txt'), { code: 'MASTER_NOT_READY' });
  await f.refresh();
  await assert.rejects(f.exportCv('txt'), { code: 'APPLICATION_CONTEXT_CHANGED' });
  await f.saveCv();
  assert.deepEqual(experience(await readFile((await f.exportCv('txt')).path, 'utf8'))[1],
    ['Porto, Portugal', 'Family care', 'Jun 2019 – Mar 2021', '• Cared for a family member full time']);
  await f.set(on({ enabled: false })); await f.refresh(); await f.saveCv();
  assert.doesNotMatch(await readFile((await f.exportCv('txt')).path, 'utf8'), /Family care/);
});
