import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { BROWSER_IDENTITIES } from '../src/browser-identity.mjs';
import { createManifest } from '../browser-extension/manifest.mjs';
import { safeDeviceRequest, externalSenderAllowed, deviceResult, createNativeClient, safeNativeCommand } from '../browser-extension/src/protocol.mjs';
import { captureJobs, inspectForm, fillForm, checkFormBindings, armSmartPaste, disarmSmartPaste, pressAction, observePage } from '../browser-extension/src/page.mjs';
import { createPageAccess } from '../browser-extension/src/page-access.mjs';

const origin = BROWSER_IDENTITIES.production.productOrigin;
const request = (op, payload = {}) => ({ version: 1, id: randomUUID(), op, payload });
const event = () => { const listeners = []; return { addListener(fn) { listeners.push(fn); }, emit(value) { for (const fn of listeners) fn(value); } }; };
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
  await assert.rejects(inject(7, fillForm), /toolbar icon/);
  denied = false;
  await inject(7, fillForm, [{ url: 'https://jobs.example.test/apply', fields: [] }], 'snapshot-document');
  assert.deepEqual(calls.at(-1).target, { tabId: 7, documentIds: ['snapshot-document'] });
  tab.url = 'chrome://extensions';
  await assert.rejects(inject(7, captureJobs), /HTTP or HTTPS/);
  assert.equal(calls.length, 2);
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
  for (const op of ['capture_jobs','forms_prepare','forms_cancel','career_facts','credential_read','connect_provider']) assert.throws(() => safeDeviceRequest(request(op), origin));
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
  const listeners = {}, messages = [], clipboard = [];
  let responder = () => ({ value: null });
  page.context.document.querySelectorAll = selector => selector.startsWith('button') ? buttons : selector.includes('alert') ? [] : page.controls;
  page.context.document.addEventListener = (type, fn) => { listeners[type] = fn; };
  page.context.addEventListener = (type, fn) => { listeners[`window:${type}`] = fn; };
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
    if (page.context.document.activeElement) listeners.focusout({});
    page.context.document.activeElement = el;
    listeners.focusin({ target: el, isTrusted: trusted });
  };
  return { ...page, buttons, listeners, messages, clipboard, focus, respond: fn => { responder = fn; } };
}

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

async function backgroundFixture(page = pastePage()) {
  const calls = [];
  let nativeOptions, messageHandler, documentId = 'document-1', permission = true, validate = async () => ({ valid: true });
  const chrome = {
    runtime: { id: 'extension', onConnectExternal: event(), onConnect: event(), onMessage: { addListener(fn) { messageHandler = fn; } }, getURL: path => `chrome-extension://extension/${path}` },
    permissions: { contains: async () => permission },
    tabs: { get: async () => ({ id: 7, url: page.context.location.href, title: 'Application', status: 'complete' }) },
    sidePanel: {}, scripting: {},
  };
  const context = vm.createContext({
    chrome, crypto: { randomUUID }, PRODUCT_ORIGIN: origin, NATIVE_HOST: 'synthetic',
    captureJobs, inspectForm, fillForm, checkFormBindings, armSmartPaste, disarmSmartPaste, pressAction, observePage,
    safeDeviceRequest, externalSenderAllowed, deviceResult,
    setTimeout: fn => setTimeout(fn, 0),
    createPageAccess: () => async (tabId, fn, args = [], expectedDocument = null) => {
      if (expectedDocument && expectedDocument !== documentId) throw new Error('The page changed.');
      return { page: fn === captureJobs ? { jobs: [] } : page.invoke(fn, args[0] ?? null), documentId };
    },
    createNativeClient: options => {
      nativeOptions = options;
      return { request: async (op, payload) => {
        calls.push([op, plain(payload)]);
        if (op === 'forms_validate') return validate(payload);
        if (op === 'forms_prepare') return { formId: 'form:synthetic', fields: payload.fields.filter(field => field.empty && !field.manualOnly).slice(0, 1).map(field => ({ ...field, value: 'Synthetic Candidate' })) };
        throw new Error(`Unexpected request: ${op}`);
      } };
    },
  });
  const source = await readFile(new URL('../browser-extension/src/background.mjs', import.meta.url), 'utf8');
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, ''), context);
  const act = async message => { context.message = message; await vm.runInContext('act(message)', context); };
  await act({ action: 'detect', payload: { tabId: 7 } });
  await act({ action: 'prepare' });
  const state = () => vm.runInContext('state', context);
  assert.equal(state().error, '');
  page.context.chrome.runtime.sendMessage = (message, callback) => {
    page.messages.push(message);
    const asynchronous = messageHandler(message, { id: 'extension', tab: { id: 7 }, frameId: 0, documentId }, callback ?? (() => {}));
    if (!asynchronous && message.action !== 'paste-value') callback?.();
  };
  return {
    page, calls, state, act,
    command(op, payload) { const command = safeNativeCommand(request(op, payload)); return nativeOptions.onCommand(command.op, command.payload); },
    disconnect: () => nativeOptions.onDisconnect(),
    validate: fn => { validate = fn; },
    permission: value => { permission = value; },
    navigate: value => { documentId = value; },
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
