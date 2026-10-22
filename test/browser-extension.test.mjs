import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { BROWSER_IDENTITIES } from '../src/browser-identity.mjs';
import { createManifest } from '../browser-extension/manifest.mjs';
import { safeDeviceRequest, externalSenderAllowed, deviceResult, createNativeClient, safeNativeCommand, applicationView } from '../browser-extension/src/protocol.mjs';
import { captureJobs, captureApplicationContext, inspectForm, fillForm, checkFormBindings, armSmartPaste, disarmSmartPaste, pressAction, observePage } from '../browser-extension/src/page.mjs';
import { createPageAccess } from '../browser-extension/src/page-access.mjs';

const origin = BROWSER_IDENTITIES.production.productOrigin;
const request = (op, payload = {}) => ({ version: 1, id: randomUUID(), op, payload });
const event = () => { const listeners = []; return { addListener(fn) { listeners.push(fn); }, emit(...values) { for (const fn of listeners) fn(...values); } }; };
const fakePort = () => ({ onMessage: event(), onDisconnect: event(), sent: [], postMessage(message) { this.sent.push(message); }, disconnect() { this.onDisconnect.emit(); } });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('page access relies on Chrome permission enforcement and retains document identity on fill', async () => {
  let denied = true;
  const calls = [], tab = { id: 7 };
  const inject = createPageAccess({
    sidePanel: { setPanelBehavior: async () => {} },
    tabs: { async get() { return tab; } },
    scripting: { async executeScript(options) { calls.push(options); if (denied) throw new Error('Missing host permission'); return [{ result: { filled: [], skipped: [] }, documentId: 'snapshot-document' }]; } },
    onError: error => { throw error; },
  });
  await assert.rejects(inject(7, fillForm));
  denied = false;
  await inject(7, fillForm, [{ url: 'https://jobs.example.test/apply', fields: [] }], 'snapshot-document');
  assert.deepEqual(calls.at(-1).target, { tabId: 7, documentIds: ['snapshot-document'] });
  tab.url = 'chrome://extensions';
  await assert.rejects(inject(7, captureJobs), /HTTP or HTTPS/);
  assert.equal(calls.length, 2);
});

test('toolbar invocation opens the panel in its gesture and reads the granted tab, not a previous tab', async () => {
  let granted = false;
  const onClicked = event(), opened = [], inspected = [];
  const inject = createPageAccess({
    sidePanel: { setPanelBehavior: async () => {}, open: async ({ tabId }) => { opened.push(tabId); } },
    action: { onClicked },
    tabs: { get: async id => ({ id }) },
    scripting: { executeScript: async ({ target }) => {
      if (!granted) throw new Error('Cannot access contents of the page.');
      inspected.push(target.tabId);
      return [{ result: { fields: [] }, documentId: 'doc' }];
    } },
    onAccess: tabId => inject(tabId, inspectForm),
    onError: assert.fail,
  });
  await assert.rejects(inject(7, inspectForm));
  assert.deepEqual(inspected, []);
  granted = true; // Chrome grants activeTab before dispatching action.onClicked.
  onClicked.emit({ id: 9 });
  assert.deepEqual(opened, [9]); // Native panel open occurs synchronously in the gesture.
  await tick();
  assert.deepEqual(inspected, [9]);
  onClicked.emit({});
  await tick();
  assert.deepEqual(opened, [9]);
});

test('production and local identities derive distinct IDs and minimal user-triggered permissions', () => {
  for (const [mode, identity] of Object.entries(BROWSER_IDENTITIES)) {
    const derived = [...createHash('sha256').update(Buffer.from(identity.key, 'base64')).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
    assert.equal(derived, identity.extensionId);
    const manifest = createManifest(identity, '3.8.1', mode === 'local');
    assert.deepEqual(manifest.permissions, ['nativeMessaging','activeTab','scripting','sidePanel','clipboardWrite']);
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(manifest.content_scripts, undefined);
    assert.equal(manifest.action.default_popup, undefined);
    assert.equal(manifest.side_panel.default_path, 'panel.html');
    assert.deepEqual(manifest.externally_connectable.matches, [`${identity.productOrigin}/*`]);
  }
  assert.notEqual(BROWSER_IDENTITIES.local.extensionId, BROWSER_IDENTITIES.production.extensionId);
  assert.notEqual(BROWSER_IDENTITIES.local.nativeHost, BROWSER_IDENTITIES.production.nativeHost);
});

test('external websites can only pair, read account connection status or open settings', () => {
  for (const op of ['status','open_settings']) assert.equal(safeDeviceRequest(request(op), origin).op, op);
  const pairing = { productOrigin: origin, pairing: { deviceId: randomUUID(), challenge: 'one-time', expiresAt: new Date(Date.now() + 60000).toISOString(), account: { id: 'synthetic', label: 'Synthetic' } } };
  assert.equal(safeDeviceRequest(request('pair', pairing), origin).op, 'pair');
  for (const op of ['capture_jobs','forms_prepare','forms_profile_save','forms_cancel','application_resolve','application_status','application_prepare','application_document','application_open_ad','career_facts','credential_read','connect_provider']) assert.throws(() => safeDeviceRequest(request(op), origin));
  assert.throws(() => safeDeviceRequest(request('status', { apiKey: 'secret' }), origin));
  assert.throws(() => safeDeviceRequest(request('pair', { ...pairing, productOrigin: 'https://other.test' }), origin));
  const port = { name: 'recruiters-device', sender: { url: `${origin}/account`, origin, tab: { id: 1 }, frameId: 0 } };
  assert.equal(externalSenderAllowed(port, origin), true);
  assert.equal(externalSenderAllowed({ ...port, sender: { ...port.sender, frameId: 1 } }, origin), false);
  assert.equal(externalSenderAllowed({ ...port, sender: { ...port.sender, origin: 'https://other.test' } }, origin), false);
  const result = deviceResult('status', { installed: true, paired: true, deviceId: 'device', publicKey: 'public', career: { facts: ['secret'] }, credentials: 'secret', decisionApiConfigured: true, execution: { state: 'ready', private: 'secret' } });
  assert.deepEqual(result, { installed: true, mode: 'local_mcp', paired: true, deviceId: 'device', publicKey: 'public', connections: [], execution: { state: 'ready' } });
});

test('native replies correlate out of order, ignore unknown IDs and bound pending work', async () => {
  const port = fakePort(), client = createNativeClient({ host: 'synthetic', connect: () => port, maxPending: 2 });
  const first = client.request('status', {}), second = client.request('forms_prepare', { requestId: randomUUID() });
  assert.throws(() => client.request('status', {}), /busy/);
  port.onMessage.emit({ version: 1, id: randomUUID(), ok: true, result: 'wrong' });
  port.onMessage.emit({ version: 1, id: port.sent[1].id, ok: true, result: 'second' });
  port.onMessage.emit({ version: 1, id: port.sent[0].id, ok: true, result: 'first' });
  assert.deepEqual(await Promise.all([first, second]), ['first','second']);
  const third = client.request('status', {});
  port.disconnect();
  await assert.rejects(third, /Open Recruiters/);
});

test('native timeout and denial release request capacity for recovery', async () => {
  const port = fakePort(), client = createNativeClient({ host: 'synthetic', connect: () => port, maxPending: 1, timeoutMs: 5 });
  await assert.rejects(client.request('status', {}), /expired/);
  const denied = client.request('forms_prepare', {});
  port.onMessage.emit({ version: 1, id: port.sent.at(-1).id, ok: false, error: { message: 'Preparation cancelled.' } });
  await assert.rejects(denied, /cancelled/);
  const recovered = client.request('status', {});
  port.onMessage.emit({ version: 1, id: port.sent.at(-1).id, ok: true, result: { installed: true } });
  assert.deepEqual(await recovered, { installed: true });
});

function pageContext() {
  class Input {
    constructor(name, type = 'text', value = '') { this.name = name; this.id = name; this.type = type; this.tagName = 'INPUT'; this._value = value; this.labels = []; this.attrs = {}; this.autocomplete = ''; this.required = false; this.disabled = false; this.readOnly = false; this.isConnected = true; this.maxLength = -1; this.minLength = -1; this.events = []; }
    get value() { return this._value; } set value(v) { this._value = String(v); }
    get checked() { return this._checked === true; } set checked(value) { this._checked = Boolean(value); }
    getClientRects() { return this.hidden ? [] : [1]; }
    matches(selector) { return selector === ':disabled' && (this.disabled || this.fieldsetDisabled); }
    closest(selector) { return selector === 'input,textarea' && ['INPUT','TEXTAREA'].includes(this.tagName) ? this : selector === '[aria-disabled="true"]' && this.attrs['aria-disabled'] === 'true' ? this : null; }
    getAttribute(key) { return Object.hasOwn(this.attrs, key) ? this.attrs[key] : key === 'aria-label' ? this.name : null; }
    cloneNode() { return Object.assign(new Input(this.name, this.type, this.value), this, { attrs: { ...this.attrs }, events: [] }); }
    get validity() { return { valid: !this.invalid }; }
    dispatchEvent(event) { this.events.push(event.type); }
  }
  const controls = [new Input('Full name'), new Input('Email', 'email', 'already-entered@example.test'), new Input('Password', 'password'), new Input('Social security number'), new Input('Gender'), new Input('I agree to terms'), new Input('Resume', 'file')];
  const context = vm.createContext({ URL, crypto: { randomUUID }, location: { href: 'https://jobs.example.test/application' }, document: { title: 'Application', baseURI: 'https://jobs.example.test/application', forms: [], getElementById() { return null; }, querySelectorAll() { return controls; } }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), HTMLInputElement: Input, HTMLSelectElement: Input, HTMLTextAreaElement: Input, Event: class { constructor(type) { this.type = type; } } });
  const invoke = (fn, request = null) => { context.request = request; return vm.runInContext(`(${fn.toString()})(request)`, context); };
  return { controls, context, invoke };
}

