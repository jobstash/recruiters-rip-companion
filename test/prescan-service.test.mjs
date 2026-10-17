import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { createCareerState, CareerError } from '../src/mcp/state.mjs';
import { ASSESSMENT_POLICY_ID, deriveDecision } from '../src/mcp/matching-contract.mjs';
import { decisionProviders } from '../src/prescan/providers.mjs';
import { createScopedAccess } from '../src/mcp/scope.mjs';
import { createPrescanController } from '../src/prescan/service.mjs';
import { createPrescanTools } from '../src/mcp/prescan-tools.mjs';

const publishedAt = new Date(Date.now() - 86400000).toISOString();
const job = index => ({ id: `node:${index}`, title: `Role ${index}`, company: 'Synthetic company', publishedAt,
  applyUrl: 'https://employer.example/jobs', salary: { minimum: 80000, maximum: 100000, currency: 'EUR', period: 'year' },
  location: 'Dublin, Ireland', city: 'Dublin', workMode: 'hybrid' });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const assessment = () => ({ status: 'scored', provider: 'openai', model: 'gpt-6-luna', priority: 75, direction: 'aligned',
  constraints: 'uncertain', eligibility: 'aligned', dimensions: { direction: 75, capability: 75, scope: 75, preferences: 75 },
  confidence: 0.8, answers: [], inputTokens: 17 });

// Only tests inject this synthetic provider. Production uses the fixed OpenAI adapter registry.
function fixture({ count = 3, assess = async () => assessment(), authorize = async () => true, batch, catalogueWait } = {}) {
  const career = createCareerState();
  Object.assign(career.profile, { headline: 'Software engineer', location: 'Dublin', name: 'PRIVATE NAME',
    email: 'private@example.test', phone: '+353123456789', links: ['https://private.example'],
    preferences: { willingToRelocate: false, notes: 'I want hands-on product engineering.', salaryMinimum: 75000, salaryCurrency: 'EUR', salaryPeriod: 'year' } });
  career.sources.cv = { purpose: 'cv', text: 'Built reporting tools for local businesses.', originalBase64: 'PRIVATE PDF', archived: false };
  career.facts.work = { kind: 'capability', subject: 'Reporting', answer: 'Built it', detail: 'Used SQL and JavaScript.' };
  let state = { career, deviceId: 'synthetic-device', prescanCredentialVersion: 1,
    prescanCredentials: { openai: { apiKey: 'sk-synthetic-only-never-a-real-key' } } };
  let queue = Promise.resolve(), locked = false, epoch = 0, concurrent = 0, maxConcurrent = 0;
  const listeners = new Set(), apiCalls = [], platformCalls = [], authorizations = [], catalogue = Array.from({ length: count }, (_, i) => job(i));
  const changed = () => { for (const listener of [...listeners]) listener(); };
  const assertAvailable = () => { if (locked) throw new CareerError('LOCAL_LOCKED', 'Fixture locked'); };
  const store = {
    get() { assertAvailable(); return structuredClone(state); },
    update(change) {
      const pending = queue.then(async () => {
        assertAvailable(); const next = structuredClone(state); await change(next); assertAvailable(); state = next;
      });
      queue = pending.catch(() => {});
      return pending;
    },
  };
  const credentials = {
    publicState() { const saved = store.get(); return { provider: 'openai', model: 'gpt-6-luna',
      configured: Boolean(saved.prescanCredentials?.openai), credentialVersion: saved.prescanCredentialVersion, inputUsdPerMillion: 0.1 }; },
    read(provider) {
      assert.equal(provider, 'openai'); const saved = store.get();
      if (!saved.prescanCredentials?.openai) throw new CareerError('PRESCAN_KEY_REQUIRED', 'Fixture key missing');
      return { apiKey: saved.prescanCredentials.openai.apiKey, credentialVersion: saved.prescanCredentialVersion };
    },
  };
  const providers = { openai: { id: 'openai', label: 'OpenAI Decisions', model: 'gpt-6-luna', policyId: decisionProviders.openai.policyId, inputUsdPerMillion: 0.1,
    maxInputBytes: 240000,
    async assess(input) {
      apiCalls.push(input); concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); changed();
      try { return await assess(input, apiCalls.length); } finally { concurrent--; changed(); }
    } } };
  const platform = async (operation, args) => {
    platformCalls.push({ operation, args: structuredClone(args) }); changed();
    if (operation === 'matching_catalogue') {
      if (catalogueWait) await catalogueWait;
      return { jobs: structuredClone(catalogue), total: catalogue.length };
    }
    assert.equal(operation, 'matching_jobs');
    if (batch) return batch(args);
    return { jobs: args.ids.map(id => ({ ...catalogue.find(row => row.id === id), ad: 'Full original advertisement\n'.repeat(200),
      company: { name: 'Synthetic company', stage: 'Established', graph: { unrelated: 'RAW GRAPH' } },
      locationEvidence: ['Work from Dublin office two days weekly'], rawGraph: { unrelated: 'RAW GRAPH' } })), remainingIds: [], unavailableIds: [] };
  };
  const controller = createPrescanController({ store, credentials, providers, onChange: changed,
    makeScope: () => ({ ...createScopedAccess(store, { assertAvailable, epoch: () => epoch }), platform }),
    authorize: async input => { authorizations.push(input); changed(); return authorize(input); } });
  const waitFor = predicate => new Promise((resolve, reject) => {
    const check = () => {
      try { const result = predicate(); if (result) { clearTimeout(timer); listeners.delete(check); resolve(result); } }
      catch (error) { clearTimeout(timer); listeners.delete(check); reject(error); }
    };
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error('Synthetic pre-scan condition did not settle')); }, 3000);
    listeners.add(check); check();
  });
  return { controller, store, credentials, catalogue, apiCalls, platformCalls, authorizations, waitFor,
    snapshot: () => structuredClone(state), setLocked(value) { locked = value; }, advanceEpoch() { epoch++; },
    get maxConcurrent() { return maxConcurrent; } };
}
const terminal = f => f.waitFor(() => ['completed', 'failed', 'cancelled', 'interrupted', 'stale'].includes(f.controller.status().status));

