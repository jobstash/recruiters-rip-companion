import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { validateJournal, readJournal, writeJournal, confirmUpdate, performSwap, minimalEnvironment } = require('../src/update-install.cjs');

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'recruiters-update-helper-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = 'a'.repeat(32);
  const work = path.join(root, 'updates', `install-${id}`);
  const parent = path.join(root, 'Applications');
  await mkdir(work, { recursive: true, mode: 0o700 });
  await mkdir(parent);
  const journal = { schema: 1, id, version: '1.3.0', previousVersion: '1.2.3', pid: process.pid,
    target: path.join(parent, 'Recruiters.rip Companion.app'), staged: path.join(parent, `.recruiters-update-${id}.app`),
    backup: path.join(parent, `.recruiters-backup-${id}.app`), journal: path.join(work, 'journal.json') };
  for (const [app, version] of [[journal.target, '1.2.3'], [journal.staged, '1.3.0']]) {
    await mkdir(app); await writeFile(path.join(app, 'version.txt'), version);
  }
  const data = path.join(root, 'synthetic-device'); await mkdir(data);
  await writeFile(path.join(data, 'identity.json'), JSON.stringify({ device: 'synthetic-unchanged' }));
  await writeJournal(journal, 'staged');
  return { root, data, journal, parent };
}
const versionAt = app => readFile(path.join(app, 'version.txt'), 'utf8');

test('helper waits for original process exit, swaps only the target and retains rollback until startup confirms', async t => {
  const { data, journal, parent } = await fixture(t);
  const unrelated = path.join(parent, 'Unrelated.app'); await mkdir(unrelated); await writeFile(path.join(unrelated, 'keep'), 'unchanged');
  const calls = [];
  await performSwap(journal, {
    wait: async pid => { calls.push(['wait', pid]); assert.equal(await versionAt(journal.target), '1.2.3'); },
    launchApp: async app => {
      calls.push(['launch', app]);
      assert.equal(await versionAt(journal.target), '1.3.0');
      assert.equal(await versionAt(journal.backup), '1.2.3');
      assert.equal((await readJournal(journal.journal)).status, 'launching');
      // Synthetic startup proof uses the same receipt operation as the app.
      await confirmUpdate(journal);
    }, confirmationTimeout: 100, pollInterval: 1,
  });
  assert.deepEqual(calls, [['wait', process.pid], ['launch', journal.target]]);
  assert.equal((await readJournal(journal.journal)).status, 'confirmed');
  // The helper never removes the backup itself. App startup owns its retirement.
  assert.equal(await versionAt(journal.backup), '1.2.3');
  assert.equal(await readFile(path.join(unrelated, 'keep'), 'utf8'), 'unchanged');
  assert.deepEqual(JSON.parse(await readFile(path.join(data, 'identity.json'), 'utf8')), { device: 'synthetic-unchanged' });
});

test('a successful launch request is not a confirmed startup and keeps the old app', async t => {
  const { journal } = await fixture(t);
  await performSwap(journal, { wait: async () => {}, launchApp: async () => {}, confirmationTimeout: 0 });
  assert.equal((await readJournal(journal.journal)).status, 'unconfirmed');
  assert.equal(await versionAt(journal.target), '1.3.0');
  assert.equal(await versionAt(journal.backup), '1.2.3');
});

test('startup confirmation cannot be downgraded by a late helper launch or unconfirmed receipt', async t => {
  const { journal } = await fixture(t);
  await confirmUpdate(journal);
  await writeJournal(journal, 'launched');
  assert.equal((await readJournal(journal.journal)).status, 'confirmed');
  await writeJournal(journal, 'unconfirmed');
  assert.equal((await readJournal(journal.journal)).status, 'confirmed');
  // Model an interprocess weak write that won the rename after the proof. The
  // separate immutable startup proof is authoritative for all receipt readers.
  await writeFile(journal.journal, JSON.stringify({ ...journal, status: 'launched' }), { mode: 0o600 });
  assert.equal((await readJournal(journal.journal)).status, 'confirmed');
});

test('failed new-app launch atomically restores the previous app without touching device data', async t => {
  const { journal, data } = await fixture(t);
  const launches = [];
  await assert.rejects(performSwap(journal, {
    wait: async () => {}, launchApp: async app => {
      launches.push(await versionAt(app));
      if (launches.length === 1) throw new Error('synthetic LaunchServices failure');
    },
  }), /synthetic LaunchServices failure/);
  assert.deepEqual(launches, ['1.3.0', '1.2.3']);
  assert.equal(await versionAt(journal.target), '1.2.3');
  assert.equal(await versionAt(journal.staged), '1.3.0');
  assert.equal((await readJournal(journal.journal)).status, 'rolled-back');
  assert.deepEqual(JSON.parse(await readFile(path.join(data, 'identity.json'), 'utf8')), { device: 'synthetic-unchanged' });
});

test('a failed second rename restores the old app instead of leaving the installation missing', async t => {
  const { journal } = await fixture(t);
  let renames = 0;
  await assert.rejects(performSwap(journal, {
    wait: async () => {}, launchApp: async app => { assert.equal(await versionAt(app), '1.2.3'); },
    renameApp: async (from, to) => {
      if (++renames === 2) throw new Error('synthetic second rename failure');
      await rename(from, to);
    },
  }), /synthetic second rename failure/);
  assert.equal(renames, 2);
  assert.equal((await readJournal(journal.journal)).status, 'rolled-back');
  assert.equal(await versionAt(journal.target), '1.2.3');
});

test('helper rejects arbitrary targets, linked bundles and occupied backups before changing an app', async t => {
  for (const attack of ['backup', 'link', 'path']) {
    const { journal, root } = await fixture(t);
    if (attack === 'backup') { await mkdir(journal.backup); await writeFile(path.join(journal.backup, 'keep'), 'retained'); }
    if (attack === 'link') { const actual = path.join(root, 'Actual.app'); await rename(journal.target, actual); await symlink(actual, journal.target); }
    if (attack === 'path') journal.staged = path.join(root, 'Unrelated.app');
    let waited = false;
    await assert.rejects(performSwap(journal, { wait: async () => { waited = true; }, launchApp: async () => {} }));
    assert.equal(waited, false);
    assert.equal(await versionAt(journal.target), '1.2.3');
  }
});

test('an original process that does not exit leaves both app bundles in place', async t => {
  const { journal } = await fixture(t);
  await assert.rejects(performSwap(journal, { wait: async () => { throw new Error('synthetic exit timeout'); }, launchApp: async () => { assert.fail('must not launch'); } }), /synthetic exit timeout/);
  assert.equal(await versionAt(journal.target), '1.2.3');
  assert.equal(await versionAt(journal.staged), '1.3.0');
  assert.equal((await readJournal(journal.journal)).status, 'staged');
});

test('helper receipt paths and launch environment are narrowly constrained', async t => {
  const { journal, root } = await fixture(t);
  assert.equal(validateJournal(journal, journal.journal), journal);
  for (const patch of [{ backup: path.join(root, 'data') }, { staged: path.join(root, 'source') }, { pid: 0 }, { id: '../escape' }, { target: path.join(root, 'checkout') }]) {
    assert.throws(() => validateJournal({ ...journal, ...patch }, journal.journal));
  }
  assert.deepEqual(minimalEnvironment(), { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: '/tmp', ELECTRON_RUN_AS_NODE: '1' });
  assert.equal((await readdir(path.dirname(journal.journal))).includes('journal.json'), true);
});
