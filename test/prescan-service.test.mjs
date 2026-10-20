import test from 'node:test';
import assert from 'node:assert/strict';
import { createCareerState, CareerError } from '../src/mcp/state.mjs';
import { ASSESSMENT_POLICY_ID, deriveDecision } from '../src/mcp/matching-contract.mjs';
import { decisionProviders } from '../src/prescan/providers.mjs';
import { createScopedAccess } from '../src/mcp/scope.mjs';
import { createPrescanController } from '../src/prescan/service.mjs';
import { createPrescanTools } from '../src/mcp/prescan-tools.mjs';
import { PUBLICATION_RANGES, publicationInWindow } from '../src/prescan/publication-range.mjs';

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
function fixture({ count = 3, assess = async () => assessment(), authorize = async () => true, batch, catalogueWait,
  cataloguePageSize = 1000, cataloguePage } = {}) {
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
  const catalogues = new Map();
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
      if (cataloguePage) return cataloguePage(args);
      const window = { range: args.publicationRange, since: args.since, until: args.until };
      const key = JSON.stringify(window), offset = args.offset ?? 0;
      if (!offset) catalogues.set(key, catalogue.filter(job => publicationInWindow(job.publishedAt, window)));
      const jobs = catalogues.get(key);
      const next = Math.min(offset + cataloguePageSize, jobs.length);
      return { jobs: structuredClone(jobs.slice(offset, next)), total: jobs.length,
        nextOffset: next < jobs.length ? next : null, publicationWindow: window };
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
  assert.equal(f.controller.status().processed, 0);
  assert.deepEqual(f.apiCalls, []); assert.deepEqual(f.platformCalls, []); assert.deepEqual(f.authorizations, []);
});

test('preview reads complete catalogue metadata without credentials, approval, provider work or persistent writes', async () => {
  const f = fixture(), before = f.snapshot();
  f.credentials.read = () => assert.fail('Preview must not read the private API key');
  const preview = await f.controller.preview();
  assert.equal(preview.jobCount, 3); assert.equal(preview.totalCatalogue, 3); assert.equal(preview.reused, 0);
  assert.equal(preview.estimatedInputTokens > 0, true);
  assert.equal(preview.estimatedCostUsd, preview.estimatedInputTokens * preview.inputUsdPerMillion / 1_000_000);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.platformCalls.map(call => call.operation), ['matching_catalogue']);
  assert.equal(f.apiCalls.length, 0); assert.equal(f.authorizations.length, 0); assert.equal(f.controller.isActive(), false);
});

test('100,000 pending jobs are previewed and planned for native approval without a count cap or paid inference', async () => {
  const f = fixture({ count: 100_000, authorize: async () => false }), before = f.snapshot();
  const preview = await f.controller.preview();
  assert.equal(preview.jobCount, 100_000); assert.equal(preview.totalCatalogue, 100_000);
  assert.equal(preview.reused, 0); assert.equal(preview.estimatedInputTokens > 100_000, true);
  assert.deepEqual(f.platformCalls.map(call => call.args.offset ?? 0), Array.from({ length: 100 }, (_, index) => index * 1000));
  await assert.rejects(f.controller.start(), { code: 'PRESCAN_NOT_AUTHORIZED' });
  assert.equal(f.authorizations[0].jobCount, 100_000);
  assert.equal(f.authorizations[0].estimatedInputTokens, preview.estimatedInputTokens);
  assert.equal(f.authorizations[0].estimatedCostUsd, preview.estimatedCostUsd);
  assert.equal(f.apiCalls.length, 0);
  assert.equal(f.platformCalls.every(call => call.operation === 'matching_catalogue'), true);
  assert.deepEqual(f.snapshot(), before);
});

