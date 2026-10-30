import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { derivePanelFlow } from '../browser-extension/src/panel-flow.mjs';

const BUILD_ID = 'synthetic-panel-build';
async function panelFixture(initialState = {}, { platform = 'MacIntel', firefox = false, clipboardDenied = false } = {}) {
  const nodes = new Map(), sent = [], copied = [];
  let document;
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.value = ''; this.hidden = false; this.disabled = false; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this[name] = value; }
    focus() { document.activeElement = this; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    reportValidity() { this.validityChecks = (this.validityChecks || 0) + 1; return this.valid !== false; }
  }
  const html = await readFile(new URL('../browser-extension/src/panel.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) nodes.set(match[2], new Element(match[1]));
  const descendants = node => [node, ...node.children.flatMap(descendants)];
  const all = () => [...nodes.values()].flatMap(descendants);
  document = { activeElement: null, getElementById: id => nodes.get(id) || all().find(node => node.id === id), createElement: tag => new Element(tag), querySelectorAll: selector => all().filter(node => selector === 'button' ? node.tagName === 'BUTTON' : Object.hasOwn(node.dataset, 'job') && (!selector.endsWith(':checked') || node.checked)) };
  let receive, disconnected, reloads = 0, tabQueries = 0;
  const port = { onMessage: { addListener(fn) { receive = fn; } }, onDisconnect: { addListener(fn) { disconnected = fn; } }, postMessage(message) { sent.push(JSON.parse(JSON.stringify(message))); } };
  const context = vm.createContext({
    document, derivePanelFlow,
    [firefox ? 'browser' : 'chrome']: { runtime: { connect: () => port, reload() { reloads++; } }, tabs: { query: async () => { tabQueries++; return [{ id: 7 }]; } } },
    navigator: { platform, clipboard: { writeText: async text => { if (clipboardDenied) throw Error('denied'); copied.push(text); } } }, setInterval() {}, setTimeout() {}, clearTimeout() {},
  });
  const source = await readFile(new URL('../browser-extension/src/panel.mjs', import.meta.url), 'utf8');
  vm.runInContext(source.replace(/^import \{ BUILD_ID \} from '\.\/config\.mjs';/, `const BUILD_ID = ${JSON.stringify(BUILD_ID)};`).replace(/^import \{ derivePanelFlow \} from '\.\/panel-flow\.mjs';/m, ''), context);
  const state = { buildId: BUILD_ID, busy: null, notice: '', error: '', pageKind: 'application', companion: { workflowVersion: 2, hasCv: true }, tabId: 7, documentId: 'doc', page: { title: 'Application · Example', url: 'https://example.test/apply' }, jobs: [], form: { fields: [] }, selected: ['name'], edits: { name: 'Saved Name' }, paste: null,
    prepared: { formId: 'form:synthetic', snapshot: 'snapshot:synthetic', api: { configured: false, used: false }, fields: [{ id: 'name', label: 'Full name', type: 'text', value: 'Saved Name', empty: true }], questions: [{ key: 'phone', label: 'Phone', type: 'tel', required: true }], unresolved: [{ label: 'Why this role?', reason: 'private internal reason' }] } };
  const update = patch => { Object.assign(state, patch); receive(JSON.parse(JSON.stringify(state))); };
  update(initialState);
  const inputs = id => descendants(nodes.get(id)).filter(node => ['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName));
  return { nodes, sent, copied, state, update, inputs, html, descendants, document, disconnect: () => disconnected(), get reloads() { return reloads; }, get tabQueries() { return tabQueries; } };
}
const application = (overrides = {}) => ({
  bindingId: 'binding:private-internal', title: 'Engineer', company: 'Example', state: 'needs_documents',
  documents: [{ kind: 'cv', ready: false }, { kind: 'cover_letter', ready: false }], introduction: { ready: false },
  writing: [], handoff: null, jobUrl: 'https://jobs.example.test/role', ...overrides,
});

test('Chrome and Firefox offer the native clipboard shortcut on every supported desktop OS', async () => {
  for (const firefox of [false, true]) for (const [platform, shortcut] of [['MacIntel', '⌘V'], ['Win32', 'Ctrl+V'], ['Linux x86_64', 'Ctrl+V']]) {
    const panel = await panelFixture({}, { platform, firefox });
    assert.ok(panel.nodes.get('paste').textContent.includes(shortcut));
    panel.update({ paste: { label: 'Full name', ok: true } });
    assert.ok(panel.nodes.get('paste').textContent.includes(shortcut));
    assert.ok(panel.nodes.get('paste').textContent.includes('Full name'));
    await panel.nodes.get('refresh').onclick();
    assert.deepEqual(panel.sent.at(-1), { action: 'detect', payload: { tabId: 7 } });
  }
});

test('one Prepare action launches the selected app, while Options persists the choice independently', async () => {
  const panel = await panelFixture({ application: application(), applicationHost: 'codex', prepared: null });
  assert.equal(panel.nodes.get('title').textContent, 'Engineer');
  assert.equal(panel.nodes.get('company').textContent, 'Example');
  assert.equal(panel.nodes.get('application-prepare').hidden, false);
  assert.equal(panel.nodes.get('detect').hidden, true);
  panel.nodes.get('application-prepare').onclick();
  assert.deepEqual(panel.sent.at(-1), { action: 'application-prepare', payload: { host: 'codex' } });
  panel.nodes.get('application-host').value = 'claude'; panel.nodes.get('application-host').onchange();
  assert.deepEqual(panel.sent.at(-1), { action: 'application-host', payload: { host: 'claude' } });
  assert.equal(panel.nodes.get('application').hidden, true, 'no empty document section');
});

test('handoffs give actual Send or Enter instructions and never expose Stop or another Start', async () => {
  for (const [mode, instruction] of [['cli', 'Enter'], ['desktop', 'Send']]) {
    const waiting = application({ handoff: { host: 'codex', requiresSend: true, mode } });
    const panel = await panelFixture({ application: waiting });
    assert.ok(panel.nodes.get('status').textContent.includes(instruction));
    assert.equal(panel.nodes.get('application-prepare').hidden, true);
    assert.equal(panel.nodes.get('cancel').hidden, true);
    panel.update({ application: { ...waiting, handoff: { host: 'codex', state: 'agent_read', requiresSend: false } } });
    assert.match(panel.nodes.get('status').textContent, /has read/);
    assert.doesNotMatch(panel.nodes.get('status').textContent, /writing|generating/i);
    assert.equal(panel.nodes.get('application').hidden, true);
  }
});

test('only owned preparation exposes Stop and removes its inactive primary action', async () => {
  const panel = await panelFixture({ busy: 'prepare' });
  assert.equal(panel.nodes.get('cancel').hidden, false); assert.equal(panel.nodes.get('cancel').disabled, false);
  assert.equal(panel.nodes.get('application-prepare').hidden, true);
  panel.nodes.get('cancel').onclick(); assert.equal(panel.sent.at(-1).action, 'cancel');
  panel.update({ busy: 'application-prepare' }); assert.equal(panel.nodes.get('cancel').hidden, true);
});

test('paste, errors and saved answer refreshes preserve explicit edits, selections and focused controls', async () => {
  const panel = await panelFixture();
  const question = panel.inputs('question-list')[0], reviewed = panel.inputs('field-list').find(node => node.type !== 'checkbox');
  question.value = '+44 1234567890'; question.oninput();
  reviewed.value = 'Reviewed Candidate'; reviewed.oninput(); reviewed.focus(); reviewed.setSelectionRange(4, 8);
  for (const patch of [{ paste: { label: 'Full name', ok: true } }, { error: 'Storage is locked. Unlock Companion and try again.' }, { error: '', prepared: { ...panel.state.prepared, snapshot: 'new', fields: [{ ...panel.state.prepared.fields[0], value: 'New saved name' }] }, edits: { name: 'New saved name' } }]) {
    panel.update(patch);
    assert.equal(panel.inputs('question-list')[0], question);
    assert.equal(panel.inputs('field-list').find(node => node.type !== 'checkbox'), reviewed);
    assert.equal(question.value, '+44 1234567890'); assert.equal(reviewed.value, 'Reviewed Candidate');
    assert.equal(panel.document.activeElement, reviewed); assert.equal(reviewed.selectionStart, 4);
  }
  await panel.nodes.get('copy').onclick(); assert.deepEqual(panel.copied, ['Full name: Reviewed Candidate']);
});

test('schema changes restore focus and draft only for the same surviving answer', async () => {
  const panel = await panelFixture(), input = panel.inputs('field-list').find(node => node.type !== 'checkbox');
  input.value = 'Explicit edit'; input.oninput(); input.focus(); input.setSelectionRange(2, 4);
  panel.update({ prepared: { ...panel.state.prepared, fields: [{ ...panel.state.prepared.fields[0], label: 'Your full name' }] } });
  const replacement = panel.inputs('field-list').find(node => node.type !== 'checkbox');
  assert.equal(replacement.value, 'Explicit edit'); assert.equal(panel.document.activeElement, replacement); assert.equal(replacement.selectionStart, 2);
});

test('save details uses native validation, allows a subset and clears only confirmed saved values', async () => {
  const panel = await panelFixture();
  panel.update({ prepared: { ...panel.state.prepared, questions: [{ key: 'phone', label: 'Phone', type: 'tel', required: true }, { key: 'email', label: 'Email', type: 'email', required: true }] } });
  const form = panel.nodes.get('details-form'), [phone, email] = panel.inputs('question-list');
  phone.value = '+44 1234567890'; phone.oninput();
  assert.notEqual(phone.required, true); assert.notEqual(email.required, true);
  form.valid = false; form.onsubmit({ preventDefault() {} }); assert.equal(panel.sent.length, 0);
  form.valid = true; form.onsubmit({ preventDefault() {} });
  assert.deepEqual(panel.sent.at(-1), { action: 'profile-save', payload: { values: { phone: '+44 1234567890' } } });
  assert.equal(phone.value, '+44 1234567890');
  panel.update({ busy: 'profile-save' }); assert.equal(phone.disabled, true);
  panel.update({ busy: null, error: 'Could not save.' }); assert.equal(phone.value, '+44 1234567890');
  panel.update({ error: '', saveReceipt: { id: 'receipt', keys: ['phone'] }, notice: 'Details saved.' }); assert.equal(phone.value, '');
});

test('job-specific summaries are never reusable details; boolean answers require an explicit choice', async () => {
  const panel = await panelFixture();
  panel.update({ prepared: { ...panel.state.prepared, questions: [{ key: 'personalSummary', label: 'Summary', type: 'textarea' }] } });
  assert.equal(panel.inputs('question-list').length, 0); assert.equal(panel.nodes.get('missing-details').hidden, true);
  panel.update({ prepared: { ...panel.state.prepared, questions: [{ key: 'requiresSponsorship', label: 'Sponsorship?', type: 'boolean', options: [{ value: true, label: 'Yes' }, { value: false, label: 'No' }] }] } });
  const input = panel.inputs('question-list')[0]; assert.equal(input.value, '');
  panel.nodes.get('details-form').onsubmit({ preventDefault() {} }); assert.equal(panel.sent.length, 0);
  input.value = 'false'; input.oninput(); panel.nodes.get('details-form').onsubmit({ preventDefault() {} });
  assert.deepEqual(panel.sent.at(-1).payload.values, { requiresSponsorship: false });
});

test('inspected webpage values never become answer controls before successful preparation', async () => {
  const panel = await panelFixture({ prepared: null, form: { fields: [{ id: 'name', value: 'Private webpage value' }] } });
  for (const patch of [{}, { busy: 'prepare' }, { busy: null, error: 'Preparation cancelled.' }]) {
    panel.update(patch); assert.equal(panel.nodes.get('review').hidden, true); assert.equal(panel.inputs('field-list').length, 0); assert.equal(panel.nodes.get('paste').hidden, true);
    assert.doesNotMatch(JSON.stringify([...panel.nodes.values()]), /Private webpage value/);
  }
});

test('clipboard progress, failure, confirmation and browser denial remain distinct', async () => {
  const panel = await panelFixture(), notices = new Set([panel.nodes.get('paste').textContent]);
  for (const ok of [undefined, false, true]) { panel.update({ paste: { label: 'Full name', ok } }); notices.add(panel.nodes.get('paste').textContent); }
  assert.equal(notices.size, 4);
  const denied = await panelFixture({}, { clipboardDenied: true }); await denied.nodes.get('copy').onclick();
  assert.equal(denied.nodes.get('error').hidden, false); assert.match(denied.nodes.get('error').textContent, /manually/);
});

test('missing answers show reusable details separately and do not leak internal reasons', async () => {
  const panel = await panelFixture();
  panel.update({ prepared: { ...panel.state.prepared, fields: [], unresolved: [{ label: 'Phone', reason: 'private reason' }, { label: 'Why this role?', reason: 'private reason' }] } });
  assert.equal(panel.nodes.get('paste').hidden, true); assert.equal(panel.nodes.get('review-actions').hidden, true);
  assert.equal(panel.nodes.get('details-form').hidden, false);
  assert.deepEqual(panel.nodes.get('unresolved').children[1].children.map(node => node.textContent), ['Why this role?']);
  assert.doesNotMatch(JSON.stringify(panel.nodes.get('unresolved')), /private reason|Phone/);
  panel.update({ prepared: { ...panel.state.prepared, unresolved: [] } }); assert.equal(panel.nodes.get('unresolved').children.length, 0);
});

test('drafts survive preparation resets but do not cross document boundaries', async () => {
  const panel = await panelFixture(), prepared = panel.state.prepared;
  const input = panel.inputs('question-list')[0]; input.value = 'Unsaved phone'; input.oninput();
  panel.update({ prepared: null, busy: 'prepare' }); panel.update({ prepared, busy: null });
  assert.equal(panel.inputs('question-list')[0].value, 'Unsaved phone');
  panel.update({ documentId: 'another-page' }); assert.equal(panel.inputs('question-list')[0].value, '');
});

test('build mismatch offers only explicit reload and preserves drafts until the compatible worker returns', async () => {
  const panel = await panelFixture(), question = panel.inputs('question-list')[0]; question.value = 'Draft'; question.oninput();
  for (const buildId of [undefined, 'older-build']) {
    panel.update({ buildId });
    for (const id of ['settings', 'error', 'cancel', 'page', 'application', 'form', 'jobs', 'options']) assert.equal(panel.nodes.get(id).hidden, true);
    assert.equal(panel.nodes.get('detect').textContent, 'Reload extension');
    panel.update({ busy: 'prepare' }); panel.nodes.get('detect').onclick(); assert.equal(panel.reloads, 0);
    panel.update({ busy: null });
  }
  panel.nodes.get('detect').onclick(); assert.equal(panel.reloads, 1); assert.equal(panel.tabQueries, 0);
  panel.update({ buildId: BUILD_ID }); assert.equal(panel.inputs('question-list')[0], question); assert.equal(question.value, 'Draft');
});

test('ready documents expose one Show CV and Copy intro, never paths or duplicate document actions', async () => {
  const panel = await panelFixture({ application: application({ state: 'ready', introduction: { ready: true }, documents: [{ kind: 'cv', ready: true, uri: 'file:///private/candidate.pdf', bytes: 'private CV' }, { kind: 'cover_letter', ready: true }] }) });
  assert.equal(panel.nodes.get('show-cv').hidden, false); assert.equal(panel.nodes.get('copy-intro').hidden, false);
  assert.equal(panel.nodes.get('application-prepare').hidden, true);
  panel.nodes.get('show-cv').onclick(); panel.nodes.get('copy-intro').onclick();
  assert.deepEqual(panel.sent.slice(-2), [{ action: 'application-document', payload: { kind: 'cv', action: 'reveal' } }, { action: 'copy-intro', payload: {} }]);
  assert.doesNotMatch(JSON.stringify([...panel.nodes.values()]), /private-internal|file:\/\/|private CV/);
  assert.equal(panel.nodes.get('application-notice').hidden, true, 'dispatch alone is not a copied receipt');
  panel.update({ applicationNotice: 'Introduction copied.' }); assert.equal(panel.nodes.get('application-notice').textContent, 'Introduction copied.');
  panel.update({ busy: 'application-document' }); assert.equal(panel.nodes.get('show-cv').disabled, true);
});

test('partial and stale application state never expose missing or outdated artifacts', async () => {
  const panel = await panelFixture({ application: application({ state: 'drafts', documents: [{ kind: 'cv', ready: true }], introduction: { ready: false } }) });
  assert.equal(panel.nodes.get('show-cv').hidden, false); assert.equal(panel.nodes.get('copy-intro').hidden, true);
  panel.update({ application: application({ state: 'ready' }), answersStale: true, applicationAnswersPending: true });
  assert.equal(panel.nodes.get('application-answers').hidden, false); assert.equal(panel.nodes.get('paste').hidden, true); assert.equal(panel.nodes.get('copy').disabled, true);
  panel.nodes.get('application-answers').onclick(); assert.equal(panel.sent.at(-1).action, 'application-answers');
  panel.update({ application: application({ state: 'needs_refresh' }) });
  assert.equal(panel.nodes.get('application-prepare').hidden, false); assert.equal(panel.nodes.get('show-cv').hidden, true);
});

test('non-job and listing states win over irrelevant setup and listing choice uses an exact URL', async () => {
  const panel = await panelFixture({ pageKind: 'none', companion: { locked: true }, prepared: null });
  assert.equal(panel.nodes.get('recover').hidden, true); assert.equal(panel.nodes.get('application-prepare').hidden, true);
  const jobs = [{ title: '<Engineer>', company: 'Example', url: 'https://example.test/one' }, { title: 'Designer', url: 'https://example.test/two' }];
  panel.update({ pageKind: 'listing', jobs });
  assert.equal(panel.nodes.get('job-selection').hidden, false); assert.equal(panel.nodes.get('page').hidden, true);
  assert.equal(panel.nodes.get('application-prepare').hidden, true);
  const buttons = panel.descendants(panel.nodes.get('candidate-list')).filter(node => node.tagName === 'BUTTON');
  assert.equal(buttons[0].textContent, '<Engineer>'); buttons[1].onclick();
  assert.deepEqual(panel.sent.at(-1), { action: 'open-job', payload: { url: jobs[1].url } });
});

test('Companion recovery distinguishes unavailable, locked, old, missing CV and unavailable AI without account gating', async () => {
  const panel = await panelFixture({ application: application(), companion: { workflowVersion: 2, hasCv: true, paired: false } });
  assert.equal(panel.nodes.get('application-prepare').hidden, false);
  panel.update({ errorCode: 'COMPANION_UNAVAILABLE' }); assert.equal(panel.nodes.get('install').hidden, false); assert.equal(panel.nodes.get('detect').textContent, 'Retry');
  await panel.nodes.get('detect').onclick(); assert.equal(panel.sent.at(-1).action, 'detect');
  for (const [companion, expected] of [[{ locked: true }, /Unlock/], [{ workflowVersion: 1 }, /Update/], [{ workflowVersion: 2, hasCv: false }, /Import CV/], [{ workflowVersion: 2, hostInfo: { claude: { available: false } } }, /unavailable/]]) {
    panel.update({ errorCode: null, companion }); assert.match(panel.nodes.get('status').textContent, expected); assert.equal(panel.nodes.get('recover').hidden, false);
    assert.equal(panel.nodes.get('application-prepare').hidden, true); panel.nodes.get('recover').onclick(); assert.equal(panel.sent.at(-1).action, 'settings');
  }
});

test('extra-help errors recover with saved answers and other errors preserve drafts', async () => {
  const panel = await panelFixture(), input = panel.inputs('question-list')[0]; input.value = 'Draft'; input.oninput();
  panel.update({ errorCode: 'DECISIONS_KEY_REQUIRED', error: 'Internal API diagnostic' });
  assert.equal(panel.nodes.get('prepare-saved').hidden, false); panel.nodes.get('prepare-saved').onclick(); assert.equal(panel.sent.at(-1).action, 'prepare-saved');
  for (const errorCode of ['PAGE_PERMISSION_REQUIRED', 'PAGE_UNSUPPORTED', 'PAGE_READ_FAILED', 'FORM_CONTEXT_CHANGED']) {
    panel.update({ errorCode, error: 'Read the page again.' }); assert.equal(panel.nodes.get('error').hidden, false); assert.equal(panel.nodes.get('detect').hidden, false);
    assert.equal(panel.inputs('question-list')[0], input); assert.equal(input.value, 'Draft');
  }
});

test('application disappearance and disconnect hide documents rather than carrying them to another page', async () => {
  const ready = application({ state: 'ready', documents: [{ kind: 'cv', ready: true }], introduction: { ready: true } });
  const panel = await panelFixture({ application: ready });
  panel.update({ application: null, page: null, pageKind: 'unknown', form: null, prepared: null, tabId: 9, documentId: null });
  assert.equal(panel.nodes.get('application').hidden, true); assert.equal(panel.nodes.get('show-cv').hidden, true);
  panel.update({ application: ready }); panel.disconnect();
  assert.equal(panel.nodes.get('application').hidden, true); assert.equal(panel.nodes.get('review').hidden, true); assert.match(panel.nodes.get('error').textContent, /disconnected/);
});

test('exact linked adverts keep one Prepare action and secondary original-ad recovery', async () => {
  const panel = await panelFixture({ application: application({ state: 'needs_job' }) });
  assert.equal(panel.nodes.get('application-open-ad').hidden, false);
  assert.equal(panel.nodes.get('application-prepare').hidden, false);
  panel.nodes.get('application-open-ad').onclick();
  assert.deepEqual(panel.sent.at(-1), { action: 'application-open-ad', payload: {} });
  panel.update({ application: application({ state: 'needs_job', jobUrl: null }) });
  assert.equal(panel.nodes.get('application-open-ad').hidden, true);
  assert.equal(panel.nodes.get('detect').hidden, false);
  assert.match(panel.nodes.get('status').textContent, /original job ad/);
});

test('job saving retains explicit choices on metadata refresh but not on another page', async () => {
  const jobs = [{ title: 'Engineer', url: 'https://example.test/one' }, { title: 'Designer', url: 'https://example.test/two' }];
  const panel = await panelFixture({ pageKind: 'listing', jobs, prepared: null });
  panel.inputs('job-list')[1].checked = true;
  panel.update({ jobs: jobs.map(job => ({ ...job, company: 'Example' })) });
  assert.equal(panel.inputs('job-list')[0].checked, false);
  assert.equal(panel.inputs('job-list')[1].checked, true);
  panel.nodes.get('save').onclick();
  assert.deepEqual(panel.sent.at(-1), { action: 'save', payload: { indexes: [1] } });
  panel.update({ documentId: 'new-page' });
  assert.equal(panel.inputs('job-list')[1].checked, false);
});

test('owned preparation restores a suspended answer focus without stealing a new focus', async () => {
  const panel = await panelFixture(), input = panel.inputs('field-list').find(node => node.type !== 'checkbox');
  input.focus(); input.setSelectionRange(2, 4);
  panel.update({ busy: 'prepare' }); panel.document.activeElement = null;
  panel.update({ busy: null });
  assert.equal(panel.document.activeElement, input); assert.equal(input.selectionStart, 2);
  panel.update({ busy: 'prepare' });
  panel.nodes.get('options').focus();
  panel.update({ busy: null });
  assert.equal(panel.document.activeElement, panel.nodes.get('options'));
});
