import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationProgress, changeProgress, nextStages, replayProgress } from '../src/application-progress.mjs';

const now = new Date('2026-11-05T12:00:00Z');
const step = (app, change) => changeProgress(app, change, now);

test('applications start prepared and follow only the next sensible step', () => {
  const app = {};
  assert.deepEqual(applicationProgress(app), { stage: 'prepared', history: [] });
  assert.deepEqual(nextStages('prepared'), ['applied']);
  for (const stage of ['interviewing', 'offer', 'hired', 'rejected', 'withdrawn'])
    assert.throws(() => step(app, { stage, at: '2026-10-21' }), { code: 'INVALID_PROGRESS' });
  assert.throws(() => step(app, { stage: 'prepared' }), { code: 'INVALID_INPUT' });
  assert.throws(() => step(app, { stage: 'ghosted' }), { code: 'INVALID_INPUT' });
  assert.equal(app.progress, undefined);
  assert.deepEqual(step(app, { stage: 'applied', at: '2026-10-21' }), { stage: 'applied', history: [{ stage: 'applied', at: '2026-10-21' }] });
  assert.equal(app.updatedAt, now.toISOString());
  assert.throws(() => step(app, { stage: 'offer', at: '2026-10-22' }), { code: 'INVALID_PROGRESS', message: /next stage can be interviewing, rejected, withdrawn/ });
  assert.throws(() => step(app, { stage: 'hired' }), { code: 'INVALID_PROGRESS' });
});

test('interviews count rounds, endings record where they happened and undo steps back', () => {
  const app = {};
  step(app, { stage: 'applied', at: '2026-10-21' });
  assert.equal(step(app, { stage: 'interviewing', at: '2026-10-24' }).round, 1);
  assert.equal(step(app, { stage: 'interviewing', at: '2026-10-30' }).round, 2);
  assert.deepEqual(step(app, { stage: 'rejected', at: '2026-11-02' }), { stage: 'rejected', atStage: 'interviewing', round: 2, history: [
    { stage: 'applied', at: '2026-10-21' }, { stage: 'interviewing', round: 1, at: '2026-10-24' },
    { stage: 'interviewing', round: 2, at: '2026-10-30' }, { stage: 'rejected', at: '2026-11-02' }] });
  for (const stage of ['applied', 'interviewing', 'offer', 'hired', 'rejected', 'withdrawn'])
    assert.throws(() => step(app, { stage }), { code: 'INVALID_PROGRESS', message: /undo the last step/ });
  assert.deepEqual(step(app, { undo: true }), { stage: 'interviewing', round: 2, history: app.progress.history });
  assert.equal(app.progress.history.length, 3);
  assert.equal(step(app, { stage: 'offer', at: '2026-11-05' }).stage, 'offer');
  assert.deepEqual(nextStages('offer'), ['hired', 'withdrawn']);
  assert.throws(() => step(app, { stage: 'rejected' }), { code: 'INVALID_PROGRESS' });
  const offered = app.progress.history;
  assert.deepEqual(step(app, { stage: 'withdrawn' }), { stage: 'withdrawn', atStage: 'offer', history: [...offered, { stage: 'withdrawn', at: '2026-11-05' }] });
  step(app, { undo: true });
  assert.equal(step(app, { stage: 'hired' }).stage, 'hired');
  const early = {};
  step(early, { stage: 'applied', at: '2026-10-01' });
  assert.deepEqual(step(early, { stage: 'withdrawn', at: '2026-10-02' }), { stage: 'withdrawn', atStage: 'applied',
    history: [{ stage: 'applied', at: '2026-10-01' }, { stage: 'withdrawn', at: '2026-10-02' }] });
  step(early, { undo: true }); step(early, { undo: true });
  assert.deepEqual(early.progress, { stage: 'prepared', history: [] });
  assert.throws(() => step(early, { undo: true }), { code: 'INVALID_PROGRESS', message: 'There is no step to undo.' });
  assert.throws(() => step(early, { undo: true, stage: 'applied' }), { code: 'INVALID_INPUT' });
});

test('dates default to today, can be changed on the current step and never run backwards or into the future', () => {
  const app = {};
  assert.throws(() => step(app, { at: '2026-10-21' }), { code: 'INVALID_PROGRESS' });
  assert.equal(step(app, { stage: 'applied' }).history[0].at, '2026-11-05');
  assert.equal(step(app, { at: '2026-10-21' }).history[0].at, '2026-10-21');
  for (const at of ['2026-02-30', '21 Oct 2026', '2026-10-21T00:00:00Z', 20261021, ''])
    assert.throws(() => step(app, { stage: 'interviewing', at }), { code: 'INVALID_INPUT' });
  assert.throws(() => step(app, { stage: 'interviewing', at: '2026-10-20' }), { code: 'INVALID_PROGRESS', message: /before the previous one \(2026-10-21\)/ });
  assert.throws(() => step(app, { stage: 'interviewing', at: '2026-11-07' }), { code: 'INVALID_PROGRESS', message: /future/ });
  // The user's local calendar can be a day ahead of UTC.
  assert.equal(step(app, { stage: 'interviewing', at: '2026-11-06' }).round, 1);
  assert.throws(() => step(app, { at: '2026-10-20' }), { code: 'INVALID_PROGRESS' });
  assert.throws(() => step(app, {}), { code: 'INVALID_INPUT' });
});

test('saved steps replay exactly: jumps, wrong rounds and unknown fields are rejected', () => {
  assert.deepEqual(replayProgress([]), { stage: 'prepared', history: [] });
  for (const history of [
    [{ stage: 'interviewing', round: 1, at: '2026-10-01' }],
    [{ stage: 'applied', at: '2026-10-01' }, { stage: 'interviewing', round: 2, at: '2026-10-02' }],
    [{ stage: 'applied', at: '2026-10-01' }, { stage: 'rejected', round: 1, at: '2026-10-02' }],
    [{ stage: 'applied', at: '2026-10-01', note: 'extra' }],
    [{ stage: 'applied', at: '2026-10-01' }, { stage: 'applied', at: '2026-10-02' }],
    [null], {},
  ]) assert.throws(() => replayProgress(history, now), error => ['INVALID_INPUT', 'INVALID_PROGRESS'].includes(error.code));
});
