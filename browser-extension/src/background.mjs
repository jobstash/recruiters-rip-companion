import { PRODUCT_ORIGIN, NATIVE_HOST } from './config.mjs';
import { createNativeClient, safeDeviceRequest, externalSenderAllowed, deviceResult } from './protocol.mjs';
import { captureJobs, inspectForm, fillForm, checkFormBindings, armSmartPaste, disarmSmartPaste, pressAction, observePage } from './page.mjs';
import { createPageAccess } from './page-access.mjs';

const native = createNativeClient({ host: NATIVE_HOST, onCommand: command, onDisconnect: () => { void expirePrepared('Companion disconnected. Inspect and prepare this form again after reconnecting.'); }, connect: host => {
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
      if (!closed) { try { port.postMessage({ version: 1, id: message?.id, ok: false, error: { code: 'device_unavailable', message: 'Open the companion to review this operation.' } }); } catch { closed = true; } }
    } finally { busy = false; }
  });
});

// Memory only: a native port keeps the worker alive, and panel reconnection can
// recover a completed request. No candidate values are persisted to Chrome disk.
let state = { busy: null, error: '', notice: '', tabId: null, documentId: null, page: null, jobs: [], form: null, prepared: null, edits: {}, selected: [], paste: null };
let generation = 0, preparingRequest = null, pasteSession = null;
const panels = new Set();
const publish = () => { for (const panel of panels) { try { panel.postMessage(state); } catch { panels.delete(panel); } } };
const inject = createPageAccess({
  sidePanel: chrome.sidePanel, tabs: chrome.tabs, scripting: chrome.scripting,
  onError: () => { state.error = 'Chrome could not open this panel. Click the Recruiters.rip toolbar icon again.'; publish(); },
});
const TEXT_TYPES = new Set(['text', 'email', 'tel', 'url', 'textarea', 'number', 'date']);
const preparedValue = field => { const value = state.edits[field.id] ?? field.value ?? ''; return typeof value === 'string' && value && value.length <= 20000 ? value : null; };
const clearForm = () => { pasteSession = null; state.prepared = null; state.selected = []; state.edits = {}; state.form = null; state.paste = null; };
async function arm(active) {
  pasteSession = null;
  if (!Number.isInteger(state.tabId) || !state.documentId) return;
  if (active && !await chrome.permissions.contains({ permissions: ['clipboardWrite'] })) throw new Error('Allow clipboard writing for Recruiters.rip before using smart paste.');
  const session = active ? crypto.randomUUID() : null;
  try {
    await inject(state.tabId, active ? armSmartPaste : disarmSmartPaste, active ? [{ session }] : [], state.documentId);
    pasteSession = session;
  } catch (error) { if (active) throw error; }
}

async function expirePrepared(notice) {
  ++generation; preparingRequest = null;
  const stopped = arm(false);
  clearForm(); state.busy = null; state.notice = notice; publish();
  await stopped;
}

const validationPayload = () => ({ formId: state.prepared.formId, fields: state.form.fields.map(({ id, signature }) => ({ id, signature })) });