test('inspection excludes protected controls and never includes entered values', () => {
  const page = pageContext(), snapshot = page.invoke(inspectForm);
  assert.deepEqual(Array.from(snapshot.fields, f => f.label), ['Full name', 'Email']);
  assert.equal(snapshot.fields[1].empty, false);
  assert.equal(snapshot.fields[1].manualOnly, true);
  assert.equal(JSON.stringify(snapshot).includes('already-entered'), false);
});

test('fill validates complete snapshot before writes and never overwrites or submits', () => {
  const page = pageContext(), snapshot = page.invoke(inspectForm);
  const result = page.invoke(fillForm, { url: snapshot.url, fields: snapshot.fields.map(f => ({ ...f, value: 'Synthetic Candidate' })) });
  assert.deepEqual(Array.from(result.filled), [snapshot.fields[0].id]);
  assert.deepEqual(Array.from(result.skipped), [snapshot.fields[1].id]);
  assert.equal(page.controls[0].value, 'Synthetic Candidate');
  assert.equal(page.controls[1].value, 'already-entered@example.test');
  assert.deepEqual(page.controls[0].events, ['input','change']);
  const changed = pageContext(), old = changed.invoke(inspectForm);
  changed.controls[0].name = 'Changed field';
  assert.throws(() => changed.invoke(fillForm, { url: old.url, fields: [{ ...old.fields[0], value: 'Must not write' }] }), /form changed/);
  assert.equal(changed.controls[0].value, '');
  changed.context.location.href = 'https://jobs.example.test/other';
  assert.throws(() => changed.invoke(fillForm, { url: old.url, fields: [] }), /page changed/);
  const replaced = pageContext(), beforeReplacement = replaced.invoke(inspectForm);
  replaced.controls[0] = new replaced.context.HTMLInputElement('Full name');
  assert.throws(() => replaced.invoke(fillForm, { url: beforeReplacement.url, fields: [{ ...beforeReplacement.fields[0], value: 'Must not write' }] }), /form changed/);
  assert.equal(replaced.controls[0].value, '');
});

test('synchronous page handlers cannot turn a later reviewed control into password or consent', () => {
  for (const mutation of [control => { control.type = 'password'; }, control => { control.name = 'I agree to the privacy terms'; }]) {
    const page = pageContext(); page.controls[1].value = '';
    const snapshot = page.invoke(inspectForm);
    page.controls[0].dispatchEvent = event => { page.controls[0].events.push(event.type); if (event.type === 'input') mutation(page.controls[1]); };
    const result = page.invoke(fillForm, { url: snapshot.url, fields: snapshot.fields.map(f => ({ ...f, value: 'Synthetic answer' })) });
    assert.deepEqual(Array.from(result.filled), [snapshot.fields[0].id]);
    assert.deepEqual(Array.from(result.skipped), [snapshot.fields[1].id]);
    assert.equal(page.controls[1].value, '');
    assert.deepEqual(page.controls[1].events, []);
  }
});

function contactPage(legend = 'Preferred contact method') {
  const page = pageContext(), Input = page.context.HTMLInputElement;
  const form = { id: 'application', action: 'https://jobs.example.test/application', method: 'post', getAttribute(key) { return this[key] ?? null; } };
  const fieldset = { querySelector: () => ({ textContent: legend }) };
  const radio = (value, label) => {
    const control = new Input('contact', 'radio', value);
    control.form = form; control.id = `${value}-radio`;
    control.closest = selector => selector === 'fieldset' ? fieldset : null;
    control.getAttribute = key => key === 'aria-label' ? label : null;
    return control;
  };
  page.controls[1] = radio('email', 'Email');
  const other = radio('phone', 'Phone'); page.controls.push(other);
  page.context.document.forms.push(form);
  return { ...page, other, radio };
}

test('contact method radio groups are fillable while contact consent stays protected', () => {
  const page = contactPage(), snapshot = page.invoke(inspectForm);
  const radio = snapshot.fields.find(field => field.type === 'radio');
  assert.equal(radio.label, 'Preferred contact method');
  assert.deepEqual(Array.from(radio.options, option => option.value), ['email', 'phone']);
  const result = page.invoke(fillForm, { url: snapshot.url, fields: [{ ...radio, value: 'email' }] });
  assert.deepEqual(Array.from(result.filled), [radio.id]);
  assert.equal(page.controls[1].checked, true);
  assert.equal(page.other.checked, false);
  assert.equal(contactPage('Contact me').invoke(inspectForm).fields.some(field => field.type === 'radio'), false);
});

test('a newly populated live radio member prevents writing the reviewed cached group', () => {
  const page = contactPage(), other = page.other;
  const snapshot = page.invoke(inspectForm), radio = snapshot.fields.find(field => field.type === 'radio');
  let inserted;
  page.controls[0].dispatchEvent = event => {
    if (event.type !== 'input') return;
    inserted = page.radio('existing', 'Existing choice');
    inserted.checked = true;
    page.controls.push(inserted);
  };
  const result = page.invoke(fillForm, { url: snapshot.url, fields: [{ ...snapshot.fields[0], value: 'Synthetic Candidate' }, { ...radio, value: 'email' }] });
  assert.deepEqual(Array.from(result.filled), [snapshot.fields[0].id]);
  assert.deepEqual(Array.from(result.skipped), [radio.id]);
  assert.equal(inserted.checked, true);
  assert.equal(page.controls[1].checked, false);
  assert.equal(other.checked, false);
  assert.deepEqual(page.controls[1].events, []);
});

test('choice filling accepts only actual inspected options', () => {
  const page = pageContext(), select = page.controls[0];
  select.name = 'Work mode'; select.tagName = 'SELECT'; select.type = 'select';
  select.options = [{ value: '', label: '' }, { value: 'remote', label: 'Remote' }, { value: 'office', label: 'Office' }];
  const snapshot = page.invoke(inspectForm), field = snapshot.fields[0];
  assert.equal(field.options.length, 2);
  assert.equal(field.options.some(option => option.value === ''), false);
  const denied = page.invoke(fillForm, { url: snapshot.url, fields: [{ ...field, value: 'invented-choice' }] });
  assert.deepEqual(Array.from(denied.filled), []);
  assert.equal(select.value, '');
  const allowed = page.invoke(fillForm, { url: snapshot.url, fields: [{ ...field, value: 'remote' }] });
  assert.deepEqual(Array.from(allowed.filled), [field.id]);
  assert.equal(select.value, 'remote');
});

function inertTemplate() {
  return { content: { textContent: '', querySelectorAll: () => [] }, set innerHTML(value) { this.content.textContent = value; } };
}
test('JSON-LD collection is bounded and preserves original metadata without invented dates', () => {
  const rows = Array.from({ length: 70 }, (_, i) => ({ '@type': 'JobPosting', title: `Role ${i}`, url: `https://jobs.example.test/jobs/${i}`, description: 'Original role description', hiringOrganization: { name: 'Synthetic employer' } }));
  const context = vm.createContext({ URL, location: { href: 'https://jobs.example.test/jobs' }, TextEncoder, document: { title: 'Roles', createElement: inertTemplate, querySelector: () => null, querySelectorAll: selector => selector.startsWith('script') ? [{ textContent: JSON.stringify({ '@graph': rows }) }] : [] } });
  const result = vm.runInContext(`(${captureJobs.toString()})()`, context);
  assert.equal(result.jobs.length, 50);
  assert.equal(result.jobs[0].complete, true);
  assert.equal(result.jobs[0].company, 'Synthetic employer');
  assert.equal(result.jobs[0].publishedAt, undefined);
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).length <= 1024 * 1024);
});

test('a reset or rejected control is skipped rather than reported as filled', () => {
  const page = pageContext(), snapshot = page.invoke(inspectForm);
  page.controls[0].dispatchEvent = event => { if (event.type === 'change') page.controls[0].value = ''; };
  const result = page.invoke(fillForm, { url: snapshot.url, fields: [{ ...snapshot.fields[0], value: 'Rejected answer' }] });
  assert.deepEqual(Array.from(result.filled), []);
  assert.deepEqual(Array.from(result.skipped), [snapshot.fields[0].id]);
});

