import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../ui/career-gap.js', import.meta.url), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
const setting = (overrides = {}) => ({ enabled: false, activity: 'Career break', place: '', description: 'Career gap period - private reasons', minMonths: 3, fromYear: 2016, toYear: 2026, ...overrides });

function fixture(invoke) {
  const calls = [];
  const control = () => {
    const listeners = new Map();
    return { hidden: false, disabled: false, checked: false, value: '', textContent: '', dataset: {},
      addEventListener: (event, callback) => listeners.set(event, callback),
      dispatch: event => listeners.get(event)?.() };
  };
  const nodes = new Map(['career-gap', ...['enabled', 'options', 'from', 'to', 'months', 'activity', 'place', 'description', 'note', 'error'].map(name => `career-gap-${name}`)]
    .map(id => [id, control()]));
  const tabs = ['sources', 'facts', 'preferences'].map(kind => Object.assign(control(), { dataset: { careerKind: kind } }));
  const companion = { invoke: async (operation, input) => {
    calls.push([operation, structuredClone(input)]);
    return invoke ? invoke(operation, input) : { ok: true, result: input };
  } };
  const context = vm.createContext({ document: { getElementById: id => nodes.get(id), querySelectorAll: () => tabs }, window: { companion } });
  vm.runInContext(script, context);
  const node = name => nodes.get(name ? `career-gap-${name}` : 'career-gap');
  // A real control fires input, then change, once the candidate commits a value.
  const edit = async (name, change) => { change(node(name)); node(name).dispatch('input'); node(name).dispatch('change'); await turn(); };
  return { node, calls, edit, tab: kind => tabs.find(tab => tab.dataset.careerKind === kind).dispatch('click'),
    refresh: value => context.window.careerGapUI.refresh(value), clear: () => context.window.careerGapUI.clear() };
}

test('detection is unticked by default and its years, minimum length and entry stay hidden', () => {
  const ui = fixture();
  assert.equal(ui.node().hidden, true, 'nothing shows before saved work is open');
  ui.refresh(setting());
  assert.equal(ui.node().hidden, false);
  assert.equal(ui.node('enabled').checked, false);
  assert.equal(ui.node('enabled').disabled, false);
  assert.equal(ui.node('options').hidden, true);
  assert.equal(ui.node('note').textContent, 'Off. Generated CVs do not mention gaps between jobs.');
  assert.equal(ui.calls.length, 0, 'showing the setting never turns it on');
});

test('ticking the checkbox reveals the options and saves detection on with the shown values', async () => {
  const ui = fixture();
  ui.refresh(setting());
  await ui.edit('enabled', node => { node.checked = true; });
  assert.deepEqual(ui.calls, [['career-gap-set', setting({ enabled: true })]]);
  assert.equal(ui.node('options').hidden, false);
  assert.deepEqual(['from', 'to', 'months', 'activity', 'place', 'description'].map(name => ui.node(name).value),
    ['2016', '2026', '3', 'Career break', '', 'Career gap period - private reasons']);
  assert.equal(ui.node('note').textContent, 'On. A gap of 3 months or more between jobs in 2016–2026 is listed in Experience among your jobs in generated CVs: “Career break” · its dates from your CV · “Career gap period - private reasons”. Earlier documents update the next time your AI prepares them.');
  await ui.edit('months', node => { node.value = '6'; });
  await ui.edit('from', node => { node.value = '2019'; });
  assert.deepEqual(ui.calls.at(-1), ['career-gap-set', setting({ enabled: true, minMonths: 6, fromYear: 2019 })]);
});

test('unticking hides the options again and saves detection off even when a hidden option is incomplete', async () => {
  const ui = fixture();
  ui.refresh(setting({ enabled: true, minMonths: 6 }));
  assert.equal(ui.node('options').hidden, false);
  ui.node('months').value = ''; ui.node('months').dispatch('input');
  await ui.edit('enabled', node => { node.checked = false; });
  assert.deepEqual(ui.calls, [['career-gap-set', setting({ enabled: false, minMonths: 6 })]]);
  assert.equal(ui.node('options').hidden, true);
  assert.equal(ui.node('error').hidden, true);
});

