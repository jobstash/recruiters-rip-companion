import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const lockModule = fileURLToPath(new URL('../src/update-install-lock.cjs', import.meta.url));
const { claimInstallation, installationLock } = createRequire(import.meta.url)(lockModule);

test('installation exclusion is held by the application process and released on its death', { timeout: 20000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'companion-install-exclusion-')));
  const target = path.join(root, 'Synthetic.app');
  await mkdir(target);
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['-e', `
    const { claimInstallation } = require(process.argv[1]);
    claimInstallation(process.argv[2]).then(release => {
      if (!release) process.exit(2);
      process.stdout.write('claimed\\n');
      process.stdin.resume();
    }).catch(() => process.exit(3));
  `, lockModule, target], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const exited = new Promise(resolve => child.once('exit', resolve));
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Competing startup failed to claim exclusion')));
    child.stdout.once('data', bytes => bytes.toString() === 'claimed\n' ? resolve() : reject(new Error('Invalid kernel claim handshake')));
  });
  assert.equal(await claimInstallation(target), null);
  child.kill('SIGKILL');
  await exited;
  const release = await claimInstallation(target);
  assert.equal(typeof release, 'function');
  await release();
});

test('Windows ordinary startup and independent PowerShell helper exclude each other', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'companion-install-pipe-')));
  const target = path.join(root, 'Synthetic');
  await mkdir(target);
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const pipe = installationLock(target).pipe;
  const start = wait => {
    const code = `try { $p=New-Object IO.Pipes.NamedPipeServerStream('${pipe}',[IO.Pipes.PipeDirection]::InOut,1) } catch { exit 73 }; try { ${wait ? "[Console]::Out.WriteLine('claimed'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null" : ''} } finally { $p.Dispose() }`;
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'inherit'] });
    t.after(() => child.kill());
    return child;
  };
  const release = await claimInstallation(target);
  assert.equal(typeof release, 'function');
  const blocked = start(false);
  assert.equal(await new Promise((resolve, reject) => { blocked.once('error', reject); blocked.once('exit', resolve); }), 73);
  await release();
  const owner = start(true);
  const exited = new Promise(resolve => owner.once('exit', resolve));
  await new Promise((resolve, reject) => {
    owner.once('error', reject);
    owner.once('exit', () => reject(new Error('PowerShell exclusion failed')));
    owner.stdout.once('data', () => resolve());
  });
  assert.equal(await claimInstallation(target), null);
  owner.stdin.end('\n');
  await exited;
  const releaseAgain = await claimInstallation(target);
  assert.equal(typeof releaseAgain, 'function');
  await releaseAgain();
});
