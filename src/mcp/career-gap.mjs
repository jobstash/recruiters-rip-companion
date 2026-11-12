import { fail } from './state.mjs';

/** What a gap entry says until the candidate writes their own: what they did, and one line about it. */
export const CAREER_GAP_ACTIVITY = 'Career break';
export const CAREER_GAP_PRIVATE_TEXT = 'Career gap period - private reasons';
export const CAREER_GAP_MIN_MONTHS = 3;
export const CAREER_GAP_MAX_MONTHS = 120;
export const CAREER_GAP_FIRST_YEAR = 1950;
export const CAREER_GAP_LAST_YEAR = 2100;
export const CAREER_GAP_DEFAULT_YEARS = 10;
export const CAREER_GAP_NAME_LIMIT = 80;
export const CAREER_GAP_TEXT_LIMIT = 200;
export const CAREER_GAP_LIMIT = 5;
const KEYS = 'activity,description,enabled,fromYear,minMonths,place,toYear';
const MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
const POINT = /^(\d{4})(?:-(0[1-9]|1[0-2]))?$(?![\s\S])/;
const point = { type: 'string', pattern: '^\\d{4}(-(0[1-9]|1[0-2]))?$' };

/** What the host may author: the period only. Companion supplies the wording from the candidate's setting. */
export const careerGapsSchema = Object.freeze({
  type: 'array', minItems: 1, maxItems: CAREER_GAP_LIMIT,
  items: { type: 'object', additionalProperties: false, required: ['start', 'end'], properties: {
    start: { ...point, description: 'When the previous role ended: YYYY-MM, or YYYY when the CV gives only the year.' },
    end: { anyOf: [point, { const: 'present' }], description: 'When the next role began: YYYY-MM or YYYY; "present" for a gap that is still open.' },
  } },
});

/**
 * Off by default. A gap counts when it lasts at least `minMonths` and touches the years `fromYear`–`toYear`.
 * `activity`, `place` and `description` are the candidate's own words for the entry: what they did, where, and one
 * line about it. The entry is laid out like a role, so it has the same parts; its dates come from the saved CV.
 */
export function assertCareerGapSetting(input) {
  const choose = 'Choose whether to detect career gaps, the years to check, their minimum length, and the activity, place and description to show.';
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join() !== KEYS) fail('INVALID_INPUT', choose);
  const { enabled, minMonths, fromYear, toYear } = input;
  if (typeof enabled !== 'boolean' || ![input.activity, input.place, input.description].every(value => typeof value === 'string')) fail('INVALID_INPUT', choose);
  if (!Number.isInteger(minMonths) || minMonths < CAREER_GAP_MIN_MONTHS || minMonths > CAREER_GAP_MAX_MONTHS)
    fail('INVALID_INPUT', `A career gap is at least ${CAREER_GAP_MIN_MONTHS} months. Choose ${CAREER_GAP_MIN_MONTHS} to ${CAREER_GAP_MAX_MONTHS} months.`);
  if (![fromYear, toYear].every(year => Number.isInteger(year) && year >= CAREER_GAP_FIRST_YEAR && year <= CAREER_GAP_LAST_YEAR))
    fail('INVALID_INPUT', `Choose the years to check, from ${CAREER_GAP_FIRST_YEAR} to ${CAREER_GAP_LAST_YEAR}.`);
  if (fromYear > toYear) fail('INVALID_INPUT', 'The first year to check must not be after the last year.');
  const line = (value, name, limit) => {
    const text = value.trim();
    if (/[\u0000-\u001f\u007f\u2028\u2029]/u.test(text) || text.length > limit) fail('INVALID_INPUT', `Write the career gap ${name} on one line, up to ${limit} characters.`);
    return text;
  };
  const activity = line(input.activity, 'activity', CAREER_GAP_NAME_LIMIT), place = line(input.place, 'place', CAREER_GAP_NAME_LIMIT);
  const description = line(input.description, 'description', CAREER_GAP_TEXT_LIMIT);
  if (!activity) fail('INVALID_INPUT', 'Write the activity to show for a career gap, such as Career break.');
  return { enabled, activity, place, description, minMonths, fromYear, toYear };
}

// 3.12.29 and 3.12.30 saved one line of wording. It becomes the description of a "Career break" entry,
// so a setting or backup from those versions keeps working.
const EARLIER_KEYS = 'enabled,fromYear,minMonths,mode,text,toYear';
const fromEarlierVersion = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === EARLIER_KEYS
  ? { enabled: value.enabled, minMonths: value.minMonths, fromYear: value.fromYear, toYear: value.toYear, activity: CAREER_GAP_ACTIVITY, place: '',
    description: value.mode === 'custom' && typeof value.text === 'string' && value.text.trim() ? value.text : CAREER_GAP_PRIVATE_TEXT }
  : value;
/** A stored setting in the current shape; throws when it is neither current nor from an earlier version. */
export const readCareerGapSetting = value => assertCareerGapSetting(fromEarlierVersion(value));

/** The saved setting; with none (or an unreadable one) saved: off, three months, the past ten years. */
export function savedCareerGap(career, now = new Date()) {
  try { return readCareerGapSetting(career?.careerGap); }
  catch {
    const year = now.getFullYear();
    return { enabled: false, activity: CAREER_GAP_ACTIVITY, place: '', description: CAREER_GAP_PRIVATE_TEXT,
      minMonths: CAREER_GAP_MIN_MONTHS, fromYear: year - CAREER_GAP_DEFAULT_YEARS, toYear: year };
  }
}

