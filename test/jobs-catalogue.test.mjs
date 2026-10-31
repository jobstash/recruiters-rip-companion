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
function fixture({ paired = true, range = 'past_3_days', feed = [job('node:1', '2026-10-31T09:00:00Z'), job('node:2', '2026-10-30T09:00:00Z')] } = {}) {
  const state = { career: { ...createCareerState(), publicationRange: range }, ...(paired ? { pairing: { origin: 'https://recruiters.rip', account: { id: 'a', label: 'A' } } } : {}) };
  const store = { get: () => structuredClone(state), async update(change) { await change(state); } };
  const calls = [];
  let respond = async args => ({ jobs: feed, total: feed.length, nextOffset: null,
    publicationWindow: { range: args.publicationRange, since: args.since, until: args.until } });
  const platform = async (operation, args) => { calls.push({ operation, args }); return respond(args); };
  const changes = [];
  const catalogue = createJobsCatalogue({ store, platform, now: () => now, onChange: current => changes.push(current.status) });
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
  assert.deepEqual(await catalogue.load(), { status: 'ready', range: 'past_3_days', total: 2 });
  assert.deepEqual(changes, ['loading', 'ready']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, 'matching_catalogue');
  assert.equal(calls[0].args.publicationRange, 'past_3_days');
  assert.equal(Date.parse(calls[0].args.until) - Date.parse(calls[0].args.since), 3 * day);
  assert.deepEqual(Object.keys(state.career.matching.jobs).sort(), ['node:1', 'node:2']);
  const list = await createCareerBrowser({ store }).list({ kind: 'jobs', view: 'jobs' });
  assert.equal(list.counts.jobs, 2);
  assert.equal(list.total, 2);
  // A fresh load is reused; Retry, a range change or Clear reviews force a new one.
  await catalogue.load();
  assert.equal(calls.length, 1);
  await catalogue.load({ force: true });
  assert.equal(calls.length, 2);
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
    assert.deepEqual(await catalogue.load(), { status: 'failed', range: 'past_3_days', reason });
  }
});

test('a load overtaken by a range change or a lock never writes or reports the old window', async () => {
  const { catalogue, state, respondWith } = fixture();
  let release;
  respondWith(args => new Promise(resolve => { release = () => resolve({ jobs: [], total: 0, nextOffset: null,
    publicationWindow: { range: args.publicationRange, since: args.since, until: args.until } }); }));
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
