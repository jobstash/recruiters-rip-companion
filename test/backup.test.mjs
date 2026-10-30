import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, readdir, rename, mkdir, unlink, symlink, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVault } from '../src/vault.mjs';
import { createBackups, parseBackup, MAX_BACKUP_BYTES } from '../src/backup.mjs';
import { createCareerState, hash, mutateCareer } from '../src/mcp/state.mjs';
import { createDocumentFiles } from '../src/mcp/files.mjs';
import { createScopedAccess } from '../src/mcp/scope.mjs';
import { assertJobNotBlocked } from '../src/mcp/blocklist.mjs';
import { assertPrivatePath } from '../src/platform-runtime.cjs';

const now = '2026-10-29T10:00:00.000Z';
const pdf = Buffer.from('%PDF-1.7\nSynthetic portable document bytes\n%%EOF');
function profile(name = 'Synthetic candidate') {
  const career = createCareerState(), sourceId = randomUUID(), factId = randomUUID(), applicationId = randomUUID();
  career.profile.name = name; career.profile.preferences = { roles: ['Engineer'], salaryMinimum: 100000, willingToRelocate: false };
  career.sources[sourceId] = { id: sourceId, purpose: 'cv', name: 'Original.pdf', text: 'Synthetic CV text', contentHash: hash('Synthetic CV text'), mediaType: 'application/pdf', originalBase64: pdf.toString('base64'), provenance: { kind: 'native_file' }, createdAt: now };
  career.facts[factId] = { id: factId, kind: 'note', subject: 'Team size', answer: 'Eight', detail: 'Led a team of eight.', followUps: [{ question: 'Which team?', answer: 'Platform', context: 'Prior role' }] };
  career.jobs = { 'local:synthetic': { id: 'local:synthetic', title: 'Engineer', company: 'Synthetic employer', url: 'https://example.test/job', description: 'Build synthetic tools.', complete: true, createdAt: now, updatedAt: now } };
  career.blocklist = { 'company:synthetic employer': { kind: 'company', value: 'Synthetic employer', createdAt: now }, 'category:recruiting': { kind: 'category', value: 'Recruiting', createdAt: now } };
  career.applications[applicationId] = { id: applicationId, job: { id: 'local:synthetic', title: 'Engineer', company: 'Synthetic employer', description: 'Build synthetic tools.', url: 'https://example.test/job' }, createdAt: now, updatedAt: now,
    cv: null, coverLetter: { version: 2, paragraphs: ['Current letter'], createdAt: now }, cvHistory: [], coverLetterHistory: [{ version: 1, paragraphs: ['Earlier letter'], createdAt: now }], exports: [], formAnswers: { saved: { value: 'Saved answer' } } };
  career.receipts.old = { operation: 'old', result: { sentinel: true } };
  career.applicationBindings = { old: { bindingId: 'old' } }; career.applicationPreparations = { old: { preparationId: 'old' } };
  career.formDrafts = { old: { formId: 'old', fields: [], answers: { answer: { value: 'Retained text' } }, evidence: 'old authority' } };
  career.introductions = { consent: { granted: true, version: 1, at: now }, documents: { [sourceId]: { contentHash: hash('Synthetic CV text'), employment: [], sharedHash: 'old sharing receipt', sharedContentHash: hash('Synthetic CV text'), sharedAt: now } } };
  Object.assign(career.introductions.documents[sourceId], { documentId: randomUUID(), sharedAccountId: 'original-account',
    remoteCopies: [{ documentId: randomUUID(), accountId: 'original-account' }] });
  return career;
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'recruiters-backup-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vault = createVault(directory); await vault.open();
  let selected, destination = path.join(directory, 'selected.json'), epoch = 0, locked = false, restoring = false, restored = 0;
  const assertAvailable = () => { if (locked) throw Object.assign(new Error('Locked'), { code: 'LOCAL_LOCKED' }); };
  const service = createBackups({ directory, store: vault, selectBackup: async () => selected, selectDestination: async () => destination,
    openFolder: async target => { assert.equal(target, path.join(directory, 'backups')); }, assertAvailable, epoch: () => epoch,
    exclusive: async action => { assert.equal(restoring, false); restoring = true; try { return await action(); } finally { restoring = false; } },
    onRestored: () => { epoch++; restored++; }, ...options });
  const files = createDocumentFiles({ directory, store: vault, assertAvailable });
  return { directory, vault, service, files, choose: file => { selected = file; }, destination: file => { destination = file; }, lock: value => { locked = value; }, bump: () => { epoch++; }, epoch: () => epoch, restored: () => restored,
    scoped: () => createScopedAccess(vault, { epoch: () => epoch, assertAvailable: () => { assertAvailable(); if (restoring) throw Object.assign(new Error('Restoring'), { code: 'LOCAL_BUSY' }); } }) };
}
async function seed(fixture, name) {
  const career = profile(name);
  await fixture.vault.update(state => { state.career = career; });
  const exported = await fixture.files.exportDocument({ applicationId: Object.keys(career.applications)[0], kind: 'cover_letter', bytes: pdf, mediaType: 'application/pdf' });
  Object.values(career.applications)[0].exports.push({ ...exported, kind: 'cover_letter', format: 'pdf', documentVersion: 2, textValidation: { passed: true }, createdAt: now });
  await fixture.vault.update(state => { state.career = career; });
  return career;
}
async function exported(t) {
  const from = await fixture(t); await seed(from);
  const result = await from.service.save(); assert.equal(result.exported, true);
  return { from, filename: path.join(from.directory, result.filename) };
}
const restoreArgs = preview => ({ restoreId: preview.restoreId, profileId: preview.profiles[0].id });