// One click on the toolbar icon reads the current tab: an application form and any job postings on it.
async function detect(tabId) {
  const { page: form, documentId } = await inject(tabId, inspectForm);
  let jobs = [];
  try { jobs = (await inject(tabId, captureJobs, [], documentId)).page.jobs; } catch { /* Not every application page carries a posting. */ }
  state = { ...state, tabId, documentId, page: { url: form.url, title: form.title }, jobs, form: form.fields.length ? form : null, prepared: null, edits: {}, selected: [], paste: null,
    notice: form.fields.length ? `Application form detected: ${form.fields.length} controls. Prepare values, then click a field and press ⌘V.` : jobs.length ? `${jobs.length} jobs detected. Select the jobs to save.` : 'No application form or job posting detected on this page.' };
}

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
    if (action === 'detect' || action === 'capture' || action === 'inspect') {
      await arm(false);
      await detect(payload.tabId);
    } else if (action === 'save') {
      const indexes = [...new Set(payload.indexes || [])].filter(i => Number.isInteger(i) && i >= 0 && i < state.jobs.length);
      if (!indexes.length) throw new Error('Select at least one detected job.');
      const result = await native.request('capture_jobs', { requestId: crypto.randomUUID(), sourceUrl: state.page.url, jobs: indexes.map(i => state.jobs[i]) });
      state.notice = `Saved ${result.added} new jobs; updated ${result.updated}. Open Jobs in the companion to review.`;
    } else if (action === 'prepare') {
      if (!state.form) throw new Error('Inspect the form first.');
      await arm(false);
      preparingRequest = crypto.randomUUID();
      const result = await native.request('forms_prepare', { requestId: preparingRequest, ...state.form, useApi: payload.useApi === true, ...(state.prepared?.formId ? { formId: state.prepared.formId } : {}) });
      if (generation !== token) return;
      state.prepared = result; state.edits = Object.fromEntries(result.fields.map(f => [f.id, f.value ?? ''])); state.selected = []; state.paste = null;
      await arm(true);
      state.notice = `${result.fields.length} values ready. Click a field on the page and press ⌘V to paste its value, or select values here to fill. Unknown answers remain manual.`;
    } else if (action === 'fill') {
      if (!state.prepared || !state.form) throw new Error('Prepare and review the form first.');
      const fields = state.prepared.fields.filter(f => state.selected.includes(f.id)).map(f => ({ ...f, value: state.edits[f.id] ?? '' }));
      if (!fields.length) throw new Error('Select at least one reviewed value.');
      try {
        const valid = await native.request('forms_validate', validationPayload());
        if (generation !== token) return;
        if (valid?.valid !== true) throw new Error('The prepared form context changed.');
      } catch {
        if (generation === token) await expirePrepared('Prepared values are no longer available. Unlock the companion, then inspect and prepare the form again.');
        return;
      }
      const result = await fill(fields);
      state.notice = `Filled ${result.filled.length}; skipped ${result.skipped.length}. Nothing was submitted.`;
      if (result.skipped.length) { state.selected = result.skipped; state.notice += ' Skipped values remain here to review or copy.'; }
    } else if (action === 'settings') {
      await native.request('open_settings', {}); state.notice = 'Companion settings opened.';
    } else throw new Error('Unknown panel action.');
  } catch (error) {
    if (generation === token) state.error = error.message || 'The request failed. Try again.';
  } finally {
    if (generation === token) { preparingRequest = null; state.busy = null; publish(); }
  }
}
async function fill(fields) {
  const { page: result } = await inject(state.tabId, fillForm, [{ url: state.form.url, fields }], state.documentId);
  // The form stays inspected: filled controls are no longer empty, so a repeat fill skips them, and the submit controls remain known.
  if (!result.skipped.length) state.selected = [];
  return result;
}

