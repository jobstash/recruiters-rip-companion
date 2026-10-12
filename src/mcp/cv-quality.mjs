const bulletStart = /^\s*(?:[-*•‣▪–—]|\d+[.)])\s+/u;
const email = /[^\s@<>|]+@[^\s@<>|]+\.[\p{L}]{2,}/u;
// Deliberately literal opening-word check, not a grammatical or semantic assessment.
const actionVerbs = new Set('achieved advised analyzed automated built coached collaborated coordinated created delivered designed developed directed drove established expanded implemented improved increased launched led maintained managed mentored migrated negotiated optimized organized owned planned presented produced reduced resolved shipped streamlined supported trained transformed wrote'.split(' '));
const placeholders = [
  /\b(?:TODO|TBD)\b/gu,
  /\[(?:(?:insert|enter|replace|add)\s+[^\]\r\n]{1,80}|your\s+(?:name|email|phone|address|title|company|achievement|metric)|name|email|phone|address|company(?: name)?|job title|metric|achievement|placeholder|x(?:%| years?))\]/giu,
];
const wordCount = text => text.match(/\S+/gu)?.length ?? 0;

function blocks(entry) {
  const result = [];
  let lines = [], bullet = false;
  const flush = () => {
    if (lines.length) {
      const quote = lines.join('').trim();
      result.push({ entryId: entry.id, quote, bullet, text: bullet ? quote.replace(bulletStart, '') : quote });
    }
    lines = [];
  };
  // Retain original line endings so every diagnostic quote is an exact substring.
  for (const match of entry.text.matchAll(/[^\r\n\f]+(?:\r\n|[\r\n\f])?|[\r\n\f]/gu)) {
    const line = match[0];
    if (!line.trim()) { flush(); bullet = false; continue; }
    if (bulletStart.test(line)) { flush(); bullet = true; }
    lines.push(line);
  }
  flush();
  return result;
}

/**
 * Inspect current entry.text, never immutable entry.original. Missing contact
 * information is a check only: absence cannot have an exact source quote.
 * These mechanical editing hints do not assess ATS compatibility, job fit,
 * factual truth, or whether a CV has all necessary sections.
 * @param {{baseline: {entries: Array<{id: string, text: string}>}, heading?: {name?: string, contact?: string, location?: string}, renderedText?: string}} input
 * @returns {{checks: Array<{id: string, status: 'pass'|'warning', message: string, entryIds: string[]}>, issues: Array<{code: string, entryId: string, quote: string, message: string}>, disclaimer: string}}
 */
export function inspectCvQuality({ baseline, heading = {}, renderedText }) {
  const checks = [], issues = [];
  const allBlocks = baseline.entries.flatMap(blocks);
  const bullets = allBlocks.filter(block => block.bullet);
  const addIssue = (code, block, message) => issues.push({ code, entryId: block.entryId, quote: block.quote, message });
  const addCheck = (id, passMessage, warningMessage) => {
    const found = issues.filter(issue => issue.code === id);
    checks.push({ id, status: found.length ? 'warning' : 'pass', message: found.length ? warningMessage : passMessage,
      entryIds: [...new Set(found.map(issue => issue.entryId))] });
  };
  // Rendered text is authoritative when header overrides suppress old contacts.
  const contactEntries = baseline.entries.filter(entry => {
    const found = entry.text.match(email);
    return found && (renderedText === undefined || renderedText.includes(found[0]));
  });
  const hasEmail = renderedText === undefined
    ? email.test(heading.contact ?? '') || contactEntries.length > 0
    : email.test(renderedText);
  checks.push({ id: 'contact_email', status: hasEmail ? 'pass' : 'warning',
    message: hasEmail ? 'An email address is present in the heading or draft body; deliverability is not checked.' : 'No email address was found in the heading or draft body. Add a contact email if you want employers to reply by email.',
    entryIds: contactEntries.map(entry => entry.id) });

  for (const block of bullets) {
    const count = wordCount(block.text);
    if (count > 45) addIssue('long_bullet', block, `This bullet has ${count} words (more than 45). Consider splitting or shortening it without losing supported facts.`);
  }
  addCheck('long_bullet', 'No marked bullet exceeds 45 words.', 'Review the marked bullets longer than 45 words.');

  const repeated = new Map(), openings = new Map();
  for (const block of bullets) {
    const matches = repeated.get(block.text) ?? [];
    matches.push(block);
    repeated.set(block.text, matches);
    const opening = block.text.match(/^[\p{L}]+/u)?.[0].toLowerCase();
    if (actionVerbs.has(opening)) {
      const matches = openings.get(opening) ?? [];
      matches.push(block);
      openings.set(opening, matches);
    }
  }
  for (const matches of repeated.values()) if (matches.length > 1) {
    for (const block of matches) addIssue('repeated_bullet', block, `This exact bullet wording appears ${matches.length} times. Check whether each occurrence describes distinct work before editing.`);
  }
  addCheck('repeated_bullet', 'No exact repeated bullet wording was found.', 'Review repeated bullet wording; preserve distinct career history.');
  for (const [opening, matches] of openings) if (matches.length >= 3) {
    for (const block of matches) addIssue('repeated_action_verb', block, `${matches.length} bullets begin with “${opening}”. Consider a more specific opening where it remains faithful to the work.`);
  }
  addCheck('repeated_action_verb', 'No recognized opening action verb is repeated across three or more bullets.', 'Review action verbs repeated at the start of three or more bullets.');

  for (const entry of baseline.entries) for (const pattern of placeholders) for (const match of entry.text.matchAll(pattern)) {
    addIssue('placeholder_text', { entryId: entry.id, quote: match[0] }, 'Possible unfinished placeholder. Replace it with supported wording or remove the placeholder after reviewing its context.');
  }
  addCheck('placeholder_text', 'No TODO, TBD, or recognized bracket placeholder was found.', 'Review possible unfinished placeholders.');
  for (const block of allBlocks) {
    const count = wordCount(block.text);
    if (!block.bullet && count > 100) addIssue('dense_paragraph', block, `This paragraph has ${count} words (more than 100). Consider shorter paragraphs or evidence-grounded bullets for readability.`);
  }
  addCheck('dense_paragraph', 'No paragraph exceeds 100 words.', 'Review paragraphs longer than 100 words.');
  return { checks, issues,
    disclaimer: 'Mechanical checks of the current draft only, not an ATS score, semantic fit assessment, or verification of claims. Warnings are editing prompts; a pass does not establish completeness or correctness.' };
}

