import test from 'node:test';
import assert from 'node:assert/strict';
import { derivePanelFlow } from '../browser-extension/src/panel-flow.mjs';

const base = { pageKind: 'job', companion: { workflowVersion: 2, hasCv: true }, application: { state: 'needs_documents', documents: [], introduction: { ready: false } } };

test('page evidence takes precedence over setup and never chooses a listing job', () => {
  for (const pageKind of ['none', 'listing']) {
    const flow = derivePanelFlow({ ...base, pageKind, errorCode: 'LOCAL_LOCKED', companion: { locked: true, hasCv: false }, jobs: [{ title: 'First' }, { title: 'Second' }] });
    assert.equal(flow.kind, pageKind === 'none' ? 'no-job' : 'listing');
    assert.notEqual(flow.primary?.id, 'application-prepare');
  }
});

test('setup is local and authoritative, with locked preceding old-version inference', () => {
  assert.equal(derivePanelFlow({ ...base, companion: { ...base.companion, paired: false } }).primary.id, 'application-prepare');
  for (const [companion, kind] of [[{ locked: true }, 'locked'], [{}, 'update'], [{ workflowVersion: 1 }, 'update'], [{ workflowVersion: 2, hasCv: false }, 'missing-cv']]) {
    assert.equal(derivePanelFlow({ ...base, companion }).kind, kind);
  }
  assert.equal(derivePanelFlow({ ...base, errorCode: 'COMPANION_UNAVAILABLE' }).kind, 'unavailable');
  assert.equal(derivePanelFlow({ ...base, companion: { ...base.companion, hostInfo: { claude: { available: false } } } }).kind, 'unavailable-ai');
});

test('Stop is offered only for owned cancellable preparation, never external AI work', () => {
  assert.equal(derivePanelFlow({ ...base, busy: 'prepare' }).primary.id, 'cancel');
  assert.equal(derivePanelFlow({ ...base, busy: 'application-prepare' }).primary, null);
  for (const handoff of [{ requiresSend: true, mode: 'desktop' }, { requiresSend: false, state: 'agent_read' }]) {
    assert.equal(derivePanelFlow({ ...base, application: { ...base.application, handoff } }).primary, null);
  }
});

test('handoff distinguishes Send, Enter, unknown mode and reading without claiming writing', () => {
  for (const [mode, expected, absent] of [['desktop', /Send/, /Enter/], ['cli', /Enter/, /Send/], [undefined, /send/, /click Send|press Enter/]]) {
    const flow = derivePanelFlow({ ...base, application: { ...base.application, handoff: { host: 'codex', requiresSend: true, mode } } });
    assert.equal(flow.kind, 'awaiting-send'); assert.match(flow.message, expected); assert.doesNotMatch(flow.message, absent);
  }
  const read = derivePanelFlow({ ...base, application: { ...base.application, handoff: { state: 'agent_read', host: 'codex' } } });
  assert.equal(read.kind, 'host-read'); assert.doesNotMatch(read.message, /writing|generating|working/i);
});

test('answer count excludes empty, protected, manual and stale values', () => {
  const state = { ...base, application: { ...base.application, state: 'ready' }, prepared: { fields: [
    { id: 'name', value: 'Name', empty: true }, { id: 'blank', value: '', empty: true },
    { id: 'manual', value: 'Manual', empty: true, manualOnly: true }, { id: 'populated', value: 'Existing', empty: false },
  ] } };
  assert.equal(derivePanelFlow(state).answerCount, 1);
  assert.equal(derivePanelFlow({ ...state, edits: { name: '' } }).answerCount, 0);
  assert.equal(derivePanelFlow({ ...state, answersStale: true }).answerCount, 0);
});

test('ready package exposes current artifacts without re-generation; partial and stale remain distinct', () => {
  const application = { state: 'ready', documents: [{ kind: 'cv', ready: true }], introduction: { ready: true } };
  const ready = derivePanelFlow({ ...base, application });
  assert.equal(ready.kind, 'ready'); assert.equal(ready.primary, null); assert.equal(ready.introReady, true);
  assert.equal(derivePanelFlow({ ...base, application: { ...application, state: 'drafts' } }).kind, 'partial');
  assert.equal(derivePanelFlow({ ...base, application: { ...application, state: 'needs_refresh' } }).kind, 'stale');
  assert.equal(derivePanelFlow({ ...base, application, answersStale: true }).primary.id, 'application-answers');
});

test('recoverable extra-help failures offer deterministic saved answers', () => {
  assert.equal(derivePanelFlow({ ...base, errorCode: 'DECISIONS_KEY_REQUIRED', error: 'Key required' }).primary.id, 'prepare-saved');
  assert.equal(derivePanelFlow({ ...base, error: 'Page changed' }).kind, 'error');
  assert.equal(derivePanelFlow({}).kind, 'connecting');
});