// Companion-initiated operations: the user's AI fills or presses submit on the tab this panel inspected,
// each after the companion's own approval dialog. The extension never chooses what to submit.
async function command(op, payload = {}) {
  if (!state.prepared || !state.form || state.busy) throw new Error('Open the Recruiters.rip panel on the application tab and prepare values first.');
  if (payload.formId !== state.prepared.formId) throw new Error('That form is not the one prepared in Chrome. Prepare it again in the panel.');
  if (op === 'forms_status') {
    const prepared = state.prepared, token = generation;
    try {
      const { page } = await inject(state.tabId, checkFormBindings, [{ url: state.form.url, fields: state.form.fields, actions: state.form.actions ?? [] }], state.documentId);
      if (prepared !== state.prepared || token !== generation) return { formId: payload.formId, attached: false };
      if (!page.attached) { await expirePrepared('The inspected page changed. Inspect and prepare the form again.'); return { formId: payload.formId, attached: false }; }
      return { formId: payload.formId, attached: true, url: state.form.url, title: state.page?.title ?? '', prepared: state.prepared.fields.length, actions: (state.form.actions ?? []).map(({ id, label, kind, signature }) => ({ id, label, kind, signature })) };
    } catch {
      if (prepared === state.prepared && token === generation) await expirePrepared('Chrome could not find the inspected page. Inspect and prepare the form again.');
      return { formId: payload.formId, attached: false };
    }
  }
  const token = ++generation;
  state = { ...state, busy: op, error: '', notice: '' }; publish();
  try {
    if (op === 'forms_fill') {
      const inspected = new Map(state.form.fields.map(field => [field.id, field]));
      if (payload.fields.length !== inspected.size || payload.fields.some(field => inspected.get(field.id)?.signature !== field.signature))
        throw new Error('The approved form no longer matches the inspected controls. Prepare it again.');
      const answers = new Map();
      for (const answer of payload.answers) {
        const field = inspected.get(answer.id);
        if (!field || field.signature !== answer.signature || !field.empty || field.manualOnly || (field.options && !field.options.some(option => option.value === answer.value)))
          throw new Error('A staged answer no longer matches an available inspected control. Prepare it again.');
        answers.set(answer.id, answer.value);
      }
      const prepared = new Map(state.prepared.fields.map(field => [field.id, field]));
      const fields = state.form.fields.filter(field => field.empty && !field.manualOnly).map(field => {
        const ready = prepared.get(field.id);
        if (ready && ready.signature !== field.signature) throw new Error('Prepared values no longer match this form. Prepare it again.');
        return { ...field, value: answers.get(field.id) ?? ready?.value ?? '' };
      }).filter(field => typeof field.value === 'string' && field.value);
      if (!fields.length) throw new Error('No prepared or staged values to fill.');
      const result = await fill(fields);
      state.notice = `Your AI filled ${result.filled.length} controls; ${result.skipped.length} skipped. Nothing was submitted.`;
      return { filled: result.filled, skipped: result.skipped, url: state.form?.url ?? null };
    }
    if (op === 'forms_submit') {
      const action = (state.form.actions ?? []).find(a => a.id === payload.actionId);
      if (!action || action.signature !== payload.actionSignature) throw new Error('That approved submit control is not on the inspected form.');
      await arm(false);
      const tabId = state.tabId, documentId = state.documentId;
      const { page: before } = await inject(tabId, observePage, [], documentId);
      const { page: pressed } = await inject(tabId, pressAction, [{ url: state.form.url, actionId: action.id, actionSignature: payload.actionSignature }], documentId);
      const observed = await settle(tabId, documentId, before);
      state.notice = `Your AI pressed “${pressed.label}”. ${observed.confirmationCandidates.length ? 'The page contains possible confirmation text; check it yourself.' : 'Check the page for the result.'} Submission is not verified.`;
      if (!observed.sameDocument) clearForm();
      return { pressed: pressed.label, ...observed };
    }
    throw new Error('This browser operation is unavailable.');
  } catch (error) {
    if (generation === token) state.error = error.message || 'The request failed.';
    throw error;
  } finally {
    if (generation === token) { state.busy = null; publish(); }
  }
}
// After a press, give the page a moment, then read what it shows. A cross-origin navigation ends
// Chrome's access to the tab; that is reported, never guessed.
async function settle(tabId, documentBefore, before) {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const unavailable = tab => ({ url: tab?.url ?? null, title: tab?.title ?? null, sameDocument: null, navigated: tab?.url && tab.url !== before.url ? true : null,
    observedText: null, confirmationCandidates: [], outcome: 'unknown', alerts: [], accessible: false });
  let tab = null;
  for (let attempt = 0; attempt < 16; attempt++) {
    await wait(500);
    try { tab = await chrome.tabs.get(tabId); } catch { return unavailable(null); }
    if (tab.status === 'complete' && attempt >= 3) break;
  }
  try {
    const { page, documentId } = await inject(tabId, observePage);
    return { ...page, sameDocument: documentId === documentBefore, navigated: documentId !== documentBefore || page.url !== before.url, accessible: true,
      confirmationCandidates: page.confirmationCandidates.map(text => ({ text, newSinceObservation: !before.confirmationCandidates.includes(text) })) };
  } catch { return unavailable(tab); }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0) return false;
  if (message?.action === 'paste-value') {
    const field = state.prepared?.fields.find(f => f.id === message.fieldId);
    const inspected = state.form?.fields.find(f => f.id === message.fieldId), prepared = state.prepared, session = pasteSession;
    const live = () => !state.busy && prepared === state.prepared && session && pasteSession === session && message.session === session && sender.tab.id === state.tabId && sender.documentId === state.documentId &&
      field && inspected?.empty && !inspected.manualOnly && inspected.signature === field.signature && field.signature === message.signature && state.form?.url === message.url && TEXT_TYPES.has(field.type);
    if (!live()) { respond({ value: null }); return false; }
    const payload = validationPayload();
    state.paste = { label: field.label, ok: null }; publish();
    void Promise.resolve().then(async () => {
      if (!await chrome.permissions.contains({ permissions: ['clipboardWrite'] })) throw new Error('Clipboard permission is unavailable.');
      const validated = await native.request('forms_validate', payload);
      if (validated?.valid !== true) throw new Error('The prepared form context changed.');
      respond({ value: live() ? preparedValue(field) : null });
    }).catch(() => {
      if (prepared === state.prepared && pasteSession === session) void expirePrepared('Prepared values are no longer available. Unlock the companion, then inspect and prepare the form again.');
      try { respond({ value: null }); } catch { /* The page disconnected. */ }
    });
    return true;
  }
  if (message?.action === 'paste-ready') {
    const field = state.prepared?.fields.find(f => f.id === message.fieldId);
    if (!state.busy && pasteSession && message.session === pasteSession && field && field.signature === message.signature && sender.tab.id === state.tabId && sender.documentId === state.documentId && state.form?.url === message.url) { state.paste = { label: field.label, ok: message.ok === true }; publish(); }
    return false;
  }
  return false;
});
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'recruiters-panel' || port.sender?.id !== chrome.runtime.id || port.sender?.url !== chrome.runtime.getURL('panel.html')) { port.disconnect(); return; }
  panels.add(port);
  try { port.postMessage(state); } catch { panels.delete(port); return; }
  port.onDisconnect.addListener(() => panels.delete(port));
  port.onMessage.addListener(message => { void act(message); });
});
