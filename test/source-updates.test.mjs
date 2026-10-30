import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { prepareSourceRoot, readManagedSource, writeSourceJSON, resolveOfficialSource, validateSourceRelease, parseSourceArguments, compareSourceVersions, assertCleanSource, assertInstalledSource, runSourceCommand, sourceEnvironment, readSourceJSON, discoverSourceTools, sourceLauncherText, writeSourceLauncher, repairManagedSourceTools, assertSourceAncestors, assertWindowsSourcePath, installSourceElectron } from '../scripts/install-source.mjs';
import { inspectManagedSource, createSourceUpdateController } from '../src/source-updates.mjs';
import { readSourceTransition } from '../src/source-update-helper.mjs';

async function temporary(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'recruiters-source-test-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function fixture(t, version = '3.12.0', parent) {
  const directory = parent || await temporary(t);
  const root = await prepareSourceRoot(path.join(directory, 'managed'));
  const sourceRoot = path.join(root, 'versions', `fixture-${version}`, 'source');
  await fs.mkdir(sourceRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify({ name: 'recruiters-companion', version }));
  await fs.writeFile(path.join(sourceRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  const receipt = { schema: 1, root, sourceRoot, version, commit: 'a'.repeat(40), provenance: 'local-candidate', tag: `v${version}`, lockDigest: createHash('sha256').update('lockfileVersion: 9.0\n').digest('hex'), tools: { node: process.execPath, git: path.join(path.parse(process.execPath).root, 'git'), npm: path.join(path.parse(process.execPath).root, 'npm-cli.js') } };
  await writeSourceJSON(path.join(path.dirname(sourceRoot), 'receipt.json'), receipt);
  await writeSourceJSON(path.join(root, 'current.json'), { schema: 1, sourceRoot, version });
  return receipt;
}
const release = { tag_name: 'v3.12.0', html_url: 'https://github.com/jobstash/recruiters-rip-companion/releases/tag/v3.12.0', draft: false, prerelease: false };
const response = value => new Response(JSON.stringify(value), { status: 200 });

test('official source selection pins published stable version and exact commit, not default branch', async () => {
  const calls = [];
  const selected = await resolveOfficialSource({ fetchImpl: async (url, options) => { calls.push({ url, options }); return response(calls.length === 1 ? release : { sha: 'b'.repeat(40) }); } });
  assert.deepEqual(selected, { version: '3.12.0', tag: 'v3.12.0', commit: 'b'.repeat(40), provenance: 'official-release', releaseUrl: release.html_url });
  assert.match(calls[0].url, /\/releases\/latest$/);
  assert.match(calls[1].url, /\/commits\/v3\.12\.0$/);
  assert.equal(calls[0].options.redirect, 'error');
});

test('source metadata rejects drafts, prereleases, foreign origin and unpinned commits', async () => {
  for (const bad of [{ ...release, draft: true }, { ...release, prerelease: true }, { ...release, tag_name: 'main' }, { ...release, html_url: 'https://example.com/release' }]) {
    await assert.rejects(resolveOfficialSource({ fetchImpl: async () => response(bad) }), { code: 'INVALID_SOURCE_RELEASE' });
  }
  let count = 0;
  await assert.rejects(resolveOfficialSource({ fetchImpl: async () => response(++count === 1 ? release : { sha: 'main' }) }), { code: 'INVALID_SOURCE_RELEASE' });
  await assert.rejects(resolveOfficialSource({ fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1)) }), { code: 'SOURCE_RELEASE_UNAVAILABLE' });
});

