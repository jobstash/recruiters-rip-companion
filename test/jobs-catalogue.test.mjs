import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createCareerState } from '../src/mcp/state.mjs';
import { createJobsCatalogue, catalogueFailure } from '../src/jobs-catalogue.mjs';
import { createCareerBrowser } from '../src/career-browser.mjs';
import { ASSESSMENT_POLICY_ID, deriveDecision } from '../src/mcp/matching-contract.mjs';

const now = Date.parse('2026-10-31T12:00:00.000Z'), day = 86400000;
const job = (id, publishedAt) => ({ id, title: `Role ${id}`, company: 'Example Labs', publishedAt });
const response = (args, jobs = [], total = jobs.length) => ({ jobs, total, nextOffset: null,
  publicationWindow: { range: args.publicationRange, since: args.since, until: args.until } });
function fixture({ paired = true, range = 'past_3_days', catalogueTotal = 137, clock = () => now,
  feed = [job('node:1', '2026-10-31T09:00:00Z'), job('node:2', '2026-10-30T09:00:00Z')] } = {}) {
  const state = { career: { ...createCareerState(), publicationRange: range }, ...(paired ? { pairing: { origin: 'https://recruiters.rip', account: { id: 'a', label: 'A' } } } : {}) };
  const store = { get: () => structuredClone(state), async update(change) { await change(state); } };
  const calls = [];
  let respond = async args => args.countOnly ? response(args, [], catalogueTotal) : response(args, feed);
  const platform = async (operation, args) => { calls.push({ operation, args }); return respond(args); };
  const changes = [];
  const catalogue = createJobsCatalogue({ store, platform, now: clock, onChange: current => changes.push(current) });
  return { state, store, calls, changes, catalogue, respondWith: next => { respond = next; } };
}
const failure = (status, message, code) => Object.assign(new Error(message), { status, code });

test('without an account Companion loads nothing and Jobs says to connect', async () => {
  const { catalogue, calls } = fixture({ paired: false });
  assert.deepEqual(await catalogue.load({ force: true }), { status: 'idle' });
  assert.deepEqual(calls, []);
});

test('a connected account loads the selected window so Jobs shows its real count before any AI review', async () => {
  const { catalogue, calls, state, store, changes } = fixture();
  assert.deepEqual(await catalogue.load(), { status: 'ready', range: 'past_3_days', total: 2, catalogueTotal: 137 });
  assert.deepEqual(changes[0], { status: 'loading', range: 'past_3_days', catalogueTotal: null });
  assert.equal(changes.at(-1).status, 'ready');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].operation, 'matching_catalogue');
  assert.equal(calls[0].args.publicationRange, 'past_3_days');
  assert.equal(Date.parse(calls[0].args.until) - Date.parse(calls[0].args.since), 3 * day);
  assert.equal(calls[0].args.countOnly, undefined);
  assert.deepEqual(calls[1], { operation: 'matching_catalogue', args: {
    publicationRange: 'all', since: null, until: new Date(now).toISOString(), countOnly: true,
  } });
  assert.equal(state.career.publicationRange, 'past_3_days');
  assert.deepEqual(Object.keys(state.career.matching.jobs).sort(), ['node:1', 'node:2']);
  const list = await createCareerBrowser({ store }).list({ kind: 'jobs', view: 'jobs' });
  assert.equal(list.counts.jobs, 2);
  assert.equal(list.total, 2);
  // A fresh load is reused; an explicit Retry refreshes both counts.
  await catalogue.load();
  assert.equal(calls.length, 2);
  await catalogue.load({ force: true });
  assert.equal(calls.length, 4);
});

test('changing the window replaces the feed, keeps every saved review and counts only the window under Jobs', async () => {
  const { catalogue, state, store } = fixture({ feed: [job('node:3', '2026-10-31T10:00:00Z')] });
  const row = { status: 'assessed', requirements: [{ requirement: 'Own services', importance: 'essential', evidence: 'demonstrated', cvQuote: 'Built services.' }],
    gates: { direction: 'pass', constraints: 'pass', eligibility: 'pass' }, dimensions: { direction: 80, capability: 80, scope: 80, preferences: 80 },
    relocation: 'not_required', reason: 'Saved review.' };
  state.career.matching = { jobs: { 'node:old': job('node:old', '2026-10-01T09:00:00Z'), 'node:unreviewed': job('node:unreviewed', '2026-10-02T09:00:00Z') },
    scores: { 'node:old': { ...row, ...deriveDecision(row), profileVersion: '0:0', policyId: ASSESSMENT_POLICY_ID, scoredAt: '2026-10-02T12:00:00.000Z' } }, pairs: {} };
  await catalogue.load({ force: true });
  assert.deepEqual(Object.keys(state.career.matching.jobs).sort(), ['node:3', 'node:old']);
  assert.ok(state.career.matching.scores['node:old']);
  const list = await createCareerBrowser({ store }).list({ kind: 'jobs', view: 'jobs' });
  assert.deepEqual(list.items.map(item => item.id), ['node:3']);
  assert.equal(list.counts.jobs, 1);
  assert.equal((await createCareerBrowser({ store }).list({ kind: 'jobs', view: 'reviewed' })).items.length, 1);
});

