import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const BUILD_ID = 'synthetic-panel-build';

async function panelFixture(initialState = {}) {
  const nodes = new Map(), sent = [];
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.value = ''; this.hidden = false; this.disabled = false; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this[name] = value; }
    reportValidity() { this.validityChecks = (this.validityChecks || 0) + 1; return this.valid !== false; }
  }
  const html = await readFile(new URL('../browser-extension/src/panel.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) nodes.set(match[2], new Element(match[1]));
  const descendants = node => [node, ...node.children.flatMap(descendants)];
  const all = () => [...nodes.values()].flatMap(descendants);
  let receive, disconnected, reloads = 0, tabQueries = 0;
  const port = { onMessage: { addListener(fn) { receive = fn; } }, onDisconnect: { addListener(fn) { disconnected = fn; } }, postMessage(message) { sent.push(JSON.parse(JSON.stringify(message))); } };
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id), createElement: tag => new Element(tag), querySelectorAll: selector => all().filter(node => selector === 'button' ? node.tagName === 'BUTTON' : Object.hasOwn(node.dataset, 'job') && (!selector.endsWith(':checked') || node.checked)) },
    chrome: { runtime: { connect: () => port, reload() { reloads++; } }, tabs: { query: async () => { tabQueries++; return [{ id: 7 }]; } } },
    navigator: { clipboard: { writeText: async () => {} } }, setInterval() {}, setTimeout() {}, clearTimeout() {},
  });
  const source = await readFile(new URL('../browser-extension/src/panel.mjs', import.meta.url), 'utf8');
  assert.match(source, /^import \{ BUILD_ID \} from '\.\/config\.mjs';/);
  vm.runInContext(source.replace(/^import \{ BUILD_ID \} from '\.\/config\.mjs';/, `const BUILD_ID = ${JSON.stringify(BUILD_ID)};`), context);
  const state = { buildId: BUILD_ID, busy: null, notice: '', error: '', tabId: 7, documentId: 'doc', page: { title: 'Application · Example', url: 'https://example.test/apply' }, jobs: [], form: { fields: [] }, selected: [], edits: { name: 'Saved Name' }, paste: null,
    prepared: { formId: 'form:synthetic', snapshot: 'snapshot:synthetic', api: { configured: false, used: false }, fields: [{ id: 'name', label: 'Full name', type: 'text', value: 'Saved Name', empty: true }], questions: [{ key: 'phone', label: 'Phone', type: 'tel', required: true }], unresolved: [{ label: 'Why this role?', reason: 'private internal reason' }] } };
  const update = patch => { Object.assign(state, patch); receive(JSON.parse(JSON.stringify(state))); };
  update(initialState);
  const inputs = id => descendants(nodes.get(id)).filter(node => ['INPUT','SELECT','TEXTAREA'].includes(node.tagName));
  return { nodes, sent, state, update, inputs, html, descendants, disconnect: () => disconnected(), get reloads() { return reloads; }, get tabQueries() { return tabQueries; } };
}

test('paste and error updates preserve focused question and reviewed answer drafts', async () => {
  const panel = await panelFixture();
  const question = panel.inputs('question-list')[0], reviewed = panel.inputs('field-list').find(node => node.type !== 'checkbox');
  question.value = '+44 1234567890'; question.oninput();
  reviewed.value = 'Reviewed Candidate'; reviewed.oninput();
  panel.update({ paste: { label: 'Full name', ok: true } });
  assert.equal(panel.inputs('question-list')[0], question);
  assert.equal(panel.inputs('field-list').find(node => node.type !== 'checkbox'), reviewed);
  assert.equal(question.value, '+44 1234567890');
  assert.equal(reviewed.value, 'Reviewed Candidate');
  panel.update({ error: 'Storage is locked. Unlock Companion and try again.' });
  assert.equal(question.value, '+44 1234567890');
  assert.equal(panel.nodes.get('error').hidden, false);
  assert.match(panel.nodes.get('error').textContent, /Unlock Companion/);
});

