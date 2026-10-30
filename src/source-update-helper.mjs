// Copied with install-source.mjs and update-install.cjs into a private transition.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import installer from './update-install.cjs';
import { assertSourceDirectory, readSourceJSON, writeSourceJSON, readManagedSource, validateSourceBuild, sourceExecutable, sourceEnvironment, assertInstalledSource, compareSourceVersions } from '../scripts/install-source.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function readSourceTransition(file) {
  const journal = await readSourceJSON(file);
  if (journal.schema !== 1 || !/^[a-f0-9]{32}$/.test(journal.id) || !Number.isSafeInteger(journal.pid) || journal.pid < 1 || !path.isAbsolute(journal.root || '') || file !== path.join(journal.root, 'transitions', journal.id, 'journal.json') || journal.journal !== file || !path.isAbsolute(journal.userData || '') || /[\0\r\n]/.test(journal.userData)) throw new Error('Invalid source transition receipt.');
  await assertSourceDirectory(journal.root, { privateRoot: true });
  await assertSourceDirectory(path.join(journal.root, 'transitions'));
  await assertSourceDirectory(path.dirname(file));
  for (const pointer of [journal.previous, journal.next]) {
    if (pointer?.schema !== 1 || typeof pointer.sourceRoot !== 'string') throw new Error('Invalid source transition target.');
    const receipt = await readManagedSource(pointer.sourceRoot, { version: pointer.version });
    if (receipt.root !== journal.root) throw new Error('A source transition escaped its installation.');
  }
  if (journal.next.version !== journal.version || journal.next.sourceRoot === journal.previous.sourceRoot || compareSourceVersions(journal.previous.version, journal.next.version) >= 0) throw new Error('Invalid source transition version.');
  return journal;
}
async function writeStatus(journal, status, extra = {}) {
  if (await installer.hasConfirmation(journal)) status = 'confirmed';
  Object.assign(journal, extra, { status, updatedAt: new Date().toISOString() });
  await writeSourceJSON(journal.journal, journal);
}
async function waitForExit(pid) {
  const deadline = Date.now() + 120000;
  for (;;) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    if (Date.now() > deadline) throw new Error('The previous source app did not exit.');
    await delay(100);
  }
}
function launch(pointer, journal) {
  return new Promise((resolve, reject) => {
    const child = spawn(sourceExecutable(pointer.sourceRoot), [pointer.sourceRoot, `--user-data-dir=${journal.userData}`], { detached: true, env: sourceEnvironment(), stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(child); });
  });
}
async function stopOwnChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(5000)]);
  if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await Promise.race([exited, delay(5000)]); }
  if (child.exitCode === null && !child.signalCode) throw new Error('The unconfirmed source process is still running; rollback is paused.');
}
export async function performSourceTransition(journal, { confirmationTimeout = 120000 } = {}) {
  let releaseLock, child, switched = false;
  try {
    await readSourceTransition(journal.journal);
    await waitForExit(journal.pid);
    releaseLock = await installer.claimInstallation(journal.root);
  } catch (error) { await writeStatus(journal, 'failed', { failure: error.message }); return; }
  if (!releaseLock) { await writeStatus(journal, 'unconfirmed', { failure: 'Another app instance owns the source installation. No pointer was changed.' }); return; }
  try {
    const current = await readSourceJSON(path.join(journal.root, 'current.json'));
    if (current.sourceRoot !== journal.previous.sourceRoot || current.version !== journal.previous.version) throw new Error('The managed source pointer changed before handoff.');
    for (const pointer of [journal.previous, journal.next]) {
      await assertInstalledSource(pointer.sourceRoot);
    }
    await validateSourceBuild(journal.next.sourceRoot, journal.version);
    await writeStatus(journal, 'switching');
    await writeSourceJSON(path.join(journal.root, 'current.json'), journal.next);
    switched = true;
    await writeStatus(journal, 'launching');
    await releaseLock(); releaseLock = null;
    child = await launch(journal.next, journal);
    await writeStatus(journal, 'launched', { launchedPid: child.pid });
    const deadline = Date.now() + confirmationTimeout;
    while (Date.now() < deadline) {
      if (await installer.hasConfirmation(journal)) { await writeStatus(journal, 'confirmed'); return; }
      if (child.exitCode !== null || child.signalCode) throw new Error('The updated source app exited before readiness confirmation.');
      await delay(200);
    }
    throw new Error('The updated source app did not confirm readiness.');
  } catch (error) {
    // A confirmation wins over timeout/failure races; never roll back a ready app.
    if (await installer.hasConfirmation(journal)) { await writeStatus(journal, 'confirmed'); return; }
    try {
      await stopOwnChild(child);
      if (!releaseLock) releaseLock = await installer.claimInstallation(journal.root);
      if (!releaseLock) { await writeStatus(journal, 'unconfirmed', { failure: 'Another app instance is running. Both source versions are retained.' }); return; }
      if (await installer.hasConfirmation(journal)) { await writeStatus(journal, 'confirmed'); return; }
      const current = await readSourceJSON(path.join(journal.root, 'current.json'));
      if (current.sourceRoot !== (switched ? journal.next.sourceRoot : journal.previous.sourceRoot)) throw new Error('The source pointer changed; recovery requires manual attention.');
      if (switched) await writeSourceJSON(path.join(journal.root, 'current.json'), journal.previous);
      await writeStatus(journal, switched ? 'rolled-back' : 'failed', { failure: error.message });
      await releaseLock(); releaseLock = null;
      try { await launch(journal.previous, journal); }
      catch (launchError) { await writeStatus(journal, switched ? 'rolled-back' : 'failed', { failure: `${error.message} The retained app could not relaunch: ${launchError.message}` }); }
    } catch (recoveryError) { await writeStatus(journal, 'unconfirmed', { failure: recoveryError.message }); }
  } finally { await releaseLock?.(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const journal = await readSourceTransition(process.argv[2]);
    if (!process.send) throw new Error('Source handoff requires a parent IPC channel.');
    const commit = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Source handoff expired.')), 30000);
      process.once('message', message => { clearTimeout(timer); message?.type === 'commit' ? resolve() : reject(new Error('Source handoff cancelled.')); });
      process.once('disconnect', () => { clearTimeout(timer); reject(new Error('Source handoff disconnected.')); });
    });
    process.send({ type: 'ready' });
    await commit;
    process.disconnect();
    await performSourceTransition(journal);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
