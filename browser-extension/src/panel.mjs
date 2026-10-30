import { BUILD_ID } from './config.mjs';
import { derivePanelFlow } from './panel-flow.mjs';
import { reviewIdentity } from './protocol.mjs';

const chrome = globalThis.browser ?? globalThis.chrome;
const pasteShortcut = /Mac/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent) ? '⌘V' : 'Ctrl+V';
const $ = id => document.getElementById(id);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
let state, port, reconnect, pageKey, questionKey, fieldKey, jobKey, receipt, flow, lastAction, suspendedFocus;
// Memory only: explicit panel edits, never values typed into the employer's page.
const drafts = new Map(), answerDrafts = new Map(), selections = new Map();
let answerContext;
const questionInputs = new Map(), reviewInputs = new Map();
function send(action, payload = {}) {
  if (state?.buildId !== BUILD_ID) return;
  if (!port) { $('error').hidden = false; $('error').textContent = 'The panel disconnected. Reopen it to continue.'; return; }
  if (action !== 'edit') lastAction = action;
  port.postMessage({ action, payload });
}
function connect() {
  port = chrome.runtime.connect({ name: 'recruiters-panel' });
  let first = true;
  port.onMessage.addListener(value => {
    state = value; render();
    if (state.buildId !== BUILD_ID) return;
    if (first && !state.busy) void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id !== state.tabId || !state.page) send('detect', { tabId: tab?.id });
    }).catch(() => {});
    first = false;
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError; port = null;
    if (state) { state = { ...state, application: null, prepared: null, form: null, busy: null, errorCode: null, error: 'The panel disconnected. Reconnecting…' }; render(); }
    clearTimeout(reconnect); reconnect = setTimeout(connect, 500);
  });
}
setInterval(() => { if (port && state?.buildId === BUILD_ID) port.postMessage({ action: 'ping' }); }, 20000);
async function pageAction() {
  try { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); send('detect', { tabId: tab?.id }); }
  catch { $('error').hidden = false; $('error').textContent = 'Select the job page, then reopen this panel.'; }
}
$('detect').onclick = () => {
  if (!state || state.busy) return;
  if (state.buildId !== BUILD_ID) { chrome.runtime.reload(); return; }
  return pageAction();
};
$('refresh').onclick = () => { if (!state?.busy) return pageAction(); };
$('recover').onclick = () => send('settings');
$('install').onclick = () => send('install');
$('configure').onclick = () => send('configure');
$('cancel').onclick = () => send('cancel');
$('save').onclick = () => send('save', { indexes: [...document.querySelectorAll('[data-job]:checked')].map(node => Number(node.dataset.job)) });
$('application-host').onchange = () => send('application-host', { host: $('application-host').value });
$('application-prepare').onclick = () => { if (!state.busy && flow.primary?.id === 'application-prepare') send('application-prepare', { host: $('application-host').value }); };
$('application-open-ad').onclick = () => send('application-open-ad');
$('application-answers').onclick = () => send('application-answers');
$('prepare-saved').onclick = () => send('prepare-saved');
$('show-cv').onclick = () => { if (!state.busy && flow.cvReady) send('application-document', { kind: 'cv', action: 'reveal' }); };
$('copy-intro').onclick = () => { if (!state.busy && flow.introReady) send('copy-intro'); };
$('details-form').onsubmit = event => {
  event.preventDefault();
  if (state.busy || !$('details-form').reportValidity()) return;
  const types = new Map((state.prepared?.questions || []).filter(question => question.key !== 'personalSummary').map(question => [question.key, question.type]));
  const values = Object.fromEntries([...questionInputs].filter(([key, input]) => types.has(key) && input.value.trim()).map(([key, input]) => [key, types.get(key) === 'boolean' ? input.value === 'true' : input.value.trim()]));
  if (!Object.keys(values).length) { $('error').hidden = false; $('error').textContent = 'Enter a missing detail before saving.'; return; }
  send('profile-save', { values });
};
function edited() { send('edit', { identity: reviewIdentity(state), snapshot: state.prepared?.snapshot, edits: state.edits, selected: state.selected }); }
function selection(id, selected) { selections.set(id, selected); state.selected = state.selected.filter(value => value !== id); if (selected) state.selected.push(id); edited(); }
$('copy').onclick = async () => {
  if (state.answersStale) return;
  const rows = state.prepared?.fields.filter(field => state.selected.includes(field.id)) || [];
  if (!rows.length) { $('status').textContent = 'Select an answer to copy.'; return; }
  try { await navigator.clipboard.writeText(rows.map(field => `${field.label}: ${state.edits[field.id] ?? ''}`).join('\n\n')); $('status').textContent = 'Selected answers copied.'; }
  catch { $('error').hidden = false; $('error').textContent = 'Clipboard access was denied. Select and copy the reviewed text manually.'; }
};
function answerInput(field) {
  const input = field.options ? el('select') : el(field.type === 'textarea' ? 'textarea' : 'input');
  if (field.options) {
    const blank = el('option', 'Choose a value'); blank.value = ''; input.append(blank);
    for (const option of field.options) { const node = el('option', option.label); node.value = String(option.value); input.append(node); }
  } else if (field.type !== 'textarea') input.type = ['email', 'tel', 'url', 'number', 'date'].includes(field.type) ? field.type : 'text';
  return input;
}
function preserveFocus(renderControls) {
  const active = document.activeElement, id = active?.id;
  const start = active?.selectionStart, end = active?.selectionEnd;
  renderControls();
  const next = id && $(id);
  if (next && next !== active) {
    next.focus();
    if (typeof start === 'number' && typeof next.setSelectionRange === 'function') next.setSelectionRange(start, end);
  }
}
// One plain row per item: check (done) or empty circle, ellipsised label, right-aligned mono status.
function listRow(label, status, done) {
  const row = el('li', '', 'item'), mark = el('span', '', done ? 'dot done' : 'dot'), name = el('span', label, 'name');
  mark.setAttribute('aria-hidden', 'true'); name.title = label;
  row.append(mark, name, el('span', status, 'state'));
  return row;
}
function answerStatus(field) {
  if (state.answersStale) return ['Changed', false];
  if (!field.empty) return ['Filled', true];
  if (field.manualOnly) return ['By you', false];
  if (!String(state.edits[field.id] ?? field.value ?? '').trim()) return ['Missing', false];
  return [state.paste?.ok === true && state.paste.label === field.label ? 'Copied' : 'Ready', true];
}
function renderAnswers(busy, hidden) {
  const prepared = hidden ? null : state.prepared;
  $('paste').hidden = !prepared || !flow.answerCount || !!state.answersStale;
  $('paste').textContent = !state.paste ? `Answers ready. Click a field and paste with ${pasteShortcut}.`
    : state.paste.ok === false ? `Could not copy ${state.paste.label}. Copy it from Edit answers instead.`
    : state.paste.ok === true ? `Ready to paste: ${state.paste.label}. Press ${pasteShortcut} in that field.`
    : `Getting ${state.paste.label} ready to paste…`;
  const questions = (prepared?.questions || []).filter(question => question.key !== 'personalSummary');
  $('details-form').hidden = !questions.length;
  const nextQuestions = JSON.stringify(questions);
  if (questionKey !== nextQuestions) preserveFocus(() => {
    questionKey = nextQuestions; questionInputs.clear(); $('question-list').replaceChildren();
    for (const question of questions) {
      const row = el('div', '', 'row'), label = el('label', question.label), input = answerInput(question);
      input.id = `detail-${question.key}`; label.htmlFor = input.id; input.maxLength = 10000;
      input.value = drafts.get(question.key) ?? ''; input.oninput = () => drafts.set(question.key, input.value);
      questionInputs.set(question.key, input); row.append(label, input); $('question-list').append(row);
    }
  });
  for (const input of questionInputs.values()) input.disabled = busy;
  const fields = prepared?.fields || [];
  $('review').hidden = !fields.length;
  $('review-actions').hidden = !fields.length;
  // Value/version refreshes update existing inputs, not their DOM identity or focused selection.
  const nextFields = JSON.stringify(fields.map(({ id, signature, label, type, options }) => ({ id, signature, label, type, options })));
  if (fieldKey !== nextFields) preserveFocus(() => {
    fieldKey = nextFields; reviewInputs.clear(); $('field-list').replaceChildren();
    for (const field of fields) {
      const row = el('div', '', 'row'), label = el('label', '', 'check'), check = el('input');
      check.type = 'checkbox'; check.id = `select-${field.id}`; check.onchange = () => selection(field.id, check.checked);
      label.append(check, el('span', field.label)); row.append(label);
      const input = answerInput(field); input.id = `answer-${field.id}`; input.setAttribute('aria-label', `Reviewed value for ${field.label}`);
      input.oninput = () => { answerDrafts.set(field.id, input.value); state.edits[field.id] = input.value; edited(); };
      reviewInputs.set(field.id, { input, check }); row.append(input); $('field-list').append(row);
    }
  });
  for (const field of fields) {
    const { input, check } = reviewInputs.get(field.id);
    const value = answerDrafts.get(field.id) ?? state.edits[field.id] ?? field.value ?? '';
    if (input.value !== value) input.value = value;
    input.disabled = check.disabled = busy || !!field.manualOnly || !field.empty || !!state.answersStale;
    check.checked = state.selected.includes(field.id);
  }
  const reusableLabels = new Set(questions.map(question => question.label));
  const unknown = (prepared?.unresolved || []).filter(item => !reusableLabels.has(item.label));
  $('answer-list').replaceChildren(...fields.map(field => listRow(field.label, ...answerStatus(field))),
    ...unknown.map(item => listRow(item.label, 'Missing', false)));
  $('answers-label').hidden = $('answer-list').hidden = !fields.length && !unknown.length;
  $('form').hidden = !prepared || (!fields.length && !unknown.length && !questions.length);
  $('copy').disabled = busy || !!state.answersStale;
}
function renderJobs(busy) {
  const jobs = state.jobs || [];
  $('jobs').hidden = jobs.length < 2 || state.pageKind === 'none';
  const nextJobs = JSON.stringify(jobs);
  if (jobKey !== nextJobs) {
    const selected = new Set(jobKey ? [...document.querySelectorAll('[data-job]:checked')].map(node => node.dataset.jobUrl) : []);
    jobKey = nextJobs; $('job-list').replaceChildren();
    jobs.forEach((job, index) => {
      const row = el('li', '', 'item'), label = el('label'), check = el('input');
      const text = [job.title || 'Job', job.company].filter(Boolean).join(' · '), name = el('span', text, 'name');
      check.type = 'checkbox'; check.dataset.job = index; check.dataset.jobUrl = job.url || `${index}:${job.title}`; check.checked = selected.has(check.dataset.jobUrl);
      name.title = text; label.append(check, name); row.append(label);
      // The worker accepts only the exact captured candidate URL; labels never become HTML.
      if (job.url) { const open = el('button', 'Open', 'text'); open.setAttribute('aria-label', `Open ${text}`); open.onclick = () => send('open-job', { url: job.url }); row.append(open); }
      $('job-list').append(row);
    });
  }
  for (const check of document.querySelectorAll('[data-job]')) check.disabled = busy;
}
function render() {
  const busy = !!state.busy;
  const active = document.activeElement;
  if (busy && !suspendedFocus && /^(detail|answer|select)-/.test(active?.id || '')) {
    suspendedFocus = { id: active.id, page: pageKey, start: active.selectionStart, end: active.selectionEnd };
  }
  for (const button of document.querySelectorAll('button')) button.disabled = busy;
  if (state.buildId !== BUILD_ID) {
    for (const id of ['error', 'cancel', 'page', 'application', 'form', 'jobs', 'options', 'install', 'recover', 'application-prepare', 'application-answers', 'prepare-saved', 'application-open-ad', 'paste', 'review', 'details-form']) $(id).hidden = true;
    $('status').textContent = 'Extension updated. Reload to continue.'; $('status').hidden = false;
    $('detect').hidden = false; $('detect').className = ''; $('detect').textContent = 'Reload extension'; return;
  }
  const currentPage = JSON.stringify([state.tabId, state.documentId, state.page?.url]);
  if (pageKey !== currentPage) { pageKey = currentPage; drafts.clear(); answerDrafts.clear(); selections.clear(); suspendedFocus = null; questionKey = fieldKey = jobKey = null; }
  state.edits ||= {}; state.selected ||= [];
  if (state.prepared) {
    const identity = reviewIdentity(state);
    if (answerContext !== identity) { answerContext = identity; answerDrafts.clear(); selections.clear(); suspendedFocus = null; }
  }
  for (const field of state.prepared?.fields || []) {
    if (answerDrafts.has(field.id)) state.edits[field.id] = answerDrafts.get(field.id);
    if (selections.has(field.id)) { state.selected = state.selected.filter(id => id !== field.id); if (selections.get(field.id)) state.selected.push(field.id); }
  }
  flow = derivePanelFlow(state);
  const noJob = ['none', 'listing'].includes(state.pageKind) || ['no-job', 'listing', 'connecting'].includes(flow.kind);
  $('page').hidden = noJob || (!state.application && !['job', 'application'].includes(state.pageKind));
  $('title').textContent = state.application?.title || (state.jobs?.length === 1 ? state.jobs[0].title : '') || state.page?.title || 'This application';
  $('company').textContent = state.application?.company || (state.jobs?.length === 1 ? state.jobs[0].company : '') || '';
  $('company').hidden = !$('company').textContent;
  $('status').textContent = flow.kind === 'error' ? '' : flow.message;
  if (!busy && state.notice && (lastAction === 'save' || (!noJob && ['profile-save', 'copy-intro', 'application-document', 'application-open-ad', 'cancel'].includes(lastAction)))) $('status').textContent += ` ${state.notice}`;
  $('error').hidden = flow.kind !== 'error'; $('error').textContent = flow.kind === 'error' ? flow.message : '';
  for (const id of ['detect', 'application-prepare', 'recover', 'cancel', 'application-open-ad', 'application-answers', 'prepare-saved']) $(id).hidden = true;
  if (flow.primary) {
    const id = flow.primary.id === 'settings' ? 'recover' : flow.primary.id;
    $(id).hidden = false; $(id).textContent = flow.primary.label;
  }
  // Re-reading a page without a job is a quiet suggestion, not the panel's task.
  $('detect').className = ['no-job', 'connecting'].includes(flow.kind) ? 'text' : '';
  $('cancel').disabled = false;
  $('install').hidden = !flow.install;
  $('options').hidden = noJob || flow.kind === 'unavailable';
  $('application-open-ad').hidden = noJob || !state.application?.jobUrl || !['needs_job', 'needs_refresh'].includes(state.application.state);
  $('application-host').disabled = busy || noJob || !state.companion || state.companion.locked || state.companion.workflowVersion < 2;
  if (document.activeElement !== $('application-host')) $('application-host').value = flow.host;
  for (const option of $('application-host').options ?? []) option.disabled = (state.companion?.hostInfo || state.application?.hostInfo)?.[option.value]?.available === false;
  $('optional-settings').hidden = noJob || state.prepared?.api?.configured !== false;
  $('configure').hidden = $('optional-settings').hidden;
  const allowDocuments = !noJob && !!state.application && !['locked', 'unavailable', 'update', 'stale'].includes(flow.kind);
  const letterReady = flow.introReady || !!state.application?.documents?.some(doc => doc.kind === 'cover_letter' && doc.ready);
  $('application').hidden = !allowDocuments;
  for (const [prefix, ready] of [['cv', flow.cvReady], ['letter', letterReady]]) {
    $(`${prefix}-mark`).className = ready ? 'dot done' : 'dot';
    $(`${prefix}-state`).textContent = ready ? 'Ready' : 'Not ready';
  }
  $('show-cv').hidden = !allowDocuments || !flow.cvReady;
  $('copy-intro').hidden = !allowDocuments || !flow.introReady;
  $('application-notice').hidden = !state.applicationNotice; $('application-notice').textContent = state.applicationNotice || '';
  if (state.saveReceipt && receipt !== state.saveReceipt.id) {
    receipt = state.saveReceipt.id;
    for (const key of state.saveReceipt.keys) { drafts.delete(key); if (questionInputs.has(key)) questionInputs.get(key).value = ''; }
  }
  const answersHidden = noJob || ['locked', 'unavailable', 'update'].includes(flow.kind);
  renderAnswers(busy, answersHidden);
  // The footer carries one sentence: the paste instruction replaces a bare answer count.
  $('status').hidden = !$('status').textContent || (!$('paste').hidden && ['ready', 'answers'].includes(flow.kind));
  renderJobs(busy);
  for (const button of document.querySelectorAll('button')) if (button !== $('cancel')) button.disabled = busy;
  if (state.answersStale) $('copy').disabled = true;
  if (!busy && suspendedFocus) {
    const saved = suspendedFocus, focused = document.activeElement, target = $(saved.id);
    suspendedFocus = null;
    if (saved.page === pageKey && target && !target.disabled && (!focused || focused.tagName === 'BODY' || focused.id === saved.id)) {
      target.focus();
      if (typeof saved.start === 'number' && typeof target.setSelectionRange === 'function') target.setSelectionRange(saved.start, saved.end);
    }
  }
}
connect();
