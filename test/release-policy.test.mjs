import test from 'node:test';
import assert from 'node:assert/strict';
import { releasePolicy, shipsRuntime, requireReleaseSecurity } from '../scripts/release-policy.mjs';

for (const name of ['src/main.mjs', 'ui/updates.js', 'browser-extension/src/background.mjs', 'scripts/after-pack.cjs', 'scripts/smoke-update.mjs', 'package.json', 'pnpm-lock.yaml', 'skills/recruiters-rip/SKILL.md']) {
  test(`shipping ${name} requires a version bump`, () => {
    assert.equal(shipsRuntime(name), true);
    assert.throws(() => releasePolicy({ version: '3.12.0', previousVersion: '3.12.0', changed: [name] }), /require a package.json version greater/);
    assert.equal(releasePolicy({ version: '3.13.0', previousVersion: '3.12.0', changed: [name] }).publish, true);
  });
}
test('documentation, tests and workflow-only edits never republish an installer', () => {
  assert.deepEqual(releasePolicy({ version: '3.12.0', previousVersion: '3.12.0', changed: ['README.md', 'AGENTS.md', 'design.md', 'test/updates.test.mjs', '.github/workflows/package.yml'] }), { version: '3.12.0', publish: false, runtimeChanged: false });
});
test('renaming or deleting shipped files is still a shipping change', () => {
  assert.throws(() => releasePolicy({ version: '3.12.0', previousVersion: '3.12.0', changed: ['src/obsolete.mjs'] }), /require a package.json version greater/);
});
test('downgrades and prerelease versions cannot enter the stable pipeline', () => {
  assert.throws(() => releasePolicy({ version: '3.11.0', previousVersion: '3.12.0', changed: ['README.md'] }), /backwards/);
  assert.throws(() => releasePolicy({ version: '3.13.0-beta.1', previousVersion: '3.12.0', changed: ['src/main.mjs'] }), /stable/);
});

const securitySha = 'a'.repeat(40);
const completedRun = { id: 42, head_sha: securitySha, head_branch: 'main', status: 'completed', conclusion: 'success' };
const completedAnalysis = { id: 7, commit_sha: securitySha, ref: 'refs/heads/main', tool: { name: 'CodeQL' },
  analysis_key: '.github/workflows/security.yml:codeql', rules_count: 103, error: '' };
function securityFixture({ runs = [completedRun], analyses = [completedAnalysis], alerts = [], secondPage = [] } = {}) {
  let clock = 0;
  const calls = [];
  return { calls, options: { sha: securitySha, timeout: 10, now: () => clock, pause: async ms => { clock += ms; },
    request: async endpoint => {
      calls.push(endpoint);
      if (endpoint.startsWith('actions/')) return { workflow_runs: runs };
      if (endpoint.startsWith('code-scanning/analyses')) return analyses;
      if (endpoint.startsWith('code-scanning/alerts')) return endpoint.endsWith('page=2') ? secondPage : alerts;
      assert.fail('Unexpected security API request');
    } } };
}
test('release requires completed exact-main full analysis and empty open-alert inventory', async () => {
  const fixture = securityFixture();
  assert.deepEqual(await requireReleaseSecurity(fixture.options), { sha: securitySha, workflowRun: 42, analysis: 7, rules: 103 });
  assert.ok(fixture.calls.some(endpoint => endpoint.includes('state=open&ref=refs%2Fheads%2Fmain')));
});
for (const [name, override] of [
  ['wrong analysis SHA', { analyses: [{ ...completedAnalysis, commit_sha: 'b'.repeat(40) }] }],
  ['PR delta analysis', { analyses: [{ ...completedAnalysis, ref: 'refs/pull/13/merge' }] }],
  ['missing analysis', { analyses: [] }],
  ['zero analyzed rules', { analyses: [{ ...completedAnalysis, rules_count: 0 }] }],
  ['incomplete workflow', { runs: [{ ...completedRun, status: 'in_progress', conclusion: null }] }],
  ['wrong workflow SHA', { runs: [{ ...completedRun, head_sha: 'b'.repeat(40) }] }],
  ['failed workflow', { runs: [{ ...completedRun, conclusion: 'failure' }] }],
  ['cancelled workflow', { runs: [{ ...completedRun, conclusion: 'cancelled' }] }],
  ['failed analysis', { analyses: [{ ...completedAnalysis, error: 'failed extraction' }] }],
  ['open finding', { alerts: [{ number: 30 }] }],
]) test(`release fails closed for ${name}`, async () => {
  await assert.rejects(requireReleaseSecurity(securityFixture(override).options));
});
test('release reads every open-alert page before rejecting the inventory', async () => {
  const fixture = securityFixture({ alerts: Array.from({ length: 100 }, (_, number) => ({ number })), secondPage: [{ number: 101 }] });
  await assert.rejects(requireReleaseSecurity(fixture.options), /101 open/);
  assert.ok(fixture.calls.some(endpoint => endpoint.endsWith('page=2')));
});
test('security API errors never authorize publication', async () => {
  const fixture = securityFixture();
  fixture.options.request = async () => { throw new Error('permission denied'); };
  await assert.rejects(requireReleaseSecurity(fixture.options), /permission denied/);
});
