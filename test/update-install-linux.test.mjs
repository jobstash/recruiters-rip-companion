import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../src/update-install.sh', import.meta.url));
const { installationLock, claimInstallation } = createRequire(import.meta.url)('../src/update-install-lock.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const result = await read(); if (result) return result; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await pause(25);
  }
  throw new Error('Native updater did not reach the expected state');
}
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

for (const outcome of ['confirmed', 'crashed', 'tampered', 'competing-before-swap', 'competing-startup']) {
  test(`Linux independent helper ${outcome}: actual file replacement and process receipt`, { skip: process.platform !== 'linux', timeout: 15000 }, async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'companion-native-update-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const id = 'd'.repeat(32), work = path.join(root, 'updates', `install-${id}`);
    await mkdir(work, { recursive: true, mode: 0o700 });
    const target = path.join(root, 'Companion.AppImage');
    const staged = path.join(root, `.recruiters-update-${id}.AppImage`);
    const backup = path.join(root, `.recruiters-backup-${id}.AppImage`);
    // Synthetic executable fixtures exercise the production shell transaction.
    // The separate installed-update CI gate uses real old/new AppImage artifacts.
    const old = `#!/bin/sh\nprintf restored > ${quote(path.join(root, 'restored'))}\n`;
    const ownerReady = path.join(root, 'owner-ready'), ownerPid = path.join(root, 'owner-pid');
    const ownerScript = `exec 9>${quote(installationLock(target).file)}; /usr/bin/flock -n 9 || exit 1; printf claimed > ${quote(ownerReady)}; exec /bin/sleep 30`;
    const next = outcome === 'crashed' ? '#!/bin/sh\nexit 7\n'
      : outcome === 'competing-startup'
        ? `#!/bin/sh\n/bin/sh -c ${quote(ownerScript)} &\nprintf '%s' "$!" > ${quote(ownerPid)}\nwhile [ ! -f ${quote(ownerReady)} ]; do sleep 0.01; done\nexit 0\n`
        : `#!/bin/sh\ncp ${quote(path.join(work, 'expected-confirmation.json'))} ${quote(path.join(work, 'confirmed.json'))}\n`;
    let competingPid;
    t.after(() => { if (competingPid) { try { process.kill(competingPid, 'SIGKILL'); } catch {} } });
    await writeFile(target, old, { mode: 0o700 });
    await writeFile(staged, next, { mode: 0o700 });
    await writeFile(path.join(root, 'synthetic-data.json'), '{"preserved":true}');
    const parent = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    t.after(() => parent.kill());
    await new Promise((resolve, reject) => { parent.once('spawn', resolve); parent.once('error', reject); });
    const digest = createHash('sha256').update(next).digest('hex');
    const journal = { schema: 1, platform: 'linux', id, version: '1.3.0', previousVersion: '1.2.3', pid: parent.pid,
      target, staged, backup, digest, userData: root, journal: path.join(work, 'journal.json'), status: 'staged' };
    await writeFile(journal.journal, JSON.stringify(journal));
    for (const status of ['swapping', 'launching', 'launched', 'confirmed', 'unconfirmed', 'rolled-back', 'failed']) {
      await writeFile(path.join(work, `receipt-${status}.json`), JSON.stringify({ ...journal, status }));
    }
    await writeFile(path.join(work, 'expected-confirmation.json'), JSON.stringify({ id, version: journal.version }));
    if (outcome === 'tampered') await writeFile(staged, '#!/bin/sh\nexit 0\n');
    const lockFd = openSync(installationLock(target).file, 'a', 0o600);
    let child;
    try {
      child = spawn('/bin/sh', [helper, work, target, staged, backup, String(parent.pid), digest, id, root, installationLock(target).file], { stdio: ['ignore', 'ignore', 'ignore', lockFd] });
    } finally { closeSync(lockFd); }
    t.after(() => child.kill());
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (outcome === 'tampered') {
      assert.notEqual(await exited, 0);
      assert.equal(await readFile(target, 'utf8'), old);
      assert.equal(JSON.parse(await readFile(journal.journal, 'utf8')).status, 'staged');
      return;
    }
    await until(async () => await readFile(path.join(work, 'ready'), 'utf8') === id);
    assert.equal(await readFile(target, 'utf8'), old);
    let release;
    if (outcome === 'competing-before-swap') {
      release = await claimInstallation(target);
      assert.equal(typeof release, 'function');
      t.after(() => release());
    }
    await writeFile(path.join(work, 'commit'), id);
    parent.kill();
    if (outcome === 'competing-startup') competingPid = Number(await until(() => readFile(ownerPid, 'utf8')));
    const code = await exited;
    const receipt = JSON.parse(await readFile(journal.journal, 'utf8'));
    if (outcome === 'competing-before-swap') {
      assert.equal(receipt.status, 'unconfirmed');
      assert.equal(await readFile(target, 'utf8'), old);
      assert.equal(await readFile(staged, 'utf8'), next);
      return;
    }
    assert.ok(Number.isSafeInteger(receipt.launchedPid));
    if (outcome === 'competing-startup') {
      competingPid = Number(await readFile(ownerPid, 'utf8'));
      assert.equal(receipt.status, 'unconfirmed');
      assert.equal(await readFile(target, 'utf8'), next);
      assert.equal(await readFile(backup, 'utf8'), old);
      process.kill(competingPid, 0);
    } else if (outcome === 'confirmed') {
      assert.equal(code, 0);
      assert.equal(receipt.status, 'confirmed');
      assert.equal(await readFile(target, 'utf8'), next);
      assert.equal(await readFile(backup, 'utf8'), old);
    } else {
      assert.notEqual(code, 0);
      assert.equal(receipt.status, 'rolled-back');
      assert.equal(await readFile(target, 'utf8'), old);
      await until(async () => await readFile(path.join(root, 'restored'), 'utf8') === 'restored');
    }
    assert.equal(await readFile(path.join(root, 'synthetic-data.json'), 'utf8'), '{"preserved":true}');
  });
}