test('portable backup round-trips originals, saved files, user history and blocks to a new real vault', async t => {
  const { from, filename } = await exported(t), target = await fixture(t);
  await target.vault.update(state => {
    state.career.profile.name = 'Before restore'; state.career.introductions = { consent: { granted: false, version: 1, at: now } };
    state.pairing = { origin: 'https://example.test', account: { id: 'current-account', label: 'Current sign-in' } };
    state.prescanCredentials = { openai: { apiKey: 'synthetic-secret-key' } }; state.prescanCredentialVersion = 4;
    state.identityArchives = { keep: { career: createCareerState(), marker: 'Do not replace' } };
  });
  const before = target.vault.get(), stale = target.scoped(); stale.store.get(); target.choose(filename);
  const preview = await target.service.preview();
  assert.deepEqual(preview.profiles[0].counts, { cvs: 1, facts: 1, jobs: 1, applications: 1 });
  assert.equal(JSON.stringify(preview).includes('originalBase64'), false); assert.equal(JSON.stringify(preview).includes(from.directory), false);
  assert.deepEqual(await target.service.restore(restoreArgs(preview)), { restored: true, profileName: 'Synthetic candidate', safetyBackupSaved: true });
  const after = target.vault.get(), original = from.vault.get().career;
  for (const key of ['deviceId', 'privateKey', 'publicKey', 'pairing', 'identityArchives', 'prescanCredentials', 'prescanCredentialVersion']) assert.deepEqual(after[key], before[key]);
  for (const key of ['sources', 'facts', 'jobs', 'blocklist', 'profile']) assert.deepEqual(after.career[key], original[key]);
  assert.deepEqual(after.career.introductions.consent, before.career.introductions.consent);
  const sharedBefore = Object.values(original.introductions.documents)[0], sharedAfter = Object.values(after.career.introductions.documents)[0];
  for (const key of ['documentId', 'sharedAccountId', 'sharedContentHash', 'remoteCopies']) assert.deepEqual(sharedAfter[key], sharedBefore[key]);
  assert.equal(sharedAfter.sharedAt, undefined); assert.equal(sharedAfter.sharedHash, undefined);
  assert.deepEqual(after.career.receipts, {}); assert.equal(after.career.applicationBindings, undefined); assert.equal(after.career.applicationPreparations, undefined);
  assert.equal(after.career.formDrafts.old.answers.answer.value, 'Retained text'); assert.equal(after.career.formDrafts.old.evidence, '');
  const application = Object.values(after.career.applications)[0], reference = application.exports[0];
  assert.deepEqual(application.coverLetterHistory, Object.values(original.applications)[0].coverLetterHistory);
  assert.equal(reference.path.startsWith(target.directory), true);
  assert.equal(path.basename(reference.path), 'Synthetic candidate - COVER LETTER.pdf');
  assert.ok(reference.path.includes(path.join('Synthetic employer', 'Engineer')));
  assert.notEqual(reference.uri, Object.values(original.applications)[0].exports[0].uri);
  assert.deepEqual(Buffer.from((await target.files.readResource(reference.uri)).blob, 'base64'), pdf);
  assert.equal(await target.files.resolveExport(reference.uri), reference.path);
  assert.throws(() => assertJobNotBlocked(after.career, application.job.id, application.job), { code: 'JOB_BLOCKED' });
  assert.throws(() => stale.store.update(state => { state.career.profile.name = 'Late old writer'; }), { code: 'IDENTITY_CHANGED' });
  const reopened = createVault(target.directory); await reopened.open(); assert.deepEqual(reopened.get(), after);
  const safetyFiles = await readdir(path.join(target.directory, 'backups')); assert.equal(safetyFiles.length, 1);
  const safetyPath = path.join(target.directory, 'backups', safetyFiles[0]); assertPrivatePath(safetyPath);
  const safety = parseBackup(await readFile(safetyPath, 'utf8')); assert.equal(safety.profiles[0].career.profile.name, 'Before restore');
  assert.equal((await readFile(filename, 'utf8')).includes('privateKey'), false); assert.equal((await readFile(safetyPath, 'utf8')).includes('synthetic-secret-key'), false);
});