test('an approved snapshot includes every job beyond 2,000 and never expands after confirmation', async () => {
  const pending = deferred();
  const f = fixture({ count: 2001, authorize: async () => { f.catalogue.push(job('new')); return true; },
    batch: async ({ ids }) => { await pending.promise; return { jobs: [], remainingIds: [], unavailableIds: ids }; } });
  const started = await f.controller.start();
  assert.equal(f.authorizations[0].jobCount, 2001); assert.equal(started.selected, 2001);
  const selected = f.snapshot().career.prescan.selectedIds;
  assert.equal(selected.length, 2001); assert.equal(selected.includes('node:2000'), true);
  assert.equal(selected.includes('node:new'), false);
  assert.equal(f.platformCalls.filter(call => call.operation === 'matching_catalogue').length, 3);
  await f.controller.cancel(); pending.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.apiCalls.length, 0); assert.equal(f.controller.status().status, 'cancelled');
});

test('publication presets scope middleware counts and whole-catalogue runs keep older jobs eligible for cached reuse', async () => {
  const f = fixture({ count: 0 }), now = Date.now(), midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const yesterday = new Date(midnight);
  yesterday.setDate(yesterday.getDate() - 1);
  const dates = [new Date((midnight.getTime() + now) / 2).toISOString(),
    new Date(yesterday.getTime() + 12 * 60 * 60 * 1000).toISOString(),
    ...[2, 6, 10, 20, 60].map(days => new Date(now - days * 86400000).toISOString())];
  f.catalogue.push(...dates.map((date, index) => ({ ...job(index), publishedAt: date })));
  const before = f.snapshot();
  const expected = { today: 1, yesterday: 1, past_3_days: 3, past_week: 4, past_2_weeks: 5, past_month: 6, all: 7 };
  for (const publicationRange of PUBLICATION_RANGES) {
    const preview = await f.controller.preview({ publicationRange });
    assert.equal(preview.publicationRange, publicationRange);
    assert.equal(preview.totalCatalogue, expected[publicationRange]); assert.equal(preview.jobCount, expected[publicationRange]);
    assert.equal(f.platformCalls.at(-1).args.publicationRange, publicationRange);
    assert.deepEqual(f.snapshot(), before);
  }
  assert.equal(f.apiCalls.length, 0); assert.equal(f.authorizations.length, 0);
  await f.controller.setPublicationRange({ publicationRange: 'all' });
  assert.equal(f.controller.status().publicationRange, 'all');
  assert.equal(f.apiCalls.length, 0); assert.equal(f.authorizations.length, 0);
  await f.controller.start(); await terminal(f);
  assert.equal(f.apiCalls.length, 7); assert.equal(f.authorizations[0].jobCount, 7);
  assert.equal(f.authorizations[0].publicationRange, 'all');
  assert.equal(f.snapshot().career.prescan.publicationRange, 'all');
  assert.equal(f.snapshot().career.prescan.publicationWindow.since, null);
  const cached = await f.controller.preview();
  assert.equal(cached.jobCount, 0); assert.equal(cached.reused, 7);
  await f.controller.setPublicationRange({ publicationRange: 'past_month' });
  const month = await f.controller.preview();
  assert.equal(month.totalCatalogue, 6); assert.equal(month.reused, 6); assert.equal(month.jobCount, 0);
  assert.equal(f.apiCalls.length, 7); assert.equal(f.authorizations.length, 1);
});

test('range changes cancel native approval, persist the new selection and never start inference', async () => {
  const approval = deferred(), f = fixture({ authorize: () => approval.promise });
  const pending = f.controller.start();
  await f.waitFor(() => f.authorizations.length === 1);
  const changed = await f.controller.setPublicationRange({ publicationRange: 'past_month' });
  assert.equal(changed.publicationRange, 'past_month'); assert.equal(changed.status, 'idle');
  assert.equal(f.snapshot().prescanPublicationRange, 'past_month');
  assert.equal(f.authorizations[0].signal.aborted, true);
  approval.resolve(true);
  await assert.rejects(pending, { code: 'PRESCAN_CANCELLED' });
  assert.equal(f.apiCalls.length, 0);
  assert.equal(f.platformCalls.every(call => call.operation === 'matching_catalogue'), true);
  const preview = await f.controller.preview();
  assert.equal(preview.publicationRange, 'past_month'); assert.equal(f.authorizations.length, 1);
});

