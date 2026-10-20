import { randomUUID } from 'node:crypto';
import { CareerError, fail } from '../mcp/state.mjs';
import { matchingProfileVersion, recentPublication } from '../mcp/assessment-policy.mjs';
import { ASSESSMENT_POLICY_ID } from '../mcp/matching-contract.mjs';
import { createMatchingTools } from '../mcp/matching-tools.mjs';
import { decisionProviders } from './providers.mjs';
import { currentPrescan, currentPrescanRow, getPrescanResults } from './state.mjs';

const PRICE_NOTE = 'Base-rate estimate from reported input tokens, not a guaranteed invoice. Regional or long-context premiums may apply. Already dispatched requests may be billed after cancellation.';
const messages = {
  PRESCAN_KEY_REQUIRED: 'Add your OpenAI API key in Settings.',
  PRESCAN_NOT_AUTHORIZED: 'Pre-filtering canceled.',
  PRESCAN_CANCELLED: 'Pre-filtering canceled.',
  PRESCAN_CONTEXT_CHANGED: 'Your profile or setup changed. Start pre-filtering again.',
  PRESCAN_AUTH: 'OpenAI rejected the API key. Update it in Settings.',
  PRESCAN_RATE_LIMIT: 'Check your OpenAI quota and billing, then try again.',
  PRESCAN_TIMEOUT: 'OpenAI timed out. Try again.',
  PRESCAN_NETWORK: 'Could not reach OpenAI. Check your connection.',
  PRESCAN_PROVIDER_ERROR: 'OpenAI could not complete the request. Try again.',
  PRESCAN_INVALID_RESPONSE: 'OpenAI returned an invalid result. Try again.',
  PRESCAN_INPUT_TOO_LARGE: 'The CV and job advert exceed the provider input limit.',
  PRESCAN_INVALID_INPUT: 'Could not prepare this job for pre-filtering.',
  PRESCAN_UNSUPPORTED_PROVIDER: 'This provider is not supported.',
  PROFILE_INCOMPLETE: 'Add your CV and career profile to start pre-filtering.',
  PAIRING_REQUIRED: 'Connect your account in Settings.',
  LOCAL_LOCKED: 'Unlock local storage to continue.',
  IDENTITY_CHANGED: 'Your account connection changed. Reconnect in Settings.',
  RANKINGS_CHANGED: 'Job assessments were cleared. Start pre-filtering again.',
  INVALID_CATALOGUE: 'Could not load the job catalogue. Try again.',
  INVALID_BATCH: 'Could not load these job adverts. Try again.',
  OUTSIDE_PUBLICATION_WINDOW: 'These jobs are outside the current catalogue. Refresh your jobs.',
  PRESCAN_FAILED: 'Pre-filtering stopped. Check your API setup in Settings.',
};
const safeError = error => {
  const code = Object.hasOwn(messages, error?.code) ? error.code : 'PRESCAN_FAILED';
  return { code, message: messages[code] };
};
const now = () => new Date().toISOString();
const unscored = { priority: null, direction: null, constraints: null, eligibility: null, dimensions: null, confidence: null };
const rowFields = ['id', 'title', 'company', 'publishedAt', 'applyUrl', 'salary', 'city', 'location', 'workMode'];
const rawGraphFields = new Set(['graph', 'graphs', 'rawGraph', 'rawGraphs', '@graph']);
function jobInput(value) {
  if (Array.isArray(value)) return value.map(jobInput);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !rawGraphFields.has(key)).map(([key, item]) => [key, jobInput(item)]));
}
function assertStart(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['limit', 'refresh'].includes(key)) ||
      (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 2000)) ||
      (args.refresh !== undefined && typeof args.refresh !== 'boolean'))
    fail('INVALID_INPUT', 'Provide a job limit from 1 to 2000 and an optional boolean refresh.');
}

