import { fail } from './state.mjs';

export const FACT_KINDS = Object.freeze(['capability', 'language', 'yes_no', 'choice', 'note', 'narrative']);
/** Suggested interview choices; saved facts also preserve free-text answers. */
export const ANSWER_OPTIONS = Object.freeze({
  capability: Object.freeze(['Led it', 'Hands-on', 'Some exposure', 'None']),
  language: Object.freeze(['Native', 'Fluent', 'Professional', 'Conversational', 'Basic']),
  yes_no: Object.freeze(['Yes', 'No']),
});

const text = (maxLength, minLength = 1) => ({ type: 'string', minLength, maxLength, ...(minLength ? { pattern: '\\S' } : {}) });
const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const factInputSchema = Object.freeze({
  type: 'object', additionalProperties: false, required: ['kind', 'subject', 'answer'],
  properties: { id: { type: 'string', format: 'uuid' }, kind: { enum: FACT_KINDS }, subject: text(120), answer: text(8000), detail: text(8000, 0), employer: text(120, 0), question: text(300, 0), context: text(600, 0), applicationId: { type: 'string', format: 'uuid' }, publication: { enum: ['allowed', 'prohibited'] } },
});

/** Human-readable context separates repeated subjects at the same employer. */
export const factKey = fact => [fact.subject, fact.employer ?? '', fact.context ?? ''].map(value => value.trim().toLocaleLowerCase()).join('\u0000');
export const compareFacts = (a, b) => a.subject.localeCompare(b.subject, undefined, { sensitivity: 'base' }) ||
  (a.employer ?? '').localeCompare(b.employer ?? '', undefined, { sensitivity: 'base' }) || (a.context ?? '').localeCompare(b.context ?? '');

/** Structural incompleteness only; the host evaluates the specificity of an explanation. */
export function needsDetail(fact) {
  if (fact.kind !== 'capability' || !ANSWER_OPTIONS.capability.slice(0, 3).includes(fact.answer)) return false;
  const detail = fact.detail?.trim().toLocaleLowerCase();
  return !detail || [fact.answer, fact.subject].some(value => value.trim().toLocaleLowerCase() === detail);
}

/** Normalize recognized choice labels without discarding other literal answers. */
export function canonicalAnswer(kind, answer) {
  const options = ANSWER_OPTIONS[kind];
  if (!options) return answer;
  return options.find(option => option.toLocaleLowerCase() === answer.trim().toLocaleLowerCase()) ?? answer;
}

/** Validates a fact input and returns its stored fields (without id or timestamps). */
export function normalizeFact({ kind, subject, answer, detail, employer, question, context, applicationId, publication }) {
  if (!FACT_KINDS.includes(kind) || typeof subject !== 'string' || !subject.trim() || subject.length > 120 ||
      typeof answer !== 'string' || !answer.trim() || answer.length > 8000) fail('INVALID_INPUT', 'Provide a valid fact kind, subject and nonempty answer.');
  if (publication !== undefined && !['allowed', 'prohibited'].includes(publication)) fail('INVALID_INPUT', 'publication must be allowed or prohibited.');
  if (applicationId !== undefined && !isUuid(applicationId)) fail('INVALID_INPUT', 'applicationId must be a saved application UUID.');
  for (const [field, value, max] of [['detail', detail, 8000], ['question', question, 300], ['context', context, 600], ['employer', employer, 120]]) {
    if (value !== undefined && (typeof value !== 'string' || value.length > max)) fail('INVALID_INPUT', `${field} must be text of at most ${max} characters.`);
  }
  const canonical = canonicalAnswer(kind, answer);
  const fact = { kind, subject: subject.trim(), answer: canonical, ...(publication !== undefined ? { publication } : {}),
    ...(detail?.trim() ? { detail } : {}), ...(employer?.trim() ? { employer: employer.trim() } : {}),
    ...(question !== undefined ? { question } : {}), ...(context !== undefined ? { context } : {}),
    ...(applicationId !== undefined ? { applicationId } : {}) };
  return fact;
}