test('changing the range cancels active work, preserves saved successes and cannot save a late paid response', async () => {
  const pending = deferred();
  const f = fixture({ assess: async (input, number) => { if (number === 2) await pending.promise; return assessment(); } });
  await f.controller.start(); await f.waitFor(() => f.apiCalls.length === 2);
  const changed = await f.controller.setPublicationRange({ publicationRange: 'all' });
  assert.equal(changed.status, 'cancelled'); assert.equal(changed.publicationRange, 'all'); assert.equal(changed.processed, 1);
  const preview = await f.controller.preview();
  assert.equal(preview.jobCount, 2); assert.equal(preview.reused, 1);
  assert.equal(f.apiCalls.length, 2); assert.equal(f.authorizations.length, 1);
  pending.resolve(); await f.waitFor(() => !f.controller.isActive());
  assert.equal(Object.keys(f.snapshot().career.prescan.rows).length, 1); assert.equal(f.apiCalls.length, 2);
});

test('pre-scan rows carry mapped seniority, commitment and classification labels and null when absent', async () => {
  const f = fixture({ count: 0 });
  f.catalogue.push({ ...job(0), seniority: '4', commitment: 'FULL_TIME', classification: 'SMART_CONTRACTS' },
    { ...job(1), seniority: '', commitment: null });
  await f.controller.start(); await terminal(f);
  const rows = f.snapshot().career.prescan.rows;
  assert.equal(f.controller.status().status, 'completed');
  assert.deepEqual([rows['node:0'].seniority, rows['node:0'].commitment, rows['node:0'].classification], ['Lead', 'Full Time', 'Smart Contracts']);
  assert.deepEqual([rows['node:1'].seniority, rows['node:1'].commitment, rows['node:1'].classification], [null, null, null]);
  assert.deepEqual([rows['node:0'].workMode, rows['node:0'].city, rows['node:0'].applyUrl], ['hybrid', 'Dublin', 'https://employer.example/jobs']);
});

test('invalid range selections and obsolete limits never fetch metadata, authorize or infer', async () => {
  const f = fixture(), before = f.snapshot();
  for (const publicationRange of ['week', '', null, 7, [], {}]) {
    await assert.rejects(f.controller.preview({ publicationRange }), { code: 'INVALID_INPUT' });
    await assert.rejects(f.controller.start({ publicationRange }), { code: 'INVALID_INPUT' });
    await assert.rejects(f.controller.setPublicationRange({ publicationRange }), { code: 'INVALID_INPUT' });
  }
  for (const args of [undefined, {}, null, [], { publicationRange: 'all', limit: 100 }])
    await assert.rejects(f.controller.setPublicationRange(args), { code: 'INVALID_INPUT' });
  assert.deepEqual(f.snapshot(), before); assert.equal(f.platformCalls.length, 0);
  assert.equal(f.authorizations.length, 0); assert.equal(f.apiCalls.length, 0);
});

test('metadata pagination rejects duplicate IDs, drifting totals, gaps and incomplete scopes before approval', async () => {
  for (const defect of ['duplicate', 'total', 'gap', 'incomplete', 'window']) {
    const f = fixture({ count: 2, cataloguePage: args => {
      const window = { range: args.publicationRange, since: args.since, until: args.until };
      const offset = args.offset ?? 0;
      return { jobs: [job(offset && defect !== 'duplicate' ? 1 : 0)],
        total: offset && defect === 'total' ? 3 : 2,
        nextOffset: offset || defect === 'incomplete' ? null : defect === 'gap' ? 2 : 1,
        publicationWindow: defect === 'window' ? { ...window, range: 'all' } : window };
    } });
    await assert.rejects(f.controller.preview(), { code: 'INVALID_CATALOGUE' });
    await assert.rejects(f.controller.start(), { code: 'INVALID_CATALOGUE' });
    assert.equal(f.authorizations.length, 0); assert.equal(f.apiCalls.length, 0);
    assert.equal(f.snapshot().career.prescan, undefined);
  }
});

