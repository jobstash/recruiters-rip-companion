import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claimInstance } from '../src/instance-lock.mjs';

const lockModule = new URL('../src/instance-lock.mjs', import.meta.url).href;

test('only one live process holds the companion claim, and a killed holder never leaves it stale', async () => {
  const directory = path.join(await mkdtemp(path.join(tmpdir(), 'rr-instance-')), 'device');
  try {
    const holder = spawn(process.execPath, ['--input-type=module', '-e',
      `const { claimInstance } = await import(${JSON.stringify(lockModule)});
       console.log(await claimInstance(${JSON.stringify(directory)}) ? 'held' : 'refused'); setInterval(() => {}, 1000);`],
    { stdio: ['ignore', 'pipe', 'inherit'] });
    const first = await new Promise(resolve => holder.stdout.once('data', chunk => resolve(chunk.toString().trim())));
    assert.equal(first, 'held');
    assert.equal(await claimInstance(directory), null);
    holder.kill('SIGKILL');
    await new Promise(resolve => holder.once('exit', resolve));
    const release = await claimInstance(directory);
    assert.equal(typeof release, 'function');
    release();
  } finally {
    await rm(path.dirname(directory), { recursive: true, force: true });
  }
});