test('a failed load names the reason the Jobs empty state acts on', async () => {
  for (const [error, reason] of [
    [failure(403, 'Check your membership and account connection. Platform (403): An active paid membership is required', 'DEVICE_UNAUTHORIZED'), 'membership'],
    [failure(401, 'Reconnect your account in companion settings. Platform (401).', 'DEVICE_UNAUTHORIZED'), 'reconnect'],
    [failure(undefined, 'Could not reach the platform. Check your connection.', 'DEVICE_OFFLINE'), 'offline'],
    [failure(undefined, 'Connect your account in companion settings.', 'PAIRING_REQUIRED'), 'not_connected'],
    [new Error('The platform returned an incomplete catalogue.'), 'failed'],
  ]) {
    assert.equal(catalogueFailure(error), reason);
    const { catalogue, respondWith } = fixture();
    respondWith(async () => { throw error; });
    assert.deepEqual(await catalogue.load(), { status: 'failed', range: 'past_3_days', reason, catalogueTotal: null });
  }
});

test('a load overtaken by a range change or a lock never writes or reports the old window', async () => {
  const { catalogue, state, respondWith } = fixture();
  let release;
  respondWith(args => args.countOnly ? response(args, [], 137) : new Promise(resolve => {
    release = () => resolve(response(args));
  }));
  const pending = catalogue.load();
  await new Promise(setImmediate);
  catalogue.reset();
  release();
  assert.deepEqual(await pending, { status: 'idle' });
  assert.equal(state.career.matching, undefined);
  // The user moved the slider while the feed was loading: the old window is discarded.
  const second = catalogue.load({ force: true });
  await new Promise(setImmediate);
  state.career.publicationRange = 'past_week';
  release();
  assert.deepEqual(await second, { status: 'idle' });
  assert.equal(state.career.matching, undefined);
});

test('the Jobs empty state leads each failure to its own next step', async () => {
  const window = {};
  runInNewContext(await readFile(new URL('../ui/jobs-empty.js', import.meta.url), 'utf8'), { window });
  const action = context => window.jobsEmptyState(context, 'in the past 2 weeks').action;
  assert.equal(action({ paired: false }), 'connect');
  assert.equal(action({ paired: true, catalogue: { status: 'loading' } }), undefined);
  assert.equal(action({ paired: true, catalogue: { status: 'failed', reason: 'membership' } }), 'connect');
  assert.equal(action({ paired: true, catalogue: { status: 'failed', reason: 'reconnect' } }), 'connect');
  assert.equal(action({ paired: true, catalogue: { status: 'failed', reason: 'offline' } }), 'retry');
  assert.equal(action({ paired: true, catalogue: { status: 'failed', reason: 'failed' } }), 'retry');
  // An empty window names the slider's current range, so changing it is the obvious next step.
  assert.match(window.jobsEmptyState({ paired: true, catalogue: { status: 'ready', total: 0 } }, 'in the past 3 days').text, /in the past 3 days/);
});

test('slider changes reload only the selected rows and keep the fresh full-catalogue count', async () => {
  const { catalogue, state, calls, changes, respondWith } = fixture();
  await catalogue.load();
  respondWith(args => response(args, [job('node:week', '2026-10-26T09:00:00Z')]));
  state.career.publicationRange = 'past_week';
  assert.deepEqual(await catalogue.load(), { status: 'ready', range: 'past_week', total: 1, catalogueTotal: 137 });
  assert.deepEqual(changes.find(change => change.status === 'loading' && change.range === 'past_week'),
    { status: 'loading', range: 'past_week', catalogueTotal: 137 });
  assert.deepEqual(Object.keys(state.career.matching.jobs), ['node:week']);
  assert.equal(state.career.matching.window.range, 'past_week');
  assert.equal(state.career.publicationRange, 'past_week');
  assert.equal(calls.filter(call => call.args.countOnly).length, 1);
  assert.deepEqual(calls.filter(call => !call.args.countOnly).map(call => call.args.publicationRange), ['past_3_days', 'past_week']);
});