test('save details uses native validation and dispatches only explicitly entered answers', async () => {
  const panel = await panelFixture(), form = panel.nodes.get('details-form'), question = panel.inputs('question-list')[0];
  question.value = '+44 1234567890'; question.oninput();
  form.valid = false; form.onsubmit({ preventDefault() {} });
  assert.equal(panel.sent.length, 0);
  form.valid = true; form.onsubmit({ preventDefault() {} });
  assert.deepEqual(panel.sent, [{ action: 'profile-save', payload: { values: { phone: '+44 1234567890' } } }]);
  assert.equal(form.validityChecks, 2);
  assert.equal(question.value, '+44 1234567890', 'dispatch alone is not persistence');
  panel.update({ busy: 'profile-save' });
  assert.equal(question.disabled, true);
  panel.update({ busy: null, error: 'Companion did not confirm saving these details.' });
  assert.equal(question.value, '+44 1234567890');
  assert.equal(question.disabled, false);
  assert.doesNotMatch(panel.nodes.get('status').textContent, /saved/);
  panel.update({ error: '', saveReceipt: { id: 'receipt', keys: ['phone'] }, notice: 'Details saved on this computer.' });
  assert.equal(question.value, '');
  assert.match(panel.nodes.get('status').textContent, /saved on this computer/);
});

test('default panel exposes missing questions and recovery, with technical answers collapsed', async () => {
  const panel = await panelFixture();
  assert.equal(panel.nodes.get('details-form').hidden, false);
  assert.equal(panel.nodes.get('configure').hidden, false);
  assert.equal(panel.nodes.get('ready').textContent, '1 answer ready');
  assert.match(panel.html, /<details id="review" hidden><summary>Review answers<\/summary>/);
  assert.equal(panel.nodes.get('review').hidden, false);
  assert.doesNotMatch(panel.html, /id="(?:api|prepare|url|form-id)"/);
  assert.equal(panel.nodes.get('unresolved').children[0].textContent, 'These answers could not be determined from your saved CV or profile. Ask your agent for application text.');
  assert.doesNotMatch(JSON.stringify(panel.nodes.get('unresolved')), /private internal reason/);
  panel.update({ busy: 'prepare' });
  assert.equal(panel.nodes.get('cancel').hidden, false);
  assert.equal(panel.nodes.get('cancel').disabled, false);
  assert.match(panel.nodes.get('status').textContent, /Companion/);
  panel.update({ busy: null, prepared: { ...panel.state.prepared, questions: [], api: { configured: true, used: false } } });
  assert.equal(panel.nodes.get('details-form').hidden, true);
  assert.equal(panel.nodes.get('configure').hidden, true);
});

test('job-specific personal summaries never appear as reusable profile details', async () => {
  const panel = await panelFixture();
  panel.update({ prepared: { ...panel.state.prepared, questions: [{ key: 'personalSummary', label: 'Personal summary', type: 'textarea' }] } });
  assert.equal(panel.inputs('question-list').length, 0);
  assert.equal(panel.nodes.get('details-form').hidden, true);
  panel.nodes.get('details-form').onsubmit({ preventDefault() {} });
  assert.equal(panel.sent.length, 0);
});

test('sponsorship remains blank until an explicit Yes or No selection', async () => {
  const panel = await panelFixture();
  panel.update({ prepared: { ...panel.state.prepared, questions: [{ key: 'requiresSponsorship', label: 'Do you require visa sponsorship?', type: 'boolean', options: [{ value: true, label: 'Yes' }, { value: false, label: 'No' }] }] } });
  const input = panel.inputs('question-list')[0];
  assert.equal(input.tagName, 'SELECT');
  assert.equal(input.value, '');
  assert.equal(input.children[0].value, '');
  panel.nodes.get('details-form').onsubmit({ preventDefault() {} });
  assert.equal(panel.sent.length, 0);
  input.value = 'false'; input.oninput();
  panel.nodes.get('details-form').onsubmit({ preventDefault() {} });
  assert.deepEqual(panel.sent.at(-1), { action: 'profile-save', payload: { values: { requiresSponsorship: false } } });
});

