import { BUILD_ID } from './config.mjs';
import { derivePanelFlow } from './panel-flow.mjs';
import { reviewIdentity } from './protocol.mjs';

const chrome = globalThis.browser ?? globalThis.chrome;
const pasteShortcut = /Mac/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent) ? '⌘V' : 'Ctrl+V';
const $ = id => document.getElementById(id);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
let state, port, reconnect, pageKey, fieldKey, listKey, jobKey, flow, lastAction, suspendedFocus;
// Memory only: explicit panel edits, never values typed into the employer's page.
const answerDrafts = new Map(), selections = new Map();
let answerContext, editing = null, editorNode = null, focusAfter = null;
const reviewInputs = new Map();
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
function listRow(label, status, done, action = null) {
  const row = el('li', '', 'item'), mark = el('span', '', done ? 'dot done' : 'dot'), name = el('span', label, 'name');
  mark.setAttribute('aria-hidden', 'true'); name.title = label;
  row.append(mark, name, ...(action ? [action] : []), el('span', status, 'state'));
  return row;
}
function answerStatus(field) {
  if (state.answersStale) return ['Changed', false];
  if (!field.empty) return ['Filled', true];
  if (field.manualOnly) return ['By you', false];
  const value = String(state.edits[field.id] ?? field.value ?? '');
  if (!value.trim()) return ['Missing', false];
  // A choice is clicked on the page, never pasted: name the option to click.
  const choice = field.options?.find(option => option.value === value)?.label;
  if (choice) return [choice.length <= 24 ? `Choose ${choice}` : 'Ready', true];
  return [state.paste?.ok === true && state.paste.label === field.label ? 'Copied' : 'Ready', true];
}
// Every prepared field in page order: ready answers, then what is still missing and whether it can be added here.
const SAVED = { future: 'Saved for future applications', application: 'Saved for this application' };
function answerRows(prepared) {
  const order = new Map((state.form?.fields || []).map((field, index) => [field.id, index]));
  return [...(prepared?.fields || []).map(item => ({ item, ready: true })), ...(prepared?.unresolved || []).map(item => ({ item, ready: false }))]
    .sort((a, b) => (order.get(a.item.id) ?? order.size) - (order.get(b.item.id) ?? order.size)).map(({ item, ready }) => {
      const saved = state.saved?.[item.id], typed = saved?.source === 'page';
      const [status, done] = typed ? ['Filled', true] : ready ? answerStatus(item) : ['Missing', false];
      return { id: item.id, label: item.label, status, done, add: !ready && item.add === true && !typed && !state.answersStale,
        caption: SAVED[saved?.scope] ?? '', undo: typed && saved.scope === 'future' };
    });
}
function openEditor(id) { editing = { id, value: '' }; editorNode = null; focusAfter = `new-${id}`; render(); }
function closeEditor(id) { editing = null; focusAfter = `add-${id}`; render(); }
function editorRow(row, busy) {
  const field = state.form?.fields?.find(item => item.id === row.id) || { type: 'text' };
  const item = el('li', '', 'editor'), form = el('form'), label = el('label', row.label), input = answerInput(field);
  const actions = el('div', '', 'actions'), save = el('button', 'Save', 'quiet'), cancel = el('button', 'Cancel', 'text');
  input.id = `new-${row.id}`; label.htmlFor = input.id; input.required = true; input.disabled = busy;
  if (!field.options) input.maxLength = field.maxLength || 10000;
  input.value = editing.value; input.oninput = input.onchange = () => { editing.value = input.value; };
  input.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); closeEditor(row.id); } };
  save.type = 'submit'; cancel.type = 'button'; cancel.onclick = () => closeEditor(row.id);
  form.onsubmit = event => {
    event.preventDefault();
    if (state.busy || !form.reportValidity()) return;
    const value = field.options ? input.value : input.value.trim();
    if (!value) { $('error').hidden = false; $('error').textContent = 'Enter an answer, or choose Cancel.'; return; }
    send('answer-save', { fieldId: row.id, value });
  };
  actions.append(save, cancel); form.append(label, input, actions); item.append(form);
  item.dataset.id = row.id;
  return item;
}
function renderAnswerList(rows, busy, prepared) {
  if (editing && prepared && !rows.some(row => row.id === editing.id && row.add)) {
    // Saved (or no longer addable): close the editor and continue with the next missing answer.
    const index = rows.findIndex(row => row.id === editing.id), next = rows.slice(index + 1).find(row => row.add) || rows.find(row => row.add);
    editing = null; focusAfter = next ? `add-${next.id}` : null;
  }
  // Status refreshes rebuild the rows but keep the open editor's node, value and focus.
  if (!editing) editorNode = null;
  const key = JSON.stringify([rows, editing?.id ?? null]);
  if (listKey !== key) preserveFocus(() => {
    listKey = key;
    $('answer-list').replaceChildren(...rows.flatMap(row => {
      let action = null;
      if (row.add && editing?.id !== row.id) {
        action = el('button', 'Add', 'text'); action.id = `add-${row.id}`; action.setAttribute('aria-label', `Add ${row.label}`);
        action.onclick = () => openEditor(row.id);
      }
      const nodes = [listRow(row.label, row.status, row.done, action)];
      if (row.caption) {
        const caption = el('li', '', 'caption');
        caption.append(el('span', row.undo ? `${row.caption} ·` : row.caption));
        if (row.undo) {
          const undo = el('button', 'Undo', 'text'); undo.setAttribute('aria-label', `Undo saved answer for ${row.label}`);
          undo.onclick = () => send('answer-undo', { fieldId: row.id });
          caption.append(undo);
        }
        nodes.push(caption);
      }
      if (row.add && editing?.id === row.id) nodes.push(editorNode?.dataset.id === row.id ? editorNode : (editorNode = editorRow(row, busy)));
      return nodes;
    }));
  });
  const input = editing && $(`new-${editing.id}`);
  if (input) input.disabled = busy;
  if (focusAfter && !busy) { $(focusAfter)?.focus(); focusAfter = null; }
}
function renderAnswers(busy, hidden) {
  const prepared = hidden ? null : state.prepared;
  $('paste').hidden = !prepared || !flow.answerCount || !!state.answersStale;
  $('paste').textContent = !state.paste ? `Answers ready. Click a field and paste with ${pasteShortcut}.`
    : state.paste.ok === false ? `Could not copy ${state.paste.label}. Copy it from Edit answers instead.`
    : state.paste.ok === true ? `Ready to paste: ${state.paste.label}. Press ${pasteShortcut} in that field.`
    : `Getting ${state.paste.label} ready to paste…`;
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
  const rows = answerRows(prepared);
  renderAnswerList(rows, busy, prepared);
  $('answers-label').hidden = $('answer-list').hidden = !rows.length;
  $('form').hidden = !prepared || !rows.length;
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
  if (busy && !suspendedFocus && /^(answer|select|new)-/.test(active?.id || '')) {
    suspendedFocus = { id: active.id, page: pageKey, start: active.selectionStart, end: active.selectionEnd };
  }
  for (const button of document.querySelectorAll('button')) button.disabled = busy;
  if (state.buildId !== BUILD_ID) {
    for (const id of ['error', 'cancel', 'page', 'application', 'form', 'jobs', 'options', 'install', 'recover', 'application-prepare', 'application-answers', 'prepare-saved', 'application-open-ad', 'paste', 'review']) $(id).hidden = true;
    $('status').textContent = 'Extension updated. Reload to continue.'; $('status').hidden = false;
    $('detect').hidden = false; $('detect').className = ''; $('detect').textContent = 'Reload extension'; return;
  }
  const currentPage = JSON.stringify([state.tabId, state.documentId, state.page?.url]);
  if (pageKey !== currentPage) { pageKey = currentPage; answerDrafts.clear(); selections.clear(); suspendedFocus = null; editing = focusAfter = null; fieldKey = listKey = jobKey = null; }
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
  if (!busy && state.notice && (lastAction === 'save' || (!noJob && ['copy-intro', 'application-document', 'application-open-ad', 'cancel'].includes(lastAction)))) $('status').textContent += ` ${state.notice}`;
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
  const answersHidden = noJob || ['locked', 'unavailable', 'update'].includes(flow.kind);
  renderAnswers(busy, answersHidden);
  // The footer carries one sentence: an error, else a state the user must act on, else the paste instruction.
  $('status').hidden = !$('status').textContent || (!$('paste').hidden && ['ready', 'answers'].includes(flow.kind));
  if (!$('status').hidden || !$('error').hidden) $('paste').hidden = true;
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
