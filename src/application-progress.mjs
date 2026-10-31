import { fail } from './mcp/state.mjs';

/** Where an application stands, as the user reports it. Off-platform outcomes live only in the local vault. */
export const PROGRESS_STAGES = ['prepared', 'applied', 'interviewing', 'offer', 'hired', 'rejected', 'withdrawn'];
const following = { prepared: ['applied'], applied: ['interviewing', 'rejected', 'withdrawn'],
  interviewing: ['interviewing', 'offer', 'rejected', 'withdrawn'], offer: ['hired', 'withdrawn'], hired: [], rejected: [], withdrawn: [] };
export const nextStages = stage => following[stage] ?? [];
export const todayDate = (now = new Date()) => now.toISOString().slice(0, 10);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
const prepared = () => ({ stage: 'prepared', history: [] });

export function applicationProgress(app) {
  const saved = app?.progress;
  return saved !== null && typeof saved === 'object' && !Array.isArray(saved) ? saved : prepared();
}

/** Rebuild the current state from its steps: every step follows the previous one, dates never go backwards or past
 *  tomorrow (the user's calendar can be ahead of UTC), and rounds are counted rather than trusted. */
export function replayProgress(history, now = new Date()) {
  if (!Array.isArray(history) || history.length > 200) fail('INVALID_INPUT', 'Progress history must be a list of steps.');
  const latest = todayDate(new Date(now.getTime() + 86_400_000));
  let progress = prepared(), previousAt = null;
  for (const entry of history) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).some(key => !['stage', 'round', 'at'].includes(key))) fail('INVALID_INPUT', 'Each progress step has only stage, round and at.');
    const allowed = nextStages(progress.stage);
    if (!allowed.includes(entry.stage))
      fail('INVALID_PROGRESS', allowed.length ? `This application is ${progress.stage}; the next stage can be ${allowed.join(', ')}.`
        : `This application is ${progress.stage}; undo the last step to change it.`);
    if (!validDate(entry.at)) fail('INVALID_INPUT', 'Use a date in the form YYYY-MM-DD.');
    if (entry.at > latest) fail('INVALID_PROGRESS', 'A step cannot be dated in the future.');
    if (previousAt && entry.at < previousAt) fail('INVALID_PROGRESS', `A step cannot be dated before the previous one (${previousAt}).`);
    const round = entry.stage === 'interviewing' ? (progress.stage === 'interviewing' ? progress.round + 1 : 1) : undefined;
    if (entry.round !== undefined && entry.round !== round) fail('INVALID_PROGRESS', 'An interview round does not follow the previous step.');
    const step = { stage: entry.stage, ...(round ? { round } : {}), at: entry.at };
    const ended = ['rejected', 'withdrawn'].includes(entry.stage);
    progress = { stage: entry.stage, ...(round ? { round } : {}),
      ...(ended ? { atStage: progress.stage, ...(progress.round ? { round: progress.round } : {}) } : {}),
      history: [...progress.history, step] };
    previousAt = entry.at;
  }
  return progress;
}

/** One change: a next stage (dated today unless `at` is given), a new date for the current step, or undo of the last step. */
export function changeProgress(app, { stage, at, undo } = {}, now = new Date()) {
  const history = [...applicationProgress(app).history];
  if (undo !== undefined) {
    if (undo !== true || stage !== undefined || at !== undefined) fail('INVALID_INPUT', 'Undo takes no stage or date.');
    if (!history.length) fail('INVALID_PROGRESS', 'There is no step to undo.');
    history.pop();
  } else if (stage === undefined) {
    if (at === undefined) fail('INVALID_INPUT', 'Provide a stage, a date or undo.');
    if (!history.length) fail('INVALID_PROGRESS', 'Record a step before changing its date.');
    history[history.length - 1] = { ...history.at(-1), at };
  } else {
    if (!PROGRESS_STAGES.includes(stage) || stage === 'prepared') fail('INVALID_INPUT', `Choose a stage: ${PROGRESS_STAGES.slice(1).join(', ')}.`);
    history.push({ stage, at: at ?? todayDate(now) });
  }
  app.progress = replayProgress(history, now);
  app.updatedAt = now.toISOString();
  return app.progress;
}
