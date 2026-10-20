import { PRODUCT_ORIGIN, NATIVE_HOST } from './config.mjs';
import { createNativeClient, safeDeviceRequest, externalSenderAllowed, deviceResult } from './protocol.mjs';
import { captureJobs, inspectForm, fillForm } from './page.mjs';
import { createPageAccess } from './page-access.mjs';

const native = createNativeClient({ host: NATIVE_HOST, connect: host => {
  const port = chrome.runtime.connectNative(host);
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; });
  return port;
} });
chrome.runtime.onConnectExternal.addListener(port => {
  if (!externalSenderAllowed(port, PRODUCT_ORIGIN)) { port.disconnect(); return; }
  let closed = false, busy = false;
  port.onDisconnect.addListener(() => { closed = true; });
  port.onMessage.addListener(async message => {
    if (busy) { port.disconnect(); return; }
    busy = true;
    try {
      const { op, payload } = safeDeviceRequest(message, PRODUCT_ORIGIN);
      const result = deviceResult(op, await native.request(op, payload));
      if (!closed) port.postMessage({ version: 1, id: message.id, ok: true, result });
    } catch {
      if (!closed) port.postMessage({ version: 1, id: message?.id, ok: false, error: { code: 'device_unavailable', message: 'Open the companion to review this operation.' } });
    } finally { busy = false; }
  });
});

// Memory only: a native port keeps the worker alive, and panel reconnection can
// recover a completed request. No candidate values are persisted to Chrome disk.
let state = { busy: null, error: '', notice: '', tabId: null, documentId: null, page: null, jobs: [], form: null, prepared: null, edits: {}, selected: [] };
let generation = 0, preparingRequest = null;
const panels = new Set();
const publish = () => { for (const panel of panels) { try { panel.postMessage(state); } catch { panels.delete(panel); } } };
const inject = createPageAccess({
  sidePanel: chrome.sidePanel, tabs: chrome.tabs, scripting: chrome.scripting,
  onError: () => { state.error = 'Chrome could not open this panel. Click the Recruiters.rip toolbar icon again.'; publish(); },
});
async function act(message) {
  if (!message || typeof message.action !== 'string') return;
  const { action, payload = {} } = message;
  if (action === 'ping') return;
  if (action === 'edit') {
    if (state.busy || !state.prepared) return;
    const fields = new Map(state.prepared.fields.map(f => [f.id, f]));
    state.edits = Object.fromEntries(Object.entries(payload.edits || {}).filter(([id, v]) => fields.has(id) && typeof v === 'string' && v.length <= 20000));
    state.selected = [...new Set(payload.selected || [])].filter(id => fields.has(id)); return;
  }
  if (action === 'cancel') {
    if (!preparingRequest) return;
    const requestId = preparingRequest; preparingRequest = null; const cancelledGeneration = ++generation;
    state = { ...state, busy: null, error: '', notice: 'Preparation cancelled. You can prepare again.' }; publish();
    try { await native.request('forms_cancel', { requestId }); } catch (error) { if (generation === cancelledGeneration) { state.error = error.message; publish(); } }
    return;
  }
  if (state.busy) return;
  const token = ++generation;
  state = { ...state, busy: action, error: '', notice: '' }; publish();
  try {
    if (action === 'capture' || action === 'inspect') {
      const tabId = payload.tabId;
      const { page, documentId } = await inject(tabId, action === 'capture' ? captureJobs : inspectForm);
      state = { ...state, tabId, documentId, page: { url: page.url, title: page.title }, jobs: action === 'capture' ? page.jobs : [], form: action === 'inspect' ? page : null, prepared: null, edits: {}, selected: [], notice: action === 'capture' ? `${page.jobs.length} jobs detected. Select the jobs to save.` : `${page.fields.length} available or populated controls inspected. Prepare suggested values to review.` };
    } else if (action === 'save') {
      const indexes = [...new Set(payload.indexes || [])].filter(i => Number.isInteger(i) && i >= 0 && i < state.jobs.length);
      if (!indexes.length) throw new Error('Select at least one detected job.');
      const result = await native.request('capture_jobs', { requestId: crypto.randomUUID(), sourceUrl: state.page.url, jobs: indexes.map(i => state.jobs[i]) });
      state.notice = `Saved ${result.added} new jobs; updated ${result.updated}. Open Jobs in the companion to review.`;
    } else if (action === 'prepare') {
      if (!state.form) throw new Error('Inspect the form first.');
      preparingRequest = crypto.randomUUID();
      const result = await native.request('forms_prepare', { requestId: preparingRequest, ...state.form, useApi: payload.useApi === true, ...(state.prepared?.formId ? { formId: state.prepared.formId } : {}) });
      if (generation !== token) return;
      state.prepared = result; state.edits = Object.fromEntries(result.fields.map(f => [f.id, f.value ?? ''])); state.selected = [];
      state.notice = 'Review and select values before copying or filling. Unknown answers remain manual.';
    } else if (action === 'fill') {
      if (!state.prepared || !state.form) throw new Error('Prepare and review the form first.');
      const fields = state.prepared.fields.filter(f => state.selected.includes(f.id)).map(f => ({ ...f, value: state.edits[f.id] ?? '' }));
      if (!fields.length) throw new Error('Select at least one reviewed value.');
      const { page: result } = await inject(state.tabId, fillForm, [{ url: state.form.url, fields }], state.documentId);
      state.notice = `Filled ${result.filled.length}; skipped ${result.skipped.length}. Nothing was submitted. Inspect again before another fill.`;
      if (result.skipped.length) {
        state.selected = result.skipped;
        state.notice += ' Skipped values remain here to review or copy.';
      } else { state.prepared = null; state.selected = []; state.edits = {}; state.form = null; }
    } else if (action === 'settings') {
      await native.request('open_settings', {}); state.notice = 'Companion settings opened.';
    } else throw new Error('Unknown panel action.');
  } catch (error) {
    if (generation === token) state.error = error.message || 'The request failed. Try again.';
  } finally {
    if (generation === token) { preparingRequest = null; state.busy = null; publish(); }
  }
}
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'recruiters-panel' || port.sender?.id !== chrome.runtime.id || port.sender?.url !== chrome.runtime.getURL('panel.html')) { port.disconnect(); return; }
  panels.add(port); port.postMessage(state);
  port.onDisconnect.addListener(() => panels.delete(port));
  port.onMessage.addListener(message => { void act(message); });
});
