import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createVault } from '../src/vault.mjs';
import { startMcpBroker } from '../src/mcp/broker.mjs';
import { createMcpServer } from '../src/mcp/server.mjs';
import { createScopedAccess } from '../src/mcp/scope.mjs';
import { createIntroductionTools } from '../src/mcp/introduction-tools.mjs';
import { createJobTools } from '../src/mcp/job-tools.mjs';
import { createApplicationTools } from '../src/mcp/application-tools.mjs';
import { createApplicationWorkflow, createApplicationPreparationTools } from '../src/application-workflow.mjs';
import { endpoint, launcherScript, mcpCommand, protectPrivatePath } from '../src/platform-runtime.cjs';
import { mcpInvocation } from '../src/host-setup.mjs';

// Real generated launcher -> local-runner -> authenticated broker -> MCP tools.
// Only the platform response is stubbed; all local records are temporary synthetic data.
test('local launcher handles LI.FI capture/application and all GitHub endpoint pairs without catalogue discovery', { timeout: 30000 }, async t => {
  const userData = await realpath(await mkdtemp(path.join(tmpdir(), 'rr-intro-launcher-')));
  const directory = path.join(userData, 'local-device'), store = createVault(directory);
  await store.open();
  await store.update(state => {
    state.career.profile.name = 'Synthetic Candidate';
    state.career.sources.cv = { purpose: 'cv', text: 'Synthetic Candidate built reliable services.', archived: false };
    state.career.publicationRange = 'today';
    state.career.matching = { jobs: {}, scores: {} };
  });
  let linkedSource = { login: 'synthetic-candidate', kind: 'user' };
  const calls = [], target = { login: 'lifinance', kind: 'organization' };
  const platform = async (operation, args) => {
    assert.equal(operation, 'intro_paths', 'No catalogue, job_read or discovery request is allowed');
    calls.push(structuredClone({ operation, args }));
    const source = args.source ?? linkedSource;
    return { source, available: Boolean(source), asOf: source ? '2026-11-05' : null, inferred: true,
      coverage: { source: source ? 'indexed' : 'unavailable', maxHops: 2 },
      ...(source ? {} : { reason: 'github_required' }),
      targets: args.targets.map(value => ({ ...value, status: source ? 'no_paths' : 'unavailable', paths: [] })) };
  };
  const workflow = createApplicationWorkflow({ store, assertAvailable() {}, validateExport: async () => true });
  const broker = await startMcpBroker({ directory, createServer() {
    const scoped = createScopedAccess(store, { assertAvailable() {}, epoch: () => 0 });
    return createMcpServer({ assertAvailable: scoped.assertAvailable, readResource: () => assert.fail('No document access'), listResources: () => [], tools: [
      ...createJobTools({ store: scoped.store }),
      ...createApplicationTools({ store: scoped.store, platform }),
      ...createApplicationPreparationTools({ workflow, openInBrowser: () => assert.fail('No browser actions') }),
      ...createIntroductionTools({ store: scoped.store, platform, openGithub: () => assert.fail('No account UI') }),
    ] });
  } });
  const command = mcpCommand(directory);
  await writeFile(command, launcherScript({ executable: process.execPath,
    script: fileURLToPath(new URL('../src/mcp/local-runner.cjs', import.meta.url)),
    args: ['--local-product', `--directory=${directory}`] }), { mode: 0o700 });
  protectPrivatePath(command, { mode: 0o700 });
  const launch = path.join(directory, 'mcp-launch.json');
  await writeFile(launch, JSON.stringify({ executable: process.execPath, args: [`--user-data-dir=${userData}`], localOnly: true, directory, userData }), { mode: 0o600 });
  protectPrivatePath(launch);
  const env = { ...process.env, HOME: userData, USERPROFILE: userData, APPDATA: path.join(userData, 'Roaming'), XDG_CONFIG_HOME: path.join(userData, 'config') };
  const invocation = mcpInvocation(command, { env });
  const client = new Client({ name: 'synthetic-introduction-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({ ...invocation, env: { ...env, ...invocation.env }, stderr: 'pipe' });
  t.after(async () => {
    await client.close();
    broker.close();
    const address = endpoint(directory, 'mcp');
    if (process.platform !== 'win32' && path.dirname(address) !== directory) await rm(path.dirname(address), { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  });
  await client.connect(transport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    return JSON.parse(result.content[0].text);
  };
  const mutation = extra => ({ requestId: randomUUID(), revision: store.get().career.revision, ...extra });
  // Company identity comes from the saved official GitHub URL, not from the LI.FI display name.
  const job = { title: 'Synthetic Platform Engineer', company: 'LI.FI', complete: true,
    url: 'https://careers.example.test/lifi/synthetic-engineer',
    description: 'Synthetic full advert: build reliable services. Company GitHub: https://github.com/lifinance/' };
  const imported = await call('career_job_import', mutation({ sourceUrl: job.url, jobs: [job] }));
  const jobId = imported.jobs[0].id;
  assert.ok(jobId.startsWith('local:'));
  const application = await call('career_application_create', mutation({ jobId }));
  const context = await call('career_application_context', { applicationId: application.applicationId });
  assert.equal(context.job.company, 'LI.FI');
  assert.equal(context.job.id, jobId);
  const githubUrl = context.job.description.match(/https:\/\/github\.com\/[a-zA-Z0-9-]+\//)[0];
  assert.deepEqual({ login: new URL(githubUrl).pathname.split('/')[1], kind: 'organization' }, target);
  const result = await call('career_intro_paths', { targets: [target] });
  assert.deepEqual(result.source, linkedSource);
  assert.deepEqual(result.targets, [{ ...target, status: 'no_paths', paths: [] }]);
  assert.deepEqual(calls, [{ operation: 'intro_paths', args: { targets: [target] } }]);
  assert.equal(store.get().career.publicationRange, 'today');
  assert.deepEqual(store.get().career.matching.jobs, {});

  // Preparation still exposes the same complete local application for automatic intro work.
  const resolved = await workflow.resolve({ requestId: randomUUID(), page: { url: job.url, title: job.title, fields: [], actions: [] },
    jobs: [], context: { original: { url: job.url, title: job.title, text: job.description, complete: true } } });
  assert.equal(resolved.applicationId, application.applicationId);

  linkedSource = null;
  const missing = await call('career_intro_paths', { targets: [target] });
  assert.equal(missing.source, null);
  assert.equal(missing.reason, 'github_required');
  assert.equal(missing.available, false);
  assert.equal(missing.targets[0].status, 'unavailable');
  for (const sourceKind of ['user', 'organization']) for (const targetKind of ['user', 'organization']) {
    const source = { login: 'Source-Account', kind: sourceKind }, selected = { login: 'Target-Account', kind: targetKind };
    const explicit = await call('career_intro_paths', { source, targets: [selected, { ...selected, login: 'target-account' }] });
    assert.deepEqual(explicit.source, { ...source, login: 'source-account' });
    assert.deepEqual(explicit.targets, [{ login: 'target-account', kind: targetKind, status: 'no_paths', paths: [] }]);
    assert.equal(explicit.available, true);
    assert.equal(Object.hasOwn(explicit, 'reason'), false);
    assert.deepEqual(calls.at(-1).args, { source: { login: 'source-account', kind: sourceKind }, targets: [{ login: 'target-account', kind: targetKind }] });
  }
  const beforeInvalid = calls.length;
  for (const args of [{ jobIds: [jobId] }, { targets: [{ login: 'LI.FI', kind: 'organization' }] },
    { targets: [target], source: null }, { targets: [{ ...target, kind: 'company' }] }]) {
    const rejected = await client.callTool({ name: 'career_intro_paths', arguments: args });
    assert.equal(rejected.isError, true);
    assert.equal(JSON.parse(rejected.content[0].text).error.code, 'INVALID_INPUT');
  }
  assert.equal(calls.length, beforeInvalid);
  assert.ok(calls.every(({ args }) => !Object.hasOwn(args, 'jobIds') && !Object.hasOwn(args, 'cv')));
});
