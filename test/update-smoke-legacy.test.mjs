// Unit checks for the CI adapter's boundary only. Native launch/replacement is
// exercised separately by the macOS --legacy-mac workflow gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const source = await readFile(new URL('../scripts/smoke-update-legacy-preload.cjs', import.meta.url), 'utf8');
const scratch = '/private/tmp/recruiters-update-synthetic';
const fixture = () => ({ target: `${scratch}/installed/Recruiters.rip Companion.app`, userData: `${scratch}/home/Library/Application Support/Recruiters Companion`, audit: `${scratch}/audit.jsonl`, environment: { HOME: `${scratch}/home`, TMPDIR: `${scratch}/tmp` } });
function load(config = fixture(), environment = {}) {
  const calls = [], audits = [];
  const childProcess = { spawn(command, args, options) { calls.push({ command, args: JSON.parse(JSON.stringify(args)), options }); return 'real-spawn-result'; } };
  const fs = { lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 1024, uid: 501, mode: 0o100600 }),
    readFileSync: () => JSON.stringify(config), appendFileSync: (file, bytes, options) => audits.push({ file, record: JSON.parse(bytes), options }) };
  const modules = { 'node:fs': fs, 'node:path': path.posix, 'node:child_process': childProcess };
  vm.runInNewContext(source, { require: name => { assert.ok(Object.hasOwn(modules, name)); return modules[name]; },
    process: { platform: 'darwin', getuid: () => 501, env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RECRUITERS_UPDATE_SMOKE_CONFIG: `${scratch}/config.json`, ...environment } } });
  return { childProcess, calls, audits };
}
test('legacy adapter adds only isolated profile/environment arguments to the exact native open call', () => {
  const config = fixture(), { childProcess, calls, audits } = load(config), options = { env: { PATH: '/usr/bin:/bin', TMPDIR: '/tmp' }, stdio: 'ignore' };
  assert.equal(childProcess.spawn('/usr/bin/open', ['-n', config.target], options), 'real-spawn-result');
  assert.deepEqual(calls[0].args, ['-n', config.target, '--env', `HOME=${config.environment.HOME}`, '--env', `TMPDIR=${config.environment.TMPDIR}`, '--args', `--user-data-dir=${config.userData}`]);
  assert.equal(calls[0].options, options);
  assert.equal(audits.length, 1); assert.equal(audits[0].file, config.audit);
  assert.deepEqual(audits[0].record.originalArgs, ['-n', config.target]);
});
test('unexpected LaunchServices arguments fail closed; unrelated commands remain unchanged', () => {
  const config = fixture(), { childProcess, calls, audits } = load(config);
  assert.throws(() => childProcess.spawn('/usr/bin/open', ['-n', '/Applications/Other.app'], {}), /unisolated/);
  assert.throws(() => childProcess.spawn('/usr/bin/open', ['-n', config.target, '--args'], {}), /unisolated/);
  childProcess.spawn('/bin/sh', ['-n', config.target], {});
  assert.equal(calls.length, 1); assert.equal(audits.length, 0);
  assert.deepEqual(calls[0].args, ['-n', config.target]);
});
test('legacy adapter refuses non-hosted execution and profile or environment escapes', () => {
  assert.throws(() => load(fixture(), { RUNNER_ENVIRONMENT: 'self-hosted' }), /GitHub-hosted/);
  assert.throws(() => load({ ...fixture(), userData: '/Users/actual-user/Library/Application Support/Recruiters Companion' }), /escaped/);
  assert.throws(() => load({ ...fixture(), environment: { NODE_OPTIONS: `${scratch}/unsafe` } }), /escaped/);
  assert.throws(() => load({ ...fixture(), target: `${scratch}/../other.app` }), /escaped/);
});
