import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCareerState, hash, upgradeCareer } from '../src/mcp/state.mjs';
import { assertMasterReady, createMasterCvTools, masterCareerGaps, masterCvState, masterExportSnapshot, masterHeading, renderMaster, saveManualMaster, validateMasterCareer } from '../src/mcp/master-cv.mjs';

const presentation = { template: 'classic', paper: 'A4' };
const document = { headline: 'System administrator', summary: 'Maintained dependable services and restored service during incidents.',
  highlights: ['Improved service reliability.'], experience: [{ employer: 'Example Labs', role: 'System administrator', startDate: '2004-01', endDate: '', bullets: ['Maintained production services.'] }] };
function fixture() {
  let state = { career: createCareerState() }, queue = Promise.resolve();
  const sourceId = randomUUID(), text = 'Example Labs: worked as a sysadmin from Jan2004. Maintained production services and improved service reliability.';
  state.career.sources[sourceId] = { id: sourceId, name: 'Synthetic original CV', purpose: 'cv', mediaType: 'text/plain', text, contentHash: hash(text) };
  Object.assign(state.career.profile, { name: 'Alex Example', email: 'alex@example.test', phone: '+44 000 1234', location: 'London', linkedinUrl: 'https://linkedin.com/in/alex-example', links: [] });
  const store = { get: () => structuredClone(state), update(change) {
    const action = queue.then(async () => { const next = structuredClone(state); await change(next); state = next; });
    queue = action.catch(() => {}); return action;
  } };
  const tools = new Map(createMasterCvTools({ store }).map(tool => [tool.name, tool]));
  const read = () => tools.get('career_master_cv_read').invoke({});
  const save = (doc = document, extra = {}) => tools.get('career_master_cv_save').invoke({ baseVersion: state.career.masterCv?.current?.version ?? 0, document: structuredClone(doc), ...extra });
  const mutation = fields => ({ requestId: randomUUID(), revision: state.career.revision, ...fields });
  const manual = (doc, extra = {}) => saveManualMaster({ store, args: mutation({ baseVersion: state.career.masterCv?.current?.version ?? 0, contact: masterCvState(state.career).contact, document: doc, presentation, ...extra }) });
  return { state: () => structuredClone(state.career), store, sourceId, tools, read, save, manual, mutation };
}

test('plain master accepts semantic titles and equivalent dates without proof bookkeeping', async () => {
  const f = fixture();
  assert.equal(f.read().status, 'missing');
  assert.deepEqual([...f.tools.keys()], ['career_master_cv_read', 'career_master_cv_save']);
  assert.deepEqual(f.tools.get('career_master_cv_save').inputSchema.required, ['baseVersion', 'document']);
  const saved = await f.save();
  assert.equal(saved.status, 'ready');
  assert.deepEqual(saved.master.document, document);
  assert.deepEqual(saved.master.presentation, presentation);
  assert.deepEqual(f.state().masterCv.current.sourceIds, [f.sourceId]);
  assert.deepEqual(f.read().sources, [{ id: f.sourceId, name: 'Synthetic original CV' }]);
  for (const key of ['evidence', 'sourceSetFingerprint', 'review', 'roles', 'policyId']) assert.equal(Object.hasOwn(f.read(), key), false);
  assert.deepEqual(f.state().facts, {}, 'saving prose does not create per-claim facts');
});

test('malformed content is rejected but unknown dates and zero employment roles are allowed', async () => {
  const f = fixture();
  assert.throws(() => f.save({ ...document, experience: [{ ...document.experience[0], bullets: [{ text: 'Not a string' }] }] }), { code: 'INVALID_INPUT' });
  assert.throws(() => f.save(document, { sourceSetFingerprint: 'a'.repeat(64) }), { code: 'INVALID_INPUT' });
  const saved = await f.save({ headline: 'Computing graduate', summary: 'Built an accessible reading project.', experience: [], education: [{ institution: 'Example University', qualification: 'BSc Computing', endDate: '' }] });
  assert.equal(saved.status, 'ready');
});

test('added removed and archived originals make a master stale without replacing saved edits', async () => {
  const f = fixture();
  await f.save();
  const edited = { ...document, summary: 'I keep services dependable and help colleagues recover from incidents.' };
  await f.manual(edited);
  const sourceId = randomUUID();
  await f.store.update(state => { state.career.sources[sourceId] = { id: sourceId, purpose: 'cv', name: 'New original', text: 'Earlier experience' }; });
  assert.equal(f.read().status, 'stale');
  assert.deepEqual(f.read().master.document, edited);
  assert.throws(() => assertMasterReady(f.state()), { code: 'MASTER_NOT_READY' });
  await f.manual(edited);
  assert.equal(f.read().status, 'stale', 'manual edits do not acknowledge newly imported CVs');
  await f.save(f.read().master.document);
  assert.equal(f.read().status, 'ready');
  assert.equal(f.read().userEdited, true);
  assert.deepEqual(f.read().master.document, edited);
  await f.store.update(state => { state.career.sources[sourceId].archived = true; });
  assert.equal(f.read().status, 'stale');
  await f.save(edited);
  await f.store.update(state => { delete state.career.sources[f.sourceId]; });
  assert.equal(f.read().status, 'stale');
  assert.equal(f.state().masterCv.history[0].document.summary, document.summary);
});

