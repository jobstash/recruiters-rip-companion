import { fail } from './state.mjs';
import { ANSWER_OPTIONS, ROLE_FACETS, assertCleanStatement, factKey } from './facts.mjs';

export const QUESTION_KINDS = Object.freeze(['capability', 'language', 'yes_no', 'choice', 'narrative']);
const LETTERS = 'abcdef';
const text = (maxLength, minLength = 1) => ({ type: 'string', minLength, maxLength, ...(minLength ? { pattern: '\\S' } : {}) });

export const questionSchema = Object.freeze({
  type: 'object', additionalProperties: false, required: ['subject', 'prompt', 'kind'],
  properties: {
    subject: text(120), prompt: text(300), kind: { enum: QUESTION_KINDS },
    options: { type: 'array', items: text(160), minItems: 2, maxItems: 6, uniqueItems: true },
    employer: text(120, 0), allowDetail: { type: 'boolean' },
    context: text(600, 0), factId: { type: 'string', format: 'uuid' }, followUp: text(300),
    roleId: { type: 'string', format: 'uuid' }, facet: { enum: ROLE_FACETS },
  },
  allOf: [{ if: { properties: { kind: { const: 'choice' } } }, then: { required: ['options'] }, else: { not: { required: ['options'] } } }],
});

/** Validates host questions and resolves each to its full answer list. */
export function prepareQuestions(questions) {
  const prepared = questions.map(question => {
    const options = question.kind === 'choice' ? question.options.map(option => option.trim()) : [...(ANSWER_OPTIONS[question.kind] ?? [])];
    const resolved = { subject: question.subject.trim(), prompt: question.prompt, kind: question.kind, options,
      ...(question.roleId ? { roleId: question.roleId } : {}), ...(question.facet ? { facet: question.facet } : {}),
      ...(question.employer?.trim() ? { employer: question.employer.trim() } : {}), ...(question.allowDetail ? { allowDetail: true } : {}),
      ...(question.context !== undefined ? { context: question.context } : {}),
      ...(question.factId ? { factId: question.factId } : {}), ...(question.followUp ? { followUp: question.followUp } : {}) };
    assertCleanStatement(resolved.subject, 'subject');
    if (resolved.employer) assertCleanStatement(resolved.employer, 'employer');
    for (const option of options) assertCleanStatement(option, 'option');
    if (new Set(options.map(option => option.toLocaleLowerCase())).size !== options.length) fail('INVALID_INPUT', `Question "${resolved.subject}" repeats an option.`);
    return resolved;
  });
  if (new Set(prepared.map(factKey)).size !== prepared.length) fail('INVALID_INPUT', 'Ask about each subject and role once per interview.');
  return prepared;
}

/** Optional fields permit partial replies; omitted permission never clears an existing restriction. */
export function formRequest(title, questions) {
  const properties = {}, required = [];
  for (const question of questions) {
    properties[`q${question.number}`] = question.stage === 'detail' || question.kind === 'narrative'
      ? { type: 'string', title: question.prompt, description: 'Answer in your own words; use skip or decline to decline, unknown if you do not know.', minLength: 1, maxLength: 8000 }
      : { type: 'string', title: question.prompt, enum: question.options };
    if (question.stage !== 'detail' && (question.allowDetail || question.kind === 'capability')) properties[`q${question.number}_detail`] = { type: 'string', title: 'What did you do, where, and what changed?', maxLength: 8000 };
    properties[`q${question.number}_publication`] = { type: 'string', title: 'May this answer appear in a CV or application?', enum: ['allowed', 'prohibited'] };
    properties[`q${question.number}_restrictedText`] = { type: 'string', title: 'If prohibited, copy exact text from your answer to keep private (one excerpt per line)', maxLength: 8000 };
  }
  return { mode: 'form', message: title || 'A few quick questions', requestedSchema: { type: 'object', properties, required } };
}