test('local detail saves allow a nonempty subset of employer-required questions', async () => {
  const panel = await panelFixture();
  panel.update({ prepared: { ...panel.state.prepared, questions: [
    { key: 'phone', label: 'Phone', type: 'tel', required: true },
    { key: 'email', label: 'Email', type: 'email', required: true },
  ] } });
  const [phone, email] = panel.inputs('question-list');
  assert.notEqual(phone.required, true);
  assert.notEqual(email.required, true);
  phone.value = '+44 1234567890'; phone.oninput();
  panel.nodes.get('details-form').onsubmit({ preventDefault() {} });
  assert.deepEqual(panel.sent.at(-1), { action: 'profile-save', payload: { values: { phone: '+44 1234567890' } } });
  assert.equal(email.value, '');
});

test('inspected fields stay hidden until preparation succeeds, including during preparation and errors', async () => {
  const panel = await panelFixture({ prepared: null, form: { fields: [
    { id: 'name', label: 'Full name', type: 'text', value: 'Private webpage value' },
    { id: 'email', label: 'Email', type: 'email' },
  ] } });
  const assertUnprepared = () => {
    assert.equal(panel.nodes.get('review').hidden, true);
    assert.equal(panel.nodes.get('field-list').children.length, 0);
    assert.equal(panel.inputs('field-list').length, 0);
    assert.equal(panel.nodes.get('details-form').hidden, true);
    assert.equal(panel.nodes.get('paste').hidden, true);
    assert.equal(panel.nodes.get('review-actions').hidden, true);
    assert.doesNotMatch(JSON.stringify([...panel.nodes.values()]), /Private webpage value|Answer on the page/);
  };
  assertUnprepared();
  assert.equal(panel.nodes.get('ready').hidden, false);
  assert.equal(panel.nodes.get('ready').textContent, 'Answers are not ready. Read page to prepare them.');
  panel.update({ busy: 'prepare' });
  assertUnprepared();
  assert.equal(panel.nodes.get('ready').hidden, true);
  assert.match(panel.nodes.get('status').textContent, /Preparing answers/);
  panel.update({ busy: null, error: 'Preparation was cancelled. Read page to try again.' });
  assertUnprepared();
  assert.equal(panel.nodes.get('ready').hidden, true);
  assert.equal(panel.nodes.get('error').hidden, false);
  panel.update({ error: '', prepared: { formId: 'form:prepared', snapshot: 'snapshot:prepared', fields: [
    { id: 'name', label: 'Full name', type: 'text', empty: true },
  ], questions: [], unresolved: [] } });
  assert.equal(panel.nodes.get('review').hidden, false);
  assert.equal(panel.nodes.get('ready').textContent, '1 answer ready');
  assert.equal(panel.inputs('field-list').length, 2);
  assert.equal(panel.nodes.get('paste').hidden, false);
  assert.doesNotMatch(panel.nodes.get('paste').textContent, /Clipboard ready/);
});

test('clipboard readiness is specific to a field and requires confirmed clipboard success', async () => {
  const panel = await panelFixture(), paste = panel.nodes.get('paste');
  assert.doesNotMatch(paste.textContent, /Clipboard ready/);
  panel.update({ paste: { label: 'Full name' } });
  assert.match(paste.textContent, /Preparing the clipboard for Full name/);
  assert.doesNotMatch(paste.textContent, /Clipboard ready/);
  panel.update({ paste: { label: 'Full name', ok: false } });
  assert.match(paste.textContent, /Clipboard access refused for Full name/);
  assert.doesNotMatch(paste.textContent, /Clipboard ready/);
  panel.update({ paste: { label: 'Full name', ok: true } });
  assert.equal(paste.textContent, 'Clipboard ready for Full name. Press ⌘V in that field.');
  assert.equal(panel.nodes.get('details-form').hidden, false, 'one clipboard answer does not resolve missing details');
  panel.update({ paste: null });
  assert.doesNotMatch(paste.textContent, /Clipboard ready/);
});