test('selected jobs become ready without waiting for the independent full count', async () => {
  const { catalogue, respondWith, state } = fixture();
  let releaseCount;
  respondWith(args => args.countOnly ? new Promise(resolve => { releaseCount = () => resolve(response(args, [], 180)); })
    : response(args, [job('node:selected', '2026-10-31T09:00:00Z')]));
  assert.deepEqual(await catalogue.load(), { status: 'ready', range: 'past_3_days', total: 1, catalogueTotal: null });
  assert.deepEqual(Object.keys(state.career.matching.jobs), ['node:selected']);
  releaseCount();
  await new Promise(setImmediate);
  assert.deepEqual(catalogue.state(), { status: 'ready', range: 'past_3_days', total: 1, catalogueTotal: 180 });
});

test('a pending full count is shared across slider loads without publishing stale selected counts', async () => {
  const { catalogue, respondWith, state, calls } = fixture();
  const releases = new Map();
  let releaseCount;
  respondWith(args => new Promise(resolve => {
    if (args.countOnly) releaseCount = () => resolve(response(args, [], 180));
    else releases.set(args.publicationRange, jobs => resolve(response(args, jobs)));
  }));
  const first = catalogue.load();
  state.career.publicationRange = 'past_week';
  const second = catalogue.load();
  assert.deepEqual(catalogue.state(), { status: 'loading', range: 'past_week', catalogueTotal: null });
  releases.get('past_3_days')([job('node:old', '2026-10-31T09:00:00Z')]);
  await first;
  assert.equal(state.career.matching, undefined);
  releaseCount();
  await new Promise(setImmediate);
  assert.deepEqual(catalogue.state(), { status: 'loading', range: 'past_week', catalogueTotal: 180 });
  releases.get('past_week')([job('node:week', '2026-10-26T09:00:00Z')]);
  assert.deepEqual(await second, { status: 'ready', range: 'past_week', total: 1, catalogueTotal: 180 });
  assert.deepEqual(Object.keys(state.career.matching.jobs), ['node:week']);
  assert.equal(calls.filter(call => call.args.countOnly).length, 1);
});

test('a failed or malformed full count remains unknown while selected jobs load normally', async () => {
  for (const countResponse of [
    () => { throw new Error('Count unavailable'); },
    args => response(args, [], -1),
    args => response(args, [], 1.5),
    args => response(args, [], Number.MAX_SAFE_INTEGER + 1),
    args => response(args, [], null),
    () => ({ total: 137 }),
    args => ({ ...response(args, [], 137), publicationWindow: { range: 'past_week', since: null, until: args.until } }),
  ]) {
    const { catalogue, respondWith, state, calls } = fixture();
    respondWith(args => args.countOnly ? countResponse(args) : response(args, [job('node:selected', '2026-10-31T09:00:00Z')]));
    assert.deepEqual(await catalogue.load(), { status: 'ready', range: 'past_3_days', total: 1, catalogueTotal: null });
    state.career.publicationRange = 'past_week';
    assert.deepEqual(await catalogue.load(), { status: 'ready', range: 'past_week', total: 1, catalogueTotal: null });
    assert.equal(calls.filter(call => call.args.countOnly).length, 1);
    assert.deepEqual(Object.keys(state.career.matching.jobs), ['node:selected']);
  }
});

test('a real empty full catalogue is zero, not an unavailable count', async () => {
  const { catalogue } = fixture({ feed: [], catalogueTotal: 0 });
  assert.deepEqual(await catalogue.load(), { status: 'ready', range: 'past_3_days', total: 0, catalogueTotal: 0 });
});

test('the full count can succeed independently of a selected feed failure', async () => {
  const { catalogue, respondWith } = fixture();
  respondWith(args => {
    if (args.countOnly) return response(args, [], 137);
    throw failure(undefined, 'Selected feed unavailable', 'DEVICE_OFFLINE');
  });
  assert.deepEqual(await catalogue.load(), { status: 'failed', range: 'past_3_days', reason: 'offline', catalogueTotal: 137 });
});

