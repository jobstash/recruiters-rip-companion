import test from 'node:test';
import assert from 'node:assert/strict';
import { createCareerState, hash } from '../src/mcp/state.mjs';
import { deleteCv } from '../src/mcp/cv-deletion.mjs';
import { createIntroductionTools } from '../src/mcp/introduction-tools.mjs';
import { applicationContextFingerprint, applicationQuestionKey, currentApplicationExport, reusableApplicationAnswer } from '../src/application-workflow.mjs';
import { matchingProfileVersion } from '../src/mcp/assessment-policy.mjs';
import { parseBackup } from '../src/backup.mjs';

const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function fixture() {
  let state = { deviceId: 'synthetic-delete-device', pairing: { origin: 'https://synthetic.invalid', account: { id: '123' } }, career: createCareerState() };
  for (const id of ['cv', 'other']) state.career.sources[id] = { id, name: `${id}.txt`, purpose: 'cv', mediaType: 'text/plain', text: `${id} synthetic evidence`, contentHash: hash(`${id} synthetic evidence`) };
  state.career.facts.independent = { id: 'independent', kind: 'note', subject: 'Language', answer: 'Fluent' };
  state.career.profile.preferences.roles = ['Engineer'];
  state.career.introductions = { consent: { granted: false }, documents: {} };
  const store = { get: () => structuredClone(state), async update(change) { const next = structuredClone(state); await change(next); state = next; } };
  const remove = options => deleteCv({ store, sourceId: 'cv', contentHash: state.career.sources.cv.contentHash, ...options });
  const shared = (documentId = first) => { state.career.introductions.documents.cv = { contentHash: state.career.sources.cv.contentHash, employment: [], documentId, sharedAccountId: '123' }; };
  return { store, remove, shared, change: change => change(state) };
}

test('never-shared CV deletion is offline and preserves independent records and other CVs', async () => {
  const f = fixture();
  f.change(state => { state.pairing = null; state.identityArchives = { saved: { career: structuredClone(state.career) } }; });
  const before = f.store.get();
  assert.deepEqual(await f.remove({ deleteRemote: () => assert.fail('No network for an unshared CV') }), { deleted: true, sourceId: 'cv', remoteCopies: 0 });
  const after = f.store.get();
  assert.equal(after.career.sources.cv, undefined);
  for (const key of ['facts', 'profile']) assert.deepEqual(after.career[key], before.career[key]);
  assert.deepEqual(after.career.sources.other, before.career.sources.other);
  assert.deepEqual(after.identityArchives, before.identityArchives);
  assert.equal(after.career.evidenceRevision, before.career.evidenceRevision + 1);
});

test('shared CV remote failure retains original bytes and every retry target; consent is irrelevant', async () => {
  const f = fixture(); f.shared();
  f.change(state => { state.career.sources.cv.originalBase64 = Buffer.from('synthetic bytes').toString('base64'); });
  const before = f.store.get();
  for (const message of ['Offline', 'Unauthorized', 'Storage unavailable']) {
    await assert.rejects(f.remove({ deleteRemote: async () => { throw new Error(message); } }), new RegExp(message));
    assert.deepEqual(f.store.get(), before);
  }
  const calls = [];
  await f.remove({ deleteRemote: async body => { calls.push(body); assert.ok(f.store.get().career.sources.cv); return { deleted: true, ...body }; } });
  assert.deepEqual(calls, [{ documentId: first }]);
  assert.equal(f.store.get().career.sources.cv, undefined);
  assert.equal(f.store.get().career.introductions.documents.cv, undefined);
});

