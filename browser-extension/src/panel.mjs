import { BUILD_ID } from './config.mjs';

const $ = id => document.getElementById(id);
let state, port, reconnect, pageKey, questionKey, fieldKey, jobKey, documentKey, receipt;
const drafts = new Map();
const questionInputs = new Map();
const reviewInputs = new Map();
const send = (action, payload = {}) => { if (state?.buildId !== BUILD_ID) return; if (!port) { $('error').hidden = false; $('error').textContent = 'The panel disconnected. Reopen it to continue; nothing was submitted.'; return; } port.postMessage({ action, payload }); };
function connect() {
  port = chrome.runtime.connect({ name: 'recruiters-panel' });
  let first = true;
  port.onMessage.addListener(value => {
    state = value; render();
    if (state.buildId !== BUILD_ID) return;
    // Opening the panel reads once; toolbar access may already have started that read.
    if (first && !state.busy) void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id !== state.tabId || !state.page) send('detect', { tabId: tab?.id });
    }).catch(() => {});
    first = false;
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError; port = null;
    if (state) {
      state = { ...state, application: null, prepared: null, form: null, busy: null, error: 'The panel disconnected. Reconnecting; nothing was submitted.' };
      render();
    }
    clearTimeout(reconnect); reconnect = setTimeout(connect, 500);
  });
}
// Memory only, including explicit unsaved answers; never observe typed webpage values.
setInterval(() => { if (port && state?.buildId === BUILD_ID) port.postMessage({ action: 'ping' }); }, 20000);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
async function pageAction(action) {
  try { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); send(action, { tabId: tab?.id }); }
  catch { $('error').hidden = false; $('error').textContent = 'Select the job page, then reopen this panel.'; }
}
$('detect').onclick = () => {
  if (!state || state.busy) return;
  if (state.buildId !== BUILD_ID) { chrome.runtime.reload(); return; }
  return pageAction('detect');
};
$('settings').onclick = () => send('settings');
$('configure').onclick = () => send('configure');
$('cancel').onclick = () => send('cancel');
$('save').onclick = () => send('save', { indexes: [...document.querySelectorAll('[data-job]:checked')].map(n => Number(n.dataset.job)) });
$('fill').onclick = () => send('fill');
$('application-host').onchange = () => send('application-host', { host: $('application-host').value });
$('application-prepare').onclick = () => send('application-prepare', { host: $('application-host').value });
$('application-open-ad').onclick = () => send('application-open-ad');
$('application-answers').onclick = () => send('application-answers');
$('details-form').onsubmit = event => {
  event.preventDefault();
  if (state.busy || !$('details-form').reportValidity()) return;
  const types = new Map((state.prepared?.questions || []).filter(question => question.key !== 'personalSummary').map(question => [question.key, question.type]));
  const values = Object.fromEntries([...questionInputs].filter(([, input]) => input.value.trim()).map(([key, input]) => [key, types.get(key) === 'boolean' ? input.value === 'true' : input.value.trim()]));
  if (!Object.keys(values).length) { $('error').hidden = false; $('error').textContent = 'Enter a missing detail before saving.'; return; }
  send('profile-save', { values });
};
function edited() { send('edit', { edits: state.edits, selected: state.selected }); }
function selection(id, selected) { state.selected = state.selected.filter(v => v !== id); if (selected) state.selected.push(id); edited(); }
async function copy(text, notice) {
  try { await navigator.clipboard.writeText(text); $('status').textContent = notice; }
  catch { $('error').hidden = false; $('error').textContent = 'Clipboard access was denied. Select and copy the reviewed text manually.'; }
}
$('copy').onclick = () => {
  if (state.answersStale) return;
  const rows = state.prepared?.fields.filter(f => state.selected.includes(f.id)) || [];
  if (!rows.length) { $('status').textContent = 'Select at least one reviewed value to copy.'; return; }
  void copy(rows.map(f => `${f.label}: ${state.edits[f.id] ?? ''}`).join('\n\n'), 'Selected values copied. Nothing was filled or submitted.');
};
function answerInput(field) {
  const input = field.options ? el('select') : el(field.type === 'textarea' ? 'textarea' : 'input');
  if (field.options) {
    const blank = el('option', 'Choose a value'); blank.value = ''; input.append(blank);
    for (const option of field.options) { const node = el('option', option.label); node.value = String(option.value); input.append(node); }
  } else if (field.type !== 'textarea') input.type = ['email','tel','url','number','date'].includes(field.type) ? field.type : 'text';
  return input;
}
function renderApplication(busy) {
  const app = state.application;
  $('application').hidden = !app;
  $('application-preparation').hidden = app?.state === 'ready';
  $('application-host').disabled = busy;
  $('application-host').value = state.applicationHost || app?.preferredHost || app?.handoff?.host || 'claude';
  $('application-title').textContent = app ? [app.title, app.company].filter(Boolean).join(' · ') : '';
  const status = !app ? '' : {
    needs_job: app.jobUrl
      ? 'The full job advert is needed. Read the job ad, or prepare with your agent to retrieve that exact link.'
      : 'This job could not be identified unambiguously. Open the original job advert and click Read page, or ask your agent to connect the right saved job.',
    needs_documents: 'Prepare a CV and cover letter for this job.',
    needs_refresh: 'The job or your career details changed. Prepare this application again before using its documents and answers.',
    drafts: 'Preparation is incomplete. Continue in your agent to save the documents and written answers.',
    ready: 'Ready for review.',
  }[app.state];
  $('application-status').textContent = status;
  $('application-open-ad').hidden = !app?.jobUrl || !['needs_job', 'needs_refresh'].includes(app.state);
  const hostName = $('application-host').value === 'codex' ? 'Codex' : 'Claude';
  const awaiting = app?.handoff?.requiresSend === true;
  $('application-prepare').textContent = awaiting ? `Open in ${hostName} and send the prepared prompt` : 'Prepare this application';
  $('application-handoff').hidden = !app?.handoff;
  $('application-handoff').textContent = !app?.handoff ? '' : awaiting
    ? `Send the prepared prompt in ${app.handoff.host === 'codex' ? 'Codex' : 'Claude'} to start. Opening the app alone does not prepare documents.`
    : 'Your agent has read this application request. Documents appear here when saved and exported.';
  const docs = app?.documents || [];
  const nextDocuments = JSON.stringify([app?.bindingId, docs]);
  if (documentKey !== nextDocuments) {
    documentKey = nextDocuments; $('application-documents').replaceChildren();
    for (const doc of docs) {
      const row = el('div', '', 'document-row'), label = doc.kind === 'cv' ? 'CV' : 'Cover letter';
      row.append(el('p', `${label} · ${doc.ready ? 'Ready' : 'Not ready'}`));
      if (doc.ready) {
        const actions = el('div', '', 'document-actions');
        for (const [action, text] of [['open', 'Open'], ['reveal', 'Show in Finder']]) {
          const button = el('button', text, 'quiet');
          button.setAttribute('aria-label', `${text}: ${label}`);
          button.onclick = () => send('application-document', { kind: doc.kind, action });
          actions.append(button);
        }
        row.append(actions);
      }
      $('application-documents').append(row);
    }
  }
  const writing = app?.writing || [], ready = writing.filter(field => field.ready).length;
  $('application-writing').hidden = !writing.length;
  $('application-writing').textContent = `${ready} of ${writing.length} written ${writing.length === 1 ? 'answer' : 'answers'} saved for this job.`;
  $('application-answers').hidden = !state.applicationAnswersPending || app?.state !== 'ready';
  $('application-notice').hidden = !state.applicationNotice;
  $('application-notice').textContent = state.applicationNotice || '';
  $('application-upload').hidden = !docs.some(doc => doc.ready);
}
function render() {
  const busy = !!state.busy;
  for (const button of document.querySelectorAll('button')) button.disabled = busy;
  const outdated = state.buildId !== BUILD_ID;
  $('detect').textContent = outdated ? 'Reload extension' : 'Read page';
  $('settings').hidden = outdated;
  if (outdated) {
    $('status').textContent = 'Extension updated. Reload to continue.';
    $('status').hidden = false;
    for (const id of ['error', 'cancel', 'page', 'application', 'form', 'jobs', 'ready', 'paste', 'review', 'details-form']) $(id).hidden = true;
    return;
  }
  $('cancel').hidden = state.busy !== 'prepare'; $('cancel').disabled = false;
  const working = { prepare: 'Preparing answers · review the request in Companion.', 'profile-save': 'Saving details…', detect: 'Reading page…', save: 'Saving jobs…', settings: 'Opening Companion…', fill: 'Filling reviewed answers…', forms_fill: 'Filling approved answers…', forms_submit: 'Checking the page after the approved action…',
    'application-prepare': 'Opening your agent…', 'application-document': 'Opening the saved document…', 'application-open-ad': 'Opening the job advert…' };
  $('status').textContent = busy ? working[state.busy] || 'Working…' : state.notice;
  $('status').hidden = !$('status').textContent;
  $('error').hidden = !state.error; $('error').textContent = state.error;
  $('page').hidden = !state.page || !!state.application; $('title').textContent = state.page?.title || 'Current page';
  const currentPage = JSON.stringify([state.tabId, state.documentId, state.page?.url]);
  if (pageKey !== currentPage) { pageKey = currentPage; drafts.clear(); questionKey = fieldKey = null; }
  renderApplication(busy);
  // Newly rendered document controls obey the same busy boundary as existing ones.
  for (const button of document.querySelectorAll('button')) if (button !== $('cancel')) button.disabled = busy;
  if (state.saveReceipt && receipt !== state.saveReceipt.id) {
    receipt = state.saveReceipt.id;
    for (const key of state.saveReceipt.keys) { drafts.delete(key); if (questionInputs.has(key)) questionInputs.get(key).value = ''; }
  }
  $('jobs').hidden = !state.jobs.length;
  const nextJobs = JSON.stringify(state.jobs);
  if (jobKey !== nextJobs) {
    jobKey = nextJobs;
    const jobList = $('job-list'); jobList.replaceChildren();
    state.jobs.forEach((job, index) => {
      const row = el('div', '', 'row'), label = el('label', '', 'check'), check = el('input'); check.type = 'checkbox'; check.dataset.job = index;
      label.append(check, el('span', job.title)); row.append(label, el('small', [job.company, job.complete ? 'Full advert captured' : 'Partial capture · full advert needed before assessment'].filter(Boolean).join(' · ')));
      if (job.description) { const detail = el('details'); detail.append(el('summary', 'Captured text'), el('p', job.description)); row.append(detail); }
      jobList.append(row);
    });
  }
  for (const check of document.querySelectorAll('[data-job]')) check.disabled = busy;
  $('form').hidden = !state.form && !state.prepared;
  $('configure').hidden = state.prepared?.api?.configured !== false;
  $('review-actions').hidden = !state.prepared?.fields.length;
  $('review').hidden = !state.prepared;
  $('ready').hidden = !state.prepared && (busy || !!state.error);
  $('ready').textContent = state.answersStale ? 'Saved answers changed. Use the current saved answers before copying or filling.'
    : !state.prepared ? 'Answers are not ready. Read page to prepare them.'
    : state.prepared.fields.length ? `${state.prepared.fields.length} ${state.prepared.fields.length === 1 ? 'answer' : 'answers'} ready`
    : 'No paste answers ready.';
  const paste = $('paste');
  paste.hidden = !state.prepared?.fields.length || state.answersStale === true;
  paste.textContent = !state.paste ? 'Click a field on the page, then press ⌘V.'
    : state.paste.ok === false ? `Clipboard access refused for ${state.paste.label}. Copy it in Review answers.`
    : state.paste.ok === true ? `Clipboard ready for ${state.paste.label}. Press ⌘V in that field.`
    : `Preparing the clipboard for ${state.paste.label}…`;
  const questions = (state.prepared?.questions || []).filter(question => question.key !== 'personalSummary');
  $('details-form').hidden = !questions.length;
  const nextQuestions = JSON.stringify(questions);
  if (questionKey !== nextQuestions) {
    questionKey = nextQuestions; questionInputs.clear(); $('question-list').replaceChildren();
    for (const question of questions) {
      const row = el('div', '', 'row'), label = el('label', question.label), input = answerInput(question);
      input.id = `detail-${question.key}`; label.htmlFor = input.id; input.maxLength = 10000;
      input.value = drafts.get(question.key) ?? ''; input.oninput = () => drafts.set(question.key, input.value);
      questionInputs.set(question.key, input); row.append(label, input); $('question-list').append(row);
    }
  }
  for (const input of questionInputs.values()) input.disabled = busy;
  const fields = state.prepared?.fields || [];
  // Paste/approval status updates must not replace focused controls or discard typed drafts.
  const nextFields = JSON.stringify([state.prepared?.formId, state.prepared?.snapshot, fields]);
  if (fieldKey !== nextFields) {
    fieldKey = nextFields; reviewInputs.clear(); const list = $('field-list'); list.replaceChildren();
    for (const field of fields) {
      const row = el('div', '', 'row');
      const label = el('label', '', 'check'), check = el('input'); check.type = 'checkbox'; check.checked = state.selected.includes(field.id); check.onchange = () => selection(field.id, check.checked);
      label.append(check, el('span', field.label)); row.append(label);
      const input = answerInput(field); input.setAttribute('aria-label', `Reviewed value for ${field.label}`); input.value = state.edits[field.id] ?? '';
      input.oninput = () => { state.edits[field.id] = input.value; edited(); };
      reviewInputs.set(field.id, { input, check, manual: field.manualOnly || !field.empty });
      row.append(input); list.append(row);
    }
  }
  const unresolved = $('unresolved'); unresolved.replaceChildren();
  const reusableLabels = new Set(questions.map(question => question.label));
  const unknown = (state.prepared?.unresolved || []).filter(item => !reusableLabels.has(item.label));
  if (unknown.length) {
    unresolved.append(el('p', 'These answers could not be determined from your saved CV or profile. Ask your agent for application text.'));
    const list = el('ul'); for (const item of unknown) list.append(el('li', item.label)); unresolved.append(list);
  }
  for (const [id, { input, check, manual }] of reviewInputs) {
    input.disabled = check.disabled = busy || manual;
    check.checked = state.selected.includes(id);
  }
  $('copy').disabled = $('fill').disabled = busy || !!state.answersStale;
}
connect();