const currency = '(?:USD|EUR|GBP|CAD|AUD|NZD|JPY|CNY|INR|CHF|SEK|NOK|DKK|PLN|BRL|ZAR|SGD|HKD|[$€£¥₹₩₽])';
const magnitude = '(?:thousand|million|billion|trillion|[kKmMbB])';
// Units are case-sensitive: MB and Mb, for example, must not become equivalent.
const unit = '(?:milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?|years?|users?|customers?|people|employees?|reports?|projects?|teams?|locations?|countries|bps|ms|ns|kg|km|cm|mm|GB|Gb|MB|Mb|KB|kB|TB|Hz|kHz|MHz|GHz|°C|°F|s|h|x|×)';
const number = '(?:[.,]\\d+|\\d+(?:(?:[.,\'/:\\-]\\d+)|(?: \\d{3}(?!\\d)))*)';
const numericValue = new RegExp(number, 'u');
const numericClaim = new RegExp(`(?<![\\p{L}\\p{N}_@.])(?:${currency} *)?[+-]?${number}(?: *${magnitude}(?![\\p{L}\\p{N}_]))?(?: *%| *${unit}(?![\\p{L}\\p{N}_]))?\\+?(?: *${currency}(?![\\p{L}\\p{N}_]))?(?![\\p{L}\\p{N}_]|[.,:/\\-]\\d)`, 'gu');

function normalizeNumber(value) {
  // Do not parse through Number: large integers must retain their exact digits.
  if (/^\d{1,3}([ '])\d{3}(?:\1\d{3})*(?:[.,]\d+)?$/u.test(value)) return value.replace(/[ ']/gu, '').replace(',', '.');
  if (/^[1-9]\d{0,2}(?:,\d{3})+(?:\.\d+)?$/u.test(value)) return value.replace(/,/gu, '');
  if (/^\d{1,3}(?:\.\d{3})+,\d+$/u.test(value)) return value.replace(/\./gu, '').replace(',', '.');
  if (/^\d{1,3}(?:\.\d{3}){2,}$/u.test(value)) return value.replace(/\./gu, '');
  if (/^\d+,\d{1,2}$/u.test(value) || /^\d+,\d{4,}$/u.test(value) || /^0,\d+$/u.test(value)) return value.replace(',', '.');
  // A lone dot remains decimal; a lone comma followed by three digits is
  // grouping only when it matches the grouping rule above. Ambiguous or mixed
  // forms otherwise remain literal rather than silently changing their value.
  return value;
}

function numericTokens(text) {
  const normalized = text.normalize('NFKC').replace(/[\u2010-\u2015\u2212]/gu, '-').replace(/[\u2018\u2019]/gu, "'")
    .replace(/[^\S\r\n]/gu, ' ').replace(/(?<=\d) *([-/:]) *(?=\d)/gu, '$1');
  const tokens = [];
  for (const match of normalized.matchAll(numericClaim)) {
    const raw = match[0];
    // Do not extract metrics from prefixed technical identifiers (ISO-27001,
    // v2.3, B2B) or dotted version literals. Numeric dates remain whole tokens.
    if (/[\p{L}_][\p{L}\p{N}_]*-$/u.test(normalized.slice(0, match.index))) continue;
    if (/^\d+(?:\.\d+){2,}$/u.test(raw) && !/^\d{1,2}\.\d{1,2}\.\d{4}$/u.test(raw) && !/^\d{1,3}(?:\.\d{3}){2,}$/u.test(raw)) continue;
    const token = raw.replace(numericValue, normalizeNumber).replace(/ /gu, '');
    // Whitespace and typographic dashes are irrelevant; currency, percent,
    // magnitude and unit spelling remain part of the claim token.
    tokens.push(token);
  }
  return tokens;
}

/**
 * Return unique normalized numeric expressions absent from supportingTexts.
 * Supply only original candidate wording and referenced candidate facts/quotes,
 * never a job advertisement. Matching a token is NOT proof that a claim is true
 * or that the surrounding statement has support. This conservative mechanical
 * guard does not infer unit conversions, locale, spelled-out numbers, semantic
 * equivalence, or associations between a number and a particular achievement.
 * Currency/percent/magnitude/unit qualifiers remain significant; ambiguous
 * formats can require the host to retain the evidence's exact numeric wording.
 * @param {string} text
 * @param {string[]} supportingTexts
 * @returns {string[]}
 */
export function unsupportedNumbers(text, supportingTexts) {
  const supported = new Set(supportingTexts.flatMap(numericTokens));
  return [...new Set(numericTokens(text))].filter(token => !supported.has(token));
}