test('start recomputes the current catalogue and candidate context instead of authorizing a stale preview', async () => {
  const approval = deferred(), f = fixture({ count: 2, authorize: () => approval.promise });
  const preview = await f.controller.preview();
  assert.equal(preview.jobCount, 2);
  await f.store.update(state => {
    state.career.evidenceRevision++;
    state.career.profile.preferences.notes = 'Updated career direction.';
  });
  f.catalogue.push(job(2));
  const started = f.controller.start();
  await f.waitFor(() => f.authorizations.length === 1);
  assert.equal(f.authorizations[0].jobCount, 3); assert.equal(f.apiCalls.length, 0);
  assert.equal(f.platformCalls.every(call => call.operation === 'matching_catalogue'), true);
  approval.resolve(true); await started; await terminal(f);
  assert.equal(f.apiCalls.length, 3);
  assert.equal(f.apiCalls.every(call => call.candidate.preferences.notes === 'Updated career direction.'), true);
});

test('native authorization reserves single-flight and receives the exact metadata-only plan before paid work', async () => {
  const approval = deferred(), response = deferred();
  const f = fixture({ authorize: () => approval.promise, assess: async () => { await response.promise; return assessment(); } });
  const before = f.snapshot();
  const first = f.controller.start();
  await f.waitFor(() => f.authorizations.length === 1);
  const concurrent = await f.controller.start({ refresh: true });
  assert.equal(concurrent.status, 'running');
  assert.equal(f.authorizations.length, 1); assert.equal(f.apiCalls.length, 0);
  assert.deepEqual(f.platformCalls.map(call => call.operation), ['matching_catalogue']);
  assert.deepEqual(f.snapshot(), before);
  const authorized = f.authorizations[0];
  assert.equal(authorized.jobCount, 3); assert.equal(authorized.totalCatalogue, 3); assert.equal(authorized.reused, 0);
  assert.equal(authorized.provider, 'openai'); assert.equal(authorized.model, 'gpt-6-luna');
  assert.equal(authorized.estimatedInputTokens > 0, true);
  assert.equal(authorized.estimatedCostUsd, authorized.estimatedInputTokens * authorized.inputUsdPerMillion / 1_000_000);
  assert.equal(authorized.signal.aborted, false);
  approval.resolve(true); const started = await first;
  await f.waitFor(() => f.apiCalls.length === 1);
  assert.equal((await f.controller.start()).runId, started.runId);
  assert.equal(f.authorizations.length, 1);
  response.resolve(); await terminal(f);
  assert.equal(f.apiCalls.length, authorized.jobCount);
});

test('a stale or cancelled summary remains busy until its paid provider request drains', async () => {
  const response = deferred();
  const f = fixture({ count: 1, assess: async () => { await response.promise; return assessment(); } });
  await f.controller.start();
  await f.waitFor(() => f.apiCalls.length === 1);
  await f.store.update(state => { state.career.evidenceRevision++; });
  assert.equal(f.controller.status().status, 'stale');
  assert.equal(f.controller.isActive(), true);
  await f.controller.cancel();
  assert.equal(f.controller.isActive(), true);
  response.resolve();
  await f.waitFor(() => !f.controller.isActive());
  assert.equal(f.controller.isActive(), false);
});