test('all attempted remote copies are removed, exact duplicate legacy target is not repeated, and unrelated targets survive', async () => {
  const f = fixture(); f.shared();
  f.change(state => {
    state.career.introductions.documents.cv.remoteCopies = [{ documentId: first, accountId: '123' }, { documentId: second, accountId: '123' }];
    state.career.introductions.documents.other = { documentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
  });
  const calls = [];
  let failSecond = true;
  const deleteRemote = async body => { calls.push(body.documentId); if (body.documentId === second && failSecond) throw new Error('retry'); return { deleted: true, ...body }; };
  await assert.rejects(f.remove({ deleteRemote }), /retry/);
  assert.ok(f.store.get().career.sources.cv);
  failSecond = false;
  await f.remove({ deleteRemote });
  assert.deepEqual(calls, [first, second, first, second]);
  assert.ok(f.store.get().career.sources.other);
  assert.ok(f.store.get().career.introductions.documents.other.documentId);
});

test('restored provenance without shared status still requires exact remote deletion and rejects known account mismatch', async () => {
  const f = fixture(); f.shared();
  // Exercise the real portable/legacy parser: restored status is unverified, removal provenance stays.
  const restored = parseBackup(JSON.stringify({ version: 1, exportedAt: '2026-01-01T00:00:00.000Z', career: f.store.get().career })).profiles[0].career;
  f.change(state => { state.career = restored; state.pairing.account.id = '999'; });
  await assert.rejects(f.remove({ deleteRemote: () => assert.fail('Wrong account must not send') }), { code: 'CV_ACCOUNT_MISMATCH' });
  assert.ok(f.store.get().career.sources.cv);
  f.change(state => { state.pairing.account.id = '123'; });
  let called = false;
  await f.remove({ deleteRemote: async body => { called = true; return { deleted: true, ...body }; } });
  assert.equal(called, true);
});

test('a changed source, changed sharing target or changed identity cannot be removed after a pending response', async () => {
  for (const change of [
    state => { state.career.sources.cv.text = 'replacement'; },
    state => { state.career.introductions.documents.cv.documentId = second; },
    state => { state.pairing.account.id = '999'; },
  ]) {
    const f = fixture(); f.shared();
    await assert.rejects(f.remove({ deleteRemote: async body => { f.change(change); return { deleted: true, ...body }; } }), error => ['CV_CHANGED', 'IDENTITY_CHANGED'].includes(error.code));
    assert.ok(f.store.get().career.sources.cv);
  }
});

test('unconfirmed remote results never count as deletion', async () => {
  const f = fixture(); f.shared();
  for (const result of [{}, { deleted: false, documentId: first }, { deleted: true, documentId: second }])
    await assert.rejects(f.remove({ deleteRemote: async () => result }), { code: 'CV_DELETE_FAILED' });
  assert.ok(f.store.get().career.sources.cv);
});

test('deletion invalidates dependent reviews, generated document exports and staged answers without deleting applications', async () => {
  const f = fixture();
  const field = { id: 'motivation', label: 'Why this role?', type: 'textarea', empty: true };
  f.change(state => {
    const career = state.career;
    const app = career.applications.app = { id: 'app', job: { id: 'local:job', title: 'Role', company: 'Company', description: 'Synthetic role' }, formAnswers: {} };
    const fingerprint = applicationContextFingerprint(career, app);
    app.cv = { version: 1, contextFingerprint: fingerprint };
    app.exports = [{ kind: 'cv', format: 'pdf', documentVersion: 1, contextFingerprint: fingerprint, textValidation: { passed: true }, uri: `recruiters://exports/${'a'.repeat(64)}.pdf` }];
    app.formAnswers[applicationQuestionKey(field)] = { value: 'Derived prose', contextFingerprint: fingerprint };
    career.formDrafts = { form: { answers: { answer: 'Derived prose' }, evidenceRevision: career.evidenceRevision } };
    career.matching = { scores: { job: { profileVersion: matchingProfileVersion(career) } } };
  });
  const before = f.store.get().career;
  assert.ok(currentApplicationExport(before, before.applications.app, 'cv'));
  assert.equal(reusableApplicationAnswer(before, 'app', field).value, 'Derived prose');
  await f.remove();
  const after = f.store.get().career;
  assert.equal(currentApplicationExport(after, after.applications.app, 'cv'), null);
  assert.ok(!reusableApplicationAnswer(after, 'app', field), 'Deleted evidence must not release a previously reusable answer');
  assert.notEqual(after.matching.scores.job.profileVersion, matchingProfileVersion(after));
  assert.deepEqual(after.applications.app.formAnswers, {});
  assert.deepEqual(after.formDrafts.form.answers, {});
  assert.deepEqual(after.applications.app.exports, before.applications.app.exports);
});

test('share persists cleanup target before upload and transport loss leaves it deletable', async () => {
  const f = fixture();
  f.change(state => { state.career.introductions.consent = { granted: true, at: '2026-01-01T00:00:00.000Z' }; state.career.introductions.documents.cv = { contentHash: state.career.sources.cv.contentHash, employment: [] }; });
  let sent;
  const tools = createIntroductionTools({ store: f.store, shareCv: async body => {
    sent = body;
    assert.deepEqual(f.store.get().career.introductions.documents.cv.remoteCopies, [{ documentId: body.documentId, accountId: '123' }]);
    await assert.rejects(f.remove(), { code: 'CV_BUSY' });
    throw new Error('response lost');
  } });
  await assert.rejects(tools.find(tool => tool.name === 'career_cv_share').invoke({ sourceId: 'cv' }), /response lost/);
  let removed;
  await f.remove({ deleteRemote: async body => { removed = body.documentId; return { deleted: true, ...body }; } });
  assert.equal(removed, sent.documentId);
});

test('a restored CV cannot acquire cleanup targets for a second account', async () => {
  const f = fixture(); f.shared();
  f.change(state => {
    state.career = parseBackup(JSON.stringify({ version: 1, exportedAt: '2026-01-01T00:00:00.000Z', career: state.career })).profiles[0].career;
    state.pairing.account.id = '999';
    state.career.introductions.consent = { granted: true, at: '2026-01-01T00:00:00.000Z' };
  });
  const before = f.store.get();
  const tools = createIntroductionTools({ store: f.store, shareCv: () => assert.fail('A different account must not receive this CV') });
  await assert.rejects(tools.find(tool => tool.name === 'career_cv_share').invoke({ sourceId: 'cv' }), {
    code: 'CV_ACCOUNT_MISMATCH',
  });
  assert.deepEqual(f.store.get(), before, 'Refusal must not append a second-account target');
  f.change(state => { state.pairing.account.id = '123'; });
  const targets = [];
  await f.remove({ deleteRemote: async body => { targets.push(body.documentId); return { deleted: true, ...body }; } });
  assert.deepEqual(targets, [first], 'The original account can still remove the original copy');
});

test('unbound legacy sharing provenance is retained rather than assigned to the current account', async () => {
  const f = fixture(); f.shared();
  f.change(state => {
    delete state.career.introductions.documents.cv.sharedAccountId;
    state.career.introductions.consent = { granted: true, at: '2026-01-01T00:00:00.000Z' };
  });
  const before = f.store.get();
  const tools = createIntroductionTools({ store: f.store, shareCv: () => assert.fail('Unknown previous ownership must not create a mixed-account source') });
  await assert.rejects(tools.find(tool => tool.name === 'career_cv_share').invoke({ sourceId: 'cv' }), { code: 'CV_ACCOUNT_MISMATCH' });
  assert.deepEqual(f.store.get(), before);
});