function captureFixture({ metadata = [], original = null, cards = [] } = {}) {
  const textNode = text => ({ nodeType: 3, textContent: text });
  const element = (tagName, text = '', children = []) => ({ nodeType: 1, tagName, textContent: text, childNodes: children.length ? children : [textNode(text)], getClientRects: () => [1], closest: () => null });
  const heading = element('H1', 'Synthetic role');
  const originalElement = original === null ? null : element('DIV', '', Array.isArray(original) ? original.map(text => element('P', text)) : [textNode(original)]);
  const context = vm.createContext({ URL, TextEncoder, location: { href: 'https://jobs.example.test/jobs/synthetic' }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    document: { title: 'Synthetic role', createElement: inertTemplate, querySelector(selector) { if (selector === 'main h1,h1') return heading; if (selector.includes('job-description')) return originalElement; return null; }, querySelectorAll(selector) { return selector.startsWith('script') ? [{ textContent: JSON.stringify(metadata) }] : cards; } },
  });
  return { run: () => vm.runInContext(`(${captureJobs.toString()})()`, context), element };
}

test('a complete rendered original upgrades incomplete JSON-LD while keeping factual metadata', () => {
  const fixture = captureFixture({ metadata: [{ '@type': 'JobPosting', title: 'Synthetic role', url: 'https://jobs.example.test/jobs/synthetic', hiringOrganization: { name: 'Synthetic employer' }, datePosted: '2026-10-01' }], original: 'Original responsibilities and requirements. '.repeat(10) });
  const result = fixture.run();
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].complete, true);
  assert.equal(result.jobs[0].company, 'Synthetic employer');
  assert.equal(result.jobs[0].publishedAt, '2026-10-01');
  assert.match(result.jobs[0].description, /Original responsibilities/);
});

test('clipped JSON-LD, rendered text and rendered traversal never claim a full advert', () => {
  const long = 'Long original description. '.repeat(4000);
  const json = captureFixture({ metadata: [{ '@type': 'JobPosting', title: 'Synthetic role', description: long }] }).run();
  assert.equal(json.jobs[0].complete, false);
  assert.equal(captureFixture({ original: long }).run().jobs[0].complete, false);
  assert.equal(captureFixture({ original: Array.from({ length: 2600 }, () => 'Original role text.') }).run().jobs[0].complete, false);
});

test('visible listing cards remain partial captures and never inherit input contents', () => {
  const cards = [], fixture = captureFixture({ cards });
  const heading = fixture.element('H2', 'Visible listing role'), link = fixture.element('A', 'Visible listing role');
  link.href = 'https://jobs.example.test/jobs/listed'; link.getAttribute = () => '/jobs/listed';
  const input = fixture.element('TEXTAREA', 'private entered answer');
  const card = fixture.element('ARTICLE', '', [heading, input]); card.querySelectorAll = () => [link]; card.querySelector = selector => selector.startsWith('h2') ? heading : null; cards.push(card);
  const result = fixture.run();
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].complete, false);
  assert.equal(result.jobs[0].title, 'Visible listing role');
  assert.equal(result.jobs[0].description.includes('private entered answer'), false);
});

test('companion commands arrive on the native port and are answered in place', async () => {
  const seen = [];
  const port = fakePort(), client = createNativeClient({ host: 'synthetic', connect: () => port, onCommand: async (op, payload) => { seen.push([op, payload]); if (op === 'forms_submit') throw new Error('The page changed.'); return { filled: ['control-0'], skipped: [] }; } });
  const status = client.request('status', {});
  const fill = request('forms_fill', { requestId: randomUUID(), formId: 'form:1', fields: [], answers: [] });
  const submit = request('forms_submit', { requestId: randomUUID(), formId: 'form:1', actionId: 'action-3', actionSignature: randomUUID() });
  port.onMessage.emit(fill); port.onMessage.emit(submit);
  await tick();
  assert.deepEqual(seen, [['forms_fill', fill.payload], ['forms_submit', submit.payload]]);
  const replies = port.sent.filter(message => Object.hasOwn(message, 'ok'));
  assert.deepEqual(replies[0], { version: 1, id: fill.id, ok: true, result: { filled: ['control-0'], skipped: [] } });
  assert.deepEqual(replies[1], { version: 1, id: submit.id, ok: false, error: { message: 'The page changed.' } });
  port.onMessage.emit(fill);
  await tick();
  assert.equal(seen.length, 2);
  assert.match(port.sent.at(-1).error.message, /already received/);
  port.onMessage.emit({ version: 1, id: port.sent[0].id, ok: true, result: { installed: true } });
  assert.deepEqual(await status, { installed: true });
});

test('native commands reject unknown, oversized, duplicate and unsigned inputs', () => {
  const field = { id: 'control-0', signature: 'inspected' };
  const fill = request('forms_fill', { requestId: randomUUID(), formId: 'form:1', fields: [field], answers: [{ ...field, value: 'Answer' }] });
  assert.deepEqual(safeNativeCommand(fill), { op: fill.op, payload: fill.payload });
  for (const message of [
    { ...fill, op: 'evaluate' },
    { ...fill, id: 'not-a-uuid' },
    { ...fill, extra: true },
    { ...fill, payload: { ...fill.payload, script: 'bad' } },
    { ...fill, payload: { ...fill.payload, fields: [field, field] } },
    { ...fill, payload: { ...fill.payload, answers: [fill.payload.answers[0], fill.payload.answers[0]] } },
    { ...fill, payload: { ...fill.payload, answers: [{ id: field.id, value: 'No signature' }] } },
    { ...fill, payload: { ...fill.payload, answers: [{ ...field, value: 'x'.repeat(10001) }] } },
    { ...fill, payload: { ...fill.payload, fields: Array.from({ length: 65 }, (_, i) => ({ ...field, id: `control-${i}` })) } },
    { ...fill, payload: { ...fill.payload, formId: 'x'.repeat(1024 * 1024) } },
    request('forms_submit', { requestId: randomUUID(), formId: 'form:1', actionId: 'action-0' }),
  ]) assert.throws(() => safeNativeCommand(message));
});

