import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { createCareerState } from '../src/mcp/state.mjs';
import { createIntroductionTools, introductionsStatus } from '../src/mcp/introduction-tools.mjs';

const target = { login: 'lifinance', kind: 'organization' };
function fixture({ platform = async (_operation, args) => ({ targets: args.targets.map(value => ({ ...value, paths: [] })) }) } = {}) {
  let state = { career: createCareerState(), deviceId: 'synthetic-device', pairing: { account: { id: '123' } } };
  const store = { get: () => structuredClone(state), update: async change => { const next = structuredClone(state); await change(next); state = next; } };
  const calls = { platform: [], github: 0 };
  const tools = new Map(createIntroductionTools({ store,
    platform: async (operation, args) => { calls.platform.push({ operation, args }); return platform(operation, args); },
    openGithub: async () => { calls.github++; },
  }).map(tool => [tool.name, tool]));
  const call = (name, args = {}) => tools.get(name).invoke(args);
  return { store, calls, tools, call, set: change => change(state.career) };
}

test('GitHub endpoints are canonicalized and deduplicated without adding a default source', async () => {
  const f = fixture(), args = { targets: [{ login: 'LiFinance', kind: 'organization' }, target, { login: 'Alice', kind: 'user' }] };
  const before = structuredClone(args);
  await f.call('career_intro_paths', args);
  assert.deepEqual(f.calls.platform, [{ operation: 'intro_paths', args: { targets: [target, { login: 'alice', kind: 'user' }] } }]);
  assert.deepEqual(args, before);
  for (const kind of ['user', 'organization']) {
    await f.call('career_intro_paths', { source: { login: 'Source-Account', kind }, targets: [target, { login: 'Alice', kind: 'user' }] });
    assert.deepEqual(f.calls.platform.at(-1).args, { source: { login: 'source-account', kind }, targets: [target, { login: 'alice', kind: 'user' }] });
  }
});

test('published schema and invoke reject invalid GitHub identities, extra data and obsolete job arguments', async () => {
  const f = fixture(), validate = new Ajv().compile(f.tools.get('career_intro_paths').inputSchema);
  const invalidEndpoints = [null, [], {}, { login: 'alice' }, { kind: 'user' }, { login: 'alice', kind: 'person' },
    { login: 'alice', kind: 'user', cv: 'private' }, ...['', '-alice', 'alice-', 'al--ice', 'a_b', 'LI.FI', '@alice',
      'https://github.com/alice', 'a/b', ' alice', 'alice ', 'álîce', 'a'.repeat(40), 'a\n'].map(login => ({ login, kind: 'user' }))];
  const invalid = [null, [], {}, { targets: [] }, { targets: [target], extra: true }, { jobIds: ['node:1'] },
    { targets: [target], jobIds: ['local:captured'] }, { targets: Array(21).fill(target) },
    ...invalidEndpoints.flatMap(value => [{ targets: [value] }, { source: value, targets: [target] }])];
  for (const args of invalid) {
    assert.equal(validate(args), false, JSON.stringify(args));
    await assert.rejects(f.call('career_intro_paths', args), { code: 'INVALID_INPUT' });
  }
  assert.deepEqual(f.calls.platform, []);
  for (const login of ['a', '1', 'A-1', 'a'.repeat(39)]) {
    const args = { targets: [{ login, kind: 'user' }] };
    assert.equal(validate(args), true);
    await f.call('career_intro_paths', args);
  }
  const maximum = { targets: Array.from({ length: 20 }, (_, index) => ({ login: `user-${index}`, kind: 'user' })) };
  assert.equal(validate(maximum), true);
  await f.call('career_intro_paths', maximum);
  assert.equal(f.calls.platform.at(-1).args.targets.length, 20);
});