test('archives are selectable and do not replace existing identity archives', async t => {
  const from = await fixture(t); await seed(from, 'Archived profile'); const archived = from.vault.get();
  await from.vault.resetIdentity(); await from.vault.update(state => { state.career.profile.name = 'Active profile'; });
  const saved = await from.service.save(), target = await fixture(t); target.choose(path.join(from.directory, saved.filename));
  const preview = await target.service.preview(); assert.deepEqual(preview.profiles.map(item => item.name), ['Active profile', 'Archived profile']);
  await target.service.restore({ restoreId: preview.restoreId, profileId: preview.profiles[1].id });
  const after = target.vault.get(); assert.equal(after.career.profile.name, 'Archived profile'); assert.deepEqual(after.identityArchives, {});
  assert.deepEqual(after.career.sources, archived.career.sources);
  assert.deepEqual(Buffer.from((await target.files.readResource(Object.values(after.career.applications)[0].exports[0].uri)).blob, 'base64'), pdf);
});

test('current version-one JSON restores career and archives honestly without reading its foreign file paths', async t => {
  const target = await fixture(t), old = profile('Existing export'), archived = profile('Existing archive');
  Object.values(old.applications)[0].exports.push({ path: '/private/foreign/computer/not-readable.pdf', uri: `recruiters://exports/${'a'.repeat(64)}.pdf`, sha256: 'a'.repeat(64), mediaType: 'application/pdf', bytes: 321, kind: 'cover_letter', format: 'pdf' });
  const filename = path.join(target.directory, 'old.json');
  await writeFile(filename, JSON.stringify({ version: 1, exportedAt: now, account: { label: 'Old sign-in' }, career: old, archives: [{ deviceId: 'foreign-device', account: { label: 'Old account' }, career: archived }] }));
  target.choose(filename); const preview = await target.service.preview(); assert.equal(preview.profiles.length, 2); assert.ok(preview.profiles[0].warnings.length);
  await target.service.restore(restoreArgs(preview));
  const restored = target.vault.get(); assert.deepEqual(restored.career.sources, old.sources); assert.equal(restored.pairing, null); assert.equal(restored.career.introductions.consent, undefined);
  const file = Object.values(restored.career.applications)[0].exports[0]; assert.equal(file.path, undefined); assert.equal(file.uri, undefined); assert.equal(file.unavailable, true);
  assert.deepEqual(await target.files.listResources(), []);
  const resaved = await target.service.save(); assert.ok(resaved.warnings.length);
});