test('construction and local readers never authorize, fetch or infer; constructor also works while locked', () => {
  const unavailable = () => { throw new Error('Constructor must not read vault'); };
  createPrescanController({ store: { get: unavailable }, makeScope: unavailable,
    credentials: { publicState: unavailable }, authorize: unavailable });
  const f = fixture();
  assert.equal(f.controller.status().status, 'idle');
  assert.deepEqual(f.controller.results().items, []);
  assert.deepEqual(f.apiCalls, []); assert.deepEqual(f.platformCalls, []); assert.deepEqual(f.authorizations, []);
});

test('native authorization reserves single-flight before awaiting confirmation and before any network call', async () => {
  const approval = deferred(), response = deferred();
  const f = fixture({ authorize: () => approval.promise, assess: async () => { await response.promise; return assessment(); } });
  const first = f.controller.start({ limit: 2 });
  await f.waitFor(() => f.authorizations.length === 1);
  const concurrent = await f.controller.start({ limit: 2000, refresh: true });
  assert.equal(concurrent.status, 'running');
  assert.equal(f.authorizations.length, 1); assert.equal(f.platformCalls.length, 0); assert.equal(f.apiCalls.length, 0);
  assert.deepEqual(Object.keys(f.authorizations[0]).sort(), ['inputUsdPerMillion', 'label', 'limit', 'model', 'provider']);
  approval.resolve(true); const started = await first;
  await f.waitFor(() => f.apiCalls.length === 1);
  assert.equal((await f.controller.start()).runId, started.runId);
  assert.equal(f.authorizations.length, 1);
  response.resolve(); await terminal(f);
  assert.equal(f.apiCalls.length, 2);
});

test('declined confirmation, missing credentials and invalid input make no network requests', async () => {
  const f = fixture({ authorize: async () => false });
  await assert.rejects(f.controller.start(), { code: 'PRESCAN_NOT_AUTHORIZED' });
  assert.equal(f.controller.status().status, 'idle');
  assert.equal(f.platformCalls.length, 0); assert.equal(f.apiCalls.length, 0);
  await f.store.update(state => { delete state.prescanCredentials; state.prescanCredentialVersion++; });
  await assert.rejects(f.controller.start(), { code: 'PRESCAN_KEY_REQUIRED' });
  for (const args of [null, [], { limit: 0 }, { limit: 2001 }, { limit: 1.5 }, { refresh: 'yes' }, { apiKey: 'never' }, { provider: 'fake' }])
    await assert.rejects(f.controller.start(args), { code: 'INVALID_INPUT' });
  assert.equal(f.authorizations.length, 1);
});

