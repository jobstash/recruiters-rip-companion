import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationProgress, changeProgress, moveProgress, nextStages, replayProgress } from '../src/application-progress.mjs';

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

test('moving straight to a stage fills skipped steps forward and undoes steps backward', () => {
  const move = (app, to, at = '2026-11-01') => moveProgress(app, to, { at, now });
  const stages = app => app.progress.history.map(entry => entry.round ? `${entry.stage} ${entry.round}` : entry.stage);
  const app = {};
  assert.deepEqual(stages({ progress: move(app, 'hired') }), ['applied', 'interviewing 1', 'offer', 'hired']);
  assert.ok(app.progress.history.every(entry => entry.at === '2026-11-01'));
  move(app, 'interviewing');
  assert.deepEqual(stages(app), ['applied', 'interviewing 1']);
  step(app, { stage: 'interviewing', at: '2026-11-02' });
  // Back to Interviewing from Offer keeps every round; already there changes nothing.
  move(app, 'offer', '2026-11-03');
  move(app, 'interviewing');
  assert.deepEqual(stages(app), ['applied', 'interviewing 1', 'interviewing 2']);
  const before = structuredClone(app);
  assert.deepEqual(move(app, 'interviewing'), before.progress);
  assert.deepEqual(app, before);
  // Closing records the choice where it ended; leaving Closed undoes the ending first.
  assert.deepEqual([move(app, 'rejected', '2026-11-03').atStage, app.progress.round], ['interviewing', 2]);
  move(app, 'withdrawn', '2026-11-04');
  assert.deepEqual(stages(app), ['applied', 'interviewing 1', 'interviewing 2', 'withdrawn']);
  move(app, 'offer', '2026-11-05');
  assert.deepEqual(stages(app), ['applied', 'interviewing 1', 'interviewing 2', 'offer']);
  // From an offer, Rejected undoes the offer: offers are declined (withdrawn), not rejected.
  assert.deepEqual([move(app, 'withdrawn', '2026-11-05').atStage], ['offer']);
  move(app, 'offer');
  move(app, 'rejected', '2026-11-05');
  assert.deepEqual(stages(app), ['applied', 'interviewing 1', 'interviewing 2', 'rejected']);
  move(app, 'prepared');
  assert.deepEqual(app.progress, { stage: 'prepared', history: [] });
  assert.deepEqual(stages({ progress: move({}, 'rejected') }), ['applied', 'rejected']);
  assert.throws(() => move({}, 'closed'), { code: 'INVALID_INPUT' });
  assert.throws(() => move(app, 'offer', '2026-11-09'), { code: 'INVALID_PROGRESS' });
});

test('next interview dates save, reschedule and clear without changing historical steps', () => {
  const app = {};
  step(app, { stage: 'applied', at: '2026-10-21' });
  step(app, { stage: 'interviewing', at: '2026-10-24', nextInterviewAt: '2099-01-15' });
  const history = structuredClone(app.progress.history);
  assert.equal(app.progress.nextInterviewAt, '2099-01-15');
  assert.deepEqual(replayProgress(history, now, '2099-01-15'), app.progress);
  assert.equal(step(app, { nextInterviewAt: '2099-02-20' }).nextInterviewAt, '2099-02-20');
  assert.deepEqual(app.progress.history, history);
  step(app, { at: '2026-10-25' });
  assert.equal(app.progress.nextInterviewAt, '2099-02-20');
  assert.equal(app.progress.history.at(-1).at, '2026-10-25');
  const beforeMove = structuredClone(app);
  assert.deepEqual(moveProgress(app, 'interviewing', { now }), beforeMove.progress);
  assert.deepEqual(app, beforeMove);
  step(app, { nextInterviewAt: null });
  assert.equal(Object.hasOwn(app.progress, 'nextInterviewAt'), false);
  assert.equal(app.progress.round, 1);
});

test('invalid schedule dates and scheduling outside interviews leave applications untouched', () => {
  const app = {};
  moveProgress(app, 'interviewing', { at: '2026-10-21', now });
  step(app, { nextInterviewAt: '2099-01-15' });
  const before = structuredClone(app);
  for (const nextInterviewAt of ['2099-02-29', '2099-04-31', '2099-13-01', '15 Jan 2099', '2099-01-15T12:00:00Z', '', 20990115, false, {}]) {
    assert.throws(() => step(app, { nextInterviewAt }), { code: 'INVALID_INPUT' });
    assert.deepEqual(app, before);
  }
  assert.equal(step(app, { nextInterviewAt: '2100-02-28' }).nextInterviewAt, '2100-02-28');
  assert.equal(step(app, { nextInterviewAt: '2096-02-29' }).nextInterviewAt, '2096-02-29');
  assert.throws(() => step(app, { undo: true, nextInterviewAt: null }), { code: 'INVALID_INPUT' });
  for (const stage of ['prepared', 'applied', 'offer', 'hired', 'rejected', 'withdrawn']) {
    const other = {};
    moveProgress(other, stage, { at: '2026-10-21', now });
    const original = structuredClone(other);
    for (const nextInterviewAt of ['2099-01-15', null]) {
      assert.throws(() => step(other, { nextInterviewAt }), { code: 'INVALID_PROGRESS' });
      assert.throws(() => moveProgress(other, stage, { nextInterviewAt, now }), { code: 'INVALID_PROGRESS' });
      assert.deepEqual(other, original);
    }
  }
});

test('round changes, undo and status transitions clear old schedules without resurrecting them', () => {
  const scheduled = () => {
    const app = {};
    moveProgress(app, 'interviewing', { at: '2026-10-21', nextInterviewAt: '2099-01-15', now });
    return app;
  };
  const app = scheduled();
  step(app, { stage: 'interviewing' });
  assert.equal(app.progress.round, 2);
  assert.equal(app.progress.nextInterviewAt, undefined);
  step(app, { nextInterviewAt: '2099-02-15' });
  step(app, { undo: true });
  assert.equal(app.progress.round, 1);
  assert.equal(app.progress.nextInterviewAt, undefined);
  step(app, { stage: 'interviewing', nextInterviewAt: '2099-03-15' });
  assert.equal(app.progress.nextInterviewAt, '2099-03-15');
  for (const stage of ['prepared', 'applied', 'offer', 'hired', 'rejected', 'withdrawn']) {
    const other = scheduled();
    moveProgress(other, stage, { now });
    assert.equal(other.progress.nextInterviewAt, undefined, stage);
    moveProgress(other, 'interviewing', { now });
    assert.equal(other.progress.nextInterviewAt, undefined, stage);
  }
  for (const stage of ['offer', 'rejected', 'withdrawn']) {
    const other = scheduled();
    step(other, { stage });
    assert.equal(other.progress.nextInterviewAt, undefined, stage);
    step(other, { undo: true });
    assert.equal(other.progress.nextInterviewAt, undefined, stage);
  }
});