test('native command concurrency is bounded and reply send failures disconnect safely', async () => {
  const port = fakePort();
  let release, calls = 0;
  const client = createNativeClient({ host: 'synthetic', connect: () => port, maxPending: 1, onCommand: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const status = client.request('status', {});
  const rejected = assert.rejects(status, /Open Recruiters/);
  port.onMessage.emit(request('forms_status', { formId: 'form:1' }));
  port.onMessage.emit(request('forms_status', { formId: 'form:1' }));
  await tick();
  assert.equal(calls, 1);
  assert.match(port.sent.at(-1).error.message, /busy/);
  port.postMessage = () => { throw new Error('Disconnected while replying'); };
  release({ attached: true });
  await rejected;
  await tick();
  assert.equal(client.connected(), false);
});

test('native request send failure rejects and notifies disconnect exactly once', async () => {
  const port = fakePort();
  let disconnected = 0;
  port.postMessage = () => { throw new Error('Native send failed'); };
  const client = createNativeClient({ host: 'synthetic', connect: () => port, onDisconnect: () => { disconnected++; } });
  await assert.rejects(client.request('forms_validate', { formId: 'form:1', fields: [] }), /Native send failed/);
  assert.equal(client.connected(), false);
  assert.equal(disconnected, 1);
  client.disconnect();
  assert.equal(disconnected, 1);
});

const plain = value => JSON.parse(JSON.stringify(value));
function pastePage() {
  const page = pageContext();
  class Button extends page.context.HTMLInputElement {
    constructor(label, type = 'submit') { super('', type); this.tagName = 'BUTTON'; this.textContent = label; this.clicks = 0; this.form = null; }
    click() { this.clicks++; }
  }
  const buttons = [new Button('Submit application'), new Button('Cancel', 'button'), new Button('Next step', 'button')];
  const listeners = {}, windowCapture = {}, messages = [], clipboard = [];
  let responder = () => ({ value: null });
  page.context.document.querySelectorAll = selector => selector.startsWith('button') ? buttons : selector.includes('alert') ? [] : page.controls;
  page.context.document.addEventListener = (type, fn) => { listeners[type] = fn; };
  page.context.addEventListener = (type, fn, options) => {
    listeners[`window:${type}`] = fn;
    windowCapture[type] = options === true || options?.capture === true;
  };
  page.context.document.body = { innerText: 'Apply for this role. Full name. Email address.' };
  page.context.document.visibilityState = 'visible';
  page.context.document.hasFocus = () => true;
  page.context.navigator = { clipboard: { writeText: async value => { clipboard.push(value); } } };
  page.context.chrome = { runtime: { lastError: null, sendMessage: (message, callback) => {
    messages.push(message);
    if (message.action === 'paste-value') Promise.resolve(responder(message)).then(callback);
    else callback?.();
  } } };
  const focus = (el, { tab = false, trusted = true } = {}) => {
    if (tab) listeners.keydown({ key: 'Tab', isTrusted: trusted });
    else listeners.pointerdown({ target: el, button: 0, isTrusted: trusted });
    if (page.context.document.activeElement) {
      // Native element blur travels through window's capture phase before
      // focusout and the next control's focusin.
      if (windowCapture.blur) listeners['window:blur']({ target: page.context.document.activeElement });
      listeners.focusout({});
    }
    page.context.document.activeElement = el;
    listeners.focusin({ target: el, isTrusted: trusted });
  };
  return { ...page, buttons, listeners, messages, clipboard, focus, respond: fn => { responder = fn; } };
}

test('switching through seven fields replaces the clipboard after earlier fields are pasted', async () => {
  for (const tab of [false, true]) {
    const page = pastePage(), Input = page.context.HTMLInputElement;
    const values = ['Synthetic Candidate', 'candidate@example.test', 'San Francisco, CA',
      'https://x.com/synthetic_candidate', 'Synthetic Studio', 'Co-founder & CEO', 'First line.\nSecond line.'];
    const labels = ['Full name', 'Email', 'Location', 'X profile', 'Current company', 'Current role', 'Professional summary'];
    page.controls.splice(0, page.controls.length, ...labels.map((label, i) => new Input(label, i === 1 ? 'email' : i === 3 ? 'url' : 'text')));
    const snapshot = page.invoke(inspectForm);
    page.invoke(armSmartPaste, { session: randomUUID() });
    page.respond(({ fieldId }) => ({ value: values[snapshot.fields.findIndex(field => field.id === fieldId)] }));
    for (let i = 0; i < values.length; i++) {
      page.focus(page.controls[i], { tab });
      await tick();
      assert.equal(page.clipboard.at(-1), values[i], `${labels[i]} must replace the prior field's clipboard value`);
      page.controls[i].value = page.clipboard.at(-1);
    }
    assert.deepEqual(page.clipboard, values);
    assert.deepEqual(page.controls.map(control => control.value), values);
  }
});

test('approved action signatures survive filling but prevent repeat presses and reinspection replay', () => {
  const page = pastePage(), snapshot = page.invoke(inspectForm);
  assert.deepEqual(plain(snapshot.actions.map(({ label, kind }) => ({ label, kind }))), [{ label: 'Submit application', kind: 'submit' }, { label: 'Next step', kind: 'next' }]);
  const action = snapshot.actions[0], press = { url: snapshot.url, actionId: action.id, actionSignature: action.signature };
  assert.throws(() => page.invoke(pressAction, { ...press, actionSignature: 'not-approved' }), /control changed/);
  page.invoke(fillForm, { url: snapshot.url, fields: [{ ...snapshot.fields[0], value: 'Synthetic Candidate' }] });
  assert.deepEqual(plain(page.invoke(pressAction, press)), { clicked: true, label: 'Submit application', url: snapshot.url });
  assert.equal(page.buttons[0].clicks, 1);
  assert.throws(() => page.invoke(pressAction, press), /already been pressed/);
  const again = page.invoke(inspectForm);
  assert.equal(again.actions[0].signature, action.signature);
  assert.throws(() => page.invoke(pressAction, press), /already been pressed/);
  assert.equal(page.buttons[0].clicks, 1);
});

test('submit rejects changed labels, nodes, form destinations, submitter overrides and documents', () => {
  for (const mutate of [
    page => { page.buttons[0].textContent = 'Delete account'; },
    page => { page.buttons[0].form.action = 'https://other.example.test/collect'; },
    page => { page.buttons[0].attrs.formaction = 'https://other.example.test/collect'; },
    page => { page.buttons[0].formMethod = 'get'; },
    page => { page.buttons[0].formTarget = '_blank'; },
    page => { page.buttons[0].form = { ...page.buttons[0].form }; },
    page => { page.buttons[0].fieldsetDisabled = true; },
    page => { page.buttons[0].hidden = true; },
    page => { page.buttons[0].isConnected = false; page.buttons[0] = new page.buttons[0].constructor('Submit application'); },
    page => { page.context.location.href += '?changed=true'; },
  ]) {
    const page = pastePage();
    page.buttons[0].form = { action: page.context.location.href, method: 'post', enctype: 'application/x-www-form-urlencoded', target: '', getAttribute(key) { return this[key] ?? null; } };
    const snapshot = page.invoke(inspectForm), action = snapshot.actions[0], original = page.buttons[0];
    mutate(page);
    assert.throws(() => page.invoke(pressAction, { url: snapshot.url, actionId: action.id, actionSignature: action.signature }), /changed/);
    assert.equal(original.clicks, 0);
    assert.equal(page.buttons[0].clicks, 0);
  }
});

test('rebound action IDs cannot reuse an earlier approval and uncertain clicks are consumed', () => {
  const page = pastePage(), snapshot = page.invoke(inspectForm), action = snapshot.actions[0];
  page.buttons[0].attrs.formaction = '/different';
  const changed = page.invoke(inspectForm);
  assert.notEqual(changed.actions[0].signature, action.signature);
  assert.throws(() => page.invoke(pressAction, { url: snapshot.url, actionId: action.id, actionSignature: action.signature }), /control changed/);
  const press = { url: changed.url, actionId: action.id, actionSignature: changed.actions[0].signature };
  page.buttons[0].click = () => { throw new Error('Result unknown'); };
  assert.throws(() => page.invoke(pressAction, press), /Result unknown/);
  assert.throws(() => page.invoke(pressAction, press), /already been pressed/);
});

test('observed thanks text is only a confirmation candidate, never a proven submission', () => {
  const page = pastePage(); page.invoke(inspectForm);
  page.context.document.body.innerText = 'Thank you! Your application has been received by Example Labs.';
  const observed = page.invoke(observePage);
  assert.equal(observed.outcome, 'unknown');
  assert.equal(observed.confirmation, undefined);
  assert.equal(observed.observedText, page.context.document.body.innerText);
  assert.deepEqual(plain(observed.confirmationCandidates), ['Thank you', 'Your application has been received by Example Labs']);
});

test('smart paste uses native clipboard only after a trusted click or Tab onto an empty inspected field', async () => {
  const page = pastePage(), snapshot = page.invoke(inspectForm), session = randomUUID();
  assert.deepEqual(plain(page.invoke(armSmartPaste, { session })), { armed: true, fields: 1 });
  page.respond(() => ({ value: 'Synthetic Candidate' }));
  page.context.document.activeElement = page.controls[0];
  page.listeners.focusin({ target: page.controls[0], isTrusted: true });
  page.focus(page.controls[0], { trusted: false });
  await tick();
  assert.equal(page.messages.length, 0);
  page.focus(page.controls[0]);
  await tick();
  const identity = { fieldId: snapshot.fields[0].id, signature: snapshot.fields[0].signature, url: snapshot.url, session };
  assert.deepEqual(plain(page.messages[0]), { action: 'paste-value', ...identity });
  assert.deepEqual(plain(page.messages[1]), { action: 'paste-ready', ...identity, ok: true });
  assert.deepEqual(page.clipboard, ['Synthetic Candidate']);
  assert.deepEqual(page.controls[0].events, []);
  assert.equal(page.controls[0].value, '');
  assert.equal(page.listeners.paste, undefined);
  page.focus(page.controls[0], { tab: true });
  await tick();
  assert.equal(page.clipboard.length, 2);
  page.focus(page.controls[1]); // Already populated.
  page.focus(page.controls[2]); // Password.
  await tick();
  assert.equal(page.clipboard.length, 2);
  assert.equal(page.messages.filter(message => message.action === 'paste-value').length, 2);
});

test('clicking an already focused field refreshes its answer after rearming', async () => {
  const page = pastePage(), el = page.controls[0];
  page.invoke(inspectForm);
  page.invoke(armSmartPaste, { session: randomUUID() });
  page.respond(() => ({ value: 'Previous answer' }));
  page.focus(el);
  await tick();
  page.invoke(disarmSmartPaste);
  page.invoke(armSmartPaste, { session: randomUUID() });
  page.respond(() => ({ value: 'New job-specific summary' }));
  // Clicking the same DOM control does not emit another focusin.
  page.listeners.pointerdown({ target: el, button: 0, isTrusted: true });
  page.listeners.click?.({ target: el, button: 0, isTrusted: true });
  await tick();
  assert.equal(page.clipboard.at(-1), 'New job-specific summary');
  assert.equal(el.value, '');
});

test('clearing a mistaken paste refreshes only an eligible empty focused control', async () => {
  for (const scenario of ['cleared', 'untrusted', 'populated', 'protected', 'disarmed']) {
    const page = pastePage(), el = page.controls[0];
    page.invoke(inspectForm);
    page.invoke(armSmartPaste, { session: randomUUID() });
    page.context.document.activeElement = el;
    page.respond(() => ({ value: 'Prepared summary' }));
    el.value = scenario === 'populated' ? 'Keep my text' : '';
    if (scenario === 'protected') el.type = 'password';
    if (scenario === 'disarmed') page.invoke(disarmSmartPaste);
    page.listeners.input?.({ target: el, isTrusted: scenario !== 'untrusted' });
    await tick();
    assert.deepEqual(page.clipboard, scenario === 'cleared' ? ['Prepared summary'] : []);
    assert.equal(el.value, scenario === 'populated' ? 'Keep my text' : '');
  }
});

test('changed, protected, hidden and populated fields never request clipboard data', async () => {
  for (const mutate of [
    page => { page.controls[0].type = 'password'; },
    page => { page.controls[0].name = 'Social security number'; },
    page => { page.controls[0].autocomplete = 'cc-number'; },
    page => { page.controls[0].attrs.title = 'Social security number'; },
    page => { page.controls[0].attrs.placeholder = 'Credit card number'; },
    page => { page.controls[0].value = 'User answer'; },
    page => { page.controls[0].readOnly = true; },
    page => { page.controls[0].fieldsetDisabled = true; },
    page => { page.controls[0].hidden = true; },
    page => { page.controls[0].attrs.pattern = '[0-9]+'; },
    page => { page.controls[0].isConnected = false; page.controls[0] = new page.context.HTMLInputElement('Full name'); },
    page => { page.context.location.href += '?changed'; },
  ]) {
    const page = pastePage(); page.invoke(inspectForm); page.invoke(armSmartPaste, { session: randomUUID() });
    page.respond(() => ({ value: 'Must not release' }));
    mutate(page); page.focus(page.controls[0]);
    await tick();
    assert.equal(page.messages.length, 0);
    assert.equal(page.clipboard.length, 0);
  }
});

test('pending clipboard responses cannot outlive disarm, focus, field or inspection changes', async () => {
  for (const mutate of [
    page => { page.invoke(disarmSmartPaste); },
    page => { page.invoke(disarmSmartPaste); page.invoke(armSmartPaste, { session: randomUUID() }); },
    page => { page.listeners.focusout({}); page.context.document.activeElement = page.controls[1]; },
    page => { page.listeners.focusout({}); page.context.document.activeElement = page.controls[0]; },
    page => { page.listeners['window:blur'](); },
    page => { page.context.document.visibilityState = 'hidden'; page.listeners.visibilitychange(); },
    page => { page.controls[0].type = 'password'; },
    page => { page.controls[0].attrs.title = 'Social security number'; },
    page => { page.controls[0].value = 'Entered while waiting'; },
    page => { page.controls[0].isConnected = false; },
    page => { page.invoke(inspectForm); },
  ]) {
    const page = pastePage(); page.invoke(inspectForm); page.invoke(armSmartPaste, { session: randomUUID() });
    let resolve;
    page.respond(() => new Promise(done => { resolve = done; }));
    page.focus(page.controls[0]);
    assert.equal(page.messages.length, 1);
    mutate(page); resolve({ value: 'Must not write' });
    await tick();
    assert.equal(page.clipboard.length, 0);
    assert.equal(page.messages.some(message => message.action === 'paste-ready'), false);
  }
});

test('clipboard permission failures and extension send failures never use a synthetic fallback', async () => {
  const page = pastePage(); page.invoke(inspectForm); page.invoke(armSmartPaste, { session: randomUUID() });
  page.respond(() => ({ value: 'Candidate' }));
  page.context.navigator.clipboard.writeText = async () => { throw new Error('Permission denied'); };
  page.focus(page.controls[0]); await tick();
  assert.equal(page.messages.at(-1).ok, false);
  assert.deepEqual(page.clipboard, []);
  assert.deepEqual(page.controls[0].events, []);
  page.context.chrome.runtime.sendMessage = () => { throw new Error('Extension disconnected'); };
  assert.doesNotThrow(() => page.focus(page.controls[0]));
  assert.deepEqual(page.clipboard, []);
});

test('fill retains inspected native length and validity constraints', () => {
  for (const change of [el => { el.maxLength = 3; }, el => { el.minLength = 30; }, el => { el.invalid = true; }]) {
    const page = pageContext(); change(page.controls[0]);
    const snapshot = page.invoke(inspectForm);
    const result = page.invoke(fillForm, { url: snapshot.url, fields: [{ ...snapshot.fields[0], value: 'Candidate' }] });
    assert.deepEqual(plain(result), { filled: [], skipped: [snapshot.fields[0].id] });
    assert.equal(page.controls[0].value, '');
  }
});

const applicationMetadata = (overrides = {}) => ({
  bindingId: 'binding:synthetic', formId: 'form:synthetic', applicationId: 'application:synthetic', title: 'Engineer', company: 'Example',
  state: 'needs_documents', documents: [{ kind: 'cv', label: 'CV', ready: false }, { kind: 'cover_letter', label: 'Cover letter', ready: false }],
  writing: [{ fieldId: 'writing', label: 'Why this role?', ready: false }], handoff: null, answerVersion: null, jobUrl: 'https://jobs.example.test/role',
  ...overrides,
});
async function backgroundFixture(page = pastePage(), options = {}) {
  const calls = [], injections = [], timers = new Map();
  let nextTimer = 0, application = applicationMetadata({ applicationId: null, ...options.application });
  let resolveApplication = async () => application, applicationStatus = async () => application;
  let launchApplication = async payload => (application = { ...application, handoff: { host: payload.host, state: 'awaiting_agent', requiresSend: true }, preferredHost: payload.host, opened: true, requiresSend: true });
  let nativeOptions, messageHandler, access, documentId = 'document-1', permission = true, validate = async () => ({ valid: true });
  let saveDetails = async payload => ({ saved: Object.keys(payload.values) });
  let prepareResult = options.prepare || (payload => ({ formId: 'form:synthetic', snapshot: 'snapshot:synthetic', questions: [{ key: 'phone', label: 'Phone', type: 'tel' }], fields: payload.fields.filter(field => field.empty && !field.manualOnly).slice(0, 1).map(field => ({ ...field, value: 'Synthetic Candidate' })) }));
  const chrome = {
    runtime: { id: 'extension', onConnectExternal: event(), onConnect: event(), onMessage: { addListener(fn) { messageHandler = fn; } }, getURL: path => `chrome-extension://extension/${path}` },
    permissions: { contains: async () => permission },
    tabs: { get: async () => ({ id: 7, url: page.context.location.href, title: 'Application', status: 'complete' }), onActivated: event(), onUpdated: event(), onRemoved: event() },
    sidePanel: {}, scripting: {},
  };
  const context = vm.createContext({
    chrome, crypto: { randomUUID }, PRODUCT_ORIGIN: origin, NATIVE_HOST: 'synthetic', BUILD_ID: 'test-build',
    captureJobs, captureApplicationContext, inspectForm, fillForm, checkFormBindings, armSmartPaste, disarmSmartPaste, pressAction, observePage,
    safeDeviceRequest, externalSenderAllowed, deviceResult, applicationView,
    setTimeout(fn, ms) { if (ms === 5000) { const id = ++nextTimer; timers.set(id, fn); return id; } return setTimeout(fn, 0); },
    clearTimeout(id) { timers.delete(id); },
    createPageAccess: accessOptions => {
      access = accessOptions.onAccess;
      return async (tabId, fn, args = [], expectedDocument = null) => {
        injections.push(fn.name);
        if (expectedDocument && expectedDocument !== documentId) throw new Error('The page changed.');
        return { page: fn === captureJobs ? { jobs: options.jobs || [] } : fn === captureApplicationContext ? options.context || {} : page.invoke(fn, args[0] ?? null), documentId };
      };
    },
    createNativeClient: options => {
      nativeOptions = options;
      return { request: async (op, payload) => {
        calls.push([op, plain(payload)]);
        if (op === 'forms_validate') return validate(payload);
        if (op === 'forms_prepare') return prepareResult(payload);
        if (op === 'forms_profile_save') return saveDetails(payload);
        if (op === 'forms_cancel') return { cancelled: true };
        if (op === 'application_resolve') return resolveApplication(payload);
        if (op === 'application_status') return applicationStatus(payload);
        if (op === 'application_prepare') return launchApplication(payload);
        if (op === 'application_document' || op === 'application_open_ad') return { opened: true };
        throw new Error(`Unexpected request: ${op}`);
      } };
    },
  });
  const source = await readFile(new URL('../browser-extension/src/background.mjs', import.meta.url), 'utf8');
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, ''), context);
  const act = async message => { context.message = message; await vm.runInContext('act(message)', context); };
  await act({ action: 'detect', payload: { tabId: 7 } });
  const state = () => vm.runInContext('state', context);
  if (!options.prepare) assert.equal(state().error, '');
  page.context.chrome.runtime.sendMessage = (message, callback) => {
    page.messages.push(message);
    const asynchronous = messageHandler(message, { id: 'extension', tab: { id: 7 }, frameId: 0, documentId }, callback ?? (() => {}));
    if (!asynchronous && message.action !== 'paste-value') callback?.();
  };
  return {
    page, calls, injections, state, act,
    command(op, payload) { const command = safeNativeCommand(request(op, payload)); return nativeOptions.onCommand(command.op, command.payload); },
    disconnect: () => nativeOptions.onDisconnect(),
    validate: fn => { validate = fn; },
    permission: value => { permission = value; },
    navigate: value => { documentId = value; },
    saveDetails: fn => { saveDetails = fn; },
    prepare: fn => { prepareResult = fn; },
    toolbar: tabId => access(tabId),
    application: value => { application = value; },
    resolveApplication: fn => { resolveApplication = fn; },
    applicationStatus: fn => { applicationStatus = fn; },
    launchApplication: fn => { launchApplication = fn; },
    connectPanel() { const panel = fakePort(); panel.name = 'recruiters-panel'; panel.sender = { id: 'extension', url: 'chrome-extension://extension/panel.html' }; chrome.runtime.onConnect.emit(panel); return panel; },
    poll: () => vm.runInContext('pollApplication()', context),
    get scheduledPolls() { return timers.size; },
    activate: tabId => chrome.tabs.onActivated.emit({ tabId }),
    updateTab: (tabId, change) => chrome.tabs.onUpdated.emit(tabId, change),
    removeTab: tabId => chrome.tabs.onRemoved.emit(tabId),
  };
}