test('target grouping preserves organization bridge people, contribution evidence and unscored same-person paths', async () => {
  const source = { login: 'source-org', kind: 'organization' };
  const person = login => ({ login, name: login, avatar: null, githubUrl: `https://github.com/${login}`, emails: [] });
  const sourcePerson = person('source-contributor'), targetPerson = person('target-contributor');
  const sourceEvidence = { org: source.login, person: sourcePerson.login, kind: 'contribution', repos: ['repo'], firstSeen: '2024-01-01', lastSeen: '2025-01-01' };
  const targetEvidence = { ...sourceEvidence, org: target.login, person: targetPerson.login };
  const response = { source, available: true, asOf: '2026-11-05', inferred: true, coverage: { source: 'indexed', maxHops: 2 }, targets: [
    { ...target, status: 'ok', paths: [{ source: sourcePerson, sourceEvidence, target: targetPerson, targetEvidence, via: person('bridge'),
      hops: 2, tier: '1-intermediary', edges: [{ org: 'shared-org', repos: ['shared-repo'], overlapEnd: '2025-01-01' }], warmScore: 42, pathStrength: 2 }] },
    { login: 'shared-org', kind: 'organization', status: 'ok', paths: [{ source: sourcePerson, target: sourcePerson, sourceEvidence,
      targetEvidence: { ...sourceEvidence, org: 'shared-org' }, via: null, hops: 0, tier: 'same-person', edges: [], warmScore: null, pathStrength: null }] },
    { login: 'unindexed', kind: 'user', status: 'target_not_indexed', paths: [] },
  ] };
  const f = fixture({ platform: async () => structuredClone(response) });
  assert.deepEqual(await f.call('career_intro_paths', { source, targets: response.targets.map(({ login, kind }) => ({ login, kind })) }), response);
});

test('missing linked source, missing graph coverage, no paths and outages remain distinct', async () => {
  const source = { login: 'candidate', kind: 'user' };
  for (const [resolved, available, status, reason, coverage] of [
    [null, false, 'unavailable', 'github_required', 'unavailable'],
    [source, false, 'unavailable', 'unavailable', 'unavailable'],
    [source, true, 'source_not_indexed', undefined, 'not_indexed'],
    [source, true, 'target_not_indexed', undefined, 'indexed'],
    [source, true, 'no_paths', undefined, 'indexed'],
  ]) {
    const response = { source: resolved, available, asOf: available ? '2026-11-05' : null, inferred: true,
      coverage: { source: coverage, maxHops: 2 }, ...(reason ? { reason } : {}), targets: [{ ...target, status, paths: [] }] };
    const f = fixture({ platform: async () => response });
    assert.deepEqual(await f.call('career_intro_paths', { targets: [target] }), response);
  }
  const error = Object.assign(new Error('Membership required'), { code: 'DEVICE_UNAUTHORIZED' });
  const f = fixture({ platform: async () => { throw error; } });
  await assert.rejects(f.call('career_intro_paths', { targets: [target] }), error);
});

test('GitHub-only queries never inspect jobs, publication range or blocklists, including during lookup', async () => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  const f = fixture({ platform: async () => { started(); return response; } });
  f.set(career => {
    career.publicationRange = 'today';
    career.matching = { jobs: {}, scores: {} };
    career.jobs = { 'local:lifi': { title: 'Engineer', company: 'LI.FI' } };
    career.blocklist = { company: { kind: 'company', value: 'li-fi' }, direct: { kind: 'job', value: 'local:lifi' } };
  });
  const pending = f.call('career_intro_paths', { targets: [target] });
  await waiting;
  f.set(career => { career.blocklist = { company: { kind: 'company', value: 'lifinance' } }; });
  const result = { targets: [{ ...target, status: 'no_paths', paths: [] }] };
  release(result);
  assert.deepEqual(await pending, result);
  assert.deepEqual(f.calls.platform, [{ operation: 'intro_paths', args: { targets: [target] } }]);
  assert.equal(f.store.get().career.publicationRange, 'today');
  const tools = createIntroductionTools({ store: { get() { assert.fail('No local lookup needed'); } }, platform: async () => result });
  assert.deepEqual(await tools[0].invoke({ targets: [target] }), result);
});

test('GitHub onboarding records the opened page or an explicit skip', async () => {
  const f = fixture();
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