test('prepared forms with no supported answers show missing details without fake answer controls', async () => {
  const panel = await panelFixture();
  panel.update({ prepared: { ...panel.state.prepared, fields: [], unresolved: [
    { label: 'Phone', reason: 'missing basic detail' },
    { label: 'Why this role?', reason: 'private reason' },
    { label: 'Cover letter', reason: 'another private reason' },
  ] } });
  assert.equal(panel.nodes.get('ready').textContent, 'No paste answers ready.');
  assert.equal(panel.nodes.get('paste').hidden, true);
  assert.equal(panel.nodes.get('review-actions').hidden, true);
  assert.equal(panel.nodes.get('review').hidden, false);
  assert.equal(panel.nodes.get('field-list').children.length, 0);
  assert.equal(panel.nodes.get('details-form').hidden, false);
  assert.equal(panel.inputs('question-list').length, 1);
  const unresolved = panel.nodes.get('unresolved');
  assert.equal(unresolved.children.filter(node => node.tagName === 'P').length, 1);
  assert.deepEqual(unresolved.children[1].children.map(node => node.textContent), ['Why this role?', 'Cover letter']);
  assert.doesNotMatch(JSON.stringify(unresolved), /Phone|private reason|Answer on the page/);
  panel.update({ prepared: { ...panel.state.prepared, unresolved: [] } });
  assert.equal(unresolved.children.length, 0, 'unresolved state updates independently of prepared field values');
});

test('missing-detail drafts survive preparation resets but never cross to another page', async () => {
  const panel = await panelFixture(), prepared = panel.state.prepared;
  const question = panel.inputs('question-list')[0];
  question.value = '+44 1234567890'; question.oninput();
  panel.update({ prepared: null, busy: 'prepare' });
  assert.equal(panel.nodes.get('details-form').hidden, true);
  panel.update({ prepared, busy: null });
  assert.equal(panel.inputs('question-list')[0].value, '+44 1234567890');
  panel.update({ documentId: 'different-page' });
  assert.equal(panel.inputs('question-list')[0].value, '');
});

test('missing or outdated worker build blocks page reads and exposes only an explicit reload action', async () => {
  for (const buildId of [undefined, 'older-build']) {
    const panel = await panelFixture({ buildId, page: null, notice: 'Application form detected. Prepare values.', error: 'Old worker error' });
    assert.equal(panel.nodes.get('status').textContent, 'Extension updated. Reload to continue.');
    assert.equal(panel.nodes.get('status').hidden, false);
    for (const id of ['settings', 'error', 'cancel', 'page', 'application', 'form', 'jobs', 'ready', 'paste', 'review', 'details-form']) {
      assert.equal(panel.nodes.get(id).hidden, true, `${id} must be hidden for a stale worker`);
    }
    assert.equal(panel.nodes.get('field-list').children.length, 0);
    assert.equal(panel.nodes.get('detect').textContent, 'Reload extension');
    assert.equal(panel.tabQueries, 0);
    assert.equal(panel.sent.length, 0);
    assert.equal(panel.reloads, 0, 'updates never silently reload the extension');
    panel.update({ busy: 'prepare' });
    assert.equal(panel.nodes.get('detect').disabled, true);
    panel.nodes.get('detect').onclick();
    assert.equal(panel.reloads, 0);
    panel.update({ busy: null });
    assert.equal(panel.nodes.get('detect').disabled, false);
    panel.nodes.get('detect').onclick();
    assert.equal(panel.reloads, 1);
    assert.equal(panel.tabQueries, 0);
    assert.equal(panel.sent.length, 0);
  }
});

test('build mismatch hides but preserves drafts until a compatible worker returns', async () => {
  const panel = await panelFixture(), question = panel.inputs('question-list')[0];
  question.value = '+44 1234567890'; question.oninput();
  panel.update({ buildId: 'older-build' });
  assert.equal(panel.nodes.get('details-form').hidden, true);
  assert.equal(panel.reloads, 0);
  panel.update({ buildId: BUILD_ID });
  assert.equal(panel.nodes.get('detect').textContent, 'Read page');
  assert.equal(panel.nodes.get('details-form').hidden, false);
  assert.equal(panel.nodes.get('settings').hidden, false);
  assert.equal(panel.inputs('question-list')[0], question);
  assert.equal(question.value, '+44 1234567890');
  await panel.nodes.get('detect').onclick();
  assert.deepEqual(panel.sent, [{ action: 'detect', payload: { tabId: 7 } }]);
});