const approvedFill = state => ({
  requestId: randomUUID(), formId: state.prepared.formId,
  fields: state.form.fields.map(({ id, signature }) => ({ id, signature })), answers: [],
});

test('agent fill includes signed staged answers absent from prepared fields and ignores unapproved panel edits', async () => {
  const page = pastePage();
  page.controls[1].name = 'Why this role'; page.controls[1].type = 'textarea'; page.controls[1].tagName = 'TEXTAREA'; page.controls[1].value = '';
  const fixture = await backgroundFixture(page), state = fixture.state(), payload = approvedFill(state), unresolved = state.form.fields[1];
  assert.equal(state.prepared.fields.length, 1);
  payload.answers = [{ id: unresolved.id, signature: unresolved.signature, value: 'I have relevant experience.' }];
  await fixture.act({ action: 'edit', payload: { edits: { [state.form.fields[0].id]: 'Not approved by the companion' } } });
  const result = await fixture.command('forms_fill', payload);
  assert.deepEqual(plain(result.filled), plain(state.form.fields.map(field => field.id)));
  assert.equal(page.controls[0].value, 'Synthetic Candidate');
  assert.equal(page.controls[1].value, 'I have relevant experience.');
  assert.equal(page.buttons[0].clicks, 0);
});

test('agent fill rejects incomplete approval, wrong staged signatures, unknown and populated fields before writes', async () => {
  for (const mutate of [
    payload => { payload.fields.pop(); },
    (payload, state) => { payload.answers = [{ id: state.form.fields[0].id, signature: 'wrong', value: 'No' }]; },
    payload => { payload.answers = [{ id: 'control-999', signature: 'unknown', value: 'No' }]; },
    (payload, state) => { const field = state.form.fields[1]; payload.answers = [{ id: field.id, signature: field.signature, value: 'No overwrite' }]; },
  ]) {
    const fixture = await backgroundFixture(), payload = approvedFill(fixture.state());
    mutate(payload, fixture.state());
    await assert.rejects(fixture.command('forms_fill', payload), /approved form|staged answer/);
    assert.equal(fixture.page.controls[0].value, '');
    assert.equal(fixture.page.controls[1].value, 'already-entered@example.test');
  }
});

