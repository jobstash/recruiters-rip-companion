import { PRODUCT_ORIGIN, NATIVE_HOST, BUILD_ID } from './config.mjs';
import { createNativeClient, safeDeviceRequest, externalSenderAllowed, deviceResult, applicationView } from './protocol.mjs';
import { captureJobs, captureApplicationContext, inspectForm, checkFormBindings, armSmartPaste, disarmSmartPaste } from './page.mjs';
import { createPageAccess, preparedPageSender } from './page-access.mjs';

const chrome = globalThis.browser ?? globalThis.chrome;
const firefox = !!chrome.sidebarAction;

const native = createNativeClient({ host: NATIVE_HOST, onCommand: command, onDisconnect: () => { void expirePrepared('Companion disconnected. Inspect and prepare this form again after reconnecting.'); }, connect: host => {
  const port = chrome.runtime.connectNative(host);
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; });
  return port;
} });
chrome.runtime.onConnectExternal?.addListener(port => {
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
// recover a completed request. No candidate values are persisted to browser disk.
let state = { buildId: BUILD_ID, busy: null, error: '', notice: '', tabId: null, documentId: null, page: null, jobs: [], form: null, prepared: null, edits: {}, selected: [], paste: null,
  application: null, applicationHost: 'claude', applicationNotice: '', applicationAnswersPending: false, answersStale: false };
let generation = 0, preparingRequest = null, pasteSession = null, automaticPreparation = false;
let pollTimer = null, pollEpoch = 0, pollInFlight = false, pollsRemaining = 0;
const answerAttempts = new Set();
const panels = new Set();
const publish = () => { for (const panel of panels) { try { panel.postMessage(state); } catch { panels.delete(panel); } } if (!panels.size) stopPolling(); };
function stopPolling() { clearTimeout(pollTimer); pollTimer = null; ++pollEpoch; }
function clearApplication() {
  stopPolling(); answerAttempts.clear(); pollsRemaining = 0;
  state.application = null; state.applicationNotice = ''; state.applicationAnswersPending = false;
}
function schedulePoll() {
  if (pollTimer || pollInFlight || !panels.size || !state.application || pollsRemaining <= 0) return;
  pollTimer = setTimeout(() => { pollTimer = null; void pollApplication(); }, 5000);
}
function setApplication(result, restoreHost = false) {
  const view = applicationView(result);
  state.application = view;
  if (restoreHost) state.applicationHost = view.preferredHost || view.handoff?.host || state.applicationHost;
}
const answerKey = () => state.application?.state === 'ready' && state.application.answerVersion
  ? `${state.application.bindingId}:${state.application.answerVersion}` : null;
function markAnswerAttempt(key) {
  if (!key) return;
  answerAttempts.add(key);
  if (answerAttempts.size > 64) answerAttempts.delete(answerAttempts.values().next().value);
}
const hasReviewedEdits = () => state.selected.length > 0 || state.prepared?.fields.some(field => (state.edits[field.id] ?? '') !== (field.value ?? ''));
async function pollApplication() {
  if (pollInFlight || !panels.size || !state.application || pollsRemaining <= 0) return;
  if (state.busy) { schedulePoll(); return; }
  pollInFlight = true; --pollsRemaining;
  const epoch = pollEpoch, token = generation, bindingId = state.application.bindingId, tabId = state.tabId, documentId = state.documentId;
  const current = () => epoch === pollEpoch && token === generation && panels.size > 0 && state.application?.bindingId === bindingId && state.tabId === tabId && state.documentId === documentId;
  try {
    const result = await native.request('application_status', { bindingId });
    if (!current()) return;
    const view = applicationView(result);
    if (view.bindingId !== bindingId) throw new Error('Application context changed. Read page again.');
    const previousVersion = state.application.answerVersion;
    setApplication(view); state.applicationNotice = '';
    if (state.prepared && (previousVersion !== view.answerVersion || view.state === 'needs_refresh')) {
      // Keep explicit edits for review, but never keep stale clipboard access.
      state.paste = null; state.answersStale = true;
      await arm(false);
      if (!current()) return;
    }
    const key = answerKey();
    if (key && state.answersStale) state.applicationAnswersPending = true;
    if (key && !answerAttempts.has(key) && state.form && isApplication(state.form, !!state.application.applicationId)) {
      state.applicationAnswersPending = true;
      if (!state.busy && !hasReviewedEdits()) await act({ action: 'application-answers', payload: { automatic: true } });
    }
    if (current() && pollsRemaining === 0) state.applicationNotice = 'Automatic updates paused. Read page to check saved documents.';
    if (current()) publish();
  } catch (error) {
    if (current()) { state.applicationNotice = error.message || 'Could not check saved documents. Read page to reconnect.'; publish(); }
  } finally { pollInFlight = false; schedulePoll(); }
}
const inject = createPageAccess({
  sidePanel: chrome.sidePanel, sidebarAction: chrome.sidebarAction, tabs: chrome.tabs, scripting: chrome.scripting, action: chrome.action,
  onAccess: tabId => act({ action: 'detect', payload: { tabId } }),
  onError: () => { state.error = 'The browser could not open this panel. Click the Recruiters.rip toolbar icon again.'; publish(); },
});
const TEXT_TYPES = new Set(['text', 'email', 'tel', 'url', 'textarea', 'number', 'date']);
const preparedValue = field => { const value = state.edits[field.id] ?? field.value ?? ''; return typeof value === 'string' && value && value.length <= 20000 ? value : null; };
const clearForm = () => { pasteSession = null; state.prepared = null; state.selected = []; state.edits = {}; state.form = null; state.paste = null; state.answersStale = false; };
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
  clearApplication(); clearForm(); state.busy = null; state.notice = notice; publish();
  await stopped;
}

const validationPayload = () => ({ formId: state.prepared.formId, fields: state.form.fields.map(({ id, signature }) => ({ id, signature })) });

// Require application context, not merely a form: login and newsletter controls are not paid work.
function isApplication(form, bound = false) {
  if (!form.fields.length) return false;
  const title = form.title || '';
  if (/\b(log[ -]?in|sign[ -]?in|newsletter|subscribe|sign[ -]?up|create (?:an? )?account)\b/i.test(title)) return false;
  if (bound) return true;
  const labels = form.fields.map(field => field.label || '').join(' ');
  const careerFields = /\b(resume|résumé|curriculum vitae|cover letter|work experience|employment history|why (?:this|the) (?:role|company)|salary|sponsorship|linkedin)\b/i.test(labels);
  const namedApplication = /\b(job application|apply(?:ing)? (?:for|to)|application (?:form|for))\b/i.test(title) || /^(?:application|apply)\b/i.test(title);
  const contactFields = /\b(name|e-?mail|phone)\b/i.test(labels);
  return (namedApplication && (careerFields || (contactFields && form.fields.length >= 2))) ||
    (careerFields && (form.fields.length >= 3 || /\b(job|position|role|apply|careers?)\b/i.test(title)));
}
async function detect(tabId, token) {
  clearApplication(); clearForm();
  if (tabId !== state.tabId) { state.tabId = tabId; state.documentId = null; state.page = null; state.jobs = []; }
  publish();
  const { page: form, documentId } = await inject(tabId, inspectForm);
  let jobs = [], context = {};
  try { jobs = (await inject(tabId, captureJobs, [], documentId)).page.jobs; } catch { /* Not every application page carries a posting. */ }
  try { context = (await inject(tabId, captureApplicationContext, [], documentId)).page; } catch { /* The agent can retrieve the exact advert when available. */ }
  if (generation !== token) return;
  state = { ...state, tabId, documentId, page: { url: form.url, title: form.title }, jobs, form: form.fields.length ? form : null,
    notice: form.fields.length ? 'This page is not recognized as a job application. Answer its fields on the page.' : jobs.length ? `${jobs.length} jobs detected.` : 'No application form or job posting found.' };
  const result = await native.request('application_resolve', { requestId: crypto.randomUUID(), page: form, jobs, context });
  if (generation !== token) return;
  if (isApplication(form) || jobs.length || context.original || context.jobLinks?.length || result.applicationId) {
    setApplication(result, true); pollsRemaining = 240; state.notice = ''; publish(); schedulePoll();
  }
  if (isApplication(form, !!state.application?.applicationId)) {
    markAnswerAttempt(answerKey());
    await prepare(token);
  }
}
async function prepare(token, automatic = false) {
  if (!state.form || !isApplication(state.form, !!state.application?.applicationId)) throw new Error('Read a job application page to prepare answers.');
  state.busy = 'prepare'; publish();
  await arm(false);
  if (generation !== token || (automatic && !panels.size)) return;
  const { page: binding } = await inject(state.tabId, checkFormBindings, [{ url: state.form.url, fields: state.form.fields, actions: state.form.actions ?? [] }], state.documentId);
  if (generation !== token || (automatic && !panels.size)) return;
  if (!binding.attached) { await expirePrepared('The inspected page changed. Read page to prepare this application again.'); return; }
  preparingRequest = crypto.randomUUID();
  const result = await native.request('forms_prepare', { requestId: preparingRequest, ...state.form });
  if (generation !== token || (automatic && !panels.size)) return;
  state.prepared = result; state.edits = Object.fromEntries(result.fields.map(f => [f.id, f.value ?? ''])); state.selected = []; state.paste = null;
  state.applicationAnswersPending = false; state.answersStale = false;
  await arm(true);
  if (generation === token) state.notice = '';
}

async function act(message) {
  if (!message || typeof message.action !== 'string') return;
  const { action, payload = {} } = message;
  if (action === 'ping') return;
  if (action === 'application-host') {
    if (!state.busy && ['claude', 'codex'].includes(payload.host)) { state.applicationHost = payload.host; publish(); }
    return;
  }
  if (action === 'edit') {
    if (state.busy || !state.prepared) return;
    const fields = new Map(state.prepared.fields.map(f => [f.id, f]));
    state.edits = Object.fromEntries(Object.entries(payload.edits || {}).filter(([id, v]) => fields.has(id) && typeof v === 'string' && v.length <= 20000));
    state.selected = [...new Set(payload.selected || [])].filter(id => fields.has(id)); return;
  }
  if (action === 'cancel') {
    if (!preparingRequest) return;
    const requestId = preparingRequest; preparingRequest = null; const cancelledGeneration = ++generation;
    state = { ...state, busy: null, error: '', notice: 'Preparation cancelled. Read page to try again.' }; publish();
    try { await native.request('forms_cancel', { requestId }); } catch (error) { if (generation === cancelledGeneration) { state.error = error.message; publish(); } }
    return;
  }
  if (state.busy) return;
  const token = ++generation;
  state = { ...state, busy: action, error: '', notice: '' }; publish();
  try {
    if (action === 'detect' || action === 'capture' || action === 'inspect') {
      await arm(false);
      if (generation !== token) return;
      await detect(payload.tabId, token);
    } else if (action === 'application-prepare') {
      if (!state.application || !['claude', 'codex'].includes(payload.host)) throw new Error('Read the application page and choose Claude or Codex.');
      const bindingId = state.application.bindingId;
      const result = await native.request('application_prepare', { bindingId, host: payload.host });
      if (generation !== token) return;
      if (result.bindingId !== bindingId) throw new Error('Application context changed. Read page again.');
      setApplication(result);
      state.applicationHost = payload.host;
      state.notice = result.opened === true && result.requiresSend === true
        ? result.mode === 'cli' ? 'Review the prepared request in the terminal, then press Enter to start your agent.'
          : `Open in ${payload.host === 'codex' ? 'Codex' : 'Claude'} and send the prepared prompt.`
        : 'Review the application request in your agent.';
      pollsRemaining = 240;
    } else if (action === 'application-document') {
      if (!state.application || !['cv', 'cover_letter'].includes(payload.kind) || !['open', 'reveal'].includes(payload.action) ||
        !state.application.documents.some(doc => doc.kind === payload.kind && doc.ready)) throw new Error('That document is not ready. Prepare this application first.');
      await native.request('application_document', { bindingId: state.application.bindingId, kind: payload.kind, action: payload.action });
      if (generation === token) state.notice = payload.action === 'reveal' ? 'Document shown in your file manager. Upload it on the application page yourself.' : 'Document opened. Upload it on the application page yourself.';
    } else if (action === 'application-open-ad') {
      if (!state.application?.jobUrl) throw new Error('No job advert link was found. Open the original advert and click Read page.');
      await native.request('application_open_ad', { bindingId: state.application.bindingId });
      if (generation === token) state.notice = 'Job advert opened. Read that page to capture the full description.';
    } else if (action === 'application-answers') {
      const key = answerKey();
      if (!key || !state.form) throw new Error('Written answers are not ready. Finish preparation in your agent first.');
      if (payload.automatic && answerAttempts.has(key)) return;
      markAnswerAttempt(key);
      state.applicationAnswersPending = true;
      automaticPreparation = payload.automatic === true;
      try { await prepare(token, automaticPreparation); } finally { automaticPreparation = false; }
    } else if (action === 'save') {
      const indexes = [...new Set(payload.indexes || [])].filter(i => Number.isInteger(i) && i >= 0 && i < state.jobs.length);
      if (!indexes.length) throw new Error('Select at least one detected job.');
      const result = await native.request('capture_jobs', { requestId: crypto.randomUUID(), sourceUrl: state.page.url, jobs: indexes.map(i => state.jobs[i]) });
      state.notice = `Saved ${result.added} new jobs; updated ${result.updated}. Open Jobs in the companion to review.`;
    } else if (action === 'profile-save') {
      if (!state.prepared?.snapshot || !state.form) throw new Error('Read page before saving details.');
      const allowed = new Map((state.prepared.questions || []).filter(question => question.key !== 'personalSummary').map(question => [question.key, question]));
      const values = payload.values;
      if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length ||
        Object.entries(values).some(([key, value]) => !allowed.has(key) ||
          (allowed.get(key).type === 'boolean' ? typeof value !== 'boolean' : typeof value !== 'string' || !value.trim() || value.length > 10000) ||
          (allowed.get(key).options && !allowed.get(key).options.some(option => option.value === value))))
        throw new Error('Enter the requested details before saving.');
      const result = await native.request('forms_profile_save', { requestId: crypto.randomUUID(), formId: state.prepared.formId, snapshot: state.prepared.snapshot, values });
      if (generation !== token) return;
      const keys = Object.keys(values);
      if (!Array.isArray(result?.saved) || keys.some(key => !result.saved.includes(key)))
        throw new Error('Companion did not confirm saving these details. Your edits are still here; try again.');
      state.saveReceipt = { id: crypto.randomUUID(), keys };
      state.notice = 'Details saved on this computer.'; publish();
      await arm(false);
      if (generation !== token) return;
      await detect(state.tabId, token);
      if (generation === token) state.notice = 'Details saved on this computer.';
    } else if (action === 'settings') {
      await native.request('open_settings', {}); state.notice = 'Companion settings opened.';
    } else if (action === 'configure') {
      await native.request('open_decisions_settings', {}); state.notice = 'Decisions API settings opened in Companion.';
    } else throw new Error('Unknown panel action.');
  } catch (error) {
    if (generation === token) state.error = error.message || 'The request failed. Try again.';
  } finally {
    if (generation === token) { preparingRequest = null; state.busy = null; publish(); schedulePoll(); }
  }
}
async function command(op, payload = {}) {
  if (op !== 'forms_status') throw new Error('This browser operation is unavailable.');
  if (!state.prepared || !state.form || state.busy || state.answersStale) throw new Error('Open the Recruiters.rip panel on the application tab and prepare current values first.');
  if (payload.formId !== state.prepared.formId) throw new Error('That form is not the one prepared in this browser. Prepare it again in the panel.');
  if (op === 'forms_status') {
    const prepared = state.prepared, token = generation;
    try {
      const { page } = await inject(state.tabId, checkFormBindings, [{ url: state.form.url, fields: state.form.fields, actions: state.form.actions ?? [] }], state.documentId);
      if (prepared !== state.prepared || token !== generation) return { formId: payload.formId, attached: false };
      if (!page.attached) { await expirePrepared('The inspected page changed. Inspect and prepare the form again.'); return { formId: payload.formId, attached: false }; }
      return { formId: payload.formId, attached: true, url: state.form.url, title: state.page?.title ?? '', prepared: state.prepared.fields.length, actions: (state.form.actions ?? []).map(({ id, label, kind, signature }) => ({ id, label, kind, signature })) };
    } catch {
      if (prepared === state.prepared && token === generation) await expirePrepared('The browser could not find the inspected page. Inspect and prepare the form again.');
      return { formId: payload.formId, attached: false };
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0) return false;
  if (message?.action === 'paste-value') {
    const field = state.prepared?.fields.find(f => f.id === message.fieldId);
    const inspected = state.form?.fields.find(f => f.id === message.fieldId), prepared = state.prepared, session = pasteSession;
    const live = () => !state.busy && prepared === state.prepared && session && pasteSession === session && message.session === session && preparedPageSender(sender, message, state, firefox) &&
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
    if (!state.busy && pasteSession && message.session === pasteSession && field && field.signature === message.signature && preparedPageSender(sender, message, state, firefox) && state.form?.url === message.url) { state.paste = { label: field.label, ok: message.ok === true }; publish(); }
    return false;
  }
  return false;
});
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'recruiters-panel' || port.sender?.id !== chrome.runtime.id || port.sender?.url !== chrome.runtime.getURL('panel.html')) { port.disconnect(); return; }
  panels.add(port);
  try { port.postMessage(state); } catch { panels.delete(port); return; }
  port.onDisconnect.addListener(() => {
    panels.delete(port);
    if (!panels.size) {
      stopPolling();
      if (automaticPreparation && preparingRequest) void act({ action: 'cancel' });
    }
  });
  port.onMessage.addListener(message => { void act(message); });
  if (state.application) { pollsRemaining = 240; schedulePoll(); }
});

function leavePage(notice) {
  const expired = expirePrepared(notice);
  state.page = null; state.jobs = []; state.tabId = null; state.documentId = null; state.error = ''; publish();
  return expired;
}
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (state.tabId !== null && tabId !== state.tabId) void leavePage('Read page on this tab to prepare its application.');
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId === state.tabId && (change.status === 'loading' || (change.url && change.url !== state.page?.url)))
    void leavePage('The page changed. Read page to prepare this application.');
});
chrome.tabs.onRemoved.addListener(tabId => {
  if (tabId === state.tabId) void leavePage('Open an application tab, then click Read page.');
});