test('the entry is the candidate’s activity, place and description; a missing activity or invalid years or months are explained, not sent', async () => {
  const ui = fixture();
  ui.refresh(setting({ enabled: true }));
  await ui.edit('activity', node => { node.value = '   '; });
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.node('error').textContent, 'Write the activity to show for a career gap, such as Career break.');
  assert.match(ui.node('note').textContent, /“Career break” · its dates from your CV/, 'the note keeps describing what is saved');
  await ui.edit('activity', node => { node.value = '  Parental leave '; });
  await ui.edit('place', node => { node.value = ' Lisbon, Portugal '; });
  await ui.edit('description', node => { node.value = ' Cared for a newborn '; });
  assert.deepEqual(ui.calls.at(-1), ['career-gap-set', setting({ enabled: true, activity: 'Parental leave', place: 'Lisbon, Portugal', description: 'Cared for a newborn' })]);
  assert.equal(ui.calls.length, 3, 'each committed part saves at once');
  assert.equal(ui.node('error').hidden, true);
  assert.match(ui.node('note').textContent, /: “Parental leave” · “Lisbon, Portugal” · its dates from your CV · “Cared for a newborn”\./);
  await ui.edit('description', node => { node.value = ''; });
  assert.deepEqual(ui.calls.at(-1)[1].description, '', 'the description is optional');
  assert.match(ui.node('note').textContent, /: “Parental leave” · “Lisbon, Portugal” · its dates from your CV\./);
  const sent = ui.calls.length;
  for (const [name, value, message] of [['months', '2', 'A career gap is at least 3 months. Enter 3 to 120.'], ['months', '4.5', 'A career gap is at least 3 months. Enter 3 to 120.'],
    ['from', '2030', 'The first year must not be after the last year.'], ['to', '1900', 'Enter the years to check, from 1950 to 2100.']]) {
    const previous = ui.node(name).value;
    await ui.edit(name, node => { node.value = value; });
    assert.equal(ui.node('error').textContent, message);
    ui.node(name).value = previous;
  }
  assert.equal(ui.calls.length, sent);
});

test('a failed save restores what is stored and says so; polling never overwrites typing', async () => {
  let fail = true;
  const ui = fixture(async (operation, input) => fail ? { ok: false, error: { message: 'Your saved work is locked.' } } : { ok: true, result: input });
  ui.refresh(setting());
  await ui.edit('enabled', node => { node.checked = true; });
  assert.equal(ui.node('enabled').checked, false, 'a rejected save does not look enabled');
  assert.equal(ui.node('options').hidden, true);
  assert.equal(ui.node('error').textContent, 'Could not save career gap detection. Your saved work is locked.');
  assert.equal(ui.node('enabled').disabled, false);
  fail = false;
  await ui.edit('enabled', node => { node.checked = true; });
  assert.equal(ui.node('error').hidden, true);
  ui.node('months').value = '1'; ui.node('months').dispatch('input');
  ui.refresh(setting({ enabled: true }));
  assert.equal(ui.node('months').value, '1', 'an unchanged poll keeps the half-typed value');
  ui.refresh(setting({ enabled: true, minMonths: 9 }));
  assert.equal(ui.node('months').value, '1', 'so does a changed one while the candidate is typing');
});

test('the setting belongs to the CVs tab and disappears when saved work locks', () => {
  const ui = fixture();
  ui.refresh(setting({ enabled: true }));
  ui.tab('facts');
  assert.equal(ui.node().hidden, true);
  ui.tab('sources');
  assert.equal(ui.node().hidden, false);
  ui.clear();
  assert.equal(ui.node().hidden, true);
  assert.equal(ui.node('note').textContent, '');
  assert.equal(ui.node('enabled').disabled, true);
});