test('browser status checks live bindings, URL and Chrome document identity', async () => {
  for (const mutate of [
    fixture => { fixture.page.controls[0].type = 'password'; },
    fixture => { fixture.page.buttons[0].attrs.formaction = '/different'; },
    fixture => { fixture.page.context.location.href += '?changed'; },
    fixture => { fixture.navigate('document-2'); },
  ]) {
    const fixture = await backgroundFixture(), formId = fixture.state().prepared.formId;
    assert.equal((await fixture.command('forms_status', { formId })).attached, true);
    mutate(fixture);
    assert.deepEqual(plain(await fixture.command('forms_status', { formId })), { formId, attached: false });
    assert.equal(fixture.state().prepared, null);
  }
});

test('submit reports preexisting and new text as candidates without awarding success', async () => {
  for (const changed of [false, true]) {
    const fixture = await backgroundFixture(), state = fixture.state(), action = state.form.actions[0];
    fixture.page.context.document.body.innerText = 'Thank you for visiting.';
    if (changed) fixture.page.buttons[0].click = () => { fixture.page.buttons[0].clicks++; fixture.page.context.document.body.innerText = 'Application submitted.'; };
    const payload = { requestId: randomUUID(), formId: state.prepared.formId, actionId: action.id, actionSignature: action.signature };
    const result = await fixture.command('forms_submit', payload);
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.confirmation, undefined);
    assert.equal(result.sameDocument, true);
    assert.deepEqual(plain(result.confirmationCandidates), [{ text: changed ? 'Application submitted' : 'Thank you for visiting', newSinceObservation: changed }]);
    assert.equal(fixture.state().prepared.formId, payload.formId);
    await assert.rejects(fixture.command('forms_submit', { ...payload, requestId: randomUUID() }), /already been pressed/);
    assert.equal(fixture.page.buttons[0].clicks, 1);
  }
});

test('same-URL document replacement after a press is navigation, never an inferred success', async () => {
  const fixture = await backgroundFixture(), state = fixture.state(), action = state.form.actions[0];
  fixture.page.buttons[0].click = () => { fixture.navigate('document-2'); };
  const result = await fixture.command('forms_submit', { requestId: randomUUID(), formId: state.prepared.formId, actionId: action.id, actionSignature: action.signature });
  assert.equal(result.navigated, true);
  assert.equal(result.sameDocument, false);
  assert.equal(result.outcome, 'unknown');
  assert.equal(fixture.state().prepared, null);
});

test('clipboard release requires current companion validation and permission on every focus', async () => {
  const fixture = await backgroundFixture(), prepared = fixture.state().prepared;
  fixture.page.focus(fixture.page.controls[0]);
  await tick();
  assert.deepEqual(fixture.page.clipboard, ['Synthetic Candidate']);
  assert.deepEqual(fixture.calls.at(-1), ['forms_validate', {
    formId: prepared.formId, fields: plain(fixture.state().form.fields.map(({ id, signature }) => ({ id, signature }))),
  }]);
  fixture.validate(async () => { throw new Error('Companion locked or evidence changed'); });
  fixture.page.focus(fixture.page.controls[0], { tab: true });
  await tick();
  assert.deepEqual(fixture.page.clipboard, ['Synthetic Candidate']);
  assert.equal(fixture.state().prepared, null);
  const denied = await backgroundFixture();
  denied.permission(false);
  denied.page.focus(denied.page.controls[0]);
  await tick();
  assert.deepEqual(denied.page.clipboard, []);
  assert.equal(denied.state().prepared, null);
});

test('native disconnect invalidates prepared values and any pending clipboard response', async () => {
  const fixture = await backgroundFixture();
  let release;
  fixture.validate(() => new Promise(resolve => { release = resolve; }));
  fixture.page.focus(fixture.page.controls[0]);
  await tick();
  fixture.disconnect();
  release({ valid: true });
  await tick();
  assert.equal(fixture.state().prepared, null);
  assert.deepEqual(fixture.page.clipboard, []);
  fixture.page.focus(fixture.page.controls[0]);
  await tick();
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_validate').length, 1);
});

test('form destination attributes stay bound even when a named control shadows form.action', () => {
  const page = pastePage(), attrs = { action: '/approved', method: 'post' };
  page.buttons[0].form = { action: {}, getAttribute: key => attrs[key] ?? null };
  const snapshot = page.invoke(inspectForm), action = snapshot.actions[0];
  attrs.action = '/replaced';
  assert.throws(() => page.invoke(pressAction, { url: snapshot.url, actionId: action.id, actionSignature: action.signature }), /control changed/);
  assert.equal(page.buttons[0].clicks, 0);
});

test('reading an application and toolbar access each prepare once without an API switch', async () => {
  const fixture = await backgroundFixture();
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 1);
  assert.equal(Object.hasOwn(fixture.calls[0][1], 'useApi'), false);
  await fixture.toolbar(7);
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 2);
  assert.equal(fixture.state().error, '');
});

test('login and newsletter forms are inspected without dispatching paid preparation', async () => {
  for (const title of ['Sign in to Careers', 'Newsletter signup', 'Create an account', 'Contact us']) {
    const page = pastePage(); page.context.document.title = title;
    const fixture = await backgroundFixture(page);
    assert.deepEqual(fixture.calls.map(([op]) => op), ['application_resolve'], title);
    assert.ok(fixture.state().form);
    assert.equal(fixture.state().prepared, null);
  }
});

test('one pending automatic preparation blocks duplicate work and cancellation discards late values', async () => {
  const fixture = await backgroundFixture();
  let release;
  fixture.prepare(() => new Promise(resolve => { release = resolve; }));
  const pending = fixture.act({ action: 'detect', payload: { tabId: 7 } });
  await tick();
  assert.equal(fixture.state().busy, 'prepare');
  await fixture.toolbar(7);
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 2);
  await fixture.act({ action: 'cancel' });
  release({ formId: 'late', snapshot: 'late', fields: [] });
  await pending;
  assert.equal(fixture.state().prepared, null);
  assert.match(fixture.state().notice, /cancelled/);
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_cancel').length, 1);
});

