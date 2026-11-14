import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createVault } from '../src/vault.mjs';
import { createScopedAccess } from '../src/mcp/scope.mjs';
import { fail } from '../src/mcp/state.mjs';
import { masterCvState, renderMaster } from '../src/mcp/master-cv.mjs';
import { createMasterCvSettings, publishMasterFile, MASTER_CV_ACTIONS } from '../src/master-cv-settings.mjs';
import { readyMaster } from './helpers/ready-master.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'recruiters-master-shell-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createVault(directory); await store.open();
  await readyMaster(store);
  let epoch = 0, locked = false, saves = 0;
  const documents = { renderCareerCvText: value => JSON.stringify(value) };
  const operation = createMasterCvSettings({
    access: () => createScopedAccess(store, { epoch: () => epoch, assertAvailable: () => { if (locked) fail('LOCAL_LOCKED', 'Locked'); } }),
    identity: () => `${store.get().deviceId}:${epoch}`, documents: () => documents,
    selectDestination: async filename => path.join(directory, filename),
    afterSave: () => { saves++; }, ...options,
  });
  const args = (format = 'txt') => ({ requestId: randomUUID(), revision: store.get().career.revision, baseVersion: store.get().career.masterCv.current.version, format });
  return { directory, store, operation, args, documents, saves: () => saves, lock: () => { locked = true; }, rotate: () => { epoch++; } };
}

test('the preload permits only read, save and export master actions and rejects the retired prompt action', async () => {
  const source = await readFile(new URL('../src/preload.cjs', import.meta.url), 'utf8');
  const calls = []; let bridge;
  vm.runInNewContext(source, { require: name => {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); }, on() {}, removeListener() {} } };
  } });
  for (const op of MASTER_CV_ACTIONS) { const input = { marker: op }; await bridge.invoke(op, input); assert.equal(calls.at(-1)[2], input); assert.equal(calls.at(-1)[0], 'local-settings'); }
  assert.deepEqual(MASTER_CV_ACTIONS, ['master-cv-read', 'master-cv-save', 'master-cv-export']);
  await assert.rejects(bridge.invoke('master-cv-prompt'), /Unavailable/);
  await assert.rejects(bridge.invoke('master-cv-overwrite'), /Unavailable/);
  assert.equal(calls.length, MASTER_CV_ACTIONS.length);
});