const application = (overrides = {}) => ({
  bindingId: 'binding:private-internal', formId: 'form:private-internal', applicationId: 'application:private-internal',
  title: 'Engineer', company: 'Example', state: 'needs_documents',
  documents: [{ kind: 'cv', ready: false, label: 'CV' }, { kind: 'cover_letter', ready: false, label: 'Cover letter' }],
  writing: [{ fieldId: 'writing:private-internal', label: 'Why this role?', ready: false }], handoff: null,
  answerVersion: null, jobUrl: 'https://jobs.example.test/role',
  ...overrides,
});

test('application preparation remains available without Decisions or prepared values', async () => {
  const panel = await panelFixture({ application: application(), applicationHost: 'codex', prepared: null, error: 'Configure Decisions to map these fields.' });
  assert.equal(panel.nodes.get('application').hidden, false);
  assert.equal(panel.nodes.get('application-title').textContent, 'Engineer · Example');
  assert.equal(panel.nodes.get('application-host').value, 'codex');
  assert.equal(panel.nodes.get('application-prepare').disabled, false);
  assert.equal(panel.nodes.get('application-prepare').textContent, 'Prepare this application');
  panel.nodes.get('application-prepare').onclick();
  assert.deepEqual(panel.sent.at(-1), { action: 'application-prepare', payload: { host: 'codex' } });
  assert.equal(panel.nodes.get('application-writing').textContent, '0 of 1 written answer saved for this job.');
  assert.equal(panel.nodes.get('application-documents').children.length, 2);
  assert.equal(panel.descendants(panel.nodes.get('application-documents')).filter(node => node.tagName === 'BUTTON').length, 0);
  assert.equal(panel.nodes.get('application-upload').hidden, true);
  assert.doesNotMatch(JSON.stringify([...panel.nodes.values()]), /private-internal|file:\/\/|apiKey|Copy agent prompt/);
});

test('opening the agent tells the user to send, never claims writing or document readiness', async () => {
  const waiting = application({ handoff: { host: 'claude', state: 'awaiting_agent', requiresSend: true } });
  const panel = await panelFixture({ application: waiting, applicationHost: 'claude', prepared: null });
  assert.equal(panel.nodes.get('application-prepare').textContent, 'Open in Claude and send the prepared prompt');
  assert.match(panel.nodes.get('application-handoff').textContent, /Send the prepared prompt in Claude to start/);
  assert.doesNotMatch(panel.nodes.get('application-status').textContent, /saved|ready|generating/i);
  assert.equal(panel.nodes.get('application-answers').hidden, true);
  panel.update({ application: { ...waiting, handoff: { ...waiting.handoff, state: 'agent_read', requiresSend: false } } });
  assert.match(panel.nodes.get('application-handoff').textContent, /has read this application request/);
  assert.equal(panel.nodes.get('application-upload').hidden, true, 'reading the request is not a saved export');
  panel.update({ busy: 'application-prepare' });
  assert.equal(panel.nodes.get('application-host').disabled, true);
  assert.equal(panel.nodes.get('application-prepare').disabled, true);
  assert.equal(panel.nodes.get('status').textContent, 'Opening your agent…');
});

test('saved documents update in place, expose exact native actions, and never render private file metadata', async () => {
  const panel = await panelFixture({ application: application() });
  const question = panel.inputs('question-list')[0], reviewed = panel.inputs('field-list').find(node => node.type !== 'checkbox');
  question.value = '+44 1234567890'; question.oninput();
  reviewed.value = 'My reviewed answer'; reviewed.oninput();
  panel.update({ application: application({
    state: 'ready', answerVersion: 'version:private-internal',
    documents: [{ kind: 'cv', ready: true, label: '/private/candidate.pdf', uri: 'file:///private/candidate.pdf', bytes: 'private CV' }, { kind: 'cover_letter', ready: true, label: 'Cover letter' }],
    writing: [{ fieldId: 'private-internal', label: 'Why?', ready: true, value: 'Private written answer' }], credentials: 'secret-key',
  }) });
  assert.equal(panel.inputs('question-list')[0], question);
  assert.equal(panel.inputs('field-list').find(node => node.type !== 'checkbox'), reviewed);
  assert.equal(question.value, '+44 1234567890');
  assert.equal(reviewed.value, 'My reviewed answer');
  const buttons = panel.descendants(panel.nodes.get('application-documents')).filter(node => node.tagName === 'BUTTON');
  assert.deepEqual(buttons.map(button => button.textContent), ['Open', 'Show in Finder', 'Open', 'Show in Finder']);
  buttons[0].onclick(); buttons[3].onclick();
  assert.deepEqual(panel.sent.slice(-2), [
    { action: 'application-document', payload: { kind: 'cv', action: 'open' } },
    { action: 'application-document', payload: { kind: 'cover_letter', action: 'reveal' } },
  ]);
  assert.equal(panel.nodes.get('application-upload').hidden, false);
  assert.equal(panel.nodes.get('application-writing').textContent, '1 of 1 written answer saved for this job.');
  assert.doesNotMatch(JSON.stringify([...panel.nodes.values()]), /private-internal|\/private\/|file:\/\/|private CV|Private written answer|secret-key/);
  panel.update({ busy: 'application-document' });
  assert.ok(buttons.every(button => button.disabled));
});

