import { fail } from './state.mjs';

export const FACT_KINDS = Object.freeze(['capability', 'language', 'yes_no', 'choice', 'note']);
/** Fixed answer sets; choice and note answers are free text. */
export const ANSWER_OPTIONS = Object.freeze({
  capability: Object.freeze(['Led it', 'Hands-on', 'Some exposure', 'None']),
  language: Object.freeze(['Native', 'Fluent', 'Professional', 'Conversational', 'Basic']),
  yes_no: Object.freeze(['Yes', 'No']),
});
const FIELDS = new Set(['id', 'kind', 'subject', 'answer', 'detail', 'employer', 'createdAt', 'updatedAt']);

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
export const factInputSchema = Object.freeze({
  type: 'object', additionalProperties: false, required: ['kind', 'subject', 'answer'],
  properties: { id: { type: 'string', format: 'uuid' }, kind: { enum: FACT_KINDS }, subject: text(120), answer: text(160), detail: text(400, 0), employer: text(120, 0) },
});

/** Upsert key: one fact per subject (case-insensitive, trimmed). */
export const factKey = fact => fact.subject.trim().toLocaleLowerCase();
export const compareFacts = (a, b) => a.subject.localeCompare(b.subject, undefined, { sensitivity: 'base' });

/** Returns the canonical answer for enumerated kinds, or null when the answer is not one of the fixed options. */
export function canonicalAnswer(kind, answer) {
  const options = ANSWER_OPTIONS[kind];
  if (!options) return answer.trim();
  return options.find(option => option.toLocaleLowerCase() === answer.trim().toLocaleLowerCase()) ?? null;
}

/** Validates a fact input and returns its stored fields (without id or timestamps). */
export function normalizeFact({ kind, subject, answer, detail, employer }) {
  const canonical = canonicalAnswer(kind, answer);
  if (!canonical) fail('INVALID_INPUT', `A ${kind} answer must be one of: ${ANSWER_OPTIONS[kind].join(', ')}.`);
  const fact = { kind, subject: subject.trim(), answer: canonical,
    ...(detail?.trim() ? { detail: detail.trim() } : {}), ...(employer?.trim() ? { employer: employer.trim() } : {}) };
  for (const field of ['subject', 'answer', 'detail', 'employer']) if (fact[field]) assertCleanStatement(fact[field], field);
  return fact;
}

/** True for a stored fact with exactly the v4 shape. */
export function isFact(fact) {
  return Boolean(fact) && typeof fact === 'object' && FACT_KINDS.includes(fact.kind) &&
    typeof fact.subject === 'string' && Boolean(fact.subject.trim()) && typeof fact.answer === 'string' && Boolean(fact.answer.trim()) &&
    (!ANSWER_OPTIONS[fact.kind] || ANSWER_OPTIONS[fact.kind].includes(fact.answer)) &&
    ['detail', 'employer'].every(field => fact[field] === undefined || typeof fact[field] === 'string') &&
    Object.keys(fact).every(key => FIELDS.has(key));
}
