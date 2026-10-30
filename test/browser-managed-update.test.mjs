import test from 'node:test';
import assert from 'node:assert/strict';
import { installManagedUpdates } from '../browser-extension/src/managed-update.mjs';
import { createNativeClient } from '../browser-extension/src/protocol.mjs';
import { randomUUID } from 'node:crypto';

function fixture(browserName = 'chrome', saved = {}, native = null) {
  let safe = true, idle = 'idle', loaded = '3.11.0', available = '3.12.0', marker = '3.12.0', managed = true, present = true, reloads = 0;
  let alarm, requested = 0, afterSave = () => {}, readStatus = async () => ({ browserExtensions: { [browserName]: { managed, version: available } } });
  const browser = {
    runtime: { getManifest: () => ({ version: loaded }), getURL: file => `extension://synthetic/${file}`, reload: () => { reloads++; } },
    alarms: { onAlarm: { addListener: fn => { alarm = fn; } }, create: async (name, settings) => { assert.equal(name, 'managed-extension-update'); assert.equal(settings.periodInMinutes, 5); } },
    idle: { queryState: async seconds => { assert.equal(seconds, 300); return idle; } },
    storage: { local: { get: async key => ({ [key]: saved[key] }), set: async values => { Object.assign(saved, values); afterSave(); }, remove: async key => { delete saved[key]; } } },
  };
  const updater = installManagedUpdates({ browser, browserName, isSafe: () => safe && (!native || native.idle()),
    status: () => { requested++; return native ? native.request('status', {}) : readStatus(); },
    fetchImpl: async (url, options) => { assert.equal(url, 'extension://synthetic/managed-update.json'); assert.equal(options.cache, 'no-store'); return { ok: present, json: async () => ({ version: marker }) }; } });
  return { ...updater, saved, get reloads() { return reloads; }, get requested() { return requested; }, alarm: name => alarm({ name }),
    safe: value => { safe = value; }, idle: value => { idle = value; }, loaded: value => { loaded = value; }, available: value => { available = value; },
    marker: value => { marker = value; }, managed: value => { managed = value; }, present: value => { present = value; }, afterSave: fn => { afterSave = fn; }, status: fn => { readStatus = fn; } };
}

test('Chrome and Firefox managed folders reload once at idle and remember failed version attempts across worker restarts', async () => {
  for (const browserName of ['chrome', 'firefox']) {
    const f = fixture(browserName);
    f.safe(false); await f.check(); assert.equal(f.requested, 0, 'active application/panel/request blocks polling and reload');
    f.safe(true); f.idle('active'); await f.check(); assert.equal(f.reloads, 0);
    f.idle('idle'); await f.check(); assert.equal(f.reloads, 1);
    await f.check(); assert.equal(f.reloads, 1);
    const restarted = fixture(browserName, f.saved); await restarted.check(); assert.equal(restarted.reloads, 0);
    restarted.available('3.13.0'); restarted.marker('3.13.0'); await restarted.check(); assert.equal(restarted.reloads, 1);
  }
});

test('separate ZIPs, missing markers, mismatched folders, current and ahead versions never reload', async () => {
  for (const change of [f => f.managed(false), f => f.present(false), f => f.marker('3.10.0'), f => f.loaded('3.12.0'), f => f.loaded('3.13.0'), f => f.available('not-a-version')]) {
    const f = fixture(); change(f); await f.check(); assert.equal(f.reloads, 0); assert.deepEqual(f.saved, {});
  }
});

test('reload checks are single-flight and recheck application activity after every asynchronous phase', async () => {
  const f = fixture(); let release;
  f.status(() => new Promise(resolve => { release = resolve; }));
  const pending = f.check(); await f.check(); assert.equal(f.requested, 1);
  f.safe(false); release({ browserExtensions: { chrome: { managed: true, version: '3.12.0' } } }); await pending;
  assert.equal(f.reloads, 0);
  const race = fixture(); race.afterSave(() => race.safe(false)); await race.check();
  assert.equal(race.reloads, 0); assert.deepEqual(race.saved, {}, 'an interrupted attempt may be retried once idle');
  race.afterSave(() => {}); race.safe(true); await race.check(); assert.equal(race.reloads, 1);
});

test('real native request and command ownership gates managed reload across disconnect and reconnect', async t => {
  const event = () => {
    const listeners = [];
    return { addListener: listener => listeners.push(listener), emit: value => { for (const listener of listeners) listener(value); } };
  };
  const ports = [], handlers = [];
  let autoStatus = false;
  const native = createNativeClient({ host: 'synthetic', randomUUID, onCommand: () => new Promise(resolve => handlers.push(resolve)),
    connect: () => {
      const port = { onMessage: event(), onDisconnect: event(), sent: [],
        postMessage(message) {
          this.sent.push(message);
          if (autoStatus && message.op === 'status') queueMicrotask(() => this.onMessage.emit({ version: 1, id: message.id, ok: true,
            result: { browserExtensions: { chrome: { managed: true, version: '3.12.0' } } } }));
        },
        disconnect() { this.onDisconnect.emit(); },
      };
      ports.push(port); return port;
    },
  });
  t.after(() => native.disconnect());
  const f = fixture('chrome', {}, native);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const reply = port => port.onMessage.emit({ version: 1, id: port.sent.at(-1).id, ok: true, result: { opened: true } });
  assert.equal(native.idle(), true, 'idle must work before the first connection');
  const pending = native.request('open_settings', {});
  assert.equal(native.idle(), false);
  await f.check(); assert.equal(f.requested, 0);
  reply(ports[0]); await pending;
  assert.equal(native.idle(), true);

  const command = { version: 1, id: randomUUID(), op: 'forms_status', payload: { formId: 'synthetic-form' } };
  ports[0].onMessage.emit(command);
  await settle(); assert.equal(handlers.length, 1); assert.equal(native.idle(), false);
  await f.check(); assert.equal(f.requested, 0, 'native commands prevent reload too');
  const disconnected = native.request('open_settings', {});
  const rejected = assert.rejects(disconnected, { code: 'COMPANION_UNAVAILABLE' });
  ports[0].disconnect(); await rejected;
  assert.equal(native.connected(), false);
  assert.equal(native.idle(), false, 'disconnection does not cancel a handler already executing');

  const reconnect = native.request('open_settings', {});
  reply(ports[1]); await reconnect;
  ports[1].onMessage.emit(command);
  await settle(); assert.equal(handlers.length, 2, 'command IDs are scoped to each connection');
  const oldReplies = ports[0].sent.length;
  handlers[0]({ attached: true }); await settle();
  assert.equal(ports[0].sent.length, oldReplies, 'late old-connection work cannot send a reply');
  assert.equal(native.idle(), false, 'old completion cannot clear the new connection’s command');
  ports[0].disconnect(); assert.equal(native.connected(), true, 'late disconnect cannot close the new port');
  await f.check(); assert.equal(f.requested, 0);
  handlers[1]({ attached: true }); await settle();
  assert.equal(native.idle(), true);
  assert.equal(ports[1].sent.at(-1).id, command.id);
  assert.equal(ports[1].sent.at(-1).ok, true);
  autoStatus = true;
  await f.check();
  assert.equal(f.requested, 1);
  assert.equal(f.reloads, 1, 'completed native work permits an actual updater reload call');
  await f.check(); assert.equal(f.reloads, 1, 'version receipt still prevents reload loops');
});