test('invalid versions, nested containers, prototype keys and corrupted file hashes never reach the vault', async t => {
  const { filename } = await exported(t), original = JSON.parse(await readFile(filename, 'utf8')), target = await fixture(t), before = target.vault.get();
  const variants = [
    value => { value.version = 999; },
    value => { value.profiles[0].career.version = 1; },
    value => { value.profiles[0].career.version = 3; },
    value => { value.profiles[0].career.sources = []; },
    value => { value.profiles[0].career.facts = { bad: null }; },
    value => { value.profiles[0].career.profile.preferences.roles = {}; },
    value => { Object.values(value.profiles[0].career.applications)[0].coverLetter.paragraphs = {}; },
    value => { value.profiles[0].career.blocklist = { bad: { kind: 'none', value: 'Employer' } }; },
    value => { value.profiles[0].career.privateKey = 'foreign-key'; },
    value => { value.profiles[0].career.profile = JSON.parse('{"__proto__":{"polluted":true}}'); },
    value => { value.files[0].base64 = Buffer.from('%PDF-corrupted').toString('base64'); },
    value => { value.files[0].mediaType = 'application/javascript'; },
    value => { value.files[0].uri = 'file:///etc/passwd'; },
    value => { value.files = []; },
    value => { Object.values(value.profiles[0].career.applications)[0].exports[0].uri = 'file:///etc/passwd'; },
    value => { Object.values(value.profiles[0].career.sources)[0].originalBase64 = '!!!!'; },
    value => { Object.values(value.profiles[0].career.introductions.documents)[0].remoteCopies = {}; },
    value => { Object.values(value.profiles[0].career.introductions.documents)[0].remoteCopies[0].documentId = '/foreign/path'; },
    value => { Object.values(value.profiles[0].career.jobs)[0].description = {}; },
    value => { value.profiles[0].career.evidenceRevision = Number.MAX_SAFE_INTEGER - 1; },
    value => { value.profiles[0].career.rankingVersion = Number.MAX_SAFE_INTEGER - 1; },
    value => { Object.values(value.profiles[0].career.applications)[0].coverLetter.version = Number.MAX_SAFE_INTEGER - 1; },
  ];
  for (const change of variants) {
    const value = structuredClone(original); change(value);
    const selected = path.join(target.directory, 'invalid.json'); await writeFile(selected, JSON.stringify(value)); target.choose(selected);
    await assert.rejects(target.service.preview(), { code: 'INVALID_INPUT' }); assert.deepEqual(target.vault.get(), before);
  }
  assert.equal({}.polluted, undefined); assert.equal(target.restored(), 0);
});

test('foreign paths in valid portable JSON are discarded and files bind only to the new private store', async t => {
  const { filename } = await exported(t), payload = JSON.parse(await readFile(filename, 'utf8')), target = await fixture(t);
  Object.values(payload.profiles[0].career.applications)[0].exports[0].path = '/arbitrary/foreign/file.pdf';
  const selected = path.join(target.directory, 'foreign-path.json'); await writeFile(selected, JSON.stringify(payload)); target.choose(selected);
  await target.service.restore(restoreArgs(await target.service.preview()));
  const file = Object.values(target.vault.get().career.applications)[0].exports[0]; assert.equal(file.path.startsWith(target.directory), true); assert.equal(await target.files.resolveExport(file.uri), file.path);
});

test('cancellation, direct unrevisioned changes, session changes and sign-in changes invalidate preview', async t => {
  const { filename } = await exported(t), target = await fixture(t); const before = target.vault.get();
  assert.deepEqual(await target.service.preview(), { cancelled: true }); target.destination(null); assert.deepEqual(await target.service.save(), { exported: false });
  target.choose(filename); const cancelled = await target.service.preview(); assert.deepEqual(target.service.cancel(), { cancelled: true });
  await assert.rejects(target.service.restore(restoreArgs(cancelled)), { code: 'BACKUP_STALE' }); assert.deepEqual(target.vault.get(), before);
  for (const change of [() => target.vault.update(state => { state.career.profile.name = 'Direct write without revision'; }), () => target.bump(), () => target.vault.update(state => { state.pairing = { account: { id: 'different-account' } }; })]) {
    const preview = await target.service.preview(); await change(); const current = target.vault.get();
    await assert.rejects(target.service.restore(restoreArgs(preview)), { code: 'BACKUP_STALE' }); assert.deepEqual(target.vault.get(), current);
  }
  assert.equal(target.restored(), 0);
});

test('native picker results cannot survive cancellation or a lock', async t => {
  const { filename } = await exported(t); let resolvePicker;
  const target = await fixture(t, { selectBackup: () => new Promise(resolve => { resolvePicker = resolve; }) });
  const pending = target.service.preview(); target.service.cancel(); resolvePicker(filename); assert.deepEqual(await pending, { cancelled: true });
  const locked = target.service.preview(); target.lock(true); resolvePicker(filename); await assert.rejects(locked, { code: 'LOCAL_LOCKED' });
  assert.equal(target.restored(), 0);
});

