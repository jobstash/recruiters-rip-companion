import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import installer from './update-install.cjs';
import { readSourceTransition } from './source-update-helper.mjs';
import { REPOSITORY, sourceError, readManagedSource, assertInstalledSource, discoverSourceTools, resolveOfficialSource, compareSourceVersions, buildSourceVersion, validateSourceBuild, readSourceJSON, writeSourceJSON, sourceEnvironment, sourceExecutable } from '../scripts/install-source.mjs';

export async function inspectManagedSource(sourceRoot, options = {}) {
  if (!sourceRoot) return null;
  try { return await readManagedSource(sourceRoot, options); }
  catch { return null; }
}

export function acquireSourceAdmission(callback, { automatic, signal }) {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (!callback) return Promise.resolve(automatic ? null : { valid: () => true, release() {} });
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => callback({ automatic })).then(token => {
      signal.removeEventListener('abort', aborted);
      if (signal.aborted) { token?.release(); reject(signal.reason); }
      else resolve(token);
    }, error => { signal.removeEventListener('abort', aborted); reject(error); });
  });
}

export function createSourceUpdateController({ version, sourceRoot, directory, pid = process.pid, quit, fetchImpl = globalThis.fetch, onChange = () => {}, resolveRelease = ({ signal }) => resolveOfficialSource({ fetchImpl, signal }), acquireInstallAdmission }) {
  compareSourceVersions(version, version);
  if (!path.isAbsolute(sourceRoot || '') || !path.isAbsolute(directory || '') || path.resolve(directory) !== directory) throw sourceError('INVALID_DIRECTORY', 'A real source root and private profile update directory are required.');
  let view = { version, latestVersion: null, status: 'idle', progress: null, releaseUrl: null, error: null, automaticSupported: false, automaticReason: 'Checking the source installation.', installationKind: 'source' };
  let receipt, tools, release, pending, active, handedOff = false, initialized = false;
  const state = () => structuredClone(view);
  const update = changes => { Object.assign(view, changes); try { onChange(state()); } catch { /* Observers cannot break installation. */ } return state(); };
  const assertNotAborted = signal => { if (signal.aborted) throw signal.reason; };
  function operate(name, work, timeout = 30 * 60 * 1000) {
    if (active || handedOff) return Promise.reject(sourceError('UPDATE_BUSY', 'A source update is already in progress.'));
    const controller = new AbortController(), operation = { controller, name };
    active = operation;
    const timer = setTimeout(() => controller.abort(sourceError('UPDATE_TIMEOUT', 'The source update timed out; the previous version is retained.')), timeout);
    operation.promise = (async () => {
      try { return await work(controller.signal); }
      catch (error) {
        if (error.code === 'SOURCE_MODIFIED') update({ automaticSupported: false, automaticReason: error.message });
        update({ status: controller.signal.aborted ? 'cancelled' : 'error', progress: null, error: { code: error.code || 'SOURCE_UPDATE_FAILED', message: error.publicUpdateError ? error.message : 'The source update could not finish. The previous version and saved data are retained.' } });
        throw error;
      } finally { clearTimeout(timer); if (active === operation) active = null; }
    })();
    return operation.promise;
  }
  async function cleanRunningSource(signal) {
    if (!receipt) throw sourceError('UNMANAGED_SOURCE', 'This is an ordinary source checkout. Use the source installer for managed automatic builds; local files will never be overwritten.');
    tools = await discoverSourceTools(receipt.tools, signal);
    await assertInstalledSource(sourceRoot, tools, signal);
    const current = await readSourceJSON(path.join(receipt.root, 'current.json'));
    if (current.sourceRoot !== sourceRoot || current.version !== version) throw sourceError('SOURCE_NOT_CURRENT', 'This is a retained source version. Use the stable managed launcher to open the current installation.');
    update({ automaticSupported: true, automaticReason: null });
  }
  async function support(signal) {
    receipt = await inspectManagedSource(sourceRoot, { version });
    assertNotAborted(signal);
    if (!receipt) { update({ automaticSupported: false, automaticReason: 'Ordinary source checkouts are never replaced. Use the source installer for managed automatic builds.' }); return; }
    update({ sourceProvenance: receipt.provenance, sourceCommit: receipt.commit });
    try { await cleanRunningSource(signal); }
    catch (error) { if (signal.aborted) throw error; update({ automaticSupported: false, automaticReason: error.message }); }
  }
  function initialize() {
    return operate('initialize', async signal => {
      await support(signal);
      if (receipt) {
        let pointer;
        try { pointer = await readSourceJSON(path.join(receipt.root, 'transition.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (pointer) {
          if (!/^[a-f0-9]{32}$/.test(pointer.id)) throw sourceError('INVALID_SOURCE_RECEIPT', 'Invalid active source transition.');
          const journal = await readSourceTransition(path.join(receipt.root, 'transitions', pointer.id, 'journal.json'));
          if (journal.next.sourceRoot === sourceRoot && journal.version === version && ['switching', 'launching', 'launched', 'confirmed'].includes(journal.status)) {
            // Only the actual Electron runtime, after lifecycle core readiness, confirms.
            if (await fs.realpath(process.execPath) !== await fs.realpath(sourceExecutable(sourceRoot)) || journal.userData !== path.dirname(directory)) throw sourceError('INVALID_SOURCE_CONFIRMATION', 'Only the running updated source app with the preserved profile can confirm startup.');
            await validateSourceBuild(sourceRoot, version);
            await installer.confirmUpdate(journal);
            update({ status: 'confirmed', latestVersion: version });
          } else if (journal.status === 'rolled-back') update({ status: 'rolled-back', error: { code: 'ROLLED_BACK', message: 'The previous source version was restored because the update did not confirm startup. Your saved data was preserved.' } });
          else if (['unconfirmed', 'switching', 'launching', 'launched'].includes(journal.status)) update({ status: 'manual-required', automaticSupported: false, automaticReason: 'An earlier source transition is unconfirmed. Both versions are retained; restart with the stable launcher after closing other instances.' });
        }
        else {
          const current = await readSourceJSON(path.join(receipt.root, 'current.json'));
          if (/^[a-f0-9]{32}$/.test(current.bootstrapId || '') && current.sourceRoot === sourceRoot && current.version === version) {
            if (await fs.realpath(process.execPath) !== await fs.realpath(sourceExecutable(sourceRoot)) || (current.userData && current.userData !== path.dirname(directory))) throw sourceError('INVALID_SOURCE_CONFIRMATION', 'Only the actual source app with its preserved profile can confirm initial startup.');
            await validateSourceBuild(sourceRoot, version);
            await writeSourceJSON(path.join(receipt.root, 'initial-ready.json'), { id: current.bootstrapId, sourceRoot, version, pid: process.pid, userData: path.dirname(directory) });
          }
        }
      }
      initialized = true;
      return state();
    }, 120000);
  }
  async function check() {
    if (!initialized) await initialize();
    if (pending && view.status === 'downloaded') return state();
    return operate('check', async signal => {
      update({ status: 'checking', error: null });
      assertNotAborted(signal);
      await support(signal);
      assertNotAborted(signal);
      release = await resolveRelease({ signal });
      assertNotAborted(signal);
      const order = compareSourceVersions(version, release.version);
      return update({ status: order > 0 ? 'ahead' : order === 0 ? 'current' : 'available', latestVersion: release.version, releaseUrl: release.releaseUrl || `${REPOSITORY}/releases`, progress: null });
    }, 120000);
  }
  function download() {
    return operate('build', async signal => {
      if (!initialized || !release || compareSourceVersions(version, release.version) >= 0) throw sourceError('INVALID_STATE', 'Check for a newer source release before building.');
      update({ status: 'downloading', progress: null, error: null });
      assertNotAborted(signal);
      await cleanRunningSource(signal);
      assertNotAborted(signal);
      pending = await buildSourceVersion({ root: receipt.root, release, tools, signal, onProgress: message => update({ buildMessage: message }) });
      assertNotAborted(signal);
      return update({ status: 'downloaded', progress: 1, buildMessage: 'Built from source; waiting for a safe restart.' });
    });
  }
  function install({ automatic = false } = {}) {
    return operate('install', async signal => {
      if (!pending || !receipt || compareSourceVersions(version, pending.version) >= 0) throw sourceError('INVALID_STATE', 'Build and verify a newer source release before installing.');
      update({ status: 'staging', progress: null, error: null });
      await cleanRunningSource(signal);
      assertNotAborted(signal);
      await validateSourceBuild(pending.sourceRoot, pending.version);
      assertNotAborted(signal);
      await assertInstalledSource(pending.sourceRoot, tools, signal);
      const root = receipt.root;
      let oldPointer;
      try { oldPointer = await readSourceJSON(path.join(root, 'transition.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (oldPointer) {
        if (!/^[a-f0-9]{32}$/.test(oldPointer.id)) throw sourceError('INVALID_SOURCE_RECEIPT', 'Invalid previous source transition.');
        const old = await readSourceTransition(path.join(root, 'transitions', oldPointer.id, 'journal.json'));
        if (!['confirmed', 'rolled-back', 'failed', 'cancelled'].includes(old.status)) throw sourceError('UNCONFIRMED_SOURCE_UPDATE', 'The previous source transition is still unconfirmed. Both versions are retained.');
      }
      const id = randomBytes(16).toString('hex'), work = path.join(root, 'transitions', id);
      await fs.mkdir(work, { mode: 0o700 });
      await fs.mkdir(path.join(work, 'src'), { mode: 0o700 });
      await fs.mkdir(path.join(work, 'scripts'), { mode: 0o700 });
      const previous = await readSourceJSON(path.join(root, 'current.json'));
      const userData = path.dirname(directory);
      previous.userData = userData;
      const next = { schema: 1, sourceRoot: pending.sourceRoot, version: pending.version, userData };
      const journal = { schema: 1, id, root, journal: path.join(work, 'journal.json'), pid, version: pending.version, previous, next, userData, status: 'prepared' };
      await writeSourceJSON(journal.journal, journal);
      for (const relative of ['src/source-update-helper.mjs', 'src/update-install.cjs', 'src/update-install-lock.cjs', 'scripts/install-source.mjs']) {
        await fs.copyFile(fileURLToPath(new URL(`../${relative}`, import.meta.url)), path.join(work, relative), fs.constants.COPYFILE_EXCL);
        await fs.chmod(path.join(work, relative), 0o600);
      }
      let helper, admission, committed = false;
      try {
        helper = spawn(tools.node, [path.join(work, 'src', 'source-update-helper.mjs'), journal.journal], { detached: true, env: sourceEnvironment(tools), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => finish(sourceError('HELPER_TIMEOUT', 'The source update helper did not become ready.')), 20000);
          const onAbort = () => finish(signal.reason);
          const onError = error => finish(error);
          const onExit = () => finish(sourceError('HELPER_FAILED', 'The source update helper exited before handoff.'));
          const onMessage = message => finish(message?.type === 'ready' ? null : sourceError('HELPER_FAILED', 'Invalid source helper acknowledgement.'));
          const finish = error => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); helper.removeListener('error', onError); helper.removeListener('exit', onExit); helper.removeListener('message', onMessage); error ? reject(error) : resolve(); };
          signal.addEventListener('abort', onAbort, { once: true }); helper.once('error', onError); helper.once('exit', onExit); helper.once('message', onMessage);
          if (signal.aborted) onAbort();
        });
        // Prepare every asynchronous write before final admission. No mutation can
        // enter between valid() and IPC commit in the same JS turn.
        await writeSourceJSON(path.join(root, 'transition.json'), { id });
        admission = await acquireSourceAdmission(acquireInstallAdmission, { automatic, signal });
        assertNotAborted(signal);
        if (!admission || !admission.valid()) {
          await writeSourceJSON(journal.journal, { ...journal, status: 'cancelled' });
          return update({ status: 'downloaded', buildMessage: 'Built from source; waiting for a safe restart.' });
        }
        const sent = new Promise((resolve, reject) => helper.send({ type: 'commit' }, error => error ? reject(error) : resolve()));
        committed = true; handedOff = true;
        try { await sent; } catch (error) { committed = false; handedOff = false; throw error; }
        if (helper.connected) helper.disconnect();
        helper.unref();
        update({ status: 'installing', progress: null });
        quit();
        return state();
      } finally {
        if (!committed) {
          if (helper?.connected) helper.disconnect(); helper?.kill(); helper?.unref();
          admission?.release();
          await writeSourceJSON(journal.journal, { ...journal, status: 'cancelled' });
        }
      }
    }, 180000);
  }
  async function cancel() {
    if (handedOff || !active || active.name === 'initialize') throw sourceError('INVALID_STATE', 'No source update can be cancelled now.');
    const operation = active;
    operation.controller.abort(sourceError('CANCELLED', 'The source update was cancelled. The current source and saved data were not changed.'));
    await operation.promise.catch(() => {});
    return state();
  }
  return { initialize, state, check, download, install, cancel };
}