/** Saving a different setting changes what generated CVs contain, so hosts must reread before their next mutation. */
export function setCareerGap(career, input) {
  const next = assertCareerGapSetting(input);
  if (JSON.stringify(savedCareerGap(career)) !== JSON.stringify(next)) career.revision = (career.revision ?? 0) + 1;
  career.careerGap = next;
  return next;
}

/** The candidate's words for an entry; empty parts are left out. */
const careerGapWording = ({ activity, place, description }) => ({ activity, ...(place ? { place } : {}), ...(description ? { description } : {}) });

/** Bound into application fingerprints only while on, so profiles that never enable it keep their documents. */
export function careerGapBinding(career) {
  const setting = savedCareerGap(career);
  return setting.enabled ? { ...careerGapWording(setting), minMonths: setting.minMonths, fromYear: setting.fromYear, toYear: setting.toYear } : null;
}

/** Model-facing instruction, present only while the candidate has the setting on. */
export function careerGapContext(career) {
  const binding = careerGapBinding(career);
  if (!binding) return null;
  const { minMonths, fromYear, toYear, activity, place, description } = binding;
  const wording = [`activity "${activity}"`, ...(place ? [`place "${place}"`] : []), ...(description ? [`description "${description}"`] : [])].join(', ');
  return { ...binding, instruction: [
    'The candidate chose to show career gaps in generated CVs.',
    `Compare consecutive roles in the saved CV. Where one role ends and the next begins ${minMonths} or more months later, or the most recent role ended ${minMonths} or more months ago with nothing after it, and any part of that period falls in ${fromYear}–${toYear}, add it to cv.careerGaps as {start, end}: start is when the earlier role ended and end is when the later role began, as YYYY-MM (YYYY when the CV gives only years), with end "present" for a gap that is still open.`,
    `Supply only the period. Companion lists each one in the Experience section in date order, laid out like a role, in the candidate's own words: ${wording}.`,
    'A career gap is never employment: do not add it to cv.experience yourself, give it an employer, job title, duties or achievements, count it as work experience, or explain or embellish it elsewhere in the CV or cover letter beyond what saved facts state.',
    `Add no careerGaps when the saved CV shows no such period; at most ${CAREER_GAP_LIMIT}.`,
  ].join(' ') };
}

const monthIndex = (year, month) => year * 12 + month - 1;
const display = value => {
  if (value === 'present') return 'Present';
  const [, year, month] = POINT.exec(value);
  return month ? `${MONTHS[Number(month) - 1]} ${year}` : year;
};

/**
 * Turn host-authored periods into rendered entries. Year-only dates count as the
 * shortest period they can mean (December to January), so the minimum is never met by guesswork.
 * @returns {Array<{activity: string, place?: string, description?: string, startDate: string, endDate: string}>|undefined} most recent first
 */
export function resolveCareerGaps(career, gaps, now = new Date()) {
  if (gaps === undefined) return undefined;
  const setting = savedCareerGap(career, now);
  if (!setting.enabled) fail('CAREER_GAPS_OFF', 'The candidate has not turned on career gaps in generated CVs. Leave cv.careerGaps out.');
  if (!Array.isArray(gaps) || !gaps.length || gaps.length > CAREER_GAP_LIMIT)
    fail('INVALID_INPUT', `cv.careerGaps lists 1 to ${CAREER_GAP_LIMIT} periods; leave it out when there is none.`);
  const today = monthIndex(now.getFullYear(), now.getMonth() + 1), wording = careerGapWording(setting), seen = new Set();
  return gaps.map((gap, index) => {
    const at = `careerGaps[${index}]`;
    const start = typeof gap?.start === 'string' ? POINT.exec(gap.start) : null;
    const end = gap?.end === 'present' ? 'present' : typeof gap?.end === 'string' ? POINT.exec(gap.end) : null;
    if (!start || !end || Object.keys(gap).sort().join() !== 'end,start')
      fail('INVALID_INPUT', `${at}: give only start and end as YYYY-MM or YYYY; end may be "present".`);
    const startYear = Number(start[1]), endYear = end === 'present' ? now.getFullYear() : Number(end[1]);
    const from = monthIndex(startYear, start[2] ? Number(start[2]) : 12);
    const to = end === 'present' ? today : monthIndex(endYear, end[2] ? Number(end[2]) : 1);
    if (startYear < CAREER_GAP_FIRST_YEAR || from > today || to > today) fail('INVALID_INPUT', `${at}: the period must lie in the past.`);
    const months = to - from;
    if (months < setting.minMonths)
      fail('CAREER_GAP_TOO_SHORT', `${at}: ${gap.start} to ${gap.end} is ${months < 0 ? 'not a forward period' : `${months} month${months === 1 ? '' : 's'}`}${start[2] && (end === 'present' || end[2]) ? '' : ' at the shortest reading of year-only dates'}; the candidate counts a career gap from ${setting.minMonths} months. Leave it out.`);
    if (startYear > setting.toYear || endYear < setting.fromYear)
      fail('CAREER_GAP_OUT_OF_RANGE', `${at}: ${gap.start} to ${gap.end} lies outside ${setting.fromYear}–${setting.toYear}, the years the candidate checks for career gaps. Leave it out.`);
    const key = `${gap.start}|${gap.end}`;
    if (seen.has(key)) fail('INVALID_INPUT', `${at}: this period is listed twice.`);
    seen.add(key);
    return { from, entry: { ...wording, startDate: display(gap.start), endDate: display(gap.end) } };
  }).sort((a, b) => b.from - a.from).map(item => item.entry);
}