test('failed safety write or failed atomic vault replacement leaves active state untouched', async t => {
  const { filename } = await exported(t), failure = Object.assign(new Error('Synthetic disk failure'), { code: 'EIO' });
  const target = await fixture(t, { saveFile: async () => { throw failure; } }); target.choose(filename);
  const before = target.vault.get(); await assert.rejects(target.service.restore(restoreArgs(await target.service.preview())), { code: 'EIO' }); assert.deepEqual(target.vault.get(), before); assert.equal(target.restored(), 0);
  const atomic = await fixture(t); atomic.choose(filename); const original = atomic.vault.get(), preview = await atomic.service.preview();
  await rename(path.join(atomic.directory, 'vault.json'), path.join(atomic.directory, 'retained-vault.json')); await mkdir(path.join(atomic.directory, 'vault.json'));
  await assert.rejects(atomic.service.restore(restoreArgs(preview))); assert.deepEqual(atomic.vault.get(), original); assert.equal(atomic.restored(), 0);
  assert.deepEqual(await atomic.files.listResources(), []);
  await rm(path.join(atomic.directory, 'vault.json'), { recursive: true }); await rename(path.join(atomic.directory, 'retained-vault.json'), path.join(atomic.directory, 'vault.json'));
  const reopened = createVault(atomic.directory); await reopened.open(); assert.deepEqual(reopened.get(), original);
});

test('missing source export files are reported, never represented as restored files', async t => {
  const from = await fixture(t), career = await seed(from); await unlink(Object.values(career.applications)[0].exports[0].path);
  const saved = await from.service.save(); assert.ok(saved.warnings.length);
  const target = await fixture(t); target.choose(path.join(from.directory, saved.filename)); const preview = await target.service.preview(); assert.ok(preview.profiles[0].warnings.length);
  await target.service.restore(restoreArgs(preview)); assert.deepEqual(await target.files.listResources(), []);
  assert.equal(Object.values(target.vault.get().career.applications)[0].exports[0].uri, undefined);
});

test('oversized files, symlinks and unsafe backup directories are refused', async t => {
  const target = await fixture(t), oversized = path.join(target.directory, 'large.json'); await writeFile(oversized, '{}'); await truncate(oversized, MAX_BACKUP_BYTES + 1); target.choose(oversized);
  await assert.rejects(target.service.preview(), { code: 'INVALID_INPUT' });
  if (process.platform !== 'win32') {
    const link = path.join(target.directory, 'linked.json'); await symlink(oversized, link); target.choose(link); await assert.rejects(target.service.preview(), { code: 'INVALID_INPUT' });
    const elsewhere = path.join(target.directory, 'elsewhere'); await mkdir(elsewhere); await symlink(elsewhere, path.join(target.directory, 'backups'));
    await assert.rejects(target.service.openFolder());
  }
});

test('vault before-commit guard aborts a late session change without touching disk state', async t => {
  const target = await fixture(t), before = target.vault.get();
  await assert.rejects(target.vault.update(state => { state.career.profile.name = 'Not committed'; }, { beforeCommit: () => { throw Object.assign(new Error('Changed'), { code: 'IDENTITY_CHANGED' }); } }), { code: 'IDENTITY_CHANGED' });
  assert.deepEqual(target.vault.get(), before); const reopened = createVault(target.directory); await reopened.open(); assert.deepEqual(reopened.get(), before);
});

test('an in-flight scoped writer cannot commit or regain access across replacement', async t => {
  const { filename } = await exported(t), target = await fixture(t); target.choose(filename);
  const preview = await target.service.preview(), scoped = target.scoped();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), paused = new Promise(resolve => { release = resolve; });
  const oldWrite = scoped.store.update(async state => { state.career.profile.name = 'Old delayed writer'; entered(); await paused; });
  const rejected = assert.rejects(oldWrite, { code: 'LOCAL_BUSY' });
  await started;
  const restoring = target.service.restore(restoreArgs(preview)); release();
  await rejected; assert.equal((await restoring).restored, true);
  assert.equal(target.vault.get().career.profile.name, 'Synthetic candidate');
  assert.throws(() => scoped.store.update(state => { state.career.profile.name = 'Late writer'; }), { code: 'IDENTITY_CHANGED' });
});

test('a failed destination document write cannot replace the current profile', async t => {
  const { filename } = await exported(t), target = await fixture(t);
  const root = target.files.exportDirectory();
  await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  await writeFile(root, 'Not an export directory', { mode: 0o600 });
  target.choose(filename); const before = target.vault.get(), preview = await target.service.preview();
  await assert.rejects(target.service.restore(restoreArgs(preview)));
  assert.deepEqual(target.vault.get(), before); assert.equal(target.restored(), 0);
});

