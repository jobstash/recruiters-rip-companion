import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const clientId = '9b3303d8-5dc7-4f28-9fce-d17e11549bd6';
async function browserBridge(fetch) {
  const listeners = new Map(), timers = new Map(), clicks = [], calls = [];
  let source, sequence = 0;
  class EventSource {
    static CLOSED = 2;
    constructor(url) { this.url = url; this.listeners = new Map(); this.readyState = 0; source = this; }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    emit(name, value) { return this.listeners.get(name)?.(value === undefined ? {} : { data: JSON.stringify(value) }); }
  }
  const window = {};
  const context = {
    window, EventSource, crypto: { randomUUID: () => clientId },
    location: { hash: '', reload() {} }, history: { replaceState() {} },
    URLSearchParams, URL: { createObjectURL: () => 'blob:synthetic-export', revokeObjectURL() {} },
    setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, init = {}) => { calls.push({ url, init }); return fetch(url, init); },
    document: { documentElement: { dataset: {} }, addEventListener: (name, listener) => listeners.set(name, listener), body: { append() {} },
      createElement: tag => ({ tag, remove() {}, click() { clicks.push({ tag, href: this.href, download: this.download }); } }) },
  };
  vm.runInNewContext(await readFile(new URL('../ui/web-shell.js', import.meta.url), 'utf8'), context);
  return { bridge: window.companion, calls, clicks, timers, start: () => listeners.get('DOMContentLoaded')(), source: () => source };
}

test('browser IPC waits for its SSE registration and waits again during a reconnect', async () => {
  const f = await browserBridge(async () => ({ status: 200, json: async () => ({ ok: true, result: {} }) }));
  const initial = f.bridge.invoke('master-cv-read');
  await Promise.resolve();
  assert.equal(f.calls.length, 0);
  f.start();
  assert.equal(f.source().url, `/api/events?client=${clientId}`);
  f.source().emit('open');
  assert.equal((await initial).ok, true);
  assert.equal(f.calls[0].init.headers['X-Companion-Client'], clientId);
  f.source().emit('error');
  const next = f.bridge.invoke('master-cv-export', { requestId: 'synthetic' });
  await Promise.resolve();
  assert.equal(f.calls.length, 1);
  f.source().emit('open');
  assert.equal((await next).ok, true);
  assert.equal(f.calls.length, 2);
});

test('an unavailable SSE connection returns a bounded truthful error without sending an unbound IPC request', async () => {
  const f = await browserBridge(async () => { throw new Error('Must not invoke'); });
  const pending = f.bridge.invoke('master-cv-export');
  const timeout = [...f.timers.values()].find(timer => timer.delay === 30_000);
  timeout.callback();
  assert.equal((await pending).ok, false);
  assert.equal(f.calls.length, 0);
});

test('download acknowledgement follows complete response bytes and browser handoff, never just the SSE offer', async () => {
  let consume, acknowledged;
  const blob = new Promise(resolve => { consume = resolve; });
  const receipt = new Promise(resolve => { acknowledged = resolve; });
  const f = await browserBridge(async (url, init) => {
    if (url.startsWith('/files/')) return { ok: true, blob: () => blob };
    if (url.startsWith('/api/downloads/')) { acknowledged(JSON.parse(init.body)); return { ok: true }; }
    throw new Error('Unexpected request');
  });
  f.start(); f.source().emit('open');
  const offer = { url: '/files/synthetic/Master%20CV.pdf', name: 'Master CV.pdf', download: true, receipt: 'synthetic' };
  f.source().emit('open-file', offer);
  f.source().emit('open-file', offer);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls.length, 1, 'A replayed event must not duplicate download work');
  assert.equal(f.clicks.length, 0);
  consume({ size: 100 });
  assert.deepEqual(await receipt, { received: true });
  assert.deepEqual(f.clicks, [{ tag: 'a', href: 'blob:synthetic-export', download: 'Master CV.pdf' }]);
  assert.equal(f.calls[1].init.headers['X-Companion-Client'], clientId);
});

test('failed guarded file responses reject delivery instead of acknowledging an export', async () => {
  let acknowledged;
  const receipt = new Promise(resolve => { acknowledged = resolve; });
  const f = await browserBridge(async (url, init) => {
    if (url.startsWith('/files/')) return { ok: false, status: 409 };
    acknowledged(JSON.parse(init.body)); return { ok: true };
  });
  f.start(); f.source().emit('open');
  f.source().emit('open-file', { url: '/files/stale/Master.pdf', name: 'Master.pdf', download: true, receipt: 'stale' });
  assert.deepEqual(await receipt, { received: false });
  assert.equal(f.clicks.length, 0);
});