test('managed receipt binds real root, version, production package and private ownership', async t => {
  const receipt = await fixture(t);
  assert.equal((await inspectManagedSource(receipt.sourceRoot, { version: '3.12.0' })).root, receipt.root);
  assert.equal(await inspectManagedSource(receipt.sourceRoot, { version: '3.11.0' }), null);
  await writeSourceJSON(path.join(path.dirname(receipt.sourceRoot), 'receipt.json'), { ...receipt, sourceRoot: path.dirname(receipt.sourceRoot) });
  assert.equal(await inspectManagedSource(receipt.sourceRoot), null);
  await writeSourceJSON(path.join(path.dirname(receipt.sourceRoot), 'receipt.json'), receipt);
  await fs.writeFile(path.join(receipt.sourceRoot, 'package.json'), JSON.stringify({ name: 'recruiters-companion', version: receipt.version, localProduct: true }));
  assert.equal(await inspectManagedSource(receipt.sourceRoot), null);
});

test('ordinary clones cannot opt in through environment or borrowed receipt', async t => {
  const directory = await temporary(t), sourceRoot = path.join(directory, 'checkout');
  await fs.mkdir(sourceRoot);
  await fs.writeFile(path.join(sourceRoot, 'receipt.json'), '{}');
  assert.equal(await inspectManagedSource(sourceRoot), null);
  const controller = createSourceUpdateController({ version: '3.12.0', sourceRoot, directory: path.join(directory, 'profile', 'updates'), resolveRelease: async () => ({ version: '3.13.0', releaseUrl: release.html_url }) });
  await controller.initialize();
  assert.equal(controller.state().automaticSupported, false);
  assert.equal((await controller.check()).status, 'available');
  await assert.rejects(controller.download(), { code: 'UNMANAGED_SOURCE' });
  assert.deepEqual(await fs.readdir(sourceRoot), ['receipt.json']);
});

test('ahead source checkout is never downgraded and build requires a newer release', async t => {
  const sourceRoot = await temporary(t);
  const controller = createSourceUpdateController({ version: '3.12.0', sourceRoot, directory: path.join(sourceRoot, 'updates'), resolveRelease: async () => ({ version: '3.11.0' }) });
  assert.equal((await controller.check()).status, 'ahead');
  await assert.rejects(controller.download(), { code: 'INVALID_STATE' });
  assert.equal(compareSourceVersions('3.12.0', '3.11.9'), 1);
  assert.throws(() => compareSourceVersions('3.12.0-beta', '3.12.0'), { code: 'INVALID_VERSION' });
});

test('source destination refuses existing arbitrary directories and linked roots', async t => {
  const directory = await temporary(t), existing = path.join(directory, 'existing');
  await fs.mkdir(existing, { mode: 0o700 });
  await fs.writeFile(path.join(existing, 'keep'), 'user work');
  await assert.rejects(prepareSourceRoot(existing));
  assert.equal(await fs.readFile(path.join(existing, 'keep'), 'utf8'), 'user work');
  const root = await prepareSourceRoot(path.join(directory, 'managed'));
  const link = path.join(directory, 'link');
  await fs.symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareSourceRoot(link), { code: 'INVALID_SOURCE_PATH' });
  if (process.platform !== 'win32') {
    await fs.chmod(root, 0o755);
    await assert.rejects(readManagedSource(path.join(root, 'versions', 'missing', 'source')));
    await assert.rejects(prepareSourceRoot(root), { code: 'INVALID_SOURCE_PATH' });
  }
});

test('source argument parsing is explicit and never turns shell metacharacters into commands', () => {
  const directory = path.join(os.tmpdir(), "source 'quoted' ; $(never-run)");
  assert.deepEqual(parseSourceArguments(['--root', directory, '--checkout', directory, '--commit', 'a'.repeat(40), '--profile', directory, '--no-launch']), { root: directory, checkout: directory, commit: 'a'.repeat(40), profile: directory, noLaunch: true });
  assert.throws(() => parseSourceArguments(['--root']), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => parseSourceArguments(['--root', directory, '--root', directory]), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => parseSourceArguments(['--local-product']), { code: 'INVALID_ARGUMENT' });
});

