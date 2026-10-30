import test from 'node:test';
import assert from 'node:assert/strict';
import { releasePolicy, shipsRuntime } from '../scripts/release-policy.mjs';

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
