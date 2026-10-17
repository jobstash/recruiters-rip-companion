import { fail } from './state.mjs';

export const FACT_KINDS = Object.freeze(['capability', 'language', 'yes_no', 'choice', 'note']);
/** Fixed answer sets; choice and note answers are free text. */
export const ANSWER_OPTIONS = Object.freeze({
  capability: Object.freeze(['Led it', 'Hands-on', 'Some exposure', 'None']),
  language: Object.freeze(['Native', 'Fluent', 'Professional', 'Conversational', 'Basic']),
  yes_no: Object.freeze(['Yes', 'No']),
});

const UNCLEAR = [
  /\?/,
  /\b(?:cv|résumé|resume|source|document|profile|interview|candidate|linkedin)\s+(?:states?|says?|lists?|identifies|mentions?|reports?|notes?|shows?|claims?|indicates?|describes?)\b/i,
  /\baccording to\b/i,
  /\b(?:candidate|self)[- ](?:provided|reported)\b/i,
  /\breported(?:ly)?\b/i,
  /\ballegedly\b/i,
  /\bnot (?:yet )?(?:stated|specified|clear|known|verified|confirmed|promoted)\b/i,
  /\b(?:unknown|unclear|unspecified|unverified|independent(?:ly)? verif\w*)\b/i,
  /\bdoes(?:n['’]t| not) (?:say|state|specify)\b/i,
];

/** Rejects narration about documents, hedges, questions and unknowns; facts and CV/letter text must be plain statements. */
export function assertCleanStatement(text, field = 'statement') {
  if (typeof text === 'string' && UNCLEAR.some(pattern => pattern.test(text)))
    fail('UNCLEAR_FACT', `${field} must state the fact plainly (e.g. "Hands-on", "adidas.com product page experiments"), without document narration, hedging, questions or unknowns. State it plainly or leave it out: ${JSON.stringify(text.slice(0, 200))}`);
  return text;
}

const text = (maxLength, minLength = 1) => ({ type: 'string', minLength, maxLength, ...(minLength ? { pattern: '\\S' } : {}) });
const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const factInputSchema = Object.freeze({
  type: 'object', additionalProperties: false, required: ['kind', 'subject', 'answer'],
  properties: { id: { type: 'string', format: 'uuid' }, kind: { enum: FACT_KINDS }, subject: text(120), answer: text(160), detail: text(1500, 0), employer: text(120, 0), question: text(300, 0), context: text(600, 0), applicationId: { type: 'string', format: 'uuid' } },
});

/** Upsert key: one fact per subject and employer (each case-insensitive, trimmed; no employer is its own key). */
export const factKey = fact => `${fact.subject.trim().toLocaleLowerCase()}\u0000${(fact.employer ?? '').trim().toLocaleLowerCase()}`;
export const compareFacts = (a, b) => a.subject.localeCompare(b.subject, undefined, { sensitivity: 'base' }) ||
  (a.employer ?? '').localeCompare(b.employer ?? '', undefined, { sensitivity: 'base' });

/** Structural incompleteness only; the host evaluates the specificity of an explanation. */
export function needsDetail(fact) {
  if (fact.kind !== 'capability' || !ANSWER_OPTIONS.capability.slice(0, 3).includes(fact.answer)) return false;
  const detail = fact.detail?.trim().toLocaleLowerCase();
  return !detail || [fact.answer, fact.subject].some(value => value.trim().toLocaleLowerCase() === detail);
}

/** Returns the canonical answer for enumerated kinds, or null when the answer is not one of the fixed options. */
export function canonicalAnswer(kind, answer) {
  const options = ANSWER_OPTIONS[kind];
  if (!options) return answer.trim();
  return options.find(option => option.toLocaleLowerCase() === answer.trim().toLocaleLowerCase()) ?? null;
}

/** Validates a fact input and returns its stored fields (without id or timestamps). */
export function normalizeFact({ kind, subject, answer, detail, employer, question, context, applicationId }) {
  if (applicationId !== undefined && !isUuid(applicationId)) fail('INVALID_INPUT', 'applicationId must be a saved application UUID.');
  for (const [field, value, max] of [['detail', detail, 1500], ['question', question, 300], ['context', context, 600]]) {
    if (value !== undefined && (typeof value !== 'string' || value.length > max)) fail('INVALID_INPUT', `${field} must be text of at most ${max} characters.`);
  }
  const canonical = canonicalAnswer(kind, answer);
  if (!canonical) fail('INVALID_INPUT', `A ${kind} answer must be one of: ${ANSWER_OPTIONS[kind].join(', ')}.`);
  const fact = { kind, subject: subject.trim(), answer: canonical,
    ...(detail?.trim() ? { detail: detail.trim() } : {}), ...(employer?.trim() ? { employer: employer.trim() } : {}),
    ...(question !== undefined ? { question: question.trim() } : {}), ...(context !== undefined ? { context: context.trim() } : {}),
    ...(applicationId !== undefined ? { applicationId } : {}) };
  for (const field of ['subject', 'answer', 'detail', 'employer']) if (fact[field]) assertCleanStatement(fact[field], field);
  return fact;
}
