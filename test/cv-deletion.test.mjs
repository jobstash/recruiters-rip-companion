import test from 'node:test';
import assert from 'node:assert/strict';
import { createCareerState, hash } from '../src/mcp/state.mjs';
import { deleteCv } from '../src/mcp/cv-deletion.mjs';
import { applicationContextFingerprint, applicationQuestionKey, currentApplicationExport, reusableApplicationAnswer } from '../src/application-workflow.mjs';
import { matchingProfileVersion } from '../src/mcp/assessment-policy.mjs';
function fixture() {
  let state = { deviceId: 'synthetic-delete-device', pairing: { origin: 'https://synthetic.invalid', account: { id: '123' } }, career: createCareerState() };
  for (const id of ['cv', 'other']) state.career.sources[id] = { id, name: `${id}.txt`, purpose: 'cv', mediaType: 'text/plain', text: `${id} synthetic evidence`, contentHash: hash(`${id} synthetic evidence`) };
  state.career.facts.independent = { id: 'independent', kind: 'note', subject: 'Language', answer: 'Fluent' };
  state.career.profile.preferences.careerPaths = [{ name: 'Engineering', titles: ['Engineer'], why: 'Synthetic evidence.' }];
  const store = { get: () => structuredClone(state), async update(change) { const next = structuredClone(state); await change(next); state = next; } };
  const remove = options => deleteCv({ store, sourceId: 'cv', contentHash: state.career.sources.cv.contentHash, ...options });
  return { store, remove, change: change => change(state) };
}

test('local CV deletion works offline and preserves independent records and other CVs', async () => {
  const f = fixture();
  f.change(state => { state.pairing = null; state.identityArchives = { saved: { career: structuredClone(state.career) } }; });
  const before = f.store.get();
  assert.deepEqual(await f.remove(), { deleted: true, sourceId: 'cv' });
  const after = f.store.get();
  assert.equal(after.career.sources.cv, undefined);
  for (const key of ['facts', 'profile']) assert.deepEqual(after.career[key], before.career[key]);
  assert.deepEqual(after.career.sources.other, before.career.sources.other);
  assert.deepEqual(after.identityArchives, before.identityArchives);
  assert.equal(after.career.evidenceRevision, before.career.evidenceRevision + 1);
});

test('deletion invalidates dependent reviews, generated document exports and staged answers without deleting applications', async () => {
  const f = fixture();
  const field = { id: 'motivation', label: 'Why this role?', type: 'textarea', empty: true };
  f.change(state => {
    const career = state.career;
    const app = career.applications.app = { id: 'app', job: { id: 'local:job', title: 'Role', company: 'Company', description: 'Synthetic role' }, formAnswers: {} };
    const fingerprint = applicationContextFingerprint(career, app);
    app.cv = { version: 1, contextFingerprint: fingerprint };
    app.exports = [{ kind: 'cv', format: 'pdf', documentVersion: 1, contextFingerprint: fingerprint, textValidation: { passed: true }, uri: 'recruiters://documents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf' }];
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

test('local deletion refuses stale and unavailable sources without changing saved data', async () => {
  const f = fixture(), before = f.store.get();
  await assert.rejects(f.remove({ contentHash: hash('outdated') }), { code: 'CV_CHANGED' });
  await assert.rejects(f.remove({ sourceId: 'missing' }), { code: 'NOT_FOUND' });
  await assert.rejects(f.remove({ sourceId: '__proto__' }), { code: 'INVALID_INPUT' });
  assert.deepEqual(f.store.get(), before);
});