/** One shared controller serves settings and every MCP session. Construction performs no vault reads or inference. */
export function createPrescanController({ store, makeScope, credentials, authorize, onChange = () => {}, providers = decisionProviders }) {
  let active = null, providerCalls = 0;
  const slots = new Set();
  function notify() {
    try { Promise.resolve(onChange()).catch(() => {}); } catch { /* Notification failure cannot discard saved results. */ }
  }
  function check(run, state, { stopped = false, id } = {}) {
    run.scope.assertAvailable(true);
    if (!stopped && (active !== run || run.abort.signal.aborted)) fail('PRESCAN_CANCELLED', messages.PRESCAN_CANCELLED);
    const career = state.career;
    if (!career || state.deviceId !== run.deviceId || matchingProfileVersion(career) !== run.profileVersion ||
        (state.prescanCredentialVersion ?? 0) !== run.credentialVersion ||
        career.prescan?.id !== run.expectedRunId || (run.persisted &&
          (career.prescan.profileVersion !== run.profileVersion || career.prescan.assessmentPolicyId !== ASSESSMENT_POLICY_ID ||
           career.prescan.prescanPolicyId !== run.provider.policyId || career.prescan.provider !== run.provider.id ||
           career.prescan.model !== run.provider.model || career.prescan.credentialVersion !== run.credentialVersion)) ||
        (id && !Object.hasOwn(career.matching?.jobs ?? {}, id)))
      fail('PRESCAN_CONTEXT_CHANGED', messages.PRESCAN_CONTEXT_CHANGED);
  }
  function current(run, options) {
    const state = run.scope.store.get();
    check(run, state, options);
    return state;
  }
  async function change(run, mutation, options) {
    current(run, options);
    await run.scope.store.update(state => { check(run, state, options); mutation(state.career.prescan, state); });
    if (!options?.silent) notify();
  }
  function summary(state, publicState) {
    const career = state.career ?? {}, stored = career.prescan;
    const run = active && !active.persisted ? active.record : stored;
    const live = Boolean(active && active.record.id === run?.id);
    const rows = (run?.selectedIds ?? []).map(id => run.rows?.[id]).filter(Boolean);
    let status = run?.status ?? 'idle';
    if (run && (run.profileVersion !== matchingProfileVersion(career) || run.assessmentPolicyId !== ASSESSMENT_POLICY_ID ||
      run.prescanPolicyId !== providers[run.provider]?.policyId)) status = 'stale';
    else if (status === 'running' && !live) status = 'interrupted';
    const provider = providers[run?.provider ?? publicState.provider];
    const inputTokens = run?.inputTokens ?? 0;
    return { configured: publicState.configured, provider: run?.provider ?? publicState.provider,
      model: run?.model ?? publicState.model, ...(run ? { runId: run.id } : {}), status,
      selected: run?.selectedIds.length ?? 0, processed: rows.length,
      scored: rows.filter(row => row.status === 'scored').length,
      unavailable: rows.filter(row => row.status !== 'scored').length,
      totalCatalogue: run?.totalCatalogue ?? 0, inputTokens, requests: run?.requests ?? 0,
      estimatedCostUsd: inputTokens * (provider?.inputUsdPerMillion ?? publicState.inputUsdPerMillion) / 1_000_000,
      priceNote: PRICE_NOTE, ...(run?.lastError ? { lastError: run.lastError } : {}) };
  }
  function status() { return summary(store.get(), credentials.publicState()); }
  function results(args = {}) { return { ...getPrescanResults(store, args), status: status() }; }
  async function acquire(run) {
    while (providerCalls >= 8) {
      current(run);
      await new Promise(resolve => {
        const ready = () => { slots.delete(ready); run.abort.signal.removeEventListener('abort', ready); resolve(); };
        slots.add(ready); run.abort.signal.addEventListener('abort', ready, { once: true });
      });
    }
    current(run);
    providerCalls++;
  }
  function release() { providerCalls--; for (const ready of [...slots]) ready(); notify(); }
  function metadata(run, id) {
    const state = current(run, { id }), job = state.career.matching.jobs[id];
    return Object.fromEntries(rowFields.filter(field => job[field] !== undefined).map(field => [field, job[field]]));
  }
  async function saveRow(run, id, outcome, { unsent = false } = {}) {
    const row = { ...metadata(run, id), ...outcome, assessedAt: now() };
    await change(run, saved => {
      saved.rows[id] = row;
      saved.inputTokens += outcome.inputTokens ?? 0;
      if (unsent) saved.requests--;
    }, { id });
  }
  async function unavailable(run, id, message) {
    await saveRow(run, id, { status: 'unavailable', ...unscored, error: { code: 'PRESCAN_AD_UNAVAILABLE', message } });
  }
  async function assess(run, job) {
    if (typeof job.ad !== 'string' || !job.ad.trim()) {
      await unavailable(run, job.id, 'Original job advert unavailable.');
      return;
    }
    const details = metadata(run, job.id);
    if (!recentPublication(details.publishedAt)) {
      await unavailable(run, job.id, 'Job outside the current catalogue.');
      return;
    }
    const input = jobInput({ ...details, ...job });
    await acquire(run);
    try {
      await change(run, saved => { saved.requests++; }, { id: job.id });
      current(run, { id: job.id });
      const key = credentials.read(run.provider.id);
      if (key.credentialVersion !== run.credentialVersion) fail('PRESCAN_CONTEXT_CHANGED', messages.PRESCAN_CONTEXT_CHANGED);
      const answer = await run.provider.assess({ apiKey: key.apiKey, candidate: run.candidate, job: input, signal: run.abort.signal });
      await saveRow(run, job.id, { status: answer.status, priority: answer.priority, direction: answer.direction,
        constraints: answer.constraints, eligibility: answer.eligibility, dimensions: answer.dimensions,
        confidence: answer.confidence, answers: answer.answers, inputTokens: answer.inputTokens });
    } catch (error) {
      if (error?.code !== 'PRESCAN_INPUT_TOO_LARGE') throw error;
      await saveRow(run, job.id, { status: 'oversize', ...unscored, error: safeError(error) }, { unsent: true });
    } finally { release(); }
  }
  async function worker(run, queue) {
    while (queue.length) {
      current(run);
      const ids = queue.splice(0, 10);
      const batch = await run.tools.get('career_match_batch').invoke({ ids });
      current(run);
      for (const id of batch.unavailableIds) await unavailable(run, id, 'Original job advert unavailable.');
      if (batch.remainingIds.length === ids.length) {
        for (const id of batch.remainingIds) await unavailable(run, id, 'Original job advert unavailable.');
      } else queue.push(...batch.remainingIds);
      for (const job of batch.jobs) await assess(run, job);
    }
  }
  async function finish(run, status, lastError) {
    run.abort.abort();
    try {
      if (run.persisted) await change(run, saved => {
        saved.status = status; saved.finishedAt = now();
        if (lastError) saved.lastError = lastError;
      }, { stopped: true, silent: true });
    } catch { /* A lock/reset/context change must never restore or mutate invalidated work. */ }
    if (active === run) active = null;
    notify();
  }
  async function execute(run) {
    try {
      const queue = [...run.record.selectedIds];
      await Promise.all(Array.from({ length: Math.min(8, queue.length) }, () => worker(run, queue)));
      if (active === run) await finish(run, 'completed');
    } catch (error) {
      if (active === run) await finish(run, error?.code === 'PRESCAN_CANCELLED' ? 'cancelled' : 'failed', safeError(error));
    }
  }
  async function start(args = {}) {
    assertStart(args);
    if (active) return status();
    const provider = providers.openai;
    if (!provider) fail('PRESCAN_UNSUPPORTED_PROVIDER', messages.PRESCAN_UNSUPPORTED_PROVIDER);
    const scope = makeScope();
    scope.assertAvailable(true);
    const state = scope.store.get(), profileVersion = matchingProfileVersion(state.career ?? {});
    const { credentialVersion } = credentials.read(provider.id);
    const record = { id: randomUUID(), profileVersion, assessmentPolicyId: ASSESSMENT_POLICY_ID, prescanPolicyId: provider.policyId,
      provider: provider.id, model: provider.model, credentialVersion, status: 'running', startedAt: now(),
      selectedIds: [], totalCatalogue: 0, rows: {}, inputTokens: 0, requests: 0 };
    const run = { record, provider, scope, profileVersion, credentialVersion, deviceId: state.deviceId,
      expectedRunId: state.career?.prescan?.id, persisted: false, abort: new AbortController() };
    active = run;
    notify();
    try {
      const limit = args.limit ?? 100;
      if (!await authorize({ provider: provider.id, label: provider.label, model: provider.model, limit,
        inputUsdPerMillion: provider.inputUsdPerMillion })) fail('PRESCAN_NOT_AUTHORIZED', messages.PRESCAN_NOT_AUTHORIZED);
      current(run);
      const guardedStore = {
        get: () => current(run),
        update: mutation => scope.store.update(state => { check(run, state); return mutation(state); }),
      };
      run.tools = new Map(createMatchingTools({ store: guardedStore, preserveFinalAssessments: true,
        platform: async (operation, input) => {
          current(run);
          const value = await scope.platform(operation, input);
          current(run);
          return value;
        } }).map(tool => [tool.name, tool]));
      const catalogue = await run.tools.get('career_match_jobs').invoke({});
      const latest = current(run), career = latest.career;
      if (catalogue.profileVersion !== run.profileVersion || catalogue.policyId !== ASSESSMENT_POLICY_ID)
        fail('PRESCAN_CONTEXT_CHANGED', messages.PRESCAN_CONTEXT_CHANGED);
      const previous = career.prescan;
      const reusable = !args.refresh && currentPrescan(career) && previous.provider === provider.id && previous.model === provider.model;
      record.rows = reusable ? { ...previous.rows } : {};
      record.selectedIds = catalogue.jobIds.filter(id => !(reusable && previous.rows?.[id]?.status === 'scored' &&
        currentPrescanRow(career, previous.rows[id]))).slice(0, limit);
      for (const id of record.selectedIds) delete record.rows[id];
      record.totalCatalogue = catalogue.total;
      run.candidate = catalogue.candidate;
      await scope.store.update(state => { check(run, state); state.career.prescan = record; });
      run.persisted = true; run.expectedRunId = record.id;
      current(run);
      notify();
      void execute(run).catch(() => { if (active === run) { run.abort.abort(); active = null; notify(); } });
      return status();
    } catch (error) {
      if (active === run) { run.abort.abort(); active = null; notify(); }
      const safe = safeError(error);
      throw new CareerError(safe.code, safe.message);
    }
  }
  async function cancel() {
    const run = active;
    if (run) { active = null; run.abort.abort(); await finish(run, 'cancelled'); }
    try { return status(); } catch { return { status: 'interrupted', requestsMayBeBilled: true }; }
  }
  return { start, cancel, status, results, isActive: () => active !== null || providerCalls > 0 };
}
