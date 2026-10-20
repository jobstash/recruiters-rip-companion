'use strict';
// Copied outside the installed bundle before launch. Built-ins only: the old app
// can be renamed without this helper resolving any code from it afterwards.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ID = /^[a-f0-9]{32}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const minimalEnvironment = () => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: '/tmp', ELECTRON_RUN_AS_NODE: '1' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = async file => { try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

function validateJournal(journal, journalFile) {
  if (!journal || journal.schema !== 1 || !ID.test(journal.id) || !VERSION.test(journal.version) ||
      !Number.isSafeInteger(journal.pid) || journal.pid < 1 || !path.isAbsolute(journal.target) ||
      !journal.target.endsWith('.app') || path.resolve(journal.target) !== journal.target ||
      journal.journal !== journalFile || !path.isAbsolute(journalFile) || path.resolve(journalFile) !== journalFile || path.basename(journalFile) !== 'journal.json') {
    throw new Error('Invalid update receipt.');
  }
  const parent = path.dirname(journal.target);
  if (journal.staged !== path.join(parent, `.recruiters-update-${journal.id}.app`) ||
      journal.backup !== path.join(parent, `.recruiters-backup-${journal.id}.app`) ||
      path.basename(path.dirname(journalFile)) !== `install-${journal.id}`) throw new Error('Invalid update paths.');
  return journal;
}

async function readJournal(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) throw new Error('Invalid update receipt.');
  const journal = validateJournal(JSON.parse(await fs.readFile(file, 'utf8')), file);
  if (await hasConfirmation(journal)) journal.status = 'confirmed';
  return journal;
}

async function writeJournal(journal, status, extra = {}) {
  if (['launching', 'launched', 'unconfirmed'].includes(status) && await hasConfirmation(journal)) status = 'confirmed';
  const next = { ...journal, ...extra, status, updatedAt: new Date().toISOString() };
  const temporary = `${journal.journal}.tmp-${process.pid}`;
  await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'w' });
  await fs.rename(temporary, journal.journal);
  Object.assign(journal, next);
}

async function hasConfirmation(journal) {
  const file = path.join(path.dirname(journal.journal), 'confirmed.json');
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256) throw new Error('Invalid startup confirmation.');
    const proof = JSON.parse(await fs.readFile(file, 'utf8'));
    return proof.id === journal.id && proof.version === journal.version;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function confirmUpdate(journal) {
  // A separate monotonic proof prevents a helper's concurrent launch receipt
  // from losing a genuine startup confirmation.
  const file = path.join(path.dirname(journal.journal), 'confirmed.json');
  const temporary = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temporary, JSON.stringify({ id: journal.id, version: journal.version }), { mode: 0o600 });
  await fs.rename(temporary, file);
  await writeJournal(journal, 'confirmed');
}

async function realDirectory(directory) {
  if (await fs.realpath(directory) !== directory || !(await fs.lstat(directory)).isDirectory()) throw new Error('An update path is not a real directory.');
}

async function validatePaths(journal, { recovery = false } = {}) {
  validateJournal(journal, journal.journal);
  await realDirectory(path.dirname(journal.target));
  await realDirectory(path.dirname(journal.journal));
  if (!recovery || await exists(journal.target)) await realDirectory(journal.target);
  if (!recovery || await exists(journal.staged)) await realDirectory(journal.staged);
  if (await exists(journal.backup)) {
    if (!recovery) throw new Error('The update backup already exists.');
    await realDirectory(journal.backup);
  }
}

async function waitForExit(pid, timeout = 120000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    if (Date.now() >= deadline) throw new Error('The companion did not exit; the installed app was not replaced.');
    await delay(200);
  }
}

function launch(target) {
  return new Promise((resolve, reject) => {
    // open's successful exit means LaunchServices accepted a launch, not that the
    // new version started. Only its next initialize() can confirm that.
    const child = spawn('/usr/bin/open', ['-n', target], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: '/tmp' }, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('The updated app launch timed out.')); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('The updated app could not be launched.')); });
  });
}

async function restore(journal, launchApp = launch) {
  await validatePaths(journal, { recovery: true });
  if (!await exists(journal.backup)) throw new Error('The previous app is not available for rollback.');
  // Never delete an app in place: the unconfirmed version returns to its own
  // controlled staging path, then the previous version takes its original name.
  if (await exists(journal.target)) {
    if (await exists(journal.staged)) throw new Error('Rollback staging is occupied.');
    await fs.rename(journal.target, journal.staged);
  }
  await fs.rename(journal.backup, journal.target);
  await writeJournal(journal, 'rolled-back');
  try { await launchApp(journal.target); } catch { /* Receipt remains honest: restored, not launched. */ }
}

async function performSwap(journal, { wait = waitForExit, launchApp = launch, renameApp = fs.rename, confirmationTimeout = 120000, pollInterval = 250 } = {}) {
  await validatePaths(journal);
  await wait(journal.pid);
  // Recheck after the old process exits; a changed target must not be followed.
  await validatePaths(journal);
  let movedOld = false;
  let movedNew = false;
  try {
    await writeJournal(journal, 'swapping');
    await renameApp(journal.target, journal.backup);
    movedOld = true;
    await renameApp(journal.staged, journal.target);
    movedNew = true;
    await writeJournal(journal, 'launching');
    await launchApp(journal.target);
    // Confirmation is a separate monotonic proof, not a launch acknowledgement.
    if (!await hasConfirmation(journal)) await writeJournal(journal, 'launched');
    const deadline = Date.now() + confirmationTimeout;
    for (;;) {
      if (await hasConfirmation(journal)) {
        await writeJournal(journal, 'confirmed');
        return journal;
      }
      if (Date.now() >= deadline) break;
      await delay(pollInterval);
    }
    // Do not move a possibly running new app on a missing receipt. Keep the
    // backup; initialize() can confirm or offer a later explicit rollback.
    await writeJournal(journal, 'unconfirmed');
    return journal;
  } catch (error) {
    if (await hasConfirmation(journal)) {
      await writeJournal(journal, 'confirmed');
      return journal;
    }
    if (movedOld) {
      if (movedNew) await restore(journal, launchApp);
      else {
        await fs.rename(journal.backup, journal.target);
        await writeJournal(journal, 'rolled-back');
        try { await launchApp(journal.target); } catch { /* Restored even if launch fails. */ }
      }
    } else await writeJournal(journal, 'failed');
    throw error;
  }
}

async function run(file) {
  const journal = await readJournal(file);
  if (journal.status !== 'staged') throw new Error('The update has not been staged.');
  await validatePaths(journal);
  if (!process.send) throw new Error('An update helper requires its companion handshake.');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Update handover timed out.')), 15000);
    process.once('disconnect', () => { clearTimeout(timer); reject(new Error('Update handover disconnected.')); });
    process.once('message', message => {
      clearTimeout(timer);
      if (message?.type === 'commit') resolve(); else reject(new Error('Update handover was cancelled.'));
    });
    process.send({ type: 'ready' });
  });
  // No further IPC or parent environment is needed after this handover.
  if (process.connected) process.disconnect();
  await performSwap(journal);
}

module.exports = { validateJournal, readJournal, writeJournal, confirmUpdate, validatePaths, performSwap, restore, minimalEnvironment };
if (require.main === module) run(process.argv[2]).catch(() => { process.exitCode = 1; });