test('declined confirmation changes no career data and never fetches full ads or calls the provider', async () => {
  const f = fixture({ authorize: async () => false }), before = f.snapshot();
  await assert.rejects(f.controller.start(), { code: 'PRESCAN_NOT_AUTHORIZED' });
  assert.equal(f.controller.status().status, 'idle');
  assert.deepEqual(f.platformCalls.map(call => call.operation), ['matching_catalogue']);
  assert.equal(f.apiCalls.length, 0); assert.deepEqual(f.snapshot(), before);
  await f.store.update(state => { delete state.prescanCredentials; state.prescanCredentialVersion++; });
  await assert.rejects(f.controller.start(), { code: 'PRESCAN_KEY_REQUIRED' });
  for (const args of [null, [], { limit: 0 }, { limit: 1 }, { limit: 2001 }, { limit: 1.5 }, { refresh: 'yes' }, { apiKey: 'never' }, { provider: 'fake' }]) {
    await assert.rejects(f.controller.start(args), { code: 'INVALID_INPUT' });
    await assert.rejects(f.controller.preview(args), { code: 'INVALID_INPUT' });
  }
  assert.equal(f.platformCalls.length, 1); assert.equal(f.authorizations.length, 1);
});

test('full catalogue runs keep eight active calls, include final-assessed jobs and preserve full ads/context and final scores', async () => {
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
  await f.controller.start();
  await f.waitFor(() => f.apiCalls.length === 8);
  assert.equal(f.maxConcurrent, 8);
  response.resolve(); await terminal(f);
  const summary = f.controller.status();
  assert.equal(summary.status, 'completed'); assert.equal(summary.selected, 100); assert.equal(summary.processed, 100);
  assert.equal(summary.requests, 100); assert.equal(summary.inputTokens, 100 * 17); assert.equal(summary.totalCatalogue, 100);
  assert.equal(summary.estimatedCostUsd, summary.inputTokens * 0.1 / 1_000_000);
  assert.equal(f.apiCalls.length, 100); assert.equal(new Set(f.apiCalls.map(call => call.job.id)).size, 100);
  assert.equal(f.apiCalls.some(call => call.job.id === 'node:99'), true);
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
  // Only the one scored row is inside the default cutoff; unscored jobs wait for a manual override.
  assert.equal(summary.included, 1); assert.equal(summary.cutoff, 50);
  await f.store.update(state => { state.career.prescanInclusion = { cutoff: 1, overrides: { 'node:1': true, 'node:0': false } }; });
  assert.equal(f.controller.status().included, 1); assert.equal(f.controller.status().cutoff, 1);
  assert.equal(f.apiCalls.length, 1);
  assert.equal(Object.keys(f.snapshot().career.prescan.rows).length, 5);
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
  const rows = Object.values(f.snapshot().career.prescan.rows);
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
  assert.equal(f.controller.status().status, 'running'); assert.equal(Object.keys(f.snapshot().career.prescan.rows).length, 1);
  second.resolve(); await terminal(f);
  assert.equal(f.controller.status().status, 'failed'); assert.equal(f.controller.status().lastError.code, 'PRESCAN_RATE_LIMIT');
  assert.equal(f.apiCalls.length, 2); assert.equal(Object.keys(f.snapshot().career.prescan.rows).length, 1);
  assert.equal(JSON.stringify(f.controller.status()).includes('RAW PROVIDER'), false);
  failing = false;
  await f.controller.start(); await terminal(f);
  assert.equal(f.apiCalls.filter(input => input.job.id === 'node:0').length, 1);
  assert.equal(Object.keys(f.snapshot().career.prescan.rows).length, 4); assert.equal(f.controller.status().selected, 3);
});

