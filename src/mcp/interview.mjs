import { fail } from './state.mjs';
import { ANSWER_OPTIONS, assertCleanStatement, factKey } from './facts.mjs';

export const QUESTION_KINDS = Object.freeze(['capability', 'language', 'yes_no', 'choice']);
const LETTERS = 'abcdef';
const text = (maxLength, minLength = 1) => ({ type: 'string', minLength, maxLength, ...(minLength ? { pattern: '\\S' } : {}) });

export const questionSchema = Object.freeze({
  type: 'object', additionalProperties: false, required: ['subject', 'prompt', 'kind'],
  properties: {
    subject: text(120), prompt: text(200), kind: { enum: QUESTION_KINDS },
    options: { type: 'array', items: text(160), minItems: 2, maxItems: 6, uniqueItems: true },
    employer: text(120, 0), allowDetail: { type: 'boolean' },
  },
  allOf: [{ if: { properties: { kind: { const: 'choice' } } }, then: { required: ['options'] }, else: { not: { required: ['options'] } } }],
});

/** Validates host questions and resolves each to its full answer list. */
export function prepareQuestions(questions) {
  const prepared = questions.map(question => {
    const options = question.kind === 'choice' ? question.options.map(option => option.trim()) : [...ANSWER_OPTIONS[question.kind]];
    const resolved = { subject: question.subject.trim(), prompt: question.prompt.trim(), kind: question.kind, options,
      ...(question.employer?.trim() ? { employer: question.employer.trim() } : {}), ...(question.allowDetail ? { allowDetail: true } : {}) };
    assertCleanStatement(resolved.subject, 'subject');
    if (resolved.employer) assertCleanStatement(resolved.employer, 'employer');
    for (const option of options) assertCleanStatement(option, 'option');
    if (new Set(options.map(option => option.toLocaleLowerCase())).size !== options.length) fail('INVALID_INPUT', `Question "${resolved.subject}" repeats an option.`);
    return resolved;
  });
  if (new Set(prepared.map(factKey)).size !== prepared.length) fail('INVALID_INPUT', 'Ask about each subject once per interview.');
  return prepared;
}

/** One MCP elicitation form: required enum q{n}, optional q{n}_detail. */
export function formRequest(title, questions) {
  const properties = {}, required = [];
  for (const question of questions) {
    properties[`q${question.number}`] = { type: 'string', title: question.prompt, enum: question.options };
    required.push(`q${question.number}`);
    if (question.allowDetail) properties[`q${question.number}_detail`] = { type: 'string', title: 'Example (optional)', maxLength: 200 };
  }
  return { mode: 'form', message: title || 'A few quick questions', requestedSchema: { type: 'object', properties, required } };
}

/** Only explicitly selected options count; anything missing or outside the options stays unanswered. */
export function formAnswers(content, questions) {
  return questions.flatMap(question => {
    const answer = content?.[`q${question.number}`];
    if (typeof answer !== 'string' || !question.options.includes(answer)) return [];
    const detail = content[`q${question.number}_detail`];
    return [{ number: question.number, answer, ...(typeof detail === 'string' && detail.trim() ? { detail: detail.trim() } : {}) }];
  });
}

export function chatText(title, questions) {
  return [
    ...(title ? [title] : []),
    'Quick questions — reply like "1a 2c" (add ": example" after any answer if you like):',
    ...questions.map(question => `${question.number}. ${question.prompt}  ${question.options.map((option, index) => `${LETTERS[index]}) ${option}`).join('  ')}`),
  ].join('\n');
}

/**
 * Parses "1a 2c", "1a,2c", "1 a; 2 c" (original question numbers) or bare letters "a c b" (pending questions in order),
 * each optionally followed by ": detail". Unrecognised text is rejected rather than guessed.
 */
export function parseReply(reply, questions) {
  const pending = [...questions].sort((a, b) => a.number - b.number);
  const byNumber = new Map(pending.map(question => [question.number, question]));
  const numbered = /^\s*\d/.test(reply);
  const example = numbered || pending.length > 1
    ? pending.slice(0, 2).map((question, index) => `${question.number}${LETTERS[Math.min(index + 1, question.options.length - 1)]}`).join(' ')
    : 'a';
  const invalid = detail => fail('INVALID_INPUT', `${detail} Reply with the question number and option letter, e.g. "${example}" or "${example.split(' ')[0]}: example". Open questions: ${pending.map(question => question.number).join(', ')}.`);
  const pattern = numbered
    ? /(^|[\s,;])(\d{1,2})\s*([a-f])(?![\p{L}\p{N}])/giu
    : /(^|[\s,;])([a-f])(?=\s*(?:[:,;]|$)|\s+[a-f](?![\p{L}\p{N}]))/giu;
  const tokens = [];
  for (const match of reply.matchAll(pattern)) {
    const number = numbered ? Number(match[2]) : null;
    const letter = (numbered ? match[3] : match[2]).toLowerCase();
    if (numbered && !(byNumber.get(number)?.options.length > LETTERS.indexOf(letter))) continue;
    tokens.push({ number, letter, start: match.index + match[1].length, end: match.index + match[0].length });
  }
  if (!tokens.length || reply.slice(0, tokens[0].start).trim()) invalid('The reply has no recognisable answers.');
  if (!numbered) {
    if (tokens.length > pending.length) invalid(`There are only ${pending.length} open questions.`);
    tokens.forEach((token, index) => { token.number = pending[index].number; });
  }
  const answers = [];
  tokens.forEach((token, index) => {
    const question = byNumber.get(token.number);
    const option = question.options[LETTERS.indexOf(token.letter)];
    if (!option) invalid(`Question ${token.number} has no option ${token.letter}).`);
    if (answers.some(answer => answer.number === token.number)) invalid(`Question ${token.number} is answered twice.`);
    const rest = reply.slice(token.end, tokens[index + 1]?.start ?? reply.length).replace(/^[\s,;]+/, '');
    let detail = '';
    if (rest.startsWith(':')) detail = rest.slice(1).replace(/[\s,;]+$/, '').trim();
    else if (rest.trim()) invalid(`"${rest.trim().slice(0, 40)}" is not an answer.`);
    if (detail.length > 400) invalid('Keep each example under 400 characters.');
    answers.push({ number: token.number, answer: option, ...(detail ? { detail } : {}) });
  });
  return answers;
}

/** True for a stored pending interview with the expected shape. */
export function isInterview(interview) {
  return Boolean(interview) && typeof interview === 'object' && typeof interview.id === 'string' &&
    (interview.title === undefined || typeof interview.title === 'string') && typeof interview.createdAt === 'string' &&
    Array.isArray(interview.questions) && interview.questions.length > 0 && interview.questions.every(question =>
      question && Number.isInteger(question.number) && question.number > 0 && typeof question.subject === 'string' &&
      typeof question.prompt === 'string' && QUESTION_KINDS.includes(question.kind) && Array.isArray(question.options) &&
      question.options.length >= 2 && question.options.length <= LETTERS.length && question.options.every(option => typeof option === 'string'));
}