test('finite capped runs have at most eight active calls, preserve full ads/context and never save final scores', async () => {
  const response = deferred();
  const f = fixture({ count: 100, assess: async () => { await response.promise; return assessment(); } });
  const assessed = { id: 'node:99', status: 'assessed', reason: 'Subscription-authored assessment.', relocation: 'not_required',
    requirements: [{ requirement: 'Reporting tools', importance: 'essential', evidence: 'demonstrated', cvQuote: 'Built reporting tools' }],
    gates: { direction: 'pass', constraints: 'pass', eligibility: 'pass' },
    dimensions: { direction: 90, capability: 85, scope: 80, preferences: 75 } };
  const finalScore = { ...assessed, ...deriveDecision(assessed), profileVersion: '0:0', policyId: ASSESSMENT_POLICY_ID,
    scoredAt: '2026-10-16T12:00:00.000Z', host: null };
  const archived = { ...finalScore, id: 'node:archived' };
  await f.store.update(state => { state.career.matching = { jobs: { 'node:archived': { ...job('archived'), publishedAt: '2020-01-01T00:00:00Z' } },
    scores: { 'node:99': finalScore, 'node:archived': archived } }; });
  const scoresBefore = f.store.get().career.matching.scores;
  await f.controller.start({ limit: 81 });
  await f.waitFor(() => f.apiCalls.length === 8);
  assert.equal(f.maxConcurrent, 8);
  response.resolve(); await terminal(f);
  const summary = f.controller.status();
  assert.equal(summary.status, 'completed'); assert.equal(summary.selected, 81); assert.equal(summary.processed, 81);
  assert.equal(summary.requests, 81); assert.equal(summary.inputTokens, 81 * 17); assert.equal(summary.totalCatalogue, 100);
  assert.equal(summary.estimatedCostUsd, summary.inputTokens * 0.1 / 1_000_000);
  assert.match(summary.priceNote, /not a guaranteed invoice/);
  assert.equal(f.apiCalls.length, 81); assert.equal(new Set(f.apiCalls.map(call => call.job.id)).size, 81);
  assert.equal(f.maxConcurrent <= 8, true);
  assert.equal(f.platformCalls.filter(call => call.operation === 'matching_jobs').every(call => call.args.ids.length <= 10), true);
  const sent = f.apiCalls[0];
  assert.equal(sent.job.ad, 'Full original advertisement\n'.repeat(200));
  assert.deepEqual(sent.job.locationEvidence, ['Work from Dublin office two days weekly']);
  assert.equal(sent.job.company.stage, 'Established'); assert.equal(sent.job.rawGraph, undefined); assert.equal(sent.job.company.graph, undefined);
  assert.equal(sent.candidate.cv, 'Built reporting tools for local businesses.');
  assert.equal(sent.candidate.preferences.notes, 'I want hands-on product engineering.');
  assert.equal(sent.candidate.facts[0].detail, 'Used SQL and JavaScript.');
  assert.equal(sent.candidate.name, undefined); assert.equal(sent.candidate.email, undefined);
  assert.deepEqual(f.store.get().career.matching.scores, scoresBefore);
  const saved = JSON.stringify(f.store.get().career.prescan);
  for (const secret of ['sk-synthetic', 'Full original advertisement', 'Built reporting tools', 'PRIVATE NAME', 'RAW GRAPH'])
    assert.equal(saved.includes(secret), false);
});

test('partial batches requeue remaining IDs finitely, while missing ads and no-progress batches remain unresolved', async () => {
  let batches = 0;
  const f = fixture({ count: 5, batch: ({ ids }) => {
    batches++;
    if (batches === 1) return { jobs: [{ ...job(0), ad: 'Original ad' }], remainingIds: ids.slice(2), unavailableIds: [ids[1]] };
    if (batches === 2) return { jobs: [{ ...job(2), ad: '' }], remainingIds: ids.slice(1), unavailableIds: [] };
    return { jobs: [], remainingIds: ids, unavailableIds: [] };
  } });
  await f.controller.start(); await terminal(f);
  assert.equal(batches, 3); assert.equal(f.apiCalls.length, 1);
  const summary = f.controller.status();
  assert.equal(summary.status, 'completed'); assert.equal(summary.processed, 5); assert.equal(summary.scored, 1); assert.equal(summary.unavailable, 4);
  assert.equal(f.controller.results().total, 5);
  assert.equal(Object.keys(f.store.get().career.matching.scores).length, 0);
});