test('known missing files are disclosed for the safety copy without preventing restore or changing consent', async t => {
  const { filename } = await exported(t), target = await fixture(t), current = await seed(target, 'Incomplete current profile');
  await unlink(Object.values(current.applications)[0].exports[0].path);
  target.choose(filename); const preview = await target.service.preview(); assert.ok(preview.profiles[0].warnings.length);
  await target.service.restore(restoreArgs(preview));
  assert.deepEqual(target.vault.get().career.introductions.consent, current.introductions.consent);
  const [safetyName] = await readdir(path.join(target.directory, 'backups'));
  const safety = parseBackup(await readFile(path.join(target.directory, 'backups', safetyName), 'utf8'));
  assert.equal(safety.profiles[0].career.profile.name, 'Incomplete current profile'); assert.ok(safety.profiles[0].warnings.length);
});

test('a failed later document import removes new files but preserves every preexisting export', async t => {
  const from = await fixture(t); await seed(from);
  const second = await from.files.exportDocument({ bytes: Buffer.from('Second document'), mediaType: 'text/csv' });
  await from.vault.update(state => { Object.values(state.career.applications)[0].exports.push(second); });
  const saved = await from.service.save(), target = await fixture(t);
  const conflict = await target.files.exportDocument({ bytes: Buffer.from('Second document'), mediaType: 'text/csv' });
  const retained = await target.files.exportDocument({ bytes: Buffer.from('Preexisting user document'), mediaType: 'text/csv' });
  await writeFile(conflict.path, 'Corrupt second document');
  const before = await target.files.listResources(), career = target.vault.get();
  target.choose(path.join(from.directory, saved.filename));
  await assert.rejects(target.service.restore(restoreArgs(await target.service.preview())), { code: 'EXPORT_CORRUPT' });
  assert.deepEqual(target.vault.get(), career); assert.deepEqual(await target.files.listResources(), before);
  assert.equal((await target.files.readResource(retained.uri)).text, 'Preexisting user document');
  assert.equal(await readFile(conflict.path, 'utf8'), 'Corrupt second document');
});

test('a late commit guard removes imported files while retaining an existing identical export', async t => {
  const from = await fixture(t); await seed(from);
  const second = await from.files.exportDocument({ bytes: Buffer.from('Second document'), mediaType: 'text/csv' });
  await from.vault.update(state => { Object.values(state.career.applications)[0].exports.push(second); });
  const saved = await from.service.save(), target = await fixture(t);
  const current = await seed(target, 'Existing Candidate');
  const retained = Object.values(current.applications)[0].exports[0];
  const before = await target.files.listResources(), state = target.vault.get();
  const service = createBackups({ directory: target.directory, selectBackup: async () => path.join(from.directory, saved.filename),
    store: { get: () => target.vault.get(), update: (change, options) => target.vault.update(change, { beforeCommit: () => {
      options.beforeCommit(); throw Object.assign(new Error('Synthetic late lock'), { code: 'LOCAL_LOCKED' });
    } }) } });
  await assert.rejects(service.restore(restoreArgs(await service.preview())), { code: 'LOCAL_LOCKED' });
  assert.deepEqual(target.vault.get(), state); assert.deepEqual(await target.files.listResources(), before);
  assert.deepEqual(Buffer.from((await target.files.readResource(retained.uri)).blob, 'base64'), pdf);
});

test('restoration uses the local revision sequence instead of an imported near-overflow counter', async t => {
  const { filename } = await exported(t), payload = JSON.parse(await readFile(filename, 'utf8')), target = await fixture(t);
  payload.profiles[0].career.revision = Number.MAX_SAFE_INTEGER - 1;
  const selected = path.join(target.directory, 'high-revision.json'); await writeFile(selected, JSON.stringify(payload));
  await target.vault.update(state => { state.career.revision = 7; });
  target.choose(selected); await target.service.restore(restoreArgs(await target.service.preview()));
  assert.equal(target.vault.get().career.revision, 8);
  await mutateCareer(target.vault, { requestId: randomUUID(), revision: 8 }, 'synthetic-edit', {}, career => {
    career.profile.name = 'Editable after restore'; return {};
  });
  const reopened = createVault(target.directory); await reopened.open();
  assert.equal(reopened.get().career.revision, 9); assert.equal(reopened.get().career.profile.name, 'Editable after restore');
});