test('missing and ambiguous jobs offer original-ad recovery without title-only writing claims', async () => {
  const panel = await panelFixture({ application: application({ state: 'needs_job' }) });
  assert.equal(panel.nodes.get('application-open-ad').hidden, false);
  assert.match(panel.nodes.get('application-status').textContent, /full job advert is needed/);
  assert.match(panel.nodes.get('application-status').textContent, /retrieve that exact link/);
  panel.nodes.get('application-open-ad').onclick();
  assert.deepEqual(panel.sent.at(-1), { action: 'application-open-ad', payload: {} });
  panel.update({ application: application({ state: 'needs_job', jobUrl: null }) });
  assert.equal(panel.nodes.get('application-open-ad').hidden, true);
  assert.match(panel.nodes.get('application-status').textContent, /identified unambiguously/);
  assert.match(panel.nodes.get('application-status').textContent, /original job advert/);
  assert.equal(panel.nodes.get('application-prepare').disabled, false, 'the connected agent can explicitly bind the correct saved job');
});

test('current package readiness does not pretend old clipboard values are ready after answers change', async () => {
  const panel = await panelFixture({ application: application({ state: 'ready' }), answersStale: true, applicationAnswersPending: true });
  assert.equal(panel.nodes.get('application-preparation').hidden, true);
  assert.match(panel.nodes.get('ready').textContent, /Saved answers changed/);
  assert.equal(panel.nodes.get('application-answers').hidden, false);
  assert.equal(panel.nodes.get('paste').hidden, true);
  assert.equal(panel.nodes.get('copy').disabled, true);
  assert.equal(panel.nodes.get('fill').disabled, true);
  panel.nodes.get('application-answers').onclick();
  assert.deepEqual(panel.sent.at(-1), { action: 'application-answers', payload: {} });
  panel.update({ busy: 'prepare' });
  assert.equal(panel.nodes.get('cancel').disabled, false);
  assert.equal(panel.nodes.get('application-answers').disabled, true);
  panel.update({ busy: null, error: 'Approval cancelled.' });
  assert.equal(panel.nodes.get('application-answers').hidden, false);
  panel.update({ application: application({ state: 'needs_refresh' }) });
  assert.equal(panel.nodes.get('application-preparation').hidden, false);
});

test('application disappearance and disconnect remove documents, without carrying them to another tab', async () => {
  const ready = application({ state: 'ready', documents: [{ kind: 'cv', ready: true }, { kind: 'cover_letter', ready: true }] });
  const panel = await panelFixture({ application: ready });
  assert.equal(panel.nodes.get('application-documents').children.length, 2);
  panel.update({ application: null, page: null, form: null, prepared: null, tabId: 9, documentId: null });
  assert.equal(panel.nodes.get('application').hidden, true);
  assert.equal(panel.nodes.get('application-documents').children.length, 0);
  assert.equal(panel.nodes.get('application-title').textContent, '');
  panel.update({ application: ready });
  panel.disconnect();
  assert.equal(panel.nodes.get('application').hidden, true);
  assert.equal(panel.nodes.get('application-documents').children.length, 0);
  assert.equal(panel.nodes.get('review').hidden, true);
  assert.match(panel.nodes.get('error').textContent, /disconnected/);
});
