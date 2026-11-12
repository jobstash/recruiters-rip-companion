// How generated CVs, cover letters and answers should read: like the candidate wrote them. The rules are adapted
// from the humanizer skill (https://github.com/blader/humanizer, MIT), which is built on Wikipedia's
// "Signs of AI writing". The host writes; Companion states the rules and points out wording that still reads as AI.

export const WRITING_STYLE = [
  'Write the way the candidate would write, so the CV and letter do not read as AI-generated (rules adapted from the humanizer skill, github.com/blader/humanizer).',
  'State each point directly. Avoid contrasts that only add weight ("not just X but Y", "it’s not X, it’s Y"), one-line closers, rhetorical questions and openers such as "In today’s fast-paced world".',
  'Use plain verbs: led, built, ran, wrote, cut, is, has. Avoid spearheaded, leveraged, utilized, showcased, fostered, served as and orchestrated.',
  'Leave out inflated and sales words: pivotal, testament, passionate, cutting-edge, world-class, best-in-class, seamless, results-driven, proven track record, synergy, dynamic professional. In a letter, skip generic enthusiasm ("I am thrilled", "dream role") and say what the candidate did that fits.',
  'Use as many items as the evidence has instead of forcing lists of three. Use commas, colons or full stops instead of em dashes. Vary sentence length and openings.',
  'Plainer wording never drops evidence: keep every supported fact, name, number and date. Save responses include notes for wording that still reads as AI-written; rewrite those lines without asking the candidate.',
].join(' ');

// High-confidence tells only: words and constructions a careful CV writer rarely chooses, so a note is worth acting on.
const TELLS = [
  [/\bspearhead(?:ed|ing|s)?\b/giu, 'led'],
  [/\bleverag(?:e|ed|es|ing)\b/giu, 'used'],
  [/\butili[sz](?:e|ed|es|ing|ation)\b/giu, 'used'],
  [/\bsynerg(?:y|ies|istic)\b/giu, null],
  [/\bshowcas(?:e|ed|es|ing)\b/giu, 'showed'],
  [/\bfoster(?:ed|ing|s)?\b/giu, 'built'],
  [/\borchestrat(?:e|ed|es|ing)\b/giu, 'ran'],
  [/\bdelv(?:e|ed|es|ing)\b/giu, null],
  [/\bpivotal\b/giu, null],
  [/\btestament\b/giu, null],
  [/\btapestry\b/giu, null],
  [/\bmeticulous(?:ly)?\b/giu, null],
  [/\bunderscor(?:e|ed|es|ing)\b/giu, null],
  [/\bpassionate\b/giu, null],
  [/\bresults[- ]driven\b/giu, null],
  [/\bproven track record\b/giu, null],
  [/\bcutting[- ]edge\b/giu, null],
  [/\b(?:world|best)[- ]in[- ]class\b|\bworld[- ]class\b/giu, null],
  [/\bseamless(?:ly)?\b/giu, null],
  [/\bgame[- ]chang(?:er|ing)\b/giu, null],
  [/\bthrilled\b/giu, null],
  [/\bdream (?:role|job|company)\b/giu, null],
  [/\bfast[- ]paced world\b/giu, null],
  [/\bnot (?:just|only|merely)\b/giu, null],
];

/**
 * Wording that reads as AI-written, one note per text field. `items` are {field, text}; date fields are skipped.
 * @returns {Array<{code: 'ai_wording', field: string, message: string}>}
 */
export function writingTells(items) {
  const notes = [];
  for (const item of items) {
    if (item.date || item.setting || typeof item.text !== 'string') continue;
    const found = [];
    for (const [pattern, plain] of TELLS) for (const match of item.text.matchAll(pattern))
      found.push(plain ? `“${match[0]}” (try “${plain}”)` : `“${match[0]}”`);
    // A dash is an ordinary separator in a headline, job title or name; in sentences it is a tell.
    const sentence = !/(?:^headline|\.(?:employer|role|location|institution|qualification|label|title))$/.test(item.field);
    if (sentence && /[—]|\s--\s/u.test(item.text)) found.push('a dash (use a comma, colon or full stop)');
    if (found.length) notes.push({ code: 'ai_wording', field: item.field,
      message: `This reads as AI-written: ${[...new Set(found)].join(', ')}. Say it plainly, keeping every fact.` });
  }
  return notes;
}