test('explicit detail save binds the snapshot and re-inspects only after confirmed persistence', async () => {
  const fixture = await backgroundFixture();
  await fixture.act({ action: 'profile-save', payload: { values: { phone: '+44 1234567890' } } });
  const payload = fixture.calls.find(([op]) => op === 'forms_profile_save')[1];
  assert.deepEqual(Object.keys(payload).sort(), ['formId','requestId','snapshot','values']);
  assert.equal(payload.formId, 'form:synthetic');
  assert.equal(payload.snapshot, 'snapshot:synthetic');
  assert.deepEqual(payload.values, { phone: '+44 1234567890' });
  assert.match(payload.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 2);
  assert.deepEqual(plain(fixture.state().saveReceipt.keys), ['phone']);
  assert.match(fixture.state().notice, /saved on this computer/);
});

test('failed and false-success detail saves do not clear drafts or announce persistence', async () => {
  for (const save of [async () => { throw new Error('Storage is locked. Unlock Companion and try again.'); }, async () => ({ saved: [] }), async () => ({ ok: true })]) {
    const fixture = await backgroundFixture(); fixture.saveDetails(save);
    await fixture.act({ action: 'profile-save', payload: { values: { phone: '+44 1234567890' } } });
    assert.ok(fixture.state().error);
    assert.equal(fixture.state().saveReceipt, undefined);
    assert.equal(fixture.state().notice, '');
    assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 1);
  }
});

test('profile save rejects non-question values before native dispatch', async () => {
  const fixture = await backgroundFixture();
  await fixture.act({ action: 'profile-save', payload: { values: { gender: 'private' } } });
  assert.match(fixture.state().error, /requested details/);
  assert.equal(fixture.calls.some(([op]) => op === 'forms_profile_save'), false);
});

test('machine-name fallback labels use friendly final path segments', () => {
  const page = pageContext(), control = page.controls[0];
  control.name = 'application_form[application][preferred_name]';
  control.getAttribute = key => key === 'aria-label' ? null : control.attrs[key] ?? null;
  assert.equal(page.invoke(inspectForm).fields[0].label, 'preferred name');
});

test('custom comboboxes remain manual and role changes invalidate native fill', () => {
  for (const attrs of [{ role: 'combobox' }, { 'aria-autocomplete': 'list' }, { 'aria-autocomplete': 'both' }]) {
    const page = pageContext(), control = page.controls[0];
    Object.assign(control.attrs, attrs);
    const snapshot = page.invoke(inspectForm), field = snapshot.fields[0];
    assert.equal(field.manualOnly, true);
    const result = page.invoke(fillForm, { url: snapshot.url, fields: [{ ...field, value: 'London' }] });
    assert.equal(result.filled.length, 0);
    assert.equal(control.value, '');
  }
  const changed = pageContext(), snapshot = changed.invoke(inspectForm);
  changed.controls[0].attrs.role = 'combobox';
  assert.throws(() => changed.invoke(fillForm, { url: snapshot.url, fields: [{ ...snapshot.fields[0], value: 'London' }] }), /changed/);
});

test('custom combobox focus never replaces the clipboard with a prepared value', async () => {
  const page = pastePage();
  page.controls[0].attrs.role = 'combobox';
  page.invoke(inspectForm);
  page.invoke(armSmartPaste, { session: randomUUID() });
  page.respond(() => ({ value: 'London' }));
  page.focus(page.controls[0]);
  await tick();
  assert.deepEqual(page.clipboard, []);
  assert.equal(page.messages.some(message => message.action === 'paste-value'), false);
});

test('sponsorship saves an explicit boolean and rejects string coercion', async () => {
  const fixture = await backgroundFixture();
  fixture.state().prepared.questions = [{ key: 'requiresSponsorship', label: 'Do you require visa sponsorship?', type: 'boolean', options: [{ value: true, label: 'Yes' }, { value: false, label: 'No' }] }];
  await fixture.act({ action: 'profile-save', payload: { values: { requiresSponsorship: 'false' } } });
  assert.equal(fixture.calls.some(([op]) => op === 'forms_profile_save'), false);
  await fixture.act({ action: 'profile-save', payload: { values: { requiresSponsorship: false } } });
  assert.deepEqual(fixture.calls.find(([op]) => op === 'forms_profile_save')[1].values, { requiresSponsorship: false });
  assert.deepEqual(plain(fixture.state().saveReceipt.keys), ['requiresSponsorship']);
});

test('application metadata projection never exposes files, prompts, credentials or prose', () => {
  const view = applicationView(applicationMetadata({
    documents: [{ kind: 'cv', ready: true, label: '/private/candidate.pdf', uri: 'file:///private/candidate.pdf', bytes: 'private CV' }],
    writing: [{ fieldId: 'why', label: 'Why this role?', ready: true, value: 'Private narrative' }],
    credentials: 'secret-key', prompt: 'private prompt', preferredHost: 'codex', state: 'drafts',
  }));
  assert.equal(view.documents[0].label, 'CV');
  assert.equal(view.documents[0].ready, true);
  assert.equal(view.documents[1].ready, false);
  assert.equal(view.preferredHost, 'codex');
  assert.doesNotMatch(JSON.stringify(view), /private|Private|secret-key|file:/);
  assert.equal(applicationView(applicationMetadata({ jobUrl: 'file:///private/candidate.pdf' })).jobUrl, null);
  assert.throws(() => applicationView({ state: 'ready' }), /Read page/);
});

test('native application operations are internal and do not expand website permissions', async () => {
  const port = fakePort(), client = createNativeClient({ host: 'synthetic', connect: () => port });
  for (const op of ['application_resolve', 'application_status', 'application_prepare', 'application_document', 'application_open_ad']) {
    const pending = client.request(op, { bindingId: 'binding:synthetic' });
    assert.equal(port.sent.at(-1).op, op);
    port.onMessage.emit({ version: 1, id: port.sent.at(-1).id, ok: true, result: { accepted: true } });
    assert.deepEqual(await pending, { accepted: true });
    assert.throws(() => safeDeviceRequest(request(op), origin), /not permitted/);
  }
});

test('reading captures original context and resolves the application before key-gated preparation', async () => {
  const context = { jobLinks: [{ url: 'https://jobs.example.test/role', title: 'Read job description' }] };
  const fixture = await backgroundFixture(pastePage(), {
    context, application: { state: 'needs_job', preferredHost: 'codex' },
    prepare: () => { throw new Error('Configure the Decisions API to map these fields.'); },
  });
  assert.deepEqual(fixture.injections.filter(name => ['inspectForm', 'captureJobs', 'captureApplicationContext'].includes(name)), ['inspectForm', 'captureJobs', 'captureApplicationContext']);
  assert.deepEqual(fixture.calls.map(([op]) => op), ['application_resolve', 'forms_prepare']);
  assert.deepEqual(fixture.calls[0][1].context, context);
  assert.equal(fixture.state().application.state, 'needs_job');
  assert.equal(fixture.state().applicationHost, 'codex');
  assert.match(fixture.state().error, /Decisions API/);
  await fixture.act({ action: 'application-prepare', payload: { host: 'codex', path: '/must-not-forward', prompt: 'must-not-forward' } });
  assert.deepEqual(fixture.calls.at(-1), ['application_prepare', { bindingId: 'binding:synthetic', host: 'codex' }]);
  assert.equal(fixture.state().application.state, 'needs_job', 'launch is not document preparation');
  assert.match(fixture.state().notice, /Open in Codex and send the prepared prompt/);
  assert.doesNotMatch(fixture.state().notice, /generating|ready/i);
});

test('web-led host launch is single-flight and polling never launches a second host', async () => {
  const fixture = await backgroundFixture(), panel = fixture.connectPanel();
  let release;
  fixture.launchApplication(() => new Promise(resolve => { release = resolve; }));
  const launch = fixture.act({ action: 'application-prepare', payload: { host: 'claude' } });
  await fixture.act({ action: 'application-prepare', payload: { host: 'claude' } });
  assert.equal(fixture.calls.filter(([op]) => op === 'application_prepare').length, 1);
  const waiting = applicationMetadata({ handoff: { host: 'claude', state: 'awaiting_agent', requiresSend: true } });
  fixture.application(waiting); release({ ...waiting, opened: true, requiresSend: true }); await launch;
  await fixture.poll(); await fixture.poll();
  assert.equal(fixture.calls.filter(([op]) => op === 'application_prepare').length, 1);
  assert.equal(fixture.state().application.documents.some(doc => doc.ready), false);
  assert.equal(fixture.state().application.writing.some(field => field.ready), false);
  panel.disconnect();
});

