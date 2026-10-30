import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../ui/updates.js', import.meta.url), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(invoke = async () => ({ ok: true, result: current() })) {
  const nodes = new Map();
  for (const name of ['version', 'automatic', 'reason', 'status', 'check', 'download', 'install', 'source-guide', 'cancel', 'progress', 'error']) {
    const listeners = new Map(), attributes = new Map();
    nodes.set(`update-${name}`, { hidden: false, disabled: false, checked: false, textContent: '',
      addEventListener: (event, callback) => listeners.set(event, callback),
      setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name),
      dispatch: event => listeners.get(event)?.(), attributes });
  }
  const context = vm.createContext({ document: { getElementById: id => nodes.get(id) }, window: { companion: { invoke } } });
  vm.runInContext(script, context);
  return { node: name => nodes.get(`update-${name}`), refresh: value => context.window.updatesUI.refresh(value), clear: () => context.window.updatesUI.clear() };
}
const current = (overrides = {}) => ({ version: '3.12.0', latestVersion: '3.12.0', status: 'current', automaticSupported: true,
  automaticReason: '', automation: { enabled: true, waitingForIdle: false }, blocked: false, ...overrides });

test('default update view has one preference and Check now, without a manual button maze', () => {
  const ui = fixture(); ui.refresh(current());
  assert.equal(ui.node('automatic').checked, true);
  assert.equal(ui.node('automatic').disabled, false);
  assert.equal(ui.node('check').disabled, false);
  for (const name of ['download', 'install', 'source-guide', 'cancel', 'progress', 'error']) assert.equal(ui.node(name).hidden, true, name);
});

test('ahead-of-release builds never offer downgrade actions', () => {
  const ui = fixture(); ui.refresh(current({ latestVersion: '3.10.0', status: 'ahead' }));
  assert.equal(ui.node('download').hidden, true);
  ui.refresh(current({ latestVersion: '3.10.0', status: 'error' }));
  assert.equal(ui.node('download').hidden, true);
});

test('unmanaged checkouts expose source setup instead of unusable update actions', () => {
  const ui = fixture();
  ui.refresh(current({ installationKind: 'source', latestVersion: '3.13.0', status: 'available', automaticSupported: false }));
  assert.equal(ui.node('download').hidden, true);
  assert.equal(ui.node('source-guide').hidden, false);
  assert.equal(ui.node('install').hidden, true);
});

test('downloads stay usable during active form work; only restart waits', () => {
  const ui = fixture();
  ui.refresh(current({ latestVersion: '3.13.0', status: 'available', blocked: true, automation: { enabled: false } }));
  assert.equal(ui.node('check').disabled, false);
  assert.equal(ui.node('download').disabled, false);
  ui.refresh(current({ latestVersion: '3.13.0', status: 'downloaded', blocked: true, automation: { enabled: true, waitingForIdle: true } }));
  assert.equal(ui.node('install').disabled, true);
  assert.equal(ui.node('check').disabled, true, 'a pending download is not discarded by rechecking');
});

test('download progress and manual recovery reflect actual controller state', () => {
  const ui = fixture();
  ui.refresh(current({ status: 'downloading', progress: { received: 50, total: 100 } }));
  assert.equal(ui.node('progress').hidden, false);
  assert.equal(ui.node('progress').value, 50);
  assert.equal(ui.node('progress').max, 100);
  assert.equal(ui.node('automatic').disabled, false);
  ui.refresh(current({ status: 'manual-required', error: { code: 'MANUAL_INSTALL_REQUIRED', message: 'Move the verified app into Applications.' } }));
  assert.equal(ui.node('install').hidden, false);
  assert.equal(ui.node('error').hidden, false);
  ui.refresh(current({ status: 'installing' }));
  assert.equal(ui.node('automatic').disabled, true);
  assert.equal(ui.node('install').hidden, true);
  assert.equal(ui.node('check').disabled, true);
});

test('preference change uses exact local IPC and displays failed persistence without false success', async () => {
  const calls = [];
  const ui = fixture(async (op, input) => { calls.push([op, input]); return { ok: false, error: { message: 'The preference could not be saved.' } }; });
  ui.refresh(current());
  ui.node('automatic').checked = false; ui.node('automatic').dispatch('change');
  await turn();
  assert.equal(calls[0][0], 'update-preferences');
  assert.equal(JSON.stringify(calls[0][1]), '{"automaticUpdates":false}');
  assert.equal(ui.node('automatic').checked, true);
  assert.equal(ui.node('automatic').disabled, false);
  assert.equal(ui.node('error').hidden, false);
});

test('automatic updates can be disabled while a user-started check is still downloading', async () => {
  let finishCheck;
  const calls = [];
  const ui = fixture(async (op, input) => {
    calls.push(op);
    if (op === 'update-check') return new Promise(resolve => { finishCheck = resolve; });
    return { ok: true, result: current({ status: 'downloading', automation: { enabled: input.automaticUpdates } }) };
  });
  ui.refresh(current()); ui.node('check').dispatch('click');
  ui.refresh(current({ status: 'downloading' }));
  assert.equal(ui.node('automatic').disabled, false);
  ui.node('automatic').checked = false; ui.node('automatic').dispatch('change'); await turn();
  assert.deepEqual(calls, ['update-check', 'update-preferences']);
  assert.equal(ui.node('automatic').checked, false);
  finishCheck({ ok: true, result: current({ status: 'downloaded', automation: { enabled: false } }) }); await turn();
  assert.equal(ui.node('automatic').checked, false);
});

test('late operations cannot repopulate the view after local storage locks', async () => {
  let resolve;
  const ui = fixture(() => new Promise(done => { resolve = done; }));
  ui.refresh(current()); ui.node('check').dispatch('click'); ui.clear();
  resolve({ ok: true, result: current({ status: 'available' }) }); await turn();
  assert.equal(ui.node('version').textContent, '');
  assert.equal(ui.node('check').disabled, true);
});


test('managed source builds use automatic update controls and staging remains cancellable', () => {
  const ui = fixture();
  ui.refresh(current({ installationKind: 'source', status: 'staging', automaticSupported: true }));
  assert.equal(ui.node('automatic').disabled, false);
  assert.equal(ui.node('cancel').hidden, false);
});

test('managed source builds retain manual build controls when automation is off', () => {
  const ui = fixture();
  ui.refresh(current({ installationKind: 'source', status: 'downloading' }));
  assert.equal(ui.node('source-guide').hidden, true);
  ui.refresh(current({ installationKind: 'source', status: 'available', latestVersion: '3.13.0', automation: { enabled: false } }));
  assert.equal(ui.node('download').hidden, false);
});