test('save captures one profile after the picker while ordinary profile edits continue during collection', async t => {
  let target, chosenPath, collecting = false, concurrentEdit;
  target = await fixture(t, {
    selectDestination: async filename => {
      await target.vault.update(state => { state.career.profile.name = 'Chosen-time profile'; state.career.profile.preferences.salaryMinimum = 110000; });
      collecting = true; chosenPath = filename; return filename;
    },
    assertAvailable: mutation => {
      if (mutation === false && collecting && !concurrentEdit) concurrentEdit = target.vault.update(state => {
        state.career.profile.name = 'Later profile edit'; state.career.profile.preferences.salaryMinimum = 120000;
      });
    },
  });
  await seed(target, 'Before picker');
  const result = await target.service.save(); await concurrentEdit;
  assert.equal(result.exported, true); assert.ok(concurrentEdit);
  const saved = parseBackup(await readFile(chosenPath, 'utf8')).profiles[0].career;
  assert.equal(saved.profile.name, 'Chosen-time profile'); assert.equal(saved.profile.preferences.salaryMinimum, 110000);
  assert.equal(target.vault.get().career.profile.name, 'Later profile edit');
  assert.equal(target.vault.get().career.profile.preferences.salaryMinimum, 120000);
  assert.equal(Object.values(saved.applications)[0].exports.length, 1);
});

test('save still aborts if sign-in, session or lock changes during its native picker', async t => {
  for (const mode of ['identity', 'session', 'lock']) {
    let target, destination;
    target = await fixture(t, { selectDestination: async filename => {
      destination = filename;
      if (mode === 'identity') await target.vault.update(state => { state.pairing = { account: { id: 'different-account' } }; });
      else if (mode === 'session') target.bump();
      else target.lock(true);
      return filename;
    } });
    await assert.rejects(target.service.save(), { code: mode === 'lock' ? 'LOCAL_LOCKED' : 'BACKUP_STALE' });
    await assert.rejects(readFile(destination), { code: 'ENOENT' });
  }
});

test('save aborts before publishing if identity changes while collecting document files', async t => {
  let target, destination, collecting = false, changed = false;
  target = await fixture(t, {
    // Change the authoritative read-side identity during collection, not after a racing disk write.
    store: { get: () => {
      const state = target.vault.get();
      return changed ? { ...state, pairing: { account: { id: 'different-account' } } } : state;
    } },
    selectDestination: async filename => { destination = filename; collecting = true; return filename; },
    assertAvailable: mutation => {
      if (mutation === false && collecting) changed = true;
    },
  });
  await seed(target);
  await assert.rejects(target.service.save(), { code: 'BACKUP_STALE' });
  await assert.rejects(readFile(destination), { code: 'ENOENT' });
});