test('master handlers reject unknown fields and the retired prompt operation while exposing real state', async t => {
  const f = await fixture(t);
  const state = await f.operation('master-cv-read', {});
  assert.equal(state.status, 'ready'); assert.equal(typeof state.identity, 'string');
  await assert.rejects(f.operation('master-cv-read', { unexpected: true }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.operation('master-cv-prompt', {}), { code: 'INVALID_INPUT' });
  await assert.rejects(f.operation('master-cv-export', { ...f.args(), path: '/outside' }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.operation('master-cv-export', { ...f.args(), format: 'docx' }), { code: 'INVALID_INPUT' });
});

test('manual plain-text saves are CAS/idempotent, preserve history, and broadcast only saved state', async t => {
  const f = await fixture(t), before = await f.operation('master-cv-read', {});
  const document = structuredClone(before.master.document);
  document.experience[0].bullets[0] = 'I resolved the release incident by isolating a failing worker.';
  const args = { requestId: randomUUID(), revision: before.revision, baseVersion: before.master.version, contact: before.contact, document, presentation: before.master.presentation };
  const saved = await f.operation('master-cv-save', args);
  assert.equal(saved.master.version, before.master.version + 1);
  assert.deepEqual(saved.master.document, document);
  assert.deepEqual(f.store.get().career.masterCv.history[0].document, before.master.document);
  assert.deepEqual(await f.operation('master-cv-save', args), saved);
  assert.equal(f.store.get().career.masterCv.history.length, 1);
  await assert.rejects(f.operation('master-cv-save', { ...args, document: { ...document, summary: 'Different reply' } }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(f.operation('master-cv-save', { ...args, requestId: randomUUID() }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(f.operation('master-cv-save', { ...args, requestId: randomUUID(), revision: saved.revision }), { code: 'VERSION_CONFLICT' });
  assert.equal(f.saves(), 2);
});

test('native export writes a master file without making an application and retries never republish', async t => {
  const f = await fixture(t), args = f.args();
  const result = await f.operation('master-cv-export', args);
  assert.deepEqual(result, { exported: true, filename: 'Master CV.txt' });
  const destination = path.join(f.directory, result.filename);
  assert.ok((await readFile(destination, 'utf8')).includes('Built reliable services.'));
  assert.deepEqual(Object.keys(f.store.get().career.applications), []);
  await writeFile(destination, 'User replaced this export');
  assert.deepEqual(await f.operation('master-cv-export', args), result);
  assert.equal(await readFile(destination, 'utf8'), 'User replaced this export');
  await assert.rejects(f.operation('master-cv-export', { ...args, format: 'pdf' }), { code: 'REQUEST_CONFLICT' });
});

test('concurrent export retries share one dialog, and cancellation is final for that request', async t => {
  const entered = deferred(), chosen = deferred(); let dialogs = 0;
  const f = await fixture(t, { selectDestination: async () => { dialogs++; entered.resolve(); return chosen.promise; } });
  const args = f.args(), first = f.operation('master-cv-export', args);
  await entered.promise;
  const retry = f.operation('master-cv-export', args);
  await assert.rejects(f.operation('master-cv-export', { ...args, format: 'pdf' }), { code: 'REQUEST_CONFLICT' });
  chosen.resolve(null);
  assert.deepEqual(await first, { exported: false }); assert.deepEqual(await retry, { exported: false });
  assert.deepEqual(await f.operation('master-cv-export', args), { exported: false }); assert.equal(dialogs, 1);
  assert.equal((await readdir(f.directory)).some(file => file.endsWith('.txt')), false);
});

for (const phase of ['dialog', 'render']) for (const change of ['revision', 'source-added', 'source-removed', 'source-archived', 'lock', 'identity']) {
  test(`master export rejects ${change} while awaiting ${phase} without publishing bytes`, async t => {
    const entered = deferred(), continueWork = deferred(); let published = 0;
    const pause = async value => { entered.resolve(); await continueWork.promise; return value; };
    const f = await fixture(t, {
      selectDestination: async () => phase === 'dialog' ? pause('Master CV.txt') : 'Master CV.txt',
      render: async (...args) => { const rendered = await renderMaster(...args); return phase === 'render' ? pause(rendered) : rendered; },
      publish: () => { published++; },
    });
    const pending = f.operation('master-cv-export', f.args());
    await entered.promise;
    if (change === 'lock') f.lock();
    else if (change === 'identity') f.rotate();
    else await f.store.update(state => {
      const career = state.career, source = Object.values(career.sources)[0];
      if (change === 'revision') career.revision++;
      else if (change === 'source-removed') delete career.sources[source.id];
      else if (change === 'source-archived') source.archived = true;
      else { const id = randomUUID(); career.sources[id] = { ...source, id }; }
    });
    continueWork.resolve();
    await assert.rejects(pending, { code: change === 'lock' ? 'LOCAL_LOCKED' : change === 'identity' ? 'IDENTITY_CHANGED' : change === 'revision' ? 'REVISION_CONFLICT' : 'MASTER_NOT_READY' });
    assert.equal(published, 0);
  });
}

test('a native publish rechecks access after its async staging write and leaves the chosen file unchanged', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'recruiters-master-publish-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'Chosen.txt'); await writeFile(destination, 'Keep this existing document');
  await assert.rejects(publishMasterFile(destination, Buffer.from('New master bytes'), () => fail('IDENTITY_CHANGED', 'Restored')), { code: 'IDENTITY_CHANGED' });
  assert.equal(await readFile(destination, 'utf8'), 'Keep this existing document');
  assert.deepEqual(await readdir(directory), ['Chosen.txt']);
});

test('master read refresh projection distinguishes revisions without changing the document version', async t => {
  const f = await fixture(t), before = masterCvState(f.store.get().career, 'session');
  await f.store.update(state => { state.career.revision++; });
  const after = await f.operation('master-cv-read', {});
  assert.equal(after.master.version, before.master.version); assert.equal(after.revision, before.revision + 1);
});

test('export rejects an old version, a reused save request ID, and unvalidated PDF bytes', async t => {
  let published = 0;
  const f = await fixture(t, { render: async () => ({ bytes: Buffer.from('%PDF-synthetic'), textValidation: { passed: false } }),
    publish: () => { published++; } });
  await assert.rejects(f.operation('master-cv-export', { ...f.args(), baseVersion: f.args().baseVersion + 1 }), { code: 'VERSION_CONFLICT' });
  const used = Object.keys(f.store.get().career.receipts)[0];
  await assert.rejects(f.operation('master-cv-export', { ...f.args(), requestId: used }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(f.operation('master-cv-export', f.args('pdf')), { code: 'EXPORT_INVALID' });
  assert.equal(published, 0);
});

test('an in-flight export reserves its request ID against a manual save', async t => {
  const entered = deferred(), chosen = deferred();
  const f = await fixture(t, { selectDestination: async () => { entered.resolve(); return chosen.promise; } });
  const args = f.args(), exporting = f.operation('master-cv-export', args);
  await entered.promise;
  const state = await f.operation('master-cv-read', {});
  await assert.rejects(f.operation('master-cv-save', { requestId: args.requestId, revision: state.revision, baseVersion: state.master.version,
    contact: state.contact, document: state.master.document, presentation: state.master.presentation }), { code: 'REQUEST_CONFLICT' });
  chosen.resolve(null);
  assert.deepEqual(await exporting, { exported: false });
});

test('manual save checks the browser session at the vault commit boundary', async t => {
  let checks = 0;
  const f = await fixture(t, { browserAccess: () => () => { if (++checks === 2) fail('IDENTITY_CHANGED', 'Browser session replaced'); } });
  const state = await f.operation('master-cv-read', {});
  const before = f.store.get().career;
  await assert.rejects(f.operation('master-cv-save', { requestId: randomUUID(), revision: state.revision, baseVersion: state.master.version,
    contact: state.contact, document: { ...state.master.document, summary: 'Candidate edit' }, presentation: state.master.presentation }), { code: 'IDENTITY_CHANGED' });
  assert.deepEqual(f.store.get().career, before);
  assert.equal(f.saves(), 0);
});
