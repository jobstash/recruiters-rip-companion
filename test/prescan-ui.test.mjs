import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

class Node {
  constructor(id = '') {
    this.id = id; this.hidden = false; this.disabled = false; this.value = ''; this.textContent = ''; this.open = false;
    this.attributes = new Map(); this.listeners = new Map(); this.children = []; this.classes = new Set();
    this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
      add: name => this.classes.add(name), remove: name => this.classes.delete(name), contains: name => this.classes.has(name) };
  }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.textContent = children.filter(value => typeof value === 'string').join(''); }
  focus() {}
  querySelector(selector) { return selector === '.run-step-number' ? this.number : null; }
}

async function fixture() {
  const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  const nodes = Object.fromEntries(ids.map(id => [id, new Node(id)]));
  for (const id of ['run-step-key', 'run-step-prefilter', 'run-step-handover']) nodes[id].number = new Node();
  nodes['view-jobs'].hidden = true; // no preview network call in this pure render test
  nodes['view-setup'].hidden = true; nodes.settings.hidden = false;
  const runSteps = new Node(); runSteps.classes.add('run-steps'); runSteps.classes.add('has-key-step');
  const document = { activeElement: null, getElementById: id => nodes[id] ?? null,
    querySelector: selector => selector === '.run-steps' ? runSteps : null,
    createElement: () => new Node() };
  const window = { companion: { invoke: async () => ({ ok: true, result: {} }) }, addEventListener() {} };
  const MutationObserver = class { observe() {} };
  runInNewContext(await readFile(new URL('../ui/prescan.js', import.meta.url), 'utf8'),
    { window, document, MutationObserver, Intl, setTimeout, clearTimeout, console });
  const run = { status: 'completed', publicationRange: 'past_3_days', selected: 0, processed: 0, scored: 0, unavailable: 0,
    included: 0, minimumScore: 36, totalCatalogue: 0, inputTokens: 0, requests: 0, estimatedCostUsd: 0 };
  const credentials = configured => ({ provider: 'openai', model: 'gpt-6-luna', configured, credentialVersion: 1,
    inputUsdPerMillion: 0.1, savedAt: configured ? '2026-10-20T19:00:00.000Z' : null, keyHint: configured ? 'hPMA' : null, providers: [] });
  return { window, nodes, runSteps, state: (configured, changes = {}) => ({ credentials: credentials(configured), run: { ...run, ...changes }, contextVersion: 'synthetic' }) };
}

const number = (nodes, name) => nodes[`run-step-${name}`].number.textContent;

test('the API-key setup step disappears after a successful save and the recurring flow renumbers to three steps', async () => {
  const f = await fixture();
  f.window.prescanUI.refresh(f.state(true), true);
  assert.equal(f.nodes['run-step-key'].hidden, true);
  assert.equal(f.runSteps.classList.contains('has-key-step'), false);
  assert.deepEqual(['prefilter', 'handover'].map(name => number(f.nodes, name)), ['1', '2']);
  assert.equal(f.nodes['run-step-handover'].attributes.get('aria-current'), 'step');
  assert.equal(f.nodes['jobs-prescan-settings'].textContent, 'Replace key');
});

test('the API-key step appears for first setup and after OpenAI rejects a saved key', async () => {
  const f = await fixture();
  f.window.prescanUI.refresh(f.state(false, { status: 'idle' }), true);
  assert.equal(f.nodes['run-step-key'].hidden, false);
  assert.equal(f.runSteps.classList.contains('has-key-step'), true);
  assert.deepEqual(['key', 'prefilter', 'handover'].map(name => number(f.nodes, name)), ['1', '2', '3']);
  assert.equal(f.nodes['run-step-key'].attributes.get('aria-current'), 'step');
  assert.equal(f.nodes['jobs-prescan-settings'].textContent, 'Add key');

  f.window.prescanUI.refresh(f.state(true, { status: 'failed', lastError: { code: 'PRESCAN_AUTH' } }), true);
  assert.equal(f.nodes['run-step-key'].hidden, false);
  assert.equal(f.nodes['prescan-key-state'].textContent, 'Key …hPMA was rejected by OpenAI.');
  assert.equal(f.nodes['jobs-prescan-settings'].textContent, 'Replace key');
  assert.equal(f.nodes['prescan-start'].disabled, true);
});