test('oversize and refusal are explicit non-scored outcomes without final-score skips or retries', async () => {
  const f = fixture({ count: 2, assess: async input => {
    if (input.job.id === 'node:0') throw new CareerError('PRESCAN_INPUT_TOO_LARGE', 'Raw oversized private payload must not escape');
    return { ...assessment(), status: 'refused', priority: null, direction: null, constraints: null, eligibility: null,
      dimensions: null, confidence: null, answers: [{ type: 'refusal', name: 'direction' }] };
  } });
  await f.controller.start(); await terminal(f);
  assert.equal(f.apiCalls.length, 2); assert.equal(f.controller.status().requests, 1);
  const rows = f.controller.results().items;
  assert.deepEqual(new Set(rows.map(row => row.status)), new Set(['oversize', 'refused']));
  assert.equal(rows.every(row => row.priority === null), true);
  assert.equal(JSON.stringify(rows).includes('private payload'), false);
  assert.equal(Object.keys(f.store.get().career.matching.scores).length, 0);
});

test('partial successes are visible immediately; provider failure stops dispatch without automatic retry', async () => {
  const second = deferred(); let failing = true;
  const f = fixture({ count: 4, assess: async (input, number) => {
    if (failing && number === 2) { await second.promise; throw new CareerError('PRESCAN_RATE_LIMIT', 'RAW PROVIDER BODY sk-private'); }
    return assessment();
  } });
  await f.controller.start(); await f.waitFor(() => f.apiCalls.length === 2);
  assert.equal(f.controller.status().status, 'running'); assert.equal(f.controller.results().items.length, 1);
  second.resolve(); await terminal(f);
  assert.equal(f.controller.status().status, 'failed'); assert.equal(f.controller.status().lastError.code, 'PRESCAN_RATE_LIMIT');
  assert.equal(f.apiCalls.length, 2); assert.equal(f.controller.results().items.length, 1);
  assert.equal(JSON.stringify(f.controller.status()).includes('RAW PROVIDER'), false);
  failing = false;
  await f.controller.start(); await terminal(f);
  assert.equal(f.apiCalls.filter(input => input.job.id === 'node:0').length, 1);
  assert.equal(f.controller.results().total, 4); assert.equal(f.controller.status().selected, 3);
});

test('explicit restarts skip current successful cache before the job cap; refresh clears only pre-scan results', async () => {
  const f = fixture({ count: 5 });
  await f.controller.start({ limit: 2 }); await terminal(f);
  await f.controller.start({ limit: 2 }); await terminal(f);
  assert.equal(f.apiCalls.length, 4); assert.equal(f.controller.results().total, 4);
  assert.equal(f.controller.status().requests, 2); assert.equal(f.controller.status().inputTokens, 34);
  const finalScores = f.store.get().career.matching.scores;
  await f.controller.start({ limit: 1, refresh: true }); await terminal(f);
  assert.equal(f.apiCalls.length, 5); assert.equal(f.controller.results().total, 1);
  assert.deepEqual(f.store.get().career.matching.scores, finalScores);
});

test('cancel returns before an uncooperative request finishes and cannot commit its late response', async () => {
  const pending = deferred();
  const f = fixture({ assess: async (input, number) => { if (number === 2) await pending.promise; return assessment(); } });
  await f.controller.start(); await f.waitFor(() => f.apiCalls.length === 2);
  const cancelled = await f.controller.cancel();
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.processed, 1);
  assert.equal(f.apiCalls[1].signal.aborted, true);
  pending.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.apiCalls.length, 2); assert.equal(f.controller.results().total, 1);
  assert.equal(f.controller.status().status, 'cancelled');
});

test('lock cancellation suppresses writes and reports interrupted after unlock, without resuming', async () => {
  const pending = deferred();
  const f = fixture({ assess: async () => { await pending.promise; return assessment(); } });
  await f.controller.start(); await f.waitFor(() => f.apiCalls.length === 1);
  f.setLocked(true); f.advanceEpoch();
  assert.equal((await f.controller.cancel()).status, 'interrupted');
  assert.equal(f.apiCalls[0].signal.aborted, true);
  f.setLocked(false); pending.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.controller.status().status, 'interrupted'); assert.equal(f.controller.results().total, 0);
  assert.equal(f.apiCalls.length, 1);
});

