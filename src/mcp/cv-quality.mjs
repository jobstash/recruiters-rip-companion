const email = /[^\s@<>|]+@[^\s@<>|]+\.[\p{L}]{2,}/u;
// Deliberately literal opening-word check, not a grammatical or semantic assessment.
const actionVerbs = new Set('achieved advised analyzed automated built coached collaborated coordinated created delivered designed developed directed drove established expanded implemented improved increased launched led maintained managed mentored migrated negotiated optimized organized owned planned presented produced reduced resolved shipped streamlined supported trained transformed wrote'.split(' '));
const placeholders = [
  /\b(?:TODO|TBD)\b/gu,
  /\[(?:(?:insert|enter|replace|add)\s+[^\]\r\n]{1,80}|your\s+(?:name|email|phone|address|title|company|achievement|metric)|name|email|phone|address|company(?: name)?|job title|metric|achievement|placeholder|x(?:%| years?))\]/giu,
];
const wordCount = text => text.match(/\S+/gu)?.length ?? 0;

/**
 * Every authored text field of a structured CvDocument, in reading order.
 * `bullet` marks list items; `date` marks structured date fields.
 * @returns {Array<{field: string, text: string, bullet?: boolean, date?: boolean}>}
 */
export function cvDocumentTexts(document) {
  const texts = [{ field: 'headline', text: document.headline }, { field: 'summary', text: document.summary }];
  const add = (field, text, extra = {}) => { if (typeof text === 'string') texts.push({ field, text, ...extra }); };
  (document.highlights ?? []).forEach((text, index) => add(`highlights[${index}]`, text, { bullet: true }));
  document.experience.forEach((entry, index) => {
    const at = `experience[${index}]`;
    for (const key of ['employer', 'role', 'location']) add(`${at}.${key}`, entry[key]);
    for (const key of ['startDate', 'endDate']) add(`${at}.${key}`, entry[key], { date: true });
    entry.bullets.forEach((text, bullet) => add(`${at}.bullets[${bullet}]`, text, { bullet: true }));
  });
  (document.education ?? []).forEach((entry, index) => {
    for (const key of ['institution', 'qualification', 'details']) add(`education[${index}].${key}`, entry[key]);
    for (const key of ['startDate', 'endDate']) add(`education[${index}].${key}`, entry[key], { date: true });
  });
  (document.skills ?? []).forEach((group, index) => {
    add(`skills[${index}].label`, group.label);
    group.items.forEach((text, item) => add(`skills[${index}].items[${item}]`, text));
  });
  (document.languages ?? []).forEach((entry, index) => {
    add(`languages[${index}].language`, entry.language);
    add(`languages[${index}].proficiency`, entry.proficiency);
  });
  (document.certifications ?? []).forEach((text, index) => add(`certifications[${index}]`, text, { bullet: true }));
  (document.additional ?? []).forEach((section, index) => {
    add(`additional[${index}].title`, section.title);
    section.items.forEach((text, item) => add(`additional[${index}].items[${item}]`, text, { bullet: true }));
  });
  return texts;
}

/**
 * Non-blocking editing notes for a structured CV: contact, length, repetition
 * and placeholders. These are mechanical hints for the host to fix silently,
 * not an ATS score, fit assessment or verification of claims.
 * @param {{document: object, heading?: {name?: string, contact?: string, location?: string}}} input
 * @returns {Array<{code: string, field: string, message: string}>}
 */
export function inspectCvQuality({ document, heading = {} }) {
  const issues = [];
  const texts = cvDocumentTexts(document);
  const bullets = texts.filter(item => item.bullet);
  if (!email.test(heading.contact ?? '')) issues.push({ code: 'missing_email', field: 'header',
    message: 'The profile has no email address, so the CV header has none. Save one with career_profile_update if the candidate shared it.' });
  if (!heading.name?.trim()) issues.push({ code: 'missing_name', field: 'header',
    message: 'The profile has no name, so the CV header has none. Save it with career_profile_update.' });

  const summaryWords = wordCount(document.summary);
  if (summaryWords > 100) issues.push({ code: 'long_summary', field: 'summary', message: `The summary has ${summaryWords} words; keep it to 2–4 sentences.` });
  for (const item of bullets) {
    const count = wordCount(item.text);
    if (count > 45) issues.push({ code: 'long_bullet', field: item.field, message: `This bullet has ${count} words (more than 45); split or tighten it.` });
  }
  const totalWords = texts.reduce((sum, item) => sum + wordCount(item.text), 0);
  if (totalWords > 1100) issues.push({ code: 'long_document', field: 'document', message: `The CV has ${totalWords} words; condense older or less relevant roles.` });

  const repeated = new Map(), openings = new Map();
  for (const item of bullets) {
    const key = item.text.trim().toLocaleLowerCase('en');
    repeated.set(key, [...(repeated.get(key) ?? []), item]);
    const opening = item.text.match(/^\s*([\p{L}]+)/u)?.[1].toLowerCase();
    if (actionVerbs.has(opening)) openings.set(opening, [...(openings.get(opening) ?? []), item]);
  }
  for (const matches of repeated.values()) if (matches.length > 1) {
    for (const item of matches) issues.push({ code: 'repeated_bullet', field: item.field, message: `This bullet wording appears ${matches.length} times; make each one distinct.` });
  }
  for (const [opening, matches] of openings) if (matches.length >= 3) {
    for (const item of matches) issues.push({ code: 'repeated_action_verb', field: item.field, message: `${matches.length} bullets begin with “${opening}”; vary the opening verb.` });
  }
  for (const item of texts) for (const pattern of placeholders) for (const match of item.text.matchAll(pattern)) {
    issues.push({ code: 'placeholder_text', field: item.field, message: `Unfinished placeholder “${match[0]}”; replace it with real content or remove it.` });
  }
  return issues;
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
 * Supply only saved career facts and profile values, never a job
 * advertisement. Matching a token is NOT proof that a claim is true
 * or that the surrounding statement has support. This conservative mechanical
 * guard does not infer unit conversions, locale, spelled-out numbers, semantic
 * equivalence, or associations between a number and a particular achievement.
 * Currency/percent/magnitude/unit qualifiers remain significant; ambiguous
 * formats can require the host to retain the fact's exact numeric wording.
 * @param {string} text
 * @param {string[]} supportingTexts
 * @returns {string[]}
 */
export function unsupportedNumbers(text, supportingTexts) {
  const supported = new Set(supportingTexts.flatMap(numericTokens));
  return [...new Set(numericTokens(text))].filter(token => !supported.has(token));
}
