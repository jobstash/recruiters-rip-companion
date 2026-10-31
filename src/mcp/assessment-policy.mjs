export const PUBLICATION_DAYS = 7;
const PUBLICATION_WINDOW_MS = PUBLICATION_DAYS * 24 * 60 * 60 * 1000;
export const matchingProfileVersion = career => `${career.evidenceRevision ?? 0}:${career.rankingVersion ?? 0}`;

// Without these the agent cannot judge role direction, location or work-mode fit, so every scan and
// review would be spent on guesses. Onboarding asks for each one before any catalogue work; answers live in the vault.
export const ESSENTIAL_PREFERENCES = Object.freeze({
  careerPaths: 'Which of these career paths should I search? Confirm, drop or add any.',
  locations: 'Where are you based, and which countries or cities can you work from?',
  workModes: 'Which work modes suit you: remote, hybrid, onsite?',
  willingToRelocate: 'Would you relocate for the right role?',
  travel: 'How much work travel is acceptable: none, occasional, frequent or any?',
});
// Career paths are proposed from the whole record, never asked open-ended or narrowed to one named title.
export const CAREER_PATHS_GUIDE = 'Before asking about careerPaths, read every current CV end to end (career_source_read, following nextOffset) and every saved fact (career_facts_list): each role, employer size and type, industry, client-facing and commercial work, budgets, team sizes, languages, founder and freelance history. Then propose every career path with good success chances the evidence supports: current trajectory, step-up, adjacent functions, agency, consultancy and enterprise variants, supported sector pivots, and fractional, interim or founder-style roles. Give each a name, concrete titles including seniority variants and common synonyms, and a one-sentence why citing the evidence. Never narrow to the one title the candidate named or misstate the profile. Ask the candidate to confirm, drop or add paths in the same message as any other missing question, then save every confirmed path with career_preferences_update and start the search.';
const unanswered = value => value === null || value === undefined || (Array.isArray(value) && !value.length) || (typeof value === 'string' && !value.trim());
export const missingPreferences = career => Object.keys(ESSENTIAL_PREFERENCES).filter(field => unanswered(career.profile?.preferences?.[field]));

export function recentPublication(publishedAt, now = Date.now()) {
  const time = Date.parse(publishedAt);
  return Number.isFinite(time) && time >= now - PUBLICATION_WINDOW_MS && time <= now;
}

export function publicationWindow(now = Date.now()) {
  return { days: PUBLICATION_DAYS, since: new Date(now - PUBLICATION_WINDOW_MS).toISOString(), until: new Date(now).toISOString() };
}

const amount = value => Number.isFinite(value) && value >= 0 ? value : null;
const annualFactor = period => period === 'year' ? 1 : period === 'month' ? 12 : null;

/** Deterministic compensation eligibility, never a professional-fit scoring formula. */
export function salaryEligibility(preferences = {}, salary) {
  const minimum = amount(preferences.salaryMinimum);
  if (minimum === null || minimum === 0) return { status: 'not_required' };
  const currency = preferences.salaryCurrency?.trim().toUpperCase();
  const period = preferences.salaryPeriod?.trim().toLowerCase();
  const requirement = { minimum, currency: currency || null, period: period || null };
  if (!salary || typeof salary !== 'object') return { ...requirement, status: 'not_stated' };
  const lower = amount(salary.minimum) ?? amount(salary.stated);
  const upper = amount(salary.maximum) ?? amount(salary.stated);
  if (lower === null && upper === null) return { ...requirement, status: 'not_stated' };
  const offeredCurrency = salary.currency?.trim().toUpperCase();
  const offeredPeriod = salary.period?.trim().toLowerCase();
  if (!currency || !period || offeredCurrency !== currency || !offeredPeriod ||
      (lower !== null && upper !== null && lower > upper))
    return { ...requirement, status: 'not_comparable' };
  let factor = 1;
  if (offeredPeriod !== period) {
    const offeredFactor = annualFactor(offeredPeriod), requiredFactor = annualFactor(period);
    if (offeredFactor === null || requiredFactor === null) return { ...requirement, status: 'not_comparable' };
    factor = offeredFactor / requiredFactor;
  }
  if (upper !== null) return { ...requirement, upperBound: upper * factor,
    status: upper * factor < minimum ? 'below_minimum' : 'range_can_meet_minimum' };
  return { ...requirement, lowerBound: lower * factor,
    status: lower * factor >= minimum ? 'meets_minimum' : 'unbounded_range' };
}