test('profile, ranking reset, credential and identity races discard late provider responses', async () => {
  const changes = [
    state => { state.career.evidenceRevision++; state.career.profile.preferences.notes = 'Changed direction'; },
    state => { state.career.rankingVersion = 1; state.career.matching = { jobs: {}, scores: {} }; delete state.career.prescan; },
    state => { state.prescanCredentialVersion++; state.prescanCredentials.openai.apiKey = 'sk-replaced-synthetic'; },
    state => { state.prescanCredentialVersion++; delete state.prescanCredentials.openai; },
    state => { state.deviceId = 'new-device'; state.career = createCareerState(); state.prescanCredentialVersion++; delete state.prescanCredentials; },
  ];
  for (const mutate of changes) {
    const pending = deferred();
    const f = fixture({ assess: async () => { await pending.promise; return assessment(); } });
    await f.controller.start(); await f.waitFor(() => f.apiCalls.length === 1);
    await f.store.update(mutate);
    pending.resolve();
    await f.waitFor(() => f.apiCalls[0].signal.aborted);
    assert.equal(Object.keys(f.snapshot().career.prescan?.rows ?? {}).length, 0);
    assert.equal(f.apiCalls.length, 1);
    assert.equal(Object.keys(f.snapshot().career.matching?.scores ?? {}).length, 0);
  }
});

test('profile changes during authorization block catalogue and paid dispatch', async () => {
  const approval = deferred(), f = fixture({ authorize: () => approval.promise });
  const pending = f.controller.start();
  await f.waitFor(() => f.authorizations.length === 1);
  await f.store.update(state => { state.career.evidenceRevision++; });
  approval.resolve(true);
  await assert.rejects(pending, { code: 'PRESCAN_CONTEXT_CHANGED' });
  assert.equal(f.platformCalls.length, 0); assert.equal(f.apiCalls.length, 0);
});

test('reset while full ads load cannot restore jobs or initiate paid requests', async () => {
  const pending = deferred();
  const f = fixture({ batch: async ({ ids }) => { await pending.promise; return { jobs: ids.map(id => ({ ...job(id.slice(5)), ad: 'Original ad' })), remainingIds: [], unavailableIds: [] }; } });
  await f.controller.start(); await f.waitFor(() => f.platformCalls.some(call => call.operation === 'matching_jobs'));
  await f.store.update(state => { state.career.rankingVersion = 1; state.career.matching = { jobs: {}, scores: {} }; delete state.career.prescan; });
  pending.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.store.get().career.matching, { jobs: {}, scores: {} });
  assert.equal(f.store.get().career.prescan, undefined); assert.equal(f.apiCalls.length, 0);
});

test('profile and ranking changes during catalogue loading prevent committing the fetched catalogue', async () => {
  for (const mutate of [
    state => { state.career.evidenceRevision++; },
    state => { state.career.rankingVersion = 1; state.career.matching = { jobs: {}, scores: {} }; },
  ]) {
    const pending = deferred(), f = fixture({ catalogueWait: pending.promise });
    const start = f.controller.start();
    await f.waitFor(() => f.platformCalls.some(call => call.operation === 'matching_catalogue'));
    await f.store.update(mutate);
    pending.resolve();
    await assert.rejects(start, { code: 'PRESCAN_CONTEXT_CHANGED' });
    assert.equal(Object.keys(f.store.get().career.matching?.jobs ?? {}).length, 0);
    assert.equal(f.store.get().career.prescan, undefined);
    assert.equal(f.apiCalls.length, 0);
  }
});

test('cancel and restart still share eight provider slots when older requests ignore abort', async () => {
  const pending = deferred(); let previous = true;
  const f = fixture({ count: 80, assess: async () => { if (previous) await pending.promise; return assessment(); } });
  await f.controller.start({ limit: 80 }); await f.waitFor(() => f.apiCalls.length === 8);
  await f.controller.cancel(); previous = false;
  await f.controller.start({ limit: 80 });
  await f.waitFor(() => f.platformCalls.filter(call => call.operation === 'matching_jobs').length === 16);
  assert.equal(f.apiCalls.length, 8);
  pending.resolve(); await terminal(f);
  assert.equal(f.maxConcurrent, 8); assert.equal(f.controller.status().status, 'completed');
  assert.equal(f.controller.status().processed, 80); assert.equal(f.controller.status().requests, 80);
});