test('preview and restarts reuse every current successful result; refresh reruns the catalogue without touching final scores', async () => {
  const f = fixture({ count: 3 });
  await f.controller.start(); await terminal(f);
  f.catalogue.push(job(3), job(4));
  const before = f.snapshot(), calls = f.apiCalls.length, authorizations = f.authorizations.length;
  const preview = await f.controller.preview();
  assert.equal(preview.jobCount, 2); assert.equal(preview.totalCatalogue, 5); assert.equal(preview.reused, 3);
  assert.equal(preview.estimatedInputTokens, 2 * 17);
  assert.equal(preview.estimatedCostUsd, 34 * 0.1 / 1_000_000);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.apiCalls.length, calls); assert.equal(f.authorizations.length, authorizations);
  await f.controller.start(); await terminal(f);
  assert.equal(f.apiCalls.length, 5); assert.equal(Object.keys(f.snapshot().career.prescan.rows).length, 5);
  assert.equal(f.controller.status().requests, 2); assert.equal(f.controller.status().inputTokens, 34);
  const coverage = f.controller.status();
  assert.equal(coverage.selected, 2); assert.equal(coverage.reused, 3);
  assert.equal(coverage.processed + coverage.reused, coverage.totalCatalogue);
  assert.equal(f.authorizations.at(-1).jobCount, preview.jobCount);
  assert.equal(f.authorizations.at(-1).estimatedCostUsd, preview.estimatedCostUsd);
  const reused = await f.controller.preview();
  assert.equal(reused.jobCount, 0); assert.equal(reused.reused, 5); assert.equal(reused.estimatedCostUsd, 0);
  const refresh = await f.controller.preview({ refresh: true });
  assert.equal(refresh.jobCount, 5); assert.equal(refresh.reused, 0); assert.equal(refresh.estimatedInputTokens, 85);
  const finalScores = f.store.get().career.matching.scores;
  await f.controller.start({ refresh: true }); await terminal(f);
  assert.equal(f.apiCalls.length, 10); assert.equal(Object.keys(f.snapshot().career.prescan.rows).length, 5);
  assert.deepEqual(f.store.get().career.matching.scores, finalScores);
});

test('only successful cache rows for unchanged catalogue metadata are reused', async () => {
  const f = fixture({ assess: async input => input.job.id === 'node:1'
    ? { ...assessment(), status: 'refused', priority: null, dimensions: null } : assessment() });
  await f.controller.start(); await terminal(f);
  f.catalogue[0].publishedAt = new Date(Date.now() - 2 * 86400000).toISOString();
  const before = f.snapshot();
  const preview = await f.controller.preview();
  assert.equal(preview.jobCount, 2); assert.equal(preview.reused, 1); assert.equal(preview.totalCatalogue, 3);
  assert.deepEqual(f.snapshot(), before);
  await f.controller.start(); await terminal(f);
  assert.equal(f.apiCalls.filter(call => call.job.id === 'node:0').length, 2);
  assert.equal(f.apiCalls.filter(call => call.job.id === 'node:1').length, 2);
  assert.equal(f.apiCalls.filter(call => call.job.id === 'node:2').length, 1);
});

test('cancel returns before an uncooperative request finishes and cannot commit its late response', async () => {
  const pending = deferred();
  const f = fixture({ assess: async (input, number) => { if (number === 2) await pending.promise; return assessment(); } });
  await f.controller.start(); await f.waitFor(() => f.apiCalls.length === 2);
  const cancelled = await f.controller.cancel();
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.processed, 1);
  assert.equal(f.apiCalls[1].signal.aborted, true);
  pending.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.apiCalls.length, 2); assert.equal(Object.keys(f.snapshot().career.prescan.rows).length, 1);
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
  assert.equal(f.controller.status().status, 'interrupted'); assert.equal(Object.keys(f.snapshot().career.prescan.rows).length, 0);
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