test('ordinary version concurrency protects saved user edits and UI retries are idempotent', async () => {
  const f = fixture();
  await f.save();
  const edited = { ...document, summary: 'Candidate-edited summary.' };
  const args = f.mutation({ baseVersion: 1, contact: f.read().contact, document: edited, presentation });
  const first = await saveManualMaster({ store: f.store, args });
  assert.deepEqual(await saveManualMaster({ store: f.store, args }), first);
  await assert.rejects(f.save(document, { baseVersion: 1 }), { code: 'VERSION_CONFLICT' });
  assert.deepEqual(f.read().master.document, edited);
  await assert.rejects(saveManualMaster({ store: f.store, args: { ...args, requestId: randomUUID() } }), { code: 'REVISION_CONFLICT' });
  const current = f.read();
  await f.save({ ...current.master.document, skills: [{ label: 'Operations', items: ['Linux'] }] }, { baseVersion: current.master.version });
  assert.equal(f.read().master.document.summary, edited.summary);
});

test('incomplete manual master remains editable but cannot export', async () => {
  const f = fixture();
  await f.manual({ headline: '', summary: '', experience: [] });
  assert.equal(f.read().status, 'draft');
  assert.throws(() => assertMasterReady(f.state()), { code: 'MASTER_NOT_READY' });
  await f.save();
  assert.equal(f.read().status, 'ready');
});

test('career breaks derive from plain master dates and never guess missing dates', async () => {
  const f = fixture();
  await f.store.update(state => { state.career.careerGap = { enabled: true, activity: 'Study leave', place: 'Home', description: 'Studied independently.', minMonths: 3, fromYear: 2015, toYear: 2026 }; });
  const doc = { ...document, experience: [{ ...document.experience[0], startDate: '2018', endDate: '2020-01' }, { ...document.experience[0], startDate: '2021-01', endDate: 'Present' }] };
  const saved = await f.save(doc);
  assert.deepEqual(saved.master.document.careerGaps, [{ activity: 'Study leave', place: 'Home', description: 'Studied independently.', startDate: 'Jan 2020', endDate: 'Jan 2021' }]);
  assert.equal(masterCareerGaps(f.state(), document), undefined);
  await f.store.update(state => { state.career.careerGap.enabled = false; });
  assert.equal(f.read().master.document.careerGaps, undefined);
});

test('master exports bind ordinary revision/version and preserve contact and plain bullets', async () => {
  const f = fixture();
  await f.save();
  const snapshot = masterExportSnapshot(f.state(), f.mutation({ baseVersion: 1, format: 'txt' }));
  const header = masterHeading({ ...snapshot.contact, addressLine1: 'Example road', links: [snapshot.contact.linkedinUrl] });
  assert.equal(header.contact.split(snapshot.contact.linkedinUrl).length - 1, 1);
  assert.match(header.contact, /Example road/);
  const result = await renderMaster(snapshot, snapshot.contact, { renderCareerCvText: ({ heading, document }) => `${heading.name}\n${heading.contact}\n${document.experience[0].bullets.join('\n')}` }, 'txt');
  assert.match(result.bytes.toString('utf8'), /Alex Example/);
  assert.match(result.bytes.toString('utf8'), /Maintained production services/);
  assert.throws(() => masterExportSnapshot(f.state(), f.mutation({ baseVersion: 0, format: 'txt' })), { code: 'INVALID_INPUT' });
  await assert.rejects(renderMaster(snapshot, snapshot.contact, { renderCareerCvText: () => 'text', measureCareerCvLayout: async () => ({ fits: false }) }, 'pdf'), { code: 'LAYOUT_OVERFLOW' });
});

test('backup master validation retains stale history and rejects corrupt structural versions', async () => {
  const f = fixture();
  await f.save();
  await f.manual(document);
  const saved = f.state();
  delete saved.sources[f.sourceId];
  assert.doesNotThrow(() => validateMasterCareer(saved));
  const noTip = structuredClone(saved); noTip.masterCv.current = null;
  assert.throws(() => validateMasterCareer(noTip), { code: 'INVALID_INPUT' });
  const overflow = structuredClone(saved); overflow.masterCv.current.version = Number.MAX_SAFE_INTEGER;
  assert.throws(() => validateMasterCareer(overflow), { code: 'INVALID_INPUT' });
});

test('one-time storage cutover preserves existing CV text edits history and answers', () => {
  const career = createCareerState(), roleId = randomUUID(), factId = randomUUID();
  const oldDocument = { ...document, highlights: [{ id: randomUUID(), text: 'User edited highlight', support: {} }], experience: [{ ...document.experience[0], roleId, bullets: [{ id: randomUUID(), text: 'User edited bullet', support: {} }] }] };
  career.roles = { [roleId]: { employer: 'Example Labs', title: 'Engineer', startDate: '2004', endDate: '' } };
  career.cvReview = { roles: {} };
  career.facts[factId] = { id: factId, kind: 'narrative', subject: 'Incident response', answer: 'I coordinated recovery.', roleId, facet: 'complex_scenario', publication: 'prohibited' };
  career.masterCv = { history: [], current: { version: 1, document: oldDocument, presentation, evidence: {}, sourceSetFingerprint: 'old', editedBy: 'user', userEdited: true } };
  const upgraded = upgradeCareer(career);
  assert.equal(upgraded.masterCv.current.document.highlights[0], 'User edited highlight');
  assert.equal(upgraded.masterCv.current.document.experience[0].bullets[0], 'User edited bullet');
  assert.equal(upgraded.masterCv.current.userEdited, true);
  assert.equal(upgraded.facts[factId].answer, 'I coordinated recovery.');
  assert.equal(upgraded.facts[factId].publication, 'prohibited');
  assert.equal(upgraded.facts[factId].employer, 'Example Labs');
  assert.equal(Object.hasOwn(upgraded, 'roles'), false);
  assert.equal(Object.hasOwn(upgraded, 'cvReview'), false);
  assert.equal(Object.hasOwn(upgraded.masterCv.current, 'evidence'), false);
  const snapshot = structuredClone(upgraded);
  assert.deepEqual(upgradeCareer(upgraded), snapshot);
});