test('a persisted running record is interrupted on startup; results remain readable after key removal', async () => {
  const f = fixture(); await f.controller.start(); await terminal(f);
  await f.store.update(state => { state.career.prescan.status = 'running'; delete state.prescanCredentials; state.prescanCredentialVersion++; });
  const before = f.apiCalls.length;
  const restarted = createPrescanController({ store: f.store, credentials: f.credentials,
    makeScope: () => assert.fail('Reading interrupted results must not create a run'),
    authorize: () => assert.fail('Reading interrupted results must not authorize a run') });
  assert.equal(restarted.status().status, 'interrupted'); assert.equal(restarted.status().configured, false);
  assert.equal(restarted.results().total, 3); assert.equal(restarted.results().current, true);
  assert.equal(f.apiCalls.length, before);
});

test('a run saved under another assessment or provider policy is stale and not reused', async () => {
  for (const field of ['assessmentPolicyId', 'prescanPolicyId']) {
    const f = fixture(); await f.controller.start(); await terminal(f);
    await f.store.update(state => { state.career.prescan[field] = 'old-policy'; });
    assert.equal(f.controller.status().status, 'stale'); assert.equal(f.controller.results().current, false);
    await f.controller.start(); await terminal(f);
    assert.equal(f.apiCalls.length, 6); assert.equal(f.controller.status().status, 'completed');
  }
});

test('MCP has four exact credential-free tools, with read-only reads and shared controller actions', async () => {
  const f = fixture(); const tools = createPrescanTools({ controller: f.controller });
  const ajv = new Ajv({ strict: false });
  assert.deepEqual(tools.map(tool => [tool.name, tool.readOnly]), [
    ['career_prescan_start', false], ['career_prescan_status', true], ['career_prescan_results', true], ['career_prescan_cancel', false],
  ]);
  for (const tool of tools) {
    const validate = ajv.compile(tool.inputSchema);
    assert.equal(validate({ apiKey: 'never' }), false);
    await assert.rejects(tool.invoke({ apiKey: 'never' }), { code: 'INVALID_INPUT' });
  }
  await tools.find(tool => tool.name === 'career_prescan_start').invoke({ limit: 1 }); await terminal(f);
  const result = await tools.find(tool => tool.name === 'career_prescan_results').invoke({});
  assert.equal(result.total, 1); assert.equal(JSON.stringify(result).includes('sk-synthetic'), false);
  assert.equal(f.authorizations.length, 1);
  const reads = f.apiCalls.length;
  await tools.find(tool => tool.name === 'career_prescan_status').invoke({});
  await tools.find(tool => tool.name === 'career_prescan_cancel').invoke({});
  assert.equal(f.apiCalls.length, reads);
});

test('cancelling pending native authorization prevents catalogue access even if approval arrives later', async () => {
  const approval = deferred(), f = fixture({ authorize: () => approval.promise });
  const start = f.controller.start();
  await f.waitFor(() => f.authorizations.length === 1);
  await f.controller.cancel();
  approval.resolve(true);
  await assert.rejects(start, { code: 'PRESCAN_CANCELLED' });
  assert.equal(f.platformCalls.length, 0); assert.equal(f.apiCalls.length, 0);
  assert.equal(f.controller.status().status, 'idle');
});

test('authentication, transport and malformed-provider failures stop immediately and expose only safe messages', async () => {
  for (const code of ['PRESCAN_AUTH', 'PRESCAN_TIMEOUT', 'PRESCAN_NETWORK', 'PRESCAN_PROVIDER_ERROR', 'PRESCAN_INVALID_RESPONSE', undefined]) {
    const f = fixture({ assess: async () => { throw Object.assign(new Error('PRIVATE REQUEST AND KEY'), { code }); } });
    await f.controller.start(); await terminal(f);
    assert.equal(f.controller.status().status, 'failed');
    assert.equal(f.controller.status().lastError.code, code ?? 'PRESCAN_FAILED');
    assert.equal(f.apiCalls.length, 1); assert.equal(f.controller.results().total, 0);
    assert.equal(JSON.stringify(f.controller.status()).includes('PRIVATE REQUEST'), false);
  }
});