test('child output, execution lifetime and cancellation are bounded', async () => {
  assert.equal(await runSourceCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'literal;$(not-a-command)']), 'literal;$(not-a-command)');
  await assert.rejects(runSourceCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(2048));setInterval(()=>{},1000)'], { maxOutput: 1024 }), { code: 'BUILD_OUTPUT_LIMIT' });
  await assert.rejects(runSourceCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 50 }), { code: 'BUILD_TIMEOUT' });
  const controller = new AbortController();
  const running = runSourceCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  controller.abort(Object.assign(new Error('Cancelled by unit test'), { code: 'CANCELLED' }));
  await assert.rejects(running, { code: 'CANCELLED' });
});

test('build environment drops Node/Electron injection flags and credentials', () => {
  const env = sourceEnvironment();
  for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'NODE_PATH', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'npm_config_prefix', 'GIT_SSH_COMMAND']) assert.equal(env[key], undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

test('real Git ignores a broken user config through the source child environment', async t => {
  const home = await temporary(t);
  await fs.writeFile(path.join(home, '.gitconfig'), '[intentionally invalid user config');
  const output = await runSourceCommand('git', ['config', '--global', '--list'], {
    cwd: home,
    env: { ...sourceEnvironment(), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') },
    timeout: 30000,
  });
  assert.equal(output, '');
});

test('transition receipt rejects foreign targets, replayed versions and traversal', async t => {
  const previous = await fixture(t, '3.11.0');
  const next = await fixture(t, '3.12.0', path.dirname(previous.root));
  const id = 'c'.repeat(32), work = path.join(previous.root, 'transitions', id);
  await fs.mkdir(work, { mode: 0o700 });
  const file = path.join(work, 'journal.json');
  const pointer = receipt => ({ schema: 1, sourceRoot: receipt.sourceRoot, version: receipt.version });
  const journal = { schema: 1, id, root: previous.root, journal: file, pid: process.pid, userData: path.join(previous.root, 'synthetic-profile'), version: next.version, previous: pointer(previous), next: pointer(next), status: 'prepared' };
  await writeSourceJSON(file, journal);
  assert.equal((await readSourceTransition(file)).next.version, '3.12.0');
  await writeSourceJSON(file, { ...journal, next: pointer(previous), version: previous.version });
  await assert.rejects(readSourceTransition(file), /Invalid source transition version/);
  await writeSourceJSON(file, { ...journal, id: '../escape' });
  await assert.rejects(readSourceTransition(file), /Invalid source transition receipt/);
  await writeSourceJSON(file, { ...journal, next: { ...pointer(next), sourceRoot: path.dirname(next.sourceRoot) } });
  await assert.rejects(readSourceTransition(file));
});

test('real Git dirty checks preserve tracked edits and untracked work', async t => {
  const directory = await temporary(t);
  const git = 'git', tools = { git };
  await runSourceCommand(git, ['init', directory]);
  await fs.writeFile(path.join(directory, 'tracked.txt'), 'original');
  await runSourceCommand(git, ['-C', directory, 'add', 'tracked.txt']);
  await runSourceCommand(git, ['-C', directory, '-c', 'user.name=Source Unit Test', '-c', 'user.email=source-test@example.invalid', 'commit', '-m', 'synthetic fixture']);
  await assertCleanSource(directory, tools);
  await fs.writeFile(path.join(directory, 'tracked.txt'), 'local edits');
  await fs.writeFile(path.join(directory, 'untracked.txt'), 'keep this too');
  await assert.rejects(assertCleanSource(directory, tools), { code: 'SOURCE_MODIFIED' });
  assert.equal(await fs.readFile(path.join(directory, 'tracked.txt'), 'utf8'), 'local edits');
  assert.equal(await fs.readFile(path.join(directory, 'untracked.txt'), 'utf8'), 'keep this too');
  await assert.rejects(validateSourceRelease({ version: '3.12.0', tag: 'v3.12.0', commit: 'a'.repeat(40), provenance: 'local-candidate', checkout: directory }, tools), { code: 'SOURCE_MODIFIED' });
});

test('clean recommits still pause replacement when the installed commit no longer matches', async t => {
  const receipt = await fixture(t), git = 'git';
  await runSourceCommand(git, ['init', receipt.sourceRoot]);
  await runSourceCommand(git, ['-C', receipt.sourceRoot, 'add', '.']);
  await runSourceCommand(git, ['-C', receipt.sourceRoot, '-c', 'user.name=Source Unit Test', '-c', 'user.email=source-test@example.invalid', 'commit', '-m', 'synthetic changed commit']);
  await assert.rejects(assertInstalledSource(receipt.sourceRoot, { git }), { code: 'SOURCE_MODIFIED' });
  assert.equal((await readSourceJSON(path.join(path.dirname(receipt.sourceRoot), 'receipt.json'))).commit, receipt.commit);
});

test('bootstrap readiness cannot be confirmed by an arbitrary Node process', async t => {
  const receipt = await fixture(t);
  await writeSourceJSON(path.join(receipt.root, 'current.json'), { schema: 1, sourceRoot: receipt.sourceRoot, version: receipt.version, bootstrapId: 'd'.repeat(32) });
  const controller = createSourceUpdateController({ version: receipt.version, sourceRoot: receipt.sourceRoot, directory: path.join(receipt.root, 'synthetic-profile', 'updates') });
  await assert.rejects(controller.initialize());
  await assert.rejects(fs.lstat(path.join(receipt.root, 'initial-ready.json')), { code: 'ENOENT' });
});

test('cancelled admission releases a late gate token instead of leaking the mutation gate', async () => {
  const { acquireSourceAdmission } = await import('../src/source-updates.mjs');
  const abort = new AbortController();
  let finish, released = 0;
  const pending = acquireSourceAdmission(() => new Promise(resolve => { finish = resolve; }), { automatic: true, signal: abort.signal });
  await Promise.resolve();
  abort.abort(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
  await assert.rejects(pending, { code: 'CANCELLED' });
  finish({ valid: () => true, release: () => released++ });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(released, 1);
  assert.equal(await acquireSourceAdmission(undefined, { automatic: true, signal: new AbortController().signal }), null);
});

test('tool discovery retains stable entrypoints and rediscovers removed or unusable versioned tools', { skip: process.platform === 'win32' || !process.versions.node.startsWith('24.') }, async t => {
  const directory = await temporary(t);
  const oldNode = path.join(directory, 'Cellar', 'node', 'old'), newNode = path.join(directory, 'Cellar', 'node', 'new');
  const oldGit = path.join(directory, 'Cellar', 'git', 'old'), newGit = path.join(directory, 'Cellar', 'git', 'new');
  for (const [prefix, npmVersion] of [[oldNode, '10.0.0'], [newNode, '11.0.0']]) {
    await fs.mkdir(path.join(prefix, 'bin'), { recursive: true });
    await fs.symlink(process.execPath, path.join(prefix, 'bin', 'node'));
    const npm = path.join(prefix, 'lib', 'node_modules', 'npm', 'bin');
    await fs.mkdir(npm, { recursive: true });
    await fs.writeFile(path.join(npm, 'npm-cli.js'), `console.log(${JSON.stringify(npmVersion)});`);
  }
  for (const prefix of [oldGit, newGit]) {
    await fs.mkdir(path.join(prefix, 'bin'), { recursive: true });
    await fs.writeFile(path.join(prefix, 'bin', 'git'), '#!/bin/sh\nprintf "git version 2.49.0\\n"\n', { mode: 0o700 });
  }
  const stableNode = path.join(directory, 'node24'), stableGit = path.join(directory, 'git');
  await fs.symlink(oldNode, stableNode, 'dir');
  await fs.symlink(oldGit, stableGit, 'dir');
  const directories = [path.join(stableNode, 'bin'), path.join(stableGit, 'bin')];
  const first = await discoverSourceTools(undefined, undefined, { directories });
  assert.equal(first.node, path.join(stableNode, 'bin', 'node'));
  assert.equal(first.git, path.join(stableGit, 'bin', 'git'));
  assert.equal(first.npm, path.join(stableNode, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  const legacy = { node: path.join(oldNode, 'bin', 'node'), git: path.join(oldGit, 'bin', 'git'), npm: path.join(oldNode, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js') };
  await fs.unlink(stableNode); await fs.symlink(newNode, stableNode, 'dir');
  await fs.unlink(stableGit); await fs.symlink(newGit, stableGit, 'dir');
  await fs.rm(oldNode, { recursive: true }); await fs.rm(oldGit, { recursive: true });
  const replacement = await discoverSourceTools(legacy, undefined, { directories });
  assert.deepEqual(replacement, first);
  assert.equal((await runSourceCommand(replacement.node, [replacement.npm, '--version'])).trim(), '11.0.0');
  const unusable = path.join(directory, 'unusable');
  await fs.mkdir(unusable);
  await fs.writeFile(path.join(unusable, 'node'), '#!/bin/sh\nprintf "v25.0.0\\n"\n', { mode: 0o700 });
  const recovered = await discoverSourceTools({ ...legacy, node: path.join(unusable, 'node') }, undefined, { directories: [unusable, ...directories] });
  assert.equal(recovered.node, first.node);
});

test('generated stable launcher survives a removed saved Node entrypoint', { skip: process.platform === 'win32' || !process.versions.node.startsWith('24.') }, async t => {
  const directory = await temporary(t), root = path.join(directory, "managed 'quoted'");
  await fs.mkdir(root, { mode: 0o700 });
  // This unit fixture exercises tool selection/argument forwarding only, not app readiness.
  await fs.writeFile(path.join(root, 'launch.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));');
  const removed = path.join(directory, 'removed-keg', 'node');
  await writeSourceLauncher(root, { node: removed });
  const bin = path.join(directory, 'replacement-bin');
  await fs.mkdir(bin);
  await fs.symlink(process.execPath, path.join(bin, 'node'));
  const argument = 'literal; $(not-a-command)';
  const result = await runSourceCommand('/bin/sh', [path.join(root, 'launch'), argument], { env: { ...sourceEnvironment(), PATH: bin } });
  assert.deepEqual(JSON.parse(result), [argument]);
});

test('Windows generated launcher finds replacement Node and preserves literal arguments after saved executable removal', { skip: process.platform !== 'win32' || !process.versions.node.startsWith('24.') }, async t => {
  const directory = await temporary(t), root = path.join(directory, "managed 'quoted'");
  const bin = path.join(directory, 'replacement-bin'), removed = path.join(directory, 'removed-keg', 'node.exe');
  await fs.mkdir(root, { mode: 0o700 });
  await fs.mkdir(bin);
  await fs.mkdir(path.dirname(removed));
  const replacement = path.join(bin, 'node.exe');
  await fs.copyFile(process.execPath, replacement);
  await fs.link(replacement, removed);
  // Only the generated tool-selection wrapper is exercised here; no app/profile
  // is launched and no application startup confirmation is manufactured.
  await fs.writeFile(path.join(root, 'launch.mjs'), 'console.log(JSON.stringify({ executable: process.execPath, args: process.argv.slice(2) }));');
  await writeSourceLauncher(root, { node: removed });
  await fs.unlink(removed);
  const foreignModules = path.join(directory, 'incompatible-module-path');
  for (const name of ['Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Security']) {
    const module = path.join(foreignModules, name);
    await fs.mkdir(module, { recursive: true });
    await fs.writeFile(path.join(module, `${name}.psd1`), "@{ ModuleVersion = '1.0.0'; PowerShellVersion = '99.0'; RootModule = 'unsupported.psm1' }");
    await fs.writeFile(path.join(module, 'unsupported.psm1'), '');
  }
  const args = ['literal; $(not-a-command) & keep', "apostrophe ' and spaces", '--bridge'];
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const output = await runSourceCommand(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(root, 'launch.ps1'), ...args], {
    env: { ...sourceEnvironment(), ProgramFiles: path.join(directory, 'absent-program-files'), PATH: bin, PSModulePath: foreignModules },
    timeout: 30000,
  });
  const launched = JSON.parse(output);
  assert.equal(await fs.realpath(launched.executable), await fs.realpath(replacement));
  assert.deepEqual(launched.args, args);
});

test('existing-root tool repair changes only recognized launchers and tool metadata, preserving source edits and profile', async t => {
  const receipt = await fixture(t);
  const currentFile = path.join(receipt.root, 'current.json');
  await writeSourceJSON(currentFile, { schema: 1, sourceRoot: receipt.sourceRoot, version: receipt.version, userData: path.join(receipt.root, 'selected-profile') });
  const current = await fs.readFile(currentFile, 'utf8');
  await fs.writeFile(path.join(receipt.sourceRoot, 'my-local-edits.txt'), 'do not discard');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const launcher = path.join(receipt.root, process.platform === 'win32' ? 'launch.ps1' : 'launch');
  const legacy = process.platform === 'win32'
    ? `& '${receipt.tools.node.replaceAll("'", "''")}' '${path.join(receipt.root, 'launch.mjs').replaceAll("'", "''")}'\r\n`
    : `#!/bin/sh\nexec ${quote(receipt.tools.node)} ${quote(path.join(receipt.root, 'launch.mjs'))}\n`;
  await fs.writeFile(launcher, legacy, { mode: 0o700 });
  const replacement = { node: process.execPath, git: path.join(receipt.root, 'new-git'), npm: path.join(receipt.root, 'new-npm.js') };
  const result = await repairManagedSourceTools(receipt.root, replacement);
  assert.equal(result.repaired, true);
  assert.equal(await fs.readFile(launcher, 'utf8'), sourceLauncherText(receipt.root, replacement.node));
  assert.equal(await fs.readFile(currentFile, 'utf8'), current);
  assert.equal(await fs.readFile(path.join(receipt.sourceRoot, 'my-local-edits.txt'), 'utf8'), 'do not discard');
  assert.equal((await readManagedSource(receipt.sourceRoot)).commit, receipt.commit);
  assert.deepEqual((await readManagedSource(receipt.sourceRoot)).tools, replacement);
  await fs.appendFile(launcher, '\n# local launcher edit\n');
  const edited = await fs.readFile(launcher, 'utf8');
  await assert.rejects(repairManagedSourceTools(receipt.root, { ...replacement, node: path.join(receipt.root, 'another-node') }), { code: 'SOURCE_LAUNCHER_MODIFIED' });
  assert.equal(await fs.readFile(launcher, 'utf8'), edited);
});

test('source roots reject replaceable ancestors before creation or repair without changing shared permissions', { skip: process.platform === 'win32' }, async t => {
  const directory = await temporary(t), shared = path.join(directory, 'shared');
  await fs.mkdir(shared, { mode: 0o700 });
  const protectedRoot = await prepareSourceRoot(path.join(shared, 'existing'));
  const marker = await fs.readFile(path.join(protectedRoot, 'managed.json'), 'utf8');
  await fs.chmod(shared, 0o777);
  await assert.rejects(prepareSourceRoot(path.join(shared, 'new-parent', 'source')), { code: 'UNSAFE_SOURCE_ANCESTOR' });
  await assert.rejects(fs.lstat(path.join(shared, 'new-parent')), { code: 'ENOENT' });
  await assert.rejects(prepareSourceRoot(protectedRoot), { code: 'UNSAFE_SOURCE_ANCESTOR' });
  await assert.rejects(repairManagedSourceTools(protectedRoot, {}), { code: 'UNSAFE_SOURCE_ANCESTOR' });
  assert.equal((await fs.stat(shared)).mode & 0o7777, 0o777);
  assert.equal(await fs.readFile(path.join(protectedRoot, 'managed.json'), 'utf8'), marker);
});

test('trusted sticky temporary ancestors preserve owned child paths and remain accepted', { skip: process.platform === 'win32' }, async t => {
  const directory = await temporary(t), sticky = path.join(directory, 'sticky');
  await fs.mkdir(sticky, { mode: 0o700 });
  await fs.chmod(sticky, 0o1777);
  const root = await prepareSourceRoot(path.join(sticky, 'private-parent', 'managed'));
  await assertSourceAncestors(root, { privateLeaf: true });
  assert.equal((await fs.stat(sticky)).mode & 0o7777, 0o1777);
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
  assert.equal((await readSourceJSON(path.join(root, 'managed.json'))).root, root);
});

test('macOS extended delete-child ACLs cannot bypass private POSIX mode bits', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await temporary(t), parent = path.join(directory, 'acl-parent');
  await fs.mkdir(parent, { mode: 0o700 });
  await runSourceCommand('/bin/chmod', ['+a', 'everyone allow delete_child', parent]);
  try {
    assert.equal((await fs.stat(parent)).mode & 0o777, 0o700);
    await assert.rejects(prepareSourceRoot(path.join(parent, 'managed')), { code: 'UNSAFE_SOURCE_ANCESTOR' });
    await assert.rejects(fs.lstat(path.join(parent, 'managed')), { code: 'ENOENT' });
  } finally { await runSourceCommand('/bin/chmod', ['-a', 'everyone allow delete_child', parent]); }
});

async function windowsFixtureRule(target, rights, { remove = false } = {}) {
  const encoded = Buffer.from(target, 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop';Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Security','Microsoft.PowerShell.Security.psd1')) -Force -ErrorAction Stop;$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$a=Get-Acl -LiteralPath $p;$r=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[Security.AccessControl.FileSystemRights]::${rights},[Security.AccessControl.AccessControlType]::Allow);$a.${remove ? 'RemoveAccessRule' : 'AddAccessRule'}($r);Set-Acl -LiteralPath $p -AclObject $a`;
  await runSourceCommand(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 30000 });
}

test('Windows ancestor creation alone is safe but DELETE_CHILD plus creation rejects even a private leaf', { skip: process.platform !== 'win32' }, async t => {
  const directory = await temporary(t), parent = path.join(directory, 'acl-parent');
  await fs.mkdir(parent);
  await windowsFixtureRule(parent, 'CreateDirectories');
  const root = await prepareSourceRoot(path.join(parent, 'managed'));
  assertWindowsSourcePath(root, { privateLeaf: true });
  await windowsFixtureRule(parent, 'DeleteSubdirectoriesAndFiles');
  await assert.rejects(prepareSourceRoot(root), { code: 'UNSAFE_SOURCE_ANCESTOR' });
  await assert.rejects(prepareSourceRoot(path.join(parent, 'missing', 'managed')), { code: 'UNSAFE_SOURCE_ANCESTOR' });
  await assert.rejects(fs.lstat(path.join(parent, 'missing')), { code: 'ENOENT' });
  await windowsFixtureRule(parent, 'DeleteSubdirectoriesAndFiles', { remove: true });
  assertWindowsSourcePath(root, { privateLeaf: true });
});

test('Windows launcher checks private root and exact module DACL before executing checkout code', { skip: process.platform !== 'win32' }, async t => {
  const receipt = await fixture(t), marker = path.join(receipt.root, 'import-was-executed');
  const runtime = path.join(receipt.sourceRoot, 'scripts', 'install-source.mjs');
  await fs.mkdir(path.dirname(runtime));
  // A synthetic import sentinel, never an app-ready confirmation or real profile.
  await fs.writeFile(runtime, `import { writeFileSync } from 'node:fs';writeFileSync(${JSON.stringify(marker)}, 'unexpected import');throw new Error('sentinel imported');`);
  const launcher = path.join(receipt.root, 'launch.mjs');
  await fs.copyFile(new URL('../src/source-launcher.mjs', import.meta.url), launcher);
  assertWindowsSourcePath(runtime, { privateLeaf: true, file: true });
  await windowsFixtureRule(receipt.root, 'CreateFiles');
  await assert.rejects(runSourceCommand(process.execPath, [launcher]), { code: 'SOURCE_COMMAND_FAILED' });
  await assert.rejects(fs.lstat(marker), { code: 'ENOENT' });
  await windowsFixtureRule(receipt.root, 'CreateFiles', { remove: true });
  await windowsFixtureRule(runtime, 'WriteData');
  assert.throws(() => assertWindowsSourcePath(runtime, { privateLeaf: true, file: true }), { code: 'UNSAFE_SOURCE_ANCESTOR' });
  await assert.rejects(runSourceCommand(process.execPath, [launcher]), { code: 'SOURCE_COMMAND_FAILED' });
  await assert.rejects(fs.lstat(marker), { code: 'ENOENT' });
});

test('lazy Electron installer runs explicitly with selected Node architecture, private cache and bundled checksums', async t => {
  const directory = await temporary(t), sourceRoot = path.join(directory, "source 'quoted' $literal");
  const electron = path.join(sourceRoot, 'node_modules', 'electron');
  await fs.mkdir(electron, { recursive: true });
  await fs.writeFile(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', version: '45.1.0', scripts: null }));
  const checksums = '{"synthetic-unit-fixture.zip":"do-not-rewrite"}';
  await fs.writeFile(path.join(electron, 'checksums.json'), checksums);
  // This fixture reports invocation inputs only; it never creates a binary or
  // writes app readiness. Native source CI exercises the real pinned installer.
  await fs.writeFile(path.join(electron, 'install.js'), `
    const fs = require('node:fs'), path = require('node:path');
    console.log(JSON.stringify({
      arch: process.arch, platform: process.platform,
      npmArch: process.env.npm_config_arch, installArch: process.env.ELECTRON_INSTALL_ARCH,
      npmPlatform: process.env.npm_config_platform, installPlatform: process.env.ELECTRON_INSTALL_PLATFORM,
      cache: process.env.electron_config_cache, legacyCache: process.env.ELECTRON_CACHE,
      remoteChecksums: process.env.electron_use_remote_checksums || process.env.npm_config_electron_use_remote_checksums,
      overrideDist: process.env.ELECTRON_OVERRIDE_DIST_PATH,
      checksums: fs.readFileSync(path.join(__dirname, 'checksums.json'), 'utf8')
    }));
  `);
  const cache = path.join(directory, 'private-electron-cache');
  const result = JSON.parse(await installSourceElectron({ sourceRoot, tools: { node: process.execPath, git: process.execPath }, cache, version: '45.1.0' }));
  assert.equal(result.npmArch, result.arch);
  assert.equal(result.installArch, result.arch);
  assert.equal(result.npmPlatform, result.platform);
  assert.equal(result.installPlatform, result.platform);
  assert.equal(result.cache, cache);
  assert.equal(result.legacyCache, cache);
  assert.equal(result.remoteChecksums, undefined);
  assert.equal(result.overrideDist, undefined);
  assert.equal(result.checksums, checksums);
  assert.equal(await fs.readFile(path.join(electron, 'checksums.json'), 'utf8'), checksums);
});

test('explicit runtime installation refuses a mismatched package or absent bundled checksums', async t => {
  const sourceRoot = await temporary(t), electron = path.join(sourceRoot, 'node_modules', 'electron');
  await fs.mkdir(electron, { recursive: true });
  await fs.writeFile(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', version: '45.1.0', scripts: null }));
  await fs.writeFile(path.join(electron, 'install.js'), 'throw new Error(\"installer must not run\");');
  const options = { sourceRoot, tools: { node: process.execPath, git: process.execPath }, cache: path.join(sourceRoot, 'cache') };
  await assert.rejects(installSourceElectron({ ...options, version: '45.0.0' }), { code: 'INVALID_SOURCE_BUILD' });
  await assert.rejects(installSourceElectron({ ...options, version: '45.1.0' }), { code: 'ENOENT' });
});