test('agent-led current packages resolve automatically without launching or re-preparing on every poll', async () => {
  const ready = applicationMetadata({ state: 'ready', answerVersion: 'version-1', documents: [{ kind: 'cv', ready: true }, { kind: 'cover_letter', ready: true }], writing: [{ fieldId: 'why', label: 'Why?', ready: true }] });
  const fixture = await backgroundFixture(pastePage(), { application: ready }), panel = fixture.connectPanel();
  assert.equal(fixture.state().application.documents.every(doc => doc.ready), true);
  for (let n = 0; n < 3; n++) await fixture.poll();
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 1);
  assert.equal(fixture.calls.some(([op]) => op === 'application_prepare'), false);
  await fixture.act({ action: 'application-document', payload: { kind: 'cover_letter', action: 'reveal', path: '/not-accepted' } });
  assert.deepEqual(fixture.calls.at(-1), ['application_document', { bindingId: ready.bindingId, kind: 'cover_letter', action: 'reveal' }]);
  panel.disconnect();
});

test('new ready answer versions trigger one approved refresh and metadata-only changes trigger none', async () => {
  const fixture = await backgroundFixture(), panel = fixture.connectPanel();
  const ready = applicationMetadata({ state: 'ready', answerVersion: 'version-1', writing: [{ fieldId: 'why', label: 'Why?', ready: true }] });
  fixture.application(ready); await fixture.poll();
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 2);
  assert.equal(fixture.state().applicationAnswersPending, false);
  assert.equal(fixture.state().answersStale, false);
  fixture.application({ ...ready, documents: [{ kind: 'cv', ready: true }, { kind: 'cover_letter', ready: true }] });
  await fixture.poll(); await fixture.poll();
  assert.equal(fixture.state().application.documents.every(doc => doc.ready), true);
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 2);
  fixture.application({ ...ready, answerVersion: 'version-2' }); await fixture.poll();
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 3);
  panel.disconnect();
});

test('refused automatic refresh retains package readiness and exposes one explicit retry without a paid loop', async () => {
  const fixture = await backgroundFixture(), panel = fixture.connectPanel();
  fixture.prepare(() => { throw new Error('Approval was cancelled.'); });
  fixture.application(applicationMetadata({ state: 'ready', answerVersion: 'version-1' }));
  await fixture.poll(); await fixture.poll(); await fixture.poll();
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 2);
  assert.equal(fixture.state().application.state, 'ready');
  assert.equal(fixture.state().applicationAnswersPending, true);
  assert.equal(fixture.state().answersStale, true);
  assert.match(fixture.state().error, /cancelled/);
  assert.deepEqual(fixture.page.clipboard, []);
  await fixture.act({ action: 'application-answers' });
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 3, 'an explicit retry is allowed');
  panel.disconnect();
});

test('saved answer updates preserve reviewed edits and require explicit replacement', async () => {
  const fixture = await backgroundFixture(), panel = fixture.connectPanel(), field = fixture.state().prepared.fields[0];
  await fixture.act({ action: 'edit', payload: { edits: { [field.id]: 'My unsaved edit' }, selected: [field.id] } });
  fixture.application(applicationMetadata({ state: 'ready', answerVersion: 'version-1' }));
  await fixture.poll(); await fixture.poll();
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 1);
  assert.equal(fixture.state().edits[field.id], 'My unsaved edit');
  assert.equal(fixture.state().applicationAnswersPending, true);
  assert.equal(fixture.state().answersStale, true);
  await fixture.act({ action: 'fill' });
  assert.match(fixture.state().error, /current saved answers/);
  assert.equal(fixture.page.controls[0].value, '');
  await fixture.act({ action: 'application-answers' });
  assert.equal(fixture.state().answersStale, false);
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 2);
  panel.disconnect();
});

test('refresh rechecks inspected controls and never restores stale or protected page bindings', async () => {
  const fixture = await backgroundFixture(), panel = fixture.connectPanel();
  fixture.page.controls[0].type = 'password';
  fixture.application(applicationMetadata({ state: 'ready', answerVersion: 'version-1' }));
  await fixture.poll();
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 1);
  assert.equal(fixture.state().application, null);
  assert.equal(fixture.state().prepared, null);
  assert.match(fixture.state().notice, /page changed/);
  assert.equal(fixture.page.controls[0].value, '');
  panel.disconnect();
});

test('application polling requires a connected panel, is single-flight and discards disconnected results', async () => {
  const fixture = await backgroundFixture();
  await fixture.poll();
  assert.equal(fixture.calls.some(([op]) => op === 'application_status'), false);
  assert.equal(fixture.scheduledPolls, 0);
  const panel = fixture.connectPanel();
  assert.equal(fixture.scheduledPolls, 1);
  let release;
  fixture.applicationStatus(() => new Promise(resolve => { release = resolve; }));
  const pending = fixture.poll();
  await fixture.poll();
  assert.equal(fixture.calls.filter(([op]) => op === 'application_status').length, 1);
  panel.disconnect();
  assert.equal(fixture.scheduledPolls, 0);
  release(applicationMetadata({ state: 'ready', answerVersion: 'version-1' })); await pending;
  assert.equal(fixture.state().application.state, 'needs_documents');
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 1);
});

test('navigation, tab switches, tab closure and native disconnect erase application and clipboard context', async () => {
  for (const leave of [fixture => fixture.activate(9), fixture => fixture.updateTab(7, { status: 'loading' }), fixture => fixture.updateTab(7, { url: 'https://unrelated.example/apply' }), fixture => fixture.removeTab(7), fixture => fixture.disconnect()]) {
    const fixture = await backgroundFixture(), panel = fixture.connectPanel();
    let release;
    fixture.applicationStatus(() => new Promise(resolve => { release = resolve; }));
    const pending = fixture.poll();
    leave(fixture);
    assert.equal(fixture.state().application, null);
    assert.equal(fixture.state().prepared, null);
    release(applicationMetadata({ state: 'ready', answerVersion: 'wrong-tab' })); await pending;
    assert.equal(fixture.state().application, null, 'late metadata cannot repopulate a previous tab');
    assert.equal(fixture.scheduledPolls, 0);
    panel.disconnect();
  }
});

test('host selection survives metadata updates and original-ad actions accept no panel URL', async () => {
  const fixture = await backgroundFixture(), panel = fixture.connectPanel();
  await fixture.act({ action: 'application-host', payload: { host: 'codex' } });
  fixture.application(applicationMetadata({ preferredHost: 'claude', state: 'needs_job' }));
  await fixture.poll();
  assert.equal(fixture.state().applicationHost, 'codex', 'polling does not undo an explicit choice');
  await fixture.act({ action: 'application-open-ad', payload: { url: 'https://wrong.example' } });
  assert.deepEqual(fixture.calls.at(-1), ['application_open_ad', { bindingId: 'binding:synthetic' }]);
  await fixture.act({ action: 'application-document', payload: { kind: 'cv', action: 'open' } });
  assert.equal(fixture.calls.some(([op]) => op === 'application_document'), false);
  assert.match(fixture.state().error, /not ready/);
  panel.disconnect();
});

test('job-specific personal summaries cannot enter reusable profile storage', async () => {
  const fixture = await backgroundFixture();
  fixture.state().prepared.questions = [{ key: 'personalSummary', label: 'Personal summary', type: 'textarea' }];
  await fixture.act({ action: 'profile-save', payload: { values: { personalSummary: 'Only for this role.' } } });
  assert.equal(fixture.calls.some(([op]) => op === 'forms_profile_save'), false);
  assert.match(fixture.state().error, /requested details/);
});

test('closing the panel cancels a pending automatic native approval and discards late values', async () => {
  const fixture = await backgroundFixture(), panel = fixture.connectPanel();
  let release;
  fixture.prepare(() => new Promise(resolve => { release = resolve; }));
  fixture.application(applicationMetadata({ state: 'ready', answerVersion: 'version-1' }));
  const pending = fixture.poll();
  await tick();
  assert.equal(fixture.state().busy, 'prepare');
  panel.disconnect();
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_cancel').length, 1);
  release({ formId: 'late', fields: [] }); await pending;
  assert.notEqual(fixture.state().prepared?.formId, 'late');
  assert.equal(fixture.state().applicationAnswersPending, true);
  assert.equal(fixture.scheduledPolls, 0);
});

test('automatic status reads have a fixed budget and never consume paid preparation repeatedly', async () => {
  const fixture = await backgroundFixture(), panel = fixture.connectPanel();
  for (let count = 0; count < 245; count++) await fixture.poll();
  assert.equal(fixture.calls.filter(([op]) => op === 'application_status').length, 240);
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 1);
  assert.match(fixture.state().applicationNotice, /Automatic updates paused/);
  panel.disconnect();
});

test('an exact saved application binding prepares an otherwise unnamed form but never a login', async () => {
  for (const [title, expectedPreparations] of [['Engineer at Example', 1], ['Sign in to Careers', 0]]) {
    const page = pastePage(); page.context.document.title = title;
    const fixture = await backgroundFixture(page, { application: applicationMetadata({ state: 'ready', answerVersion: 'saved-version' }) });
    assert.equal(fixture.state().application.applicationId, 'application:synthetic');
    assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, expectedPreparations);
    assert.equal(fixture.calls.some(([op]) => op === 'application_prepare'), false);
  }
});