test('legacy backup bytes rebind both document kinds for same-title jobs without old versions overwriting current files', async t => {
  const from = await fixture(t), career = await seed(from, 'Portable Candidate');
  const first = Object.values(career.applications)[0], secondId = randomUUID();
  const second = { ...structuredClone(first), id: secondId, job: { ...first.job, id: 'local:second', url: 'https://example.test/second' }, exports: [] };
  await from.vault.update(state => { state.career.applications[secondId] = second; });
  for (const applicationId of [first.id, secondId]) for (const kind of ['cv', 'cover_letter']) {
    const bytes = Buffer.from(`%PDF-1.7\nCurrent ${applicationId} ${kind}\n%%EOF`);
    const exported = await from.files.exportDocument({ applicationId, kind, documentVersion: 2, bytes, mediaType: 'application/pdf' });
    await from.vault.update(state => {
      state.career.applications[applicationId].exports = state.career.applications[applicationId].exports.filter(item => item.kind !== kind);
      state.career.applications[applicationId].exports.push(exported);
    });
  }
  const saved = await from.service.save(), payload = JSON.parse(await readFile(path.join(from.directory, saved.filename), 'utf8'));
  const oldURIs = new Map(payload.files.map(file => [file.uri, `recruiters://exports/${file.sha256}.pdf`]));
  for (const file of payload.files) file.uri = oldURIs.get(file.uri);
  for (const app of Object.values(payload.profiles[0].career.applications)) for (const ref of app.exports) {
    ref.uri = oldURIs.get(ref.uri); ref.path = '/foreign/untrusted.pdf';
    for (const field of ['resourceId', 'folderNumber', 'companyLimit', 'jobLimit', 'applicationId', 'candidateName', 'company', 'jobTitle']) delete ref[field];
  }
  const staleBytes = Buffer.from('%PDF-1.7\nOld letter must never win\n%%EOF');
  const sha256 = createHash('sha256').update(staleBytes).digest('hex'), staleURI = `recruiters://exports/${sha256}.pdf`;
  payload.files.push({ uri: staleURI, sha256, mediaType: 'application/pdf', bytes: staleBytes.length, base64: staleBytes.toString('base64') });
  payload.profiles[0].career.applications[first.id].exports.push({ uri: staleURI, sha256, mediaType: 'application/pdf', bytes: staleBytes.length,
    kind: 'cover_letter', format: 'pdf', documentVersion: 1 });
  const target = await fixture(t), selected = path.join(target.directory, 'legacy-documents.json');
  await writeFile(selected, JSON.stringify(payload)); target.choose(selected);
  await target.service.restore(restoreArgs(await target.service.preview()));
  const restored = target.vault.get().career, folders = [];
  for (const app of Object.values(restored.applications)) {
    const current = app.exports.filter(ref => ref.uri);
    assert.equal(current.length, 2);
    assert.equal(path.dirname(current[0].path), path.dirname(current[1].path));
    folders.push(path.dirname(current[0].path));
    for (const ref of current) {
      assert.equal(path.basename(ref.path), `Portable Candidate - ${ref.kind === 'cv' ? 'CV' : 'COVER LETTER'}.pdf`);
      assert.match(ref.uri, /^recruiters:\/\/documents\/[a-f0-9-]{36}\.pdf$/);
      const content = Buffer.from((await target.files.readResource(ref.uri)).blob, 'base64').toString();
      assert.ok(content.includes(`Current ${app.id} ${ref.kind}`));
      assert.equal(await target.files.resolveExport(ref.uri), ref.path);
    }
  }
  assert.notEqual(folders[0], folders[1]);
  assert.equal(path.basename(folders[0]), 'Engineer');
  assert.equal(path.basename(folders[1]), 'Engineer (2)');
  assert.equal(restored.applications[first.id].exports.at(-1).unavailable, true);
  await assert.rejects(target.files.readResource(staleURI), { code: 'NOT_FOUND' });
  assert.deepEqual(restored.sources, career.sources);
  assert.equal((await target.files.listResources()).length, 4);
  const roundtrip = await target.service.save(), next = await fixture(t);
  next.choose(path.join(target.directory, roundtrip.filename));
  await next.service.restore(restoreArgs(await next.service.preview()));
  assert.equal((await next.files.listResources()).length, 4);
});

test('restoring over the same application rolls back a replaced readable PDF when the vault commit fails', async t => {
  const from = await fixture(t); await seed(from, 'Rollback Candidate');
  const saved = await from.service.save(), target = await fixture(t), original = from.vault.get().career;
  const app = Object.values(original.applications)[0];
  await target.vault.update(state => {
    state.career = structuredClone(original);
    state.career.applications[app.id].exports = [];
  });
  const priorBytes = Buffer.from('%PDF-1.7\nExisting local current letter\n%%EOF');
  const prior = await target.files.exportDocument({ applicationId: app.id, kind: 'cover_letter', bytes: priorBytes, mediaType: 'application/pdf' });
  await target.vault.update(state => { state.career.applications[app.id].exports.push(prior); });
  const before = target.vault.get();
  const service = createBackups({ directory: target.directory, selectBackup: async () => path.join(from.directory, saved.filename),
    store: { get: () => target.vault.get(), update: (change, options) => target.vault.update(change, { beforeCommit: () => {
      options.beforeCommit(); throw Object.assign(new Error('Synthetic late commit failure'), { code: 'LOCAL_LOCKED' });
    } }) } });
  await assert.rejects(service.restore(restoreArgs(await service.preview())), { code: 'LOCAL_LOCKED' });
  assert.deepEqual(target.vault.get(), before);
  assert.deepEqual(await readFile(prior.path), priorBytes);
  assert.equal(await target.files.resolveExport(prior.uri), prior.path);
  assert.deepEqual(await readdir(path.dirname(prior.path)), ['Rollback Candidate - COVER LETTER.pdf']);
});
