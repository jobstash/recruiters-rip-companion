import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createReferralActions } from '../src/referrals.mjs';

const origin = 'http://127.0.0.1:3001';
const summary = { code: '1234abcd5678', earnedMonths: 4, availableMonths: 2 };
const link = `${origin}/r/${summary.code}`;
const turn = () => new Promise(resolve => setImmediate(resolve));

test('signed lookup has no career payload; only the current account’s displayed invite can be copied', async () => {
  let owner = 'first', result = summary, copied;
  const calls = [];
  const actions = createReferralActions({ origin, accountKey: () => owner, platform: async (...args) => { calls.push(args); return result; },
    copyText: value => { copied = value; return true; } });
  assert.deepEqual(await actions.read(), { ...summary, link });
  assert.deepEqual(calls, [['referrals', {}]]);
  assert.throws(() => actions.copy('other'), { code: 'IDENTITY_CHANGED' });
  assert.deepEqual(actions.copy(summary.code), { copied: true });
  assert.equal(copied, link);
  owner = null;
  await assert.rejects(actions.read(), { code: 'PAIRING_REQUIRED' });
  assert.throws(() => actions.copy(summary.code), { code: 'IDENTITY_CHANGED' });
  owner = 'second';
  const racing = actions.read(); owner = 'third';
  await assert.rejects(racing, { code: 'IDENTITY_CHANGED' });
  result = { ...summary, availableMonths: null };
  await assert.rejects(actions.read(), { code: 'DEVICE_REQUEST_FAILED' });
  result = { ...summary, code: '../account' };
  await assert.rejects(actions.read(), { code: 'DEVICE_REQUEST_FAILED' });
});

test('a milestone opens only a fixed editable X draft, without a referral link or platform request', async () => {
  const urls = [];
  const actions = createReferralActions({ origin, openExternal: async url => urls.push(new URL(url)) });
  for (const [stage, phrase] of [['interviewing', 'job interview'], ['offer', 'job offer'], ['hired', 'new job']]) {
    await actions.share(stage);
    const url = urls.at(-1);
    assert.equal(url.origin + url.pathname, 'https://x.com/intent/tweet');
    assert.deepEqual([...url.searchParams.keys()], ['text']);
    const draft = url.searchParams.get('text');
    assert.ok(draft.includes(phrase));
    assert.doesNotMatch(draft, /\/r\/|free month|https?:|\d{4}/i);
  }
  for (const stage of ['applied', '__proto__', 'offer at Private Employer', { stage: 'offer' }])
    await assert.rejects(actions.share(stage), { code: 'INVALID_INPUT' });
  assert.equal(urls.length, 3);
});

const renderer = await readFile(new URL('../ui/referrals.js', import.meta.url), 'utf8');
function uiFixture(operate) {
  const nodes = new Map(), flags = new Map(), calls = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { addEventListener(event, listener) { this[event] = listener; } });
    return nodes.get(id);
  };
  const window = { companion: { invoke: async (op, input) => { calls.push([op, structuredClone(input)]); return operate(op, input); } } };
  runInNewContext(renderer, { window, document: { getElementById: node, documentElement: { toggleAttribute: (key, value) => flags.set(key, value) } } });
  return { ...window.referralsUI, calls, flags, el: name => node(`referral-${name}`) };
}
const state = { execution: { state: 'ready' }, deviceId: 'isolated', account: { id: 'first' }, paired: true, showPipelineSharing: true };
const ready = { ok: true, result: { ...summary, link } };

test('tab reads once per visit, renders real counts and lets the member hide card actions', async () => {
  const ui = uiFixture((op, input) => op === 'pipeline-sharing-set' ? { ok: true, result: input.show }
    : op === 'referral-copy' ? { ok: true, result: { copied: true } } : ready);
  ui.refresh(state);
  assert.deepEqual(ui.calls, []);
  ui.setVisible(true); await turn();
  ui.refresh(state); ui.refresh(state);
  assert.deepEqual(ui.calls, [['referrals', {}]]);
  assert.equal(ui.el('link').value, link);
  assert.equal(ui.el('available').textContent, '2'); assert.equal(ui.el('earned').textContent, '4');
  await ui.el('copy').click();
  assert.deepEqual(ui.calls.at(-1), ['referral-copy', { code: summary.code }]);
  assert.equal(ui.el('status').textContent, 'Invite link copied.');
  ui.el('sharing').checked = false; await ui.el('sharing').change();
  assert.equal(ui.flags.get('data-pipeline-sharing'), false);
  assert.deepEqual(ui.calls.at(-1), ['pipeline-sharing-set', { show: false }]);
  ui.setVisible(false); ui.setVisible(true); await turn();
  assert.equal(ui.calls.filter(([op]) => op === 'referrals').length, 2);
});

test('unpaired and failed states show no guessed balance; a lock discards an outstanding retry', async () => {
  let answer = { ok: false, error: { code: 'DEVICE_OFFLINE' } };
  const ui = uiFixture(() => answer);
  ui.refresh({ ...state, paired: false, account: null }); ui.setVisible(true);
  assert.equal(ui.el('connect').hidden, false); assert.deepEqual(ui.calls, []);
  ui.refresh(state); await turn();
  assert.equal(ui.el('retry').hidden, false); assert.equal(ui.el('balance').hidden, true);
  let finish;
  answer = new Promise(resolve => { finish = resolve; });
  ui.el('retry').click();
  ui.refresh({ execution: { state: 'locked' } });
  finish(ready); await turn();
  assert.equal(ui.el('invite').hidden, true); assert.equal(ui.el('link').value, '');
  assert.equal(ui.el('available').textContent, ''); assert.equal(ui.el('sharing').disabled, true);
});