/** Only explicit whole-answer commands resolve a facet without an account of the work. */
export function answerResolution(answer) {
  if (/^\s*(?:skip|decline)\s*$/i.test(answer)) return 'declined';
  if (/^\s*unknown\s*$/i.test(answer)) return 'unknown';
  return 'answered';
}
/** Only explicitly selected options count; anything missing or outside the options stays unanswered. */
export function formAnswers(content, questions) {
  return questions.flatMap(question => {
    const answer = content?.[`q${question.number}`], value = content?.[`q${question.number}_publication`], restricted = content?.[`q${question.number}_restrictedText`];
    if (answer === undefined) {
      if (value !== undefined || restricted !== undefined) fail('INVALID_INPUT', 'Include the answer with its publication instruction.');
      return [];
    }
    if (typeof answer !== 'string' || !answer.trim()) fail('INVALID_INPUT', 'Provide a nonempty answer.');
    if (value !== undefined && !['allowed', 'prohibited'].includes(value)) fail('INVALID_INPUT', 'Choose allowed or prohibited for publication.');
    if (restricted !== undefined && (typeof restricted !== 'string' || value !== 'prohibited')) fail('INVALID_INPUT', 'Restricted excerpts require prohibited publication.');
    const publication = value === undefined ? undefined : { value,
      ...(restricted?.trim() ? { restrictedText: restricted.split(/\r?\n/).filter(text => text.trim()) } : {}) };
    if (question.stage === 'detail' || question.kind === 'narrative') return [{ number: question.number, answer, resolution: answerResolution(answer), ...(publication ? { publication } : {}) }];
    if (!question.options.includes(answer)) fail('INVALID_INPUT', 'Choose one of the offered answers.');
    const detail = content[`q${question.number}_detail`];
    if (detail !== undefined && typeof detail !== 'string') fail('INVALID_INPUT', 'The explanation must be text.');
    return [{ number: question.number, answer, ...(detail?.trim() ? { detail } : {}), ...(publication ? { publication } : {}) }];
  });
}

export function chatText(title, questions) {
  return [
    ...(title ? [title] : []),
    'Reply with numbered choices like "1a 2c", or "1: your account; 2: your account" for narrative questions. For one open narrative, plain text works. Use "skip" or "decline" to decline, "unknown" if you do not know, or "cancel" to close without resolving.',
    ...questions.map(question => question.stage === 'detail' || question.kind === 'narrative' ? `${question.number}. ${question.prompt}` : `${question.number}. ${question.prompt}  ${question.options.map((option, index) => `${LETTERS[index]}) ${option}`).join('  ')}`),
  ].join('\n');
}

/**
 * Parses "1a 2c", "1a,2c", "1 a; 2 c" (original question numbers) or bare letters "a c b" (pending questions in order),
 * each optionally followed by ": detail". Unrecognised text is rejected rather than guessed.
 */
export function parseReply(reply, questions) {
  if (/^\s*cancel\s*$/i.test(reply)) return [];
  if (/^\s*(skip|decline|unknown)\s*$/i.test(reply)) return questions.map(question => ({ number: question.number, answer: reply, resolution: answerResolution(reply) }));
  if (questions.some(question => question.stage === 'detail' || question.kind === 'narrative')) {
    if (questions.length === 1 && (questions[0].stage === 'detail' || questions[0].kind === 'narrative') && !/^\s*\d+\s*:/.test(reply)) {
      if (!reply.trim()) fail('INVALID_INPUT', 'Provide an answer or say skip.');
      if (questions[0].kind !== 'narrative' && /^\s*\d+\s*[a-f]\s*$/i.test(reply)) fail('INVALID_INPUT', 'Provide the requested explanation, not another option letter.');
      return [{ number: questions[0].number, answer: reply, resolution: answerResolution(reply) }];
    }
    const answers = [];
    for (const part of reply.split(/(?:;\s*|\n)(?=\d+\s*(?::|[a-f]\s*(?::|;|$)))/i)) {
      const match = /^\s*(\d+)\s*(?::\s*([\s\S]+)|([a-f])(?:\s*:\s*([\s\S]+))?)\s*$/i.exec(part);
      const question = match && questions.find(item => item.number === Number(match[1]));
      if (!question || answers.some(item => item.number === question.number)) fail('INVALID_INPUT', 'Use each open question number once, separating answers with semicolons.');
      if (match[2] && answerResolution(match[2]) !== 'answered') { answers.push({ number: question.number, answer: match[2], resolution: answerResolution(match[2]) }); continue; }
      if (question.stage === 'detail' || question.kind === 'narrative') {
        if (!match[2]?.trim()) fail('INVALID_INPUT', 'Use number: explanation for narrative questions.');
        answers.push({ number: question.number, answer: match[2], resolution: 'answered' });
      } else {
        const answer = match[3] && question.options[LETTERS.indexOf(match[3].toLowerCase())];
        if (!answer) fail('INVALID_INPUT', 'Use a numbered option letter for choice questions.');
        answers.push({ number: question.number, answer, ...(match[4] ? { detail: match[4].trim() } : {}) });
      }
    }
    return answers;
  }
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
    if (detail.length > 8000) invalid('Keep each example under 8000 characters.');
    answers.push({ number: token.number, answer: option, ...(detail ? { detail } : {}) });
  });
  return answers;
}
