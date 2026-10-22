import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, stat, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApplicationLauncher } from '../src/application-launcher.mjs';

const preparationId = '019a057a-9da1-7c39-8db7-173951f9eb20';
const anotherId = '019a057a-9da1-7c39-8db7-173951f9eb21';

async function harness(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'recruiters-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'Companion & tools #1 + résumé');
  const command = path.join(root, 'MCP "launcher" & +.command');
  await writeFile(command, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const opened = [], checked = [];
  const launcher = createApplicationLauncher({ directory, command,
    openExternal: async url => { opened.push(url); },
    hostAvailable: async host => { checked.push(host); return true; }, ...overrides });
  return { launcher, directory, command, root, opened, checked, workspace: path.join(directory, 'application-workspace') };
}

for (const host of ['claude', 'codex']) test(`${host} opens only an encoded, request-specific composer with scoped Companion tools`, async t => {
  const { launcher, opened, workspace, command, directory } = await harness(t);
  assert.deepEqual(await launcher.open({ host, preparationId }), { opened: true, host, requiresSend: true });
  assert.equal(opened.length, 1);
  const link = new URL(opened[0]);
  assert.equal(link.protocol, host === 'claude' ? 'claude:' : 'codex:');
  assert.equal(link.hostname, host === 'claude' ? 'code' : 'threads');
  assert.equal(link.pathname, '/new');
  assert.equal(link.searchParams.get(host === 'claude' ? 'folder' : 'path'), workspace);
  const prompt = link.searchParams.get(host === 'claude' ? 'q' : 'prompt');
  assert.match(prompt, /career_application_preparation_read/);
  assert.match(prompt, /using only the recruiters-rip-applications MCP connection for this workspace/);
  assert.match(prompt, /do not use another Companion connection/);
  assert.ok(prompt.includes(`{"preparationId":"${preparationId}"}`));
  assert.equal(prompt.includes(command), false);
  assert.equal(prompt.includes(directory), false);
  assert.equal(link.hash, '');
  assert.deepEqual([...link.searchParams.keys()].sort(), host === 'claude' ? ['folder', 'q'] : ['mode', 'path', 'prompt']);
  assert.equal(link.searchParams.get('mode'), host === 'codex' ? 'codex' : null);
  if (host === 'claude') {
    const config = JSON.parse(await readFile(path.join(workspace, '.mcp.json'), 'utf8'));
    assert.deepEqual(config, { mcpServers: { 'recruiters-rip-applications': { command, args: [] } } });
    assert.equal((await stat(path.join(workspace, '.mcp.json'))).mode & 0o777, 0o600);
  } else {
    const config = await readFile(path.join(workspace, '.codex', 'config.toml'), 'utf8');
    assert.equal(config, `[mcp_servers.recruiters-rip-applications]\ncommand = ${JSON.stringify(command)}\nargs = []\n`);
    assert.equal((await stat(path.join(workspace, '.codex', 'config.toml'))).mode & 0o777, 0o600);
  }
  assert.equal((await stat(workspace)).mode & 0o777, 0o700);
  await launcher.open({ host, preparationId: anotherId });
  assert.equal(opened.length, 2);
  const secondPrompt = new URL(opened[1]).searchParams.get(host === 'claude' ? 'q' : 'prompt');
  assert.equal(secondPrompt, prompt.replace(preparationId, anotherId));
});

test('availability probes hosts without opening, configuring, or claiming inference', async t => {
  const { launcher, opened, directory, checked } = await harness(t);
  assert.deepEqual(await launcher.available(), { claude: true, codex: true });
  assert.deepEqual(checked, ['claude', 'codex']);
  assert.deepEqual(opened, []);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('invalid host, UUID and extra private context are rejected before native access', async t => {
  const { launcher, opened, checked, directory } = await harness(t);
  for (const input of [undefined, null, [], {}, { host: 'browser', preparationId },
    { host: 'claude', preparationId: '../request' }, { host: 'claude', preparationId: 12 },
    { host: 'codex', preparationId: `${preparationId}&prompt=send` },
    { host: 'codex', preparationId: `${preparationId}\n` },
    { host: 'codex', preparationId: '00000000-0000-0000-0000-000000000000' },
    { host: 'claude', preparationId, prompt: 'private CV' },
    { host: 'codex', preparationId, command: '/bin/sh' },
    { host: 'claude', preparationId, directory: '/Users/person' }]) {
    await assert.rejects(launcher.open(input), { code: 'INVALID_INPUT' });
  }
  assert.deepEqual(opened, []);
  assert.deepEqual(checked, []);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('launcher configuration requires absolute local paths and native dependencies', () => {
  const options = { directory: '/tmp/application-test', command: '/tmp/mcp-test', openExternal: async () => {} };
  for (const change of [{ directory: '../outside' }, { command: 'mcp --send' }, { command: '/tmp/mcp\nextra' },
    { directory: '/tmp/hidden\0dir' }, { openExternal: undefined }, { hostAvailable: null }])
    assert.throws(() => createApplicationLauncher({ ...options, ...change }), { code: 'INVALID_INPUT' });
});

test('missing hosts fail actionably without creating configs or opening another host', async t => {
  const { launcher, opened, directory } = await harness(t, { hostAvailable: async host => host === 'claude' });
  assert.deepEqual(await launcher.available(), { claude: true, codex: false });
  await assert.rejects(launcher.open({ host: 'codex', preparationId }), error =>
    error.code === 'HOST_UNAVAILABLE' && /Install ChatGPT desktop/.test(error.message));
  assert.deepEqual(opened, []);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('a missing MCP executable cannot produce an opened result', async t => {
  const { launcher, command, opened } = await harness(t);
  await rm(command);
  await assert.rejects(launcher.open({ host: 'claude', preparationId }), { code: 'HOST_SETUP_REQUIRED' });
  assert.deepEqual(opened, []);
});

test('native link rejection does not return opened or send a fallback prompt', async t => {
  let attempts = 0;
  const { launcher } = await harness(t, { openExternal: async () => { attempts++; throw new Error('private OS detail'); } });
  await assert.rejects(launcher.open({ host: 'codex', preparationId }), error =>
    error.code === 'HOST_LAUNCH_FAILED' && /no prompt was sent/.test(error.message) && !error.message.includes('private OS detail'));
  assert.equal(attempts, 1);
});

test('scoped config never follows file symlinks or modifies unrelated host settings', async t => {
  const { launcher, workspace, root } = await harness(t);
  const userConfig = path.join(root, 'unrelated-config.json');
  await writeFile(userConfig, '{"keep":"user settings"}\n');
  await mkdir(workspace, { recursive: true });
  await symlink(userConfig, path.join(workspace, '.mcp.json'));
  await launcher.open({ host: 'claude', preparationId });
  assert.equal(await readFile(userConfig, 'utf8'), '{"keep":"user settings"}\n');
  assert.deepEqual(await readdir(workspace), ['.mcp.json']);
});

test('symlinked workspace and Codex config directories fail before opening', async t => {
  for (const target of ['workspace', 'codex']) {
    const { launcher, workspace, directory, root, opened } = await harness(t);
    const outside = path.join(root, 'unrelated');
    await mkdir(outside);
    await mkdir(directory, { recursive: true });
    if (target === 'workspace') await symlink(outside, workspace);
    else { await mkdir(workspace); await symlink(outside, path.join(workspace, '.codex')); }
    await assert.rejects(launcher.open({ host: 'codex', preparationId }), { code: 'HOST_SETUP_FAILED' });
    assert.deepEqual(opened, []);
    assert.deepEqual(await readdir(outside), []);
  }
});