test('profile changes during authorization block full-ad fetching and paid dispatch', async () => {
  const approval = deferred(), f = fixture({ authorize: () => approval.promise });
  const pending = f.controller.start();
  await f.waitFor(() => f.authorizations.length === 1);
  await f.store.update(state => { state.career.evidenceRevision++; });
  approval.resolve(true);
  await assert.rejects(pending, { code: 'PRESCAN_CONTEXT_CHANGED' });
  assert.deepEqual(f.platformCalls.map(call => call.operation), ['matching_catalogue']); assert.equal(f.apiCalls.length, 0);
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

test('profile, ranking, credential and publication-range changes invalidate loaded preview/start metadata before approval or persistence', async () => {
  for (const method of ['preview', 'start']) for (const mutate of [
    state => { state.career.evidenceRevision++; },
    state => { state.career.rankingVersion = 1; state.career.matching = { jobs: {}, scores: {} }; },
    state => { state.prescanCredentialVersion++; },
    state => { state.prescanPublicationRange = 'all'; },
  ]) {
    const pending = deferred(), f = fixture({ catalogueWait: pending.promise });
    const planned = f.controller[method]();
    await f.waitFor(() => f.platformCalls.some(call => call.operation === 'matching_catalogue'));
    await f.store.update(mutate);
    pending.resolve();
    await assert.rejects(planned, { code: 'PRESCAN_CONTEXT_CHANGED' });
    assert.equal(Object.keys(f.store.get().career.matching?.jobs ?? {}).length, 0);
    assert.equal(f.store.get().career.prescan, undefined);
    assert.equal(f.apiCalls.length, 0); assert.equal(f.authorizations.length, 0);
  }
});

test('cancel and restart still share eight provider slots when older requests ignore abort', async () => {
  const pending = deferred(); let previous = true;
  const f = fixture({ count: 80, assess: async () => { if (previous) await pending.promise; return assessment(); } });
  await f.controller.start(); await f.waitFor(() => f.apiCalls.length === 8);
  await f.controller.cancel(); previous = false;
  await f.controller.start();
  await f.waitFor(() => f.platformCalls.filter(call => call.operation === 'matching_jobs').length === 16);
  assert.equal(f.apiCalls.length, 8);
  pending.resolve(); await terminal(f);
  assert.equal(f.maxConcurrent, 8); assert.equal(f.controller.status().status, 'completed');
  assert.equal(f.controller.status().processed, 80); assert.equal(f.controller.status().requests, 80);
});

test('saved rows remain intact after credentials are removed while operational status becomes stale', async () => {
  const f = fixture(); await f.controller.start(); await terminal(f);
  await f.store.update(state => { state.career.prescan.status = 'running'; delete state.prescanCredentials; state.prescanCredentialVersion++; });
  const before = f.apiCalls.length;
  const restarted = createPrescanController({ store: f.store, credentials: f.credentials,
    makeScope: () => assert.fail('Reading interrupted results must not create a run'),
    authorize: () => assert.fail('Reading interrupted results must not authorize a run') });
  assert.equal(restarted.status().status, 'stale'); assert.equal(restarted.status().configured, false);
  assert.equal(Object.keys(f.snapshot().career.prescan.rows).length, 3);
  assert.equal(f.apiCalls.length, before);
});

test('a run saved under another provider policy is stale and not reused', async () => {
  for (const field of ['prescanPolicyId']) {
    const f = fixture(); await f.controller.start(); await terminal(f);
    await f.store.update(state => { state.career.prescan[field] = 'old-policy'; });
    assert.equal(f.controller.status().status, 'stale');
    await f.controller.start(); await terminal(f);
    assert.equal(f.apiCalls.length, 6); assert.equal(f.controller.status().status, 'completed');
  }
});

test('final-review policy changes reuse paid results while credential changes require a new scan', async () => {
  const f = fixture(); await f.controller.start(); await terminal(f);
  await f.store.update(state => { state.career.prescan.assessmentPolicyId = 'changed-final-review-only'; });
  const preview = await f.controller.preview();
  assert.equal(preview.jobCount, 0); assert.equal(preview.reused, 3);
  await f.controller.start(); await terminal(f);
  assert.equal(f.apiCalls.length, 3);
  await f.store.update(state => { state.prescanCredentialVersion++; });
  assert.equal((await f.controller.preview()).jobCount, 3);
  await f.controller.start(); await terminal(f);
  assert.equal(f.apiCalls.length, 6);
});

test('MCP preview and reads keep credentials private and only start requests native approval', async () => {
  const f = fixture(); const tools = createPrescanTools({ controller: f.controller });
  for (const tool of tools)
    await assert.rejects(tool.invoke({ apiKey: 'never' }), { code: 'INVALID_INPUT' });
  const preview = await tools.find(tool => tool.name === 'career_prescan_preview').invoke({});
  assert.equal(preview.jobCount, 3);
  assert.equal(f.authorizations.length, 0); assert.equal(f.apiCalls.length, 0);
  await assert.rejects(tools.find(tool => tool.name === 'career_prescan_start').invoke({ limit: 1 }), { code: 'INVALID_INPUT' });
  await tools.find(tool => tool.name === 'career_prescan_start').invoke({}); await terminal(f);
  await f.store.update(state => {
    state.career.prescan.rows[f.catalogue[0].id].answers = [{ reason: 'PRIVATE_PRE_SCAN_JUDGMENT' }];
  });
  const judgmentFields = new Set(['priority', 'score', 'direction', 'constraints', 'eligibility', 'dimensions', 'confidence', 'answers']);
  for (const tool of tools.filter(tool => tool.readOnly)) {
    const modelVisible = await tool.invoke({});
    assert.equal(JSON.stringify(modelVisible).includes('PRIVATE_PRE_SCAN_JUDGMENT'), false);
    const pending = [modelVisible];
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== 'object') continue;
      for (const [key, child] of Object.entries(value)) {
        assert.equal(judgmentFields.has(key), false, `Pre-scan judgment exposed to the model: ${key}`);
        pending.push(child);
      }
    }
  }
  const result = await tools.find(tool => tool.name === 'career_prescan_status').invoke({});
  assert.equal(result.processed, 3); assert.equal(JSON.stringify(result).includes('sk-synthetic'), false);
  assert.equal(f.authorizations.length, 1);
  const reads = f.apiCalls.length, fetches = f.platformCalls.length;
  await tools.find(tool => tool.name === 'career_prescan_status').invoke({});
  await tools.find(tool => tool.name === 'career_prescan_cancel').invoke({});
  assert.equal(f.apiCalls.length, reads); assert.equal(f.platformCalls.length, fetches);
});