test('a forced refresh invalidates the full count and rejects its older in-flight result', async () => {
  const { catalogue, respondWith, calls } = fixture();
  const releases = [];
  respondWith(args => args.countOnly ? new Promise(resolve => { releases.push(total => resolve(response(args, [], total))); })
    : response(args, [job('node:selected', '2026-10-31T09:00:00Z')]));
  await catalogue.load();
  assert.equal(catalogue.state().catalogueTotal, null);
  await catalogue.load({ force: true });
  releases[1](200);
  await new Promise(setImmediate);
  releases[0](100);
  await new Promise(setImmediate);
  assert.deepEqual(catalogue.state(), { status: 'ready', range: 'past_3_days', total: 1, catalogueTotal: 200 });
  assert.equal(calls.filter(call => call.args.countOnly).length, 2);
  respondWith(args => {
    if (args.countOnly) throw new Error('Count unavailable');
    return response(args, []);
  });
  assert.deepEqual(await catalogue.load({ force: true }), { status: 'ready', range: 'past_3_days', total: 0, catalogueTotal: null });
});

test('full-count freshness expires independently of a more recently loaded selected range', async () => {
  let timestamp = now;
  const { catalogue, state, calls, respondWith } = fixture({ clock: () => timestamp });
  await catalogue.load();
  timestamp += 14 * 60 * 1000;
  state.career.publicationRange = 'past_week';
  await catalogue.load();
  assert.equal(calls.length, 3);
  timestamp += 60 * 1000;
  respondWith(args => response(args, [], 200));
  await catalogue.load();
  await new Promise(setImmediate);
  assert.deepEqual(catalogue.state(), { status: 'ready', range: 'past_week', total: 2, catalogueTotal: 200 });
  assert.equal(calls.filter(call => call.args.countOnly).length, 2);
  assert.equal(calls.filter(call => !call.args.countOnly).length, 2);
});

test('reset discards a pending full count and reconnecting reloads it', async () => {
  const { catalogue, respondWith, state, calls } = fixture();
  let releaseCount;
  respondWith(args => args.countOnly ? new Promise(resolve => { releaseCount = () => resolve(response(args, [], 100)); })
    : response(args, []));
  await catalogue.load();
  catalogue.reset();
  releaseCount();
  await new Promise(setImmediate);
  assert.deepEqual(catalogue.state(), { status: 'idle' });
  respondWith(args => response(args, [], args.countOnly ? 200 : 0));
  assert.deepEqual(await catalogue.load(), { status: 'ready', range: 'past_3_days', total: 0, catalogueTotal: 200 });
  const pairing = state.pairing;
  delete state.pairing;
  assert.deepEqual(await catalogue.load(), { status: 'idle' });
  state.pairing = pairing;
  await catalogue.load();
  assert.equal(calls.filter(call => call.args.countOnly).length, 3);
});

test('an account, origin or device change invalidates fresh counts and ignores older responses', async () => {
  for (const changeIdentity of [
    state => { state.pairing.account = { id: 'b', label: 'B' }; },
    state => { state.pairing.origin = 'https://other.example'; },
    state => { state.deviceId = 'new-device'; },
  ]) {
    const { catalogue, respondWith, state, calls } = fixture();
    const releases = [];
    respondWith(args => args.countOnly ? new Promise(resolve => { releases.push(total => resolve(response(args, [], total))); })
      : response(args, []));
    await catalogue.load();
    changeIdentity(state);
    await catalogue.load();
    releases[1](200);
    await new Promise(setImmediate);
    releases[0](100);
    await new Promise(setImmediate);
    assert.equal(catalogue.state().catalogueTotal, 200);
    assert.equal(calls.filter(call => call.args.countOnly).length, 2);
    state.pairing.account = { id: 'third', label: 'Third' };
    await catalogue.load();
    assert.equal(catalogue.state().catalogueTotal, null);
    releases[2](300);
    await new Promise(setImmediate);
    assert.equal(catalogue.state().catalogueTotal, 300);
  }
});

test('identity changes without a new load cannot receive old rows or a late full count', async () => {
  const { catalogue, respondWith, state } = fixture();
  let releaseCount, releaseJobs;
  respondWith(args => new Promise(resolve => {
    if (args.countOnly) releaseCount = () => resolve(response(args, [], 100));
    else releaseJobs = () => resolve(response(args, [job('node:old', '2026-10-31T09:00:00Z')]));
  }));
  const pending = catalogue.load();
  state.pairing.account = { id: 'b', label: 'B' };
  releaseCount();
  releaseJobs();
  assert.deepEqual(await pending, { status: 'idle' });
  assert.equal(state.career.matching, undefined);
});
