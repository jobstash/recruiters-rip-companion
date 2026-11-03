import test from 'node:test';
import assert from 'node:assert/strict';
import { createCareerState } from '../src/mcp/state.mjs';
import { createIntroductionTools, introductionsStatus } from '../src/mcp/introduction-tools.mjs';

function fixture({ platform = async () => ({ results: [] }) } = {}) {
  const career = createCareerState();
  let state = { career, deviceId: 'synthetic-device', pairing: { account: { id: '123' } } };
  const store = { get: () => structuredClone(state), update: async change => { const next = structuredClone(state); await change(next); state = next; } };
  const calls = { platform: [], github: 0 };
  const tools = new Map(createIntroductionTools({ store,
    platform: async (operation, args) => { calls.platform.push({ operation, args }); return platform(operation, args); },
    openGithub: async () => { calls.github++; },
  }).map(tool => [tool.name, tool]));
  const call = (name, args = {}) => tools.get(name).invoke(args);
  return { store, calls, call, set: change => change(state.career) };
}
test('intro paths relay through the platform; GitHub onboarding records the opened page or a skip', async () => {
  const f = fixture();
  assert.deepEqual(await f.call('career_intro_paths', { jobIds: ['node:1'] }), { results: [] });
  assert.deepEqual(f.calls.platform[0], { operation: 'intro_paths', args: { jobIds: ['node:1'] } });
  await assert.rejects(f.call('career_intro_paths', { jobIds: ['local:abc'] }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.call('career_intro_paths', { jobIds: Array.from({ length: 11 }, (_, i) => `node:${i + 1}`) }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.call('career_intro_paths', {}), { code: 'INVALID_INPUT' });
  assert.equal(f.calls.platform.length, 1);
  assert.equal(introductionsStatus(f.store.get().career).github, null);
  await f.call('account_github_connect');
  assert.equal(f.calls.github, 1);
  assert.equal(introductionsStatus(f.store.get().career).github, 'requested');
  await f.call('career_introductions_update', { githubSkipped: true });
  assert.equal(introductionsStatus(f.store.get().career).github, 'skipped');
  await f.call('account_github_connect');
  assert.equal(introductionsStatus(f.store.get().career).github, 'requested');
  for (const args of [{}, { githubSkipped: 'true' }, { githubSkipped: true, extra: true }, null])
    await assert.rejects(f.call('career_introductions_update', args), { code: 'INVALID_INPUT' });
  await f.call('career_introductions_update', { githubSkipped: false });
  assert.equal(introductionsStatus(f.store.get().career).github, 'requested');
});

test('intro paths return asOf, inferred flags and paths without the scorer source label', async () => {
  const response = { github: { login: 'candidate' }, asOf: '2026-10-01', source: 'scorer-label', results: [{ jobId: 'node:1', inferred: true, orgLogins: ['example'], paths: [] }] };
  const f = fixture({ platform: async () => structuredClone(response) });
  const result = await f.call('career_intro_paths', { jobIds: ['node:1'] });
  assert.equal(Object.hasOwn(result, 'source'), false);
  const { source: _source, ...expected } = response;
  assert.deepEqual(result, expected);
});


test('introduction paths reject blocked company and job IDs without calling the platform', async () => {
  const f = fixture();
  f.set(career => {
    career.matching = { jobs: { 'node:1': { company: 'Flow Traders' }, 'node:2': { company: 'Other Company' }, 'node:3': { company: 'Allowed Company' } } };
    career.blocklist = { company: { kind: 'company', value: 'flow-traders' }, direct: { kind: 'job', value: 'node:2' } };
  });
  for (const id of ['node:1', 'node:2'])
    await assert.rejects(f.call('career_intro_paths', { jobIds: [id] }), { code: 'JOB_BLOCKED' });
  assert.deepEqual(f.calls.platform, []);
  assert.deepEqual(await f.call('career_intro_paths', { jobIds: ['node:3'] }), { results: [] });
  assert.equal(f.calls.platform.length, 1);
});

test('introduction paths are not released when their job is blocked while loading', async () => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  const f = fixture({ platform: async () => { started(); return response; } });
  const pending = f.call('career_intro_paths', { jobIds: ['node:1'] });
  await waiting;
  f.set(career => { career.blocklist = { direct: { kind: 'job', value: 'node:1' } }; });
  release({ results: [{ jobId: 'node:1', paths: [] }] });
  await assert.rejects(pending, { code: 'JOB_BLOCKED' });
});