test('cancelling pending native authorization prevents full-ad access even if approval arrives later', async () => {
  const approval = deferred(), f = fixture({ authorize: () => approval.promise });
  const start = f.controller.start();
  await f.waitFor(() => f.authorizations.length === 1);
  await f.controller.cancel();
  approval.resolve(true);
  await assert.rejects(start, { code: 'PRESCAN_CANCELLED' });
  assert.deepEqual(f.platformCalls.map(call => call.operation), ['matching_catalogue']); assert.equal(f.apiCalls.length, 0);
  assert.equal(f.authorizations[0].signal.aborted, true);
  assert.equal(f.controller.status().status, 'idle');
});

test('authentication, transport and malformed-provider failures stop immediately and expose only safe messages', async () => {
  for (const code of ['PRESCAN_AUTH', 'PRESCAN_TIMEOUT', 'PRESCAN_NETWORK', 'PRESCAN_PROVIDER_ERROR', 'PRESCAN_INVALID_RESPONSE', undefined]) {
    const f = fixture({ assess: async () => { throw Object.assign(new Error('PRIVATE REQUEST AND KEY'), { code }); } });
    await f.controller.start(); await terminal(f);
    assert.equal(f.controller.status().status, 'failed');
    assert.equal(f.controller.status().lastError.code, code ?? 'PRESCAN_FAILED');
    assert.equal(f.apiCalls.length, 1); assert.equal(Object.keys(f.snapshot().career.prescan.rows).length, 0);
    assert.equal(JSON.stringify(f.controller.status()).includes('PRIVATE REQUEST'), false);
  }
});
