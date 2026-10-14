export const ASSESSMENT_VERSION = 3;
export const PUBLICATION_DAYS = 7;
const PUBLICATION_WINDOW_MS = PUBLICATION_DAYS * 24 * 60 * 60 * 1000;
export const matchingProfileVersion = career => `${career.evidenceRevision ?? 0}:${career.rankingVersion ?? 0}`;

export function recentPublication(publishedAt, now = Date.now()) {
  const time = Date.parse(publishedAt);
  return Number.isFinite(time) && time >= now - PUBLICATION_WINDOW_MS && time <= now;
}

export function publicationWindow(now = Date.now()) {
  return { days: PUBLICATION_DAYS, since: new Date(now - PUBLICATION_WINDOW_MS).toISOString(), until: new Date(now).toISOString() };
}

export const CAREER_DIRECTION_POLICY = 'Evaluate career intent before capability. Derive the desired next move from this user’s current goals, preferences, constraints and explicitly accepted alternatives; never assume a profession, management ambition, progression path or preferred level of responsibility. Distinguish whether the user could perform the work from whether they want this kind of move. Compare the advertised remit with their intended direction using relevant dimensions such as responsibilities, autonomy, decision authority, specialisation, impact and people responsibility where applicable. A deliberate lateral move, career change or lower-scope search is valid and must be assessed against the chosen target, not penalised against the previous career. Mandatory conditions apply to every role, including accepted alternatives; broad interests do not waive narrower requirements. Distinguish the role’s predominant work from incidental duties according to the user’s own preference, and do not substitute adjacent activities or hypothetical future responsibility for a required responsibility. Where the user forbids regression, do not replace that constraint with technical familiarity or attractive job features. Preserve the boundaries of each accepted alternative: overlapping tasks, technologies, customer contact or ownership language do not by themselves make a role part of that alternative. Do not invent an exception or a future promotion. Titles alone neither establish nor disprove fit; use the full advertised responsibilities. Recommend only when the role serves the user’s intended move or a specifically accepted alternative and all mandatory conditions are supported. A demonstrated intent or scope conflict is skip, not recommend with a disclaimer; a genuinely unresolved decisive condition is clarify and stays outside recommendations. Do not ask the user to waive a clear constraint to populate a shortlist. Then assess capability, other preferences and eligibility. Score overall fit to the chosen target, not merely ability to perform the work. Explain the concrete intent-aligned remit that justifies a recommendation. Prestige, pay, location, novelty, skill overlap and scarcity of matches cannot override an explicit conflicting goal. If intent is unstated, do not invent a goal or prohibition; use the available preferences and ask only a material unresolved direction question.';

export const COMPETENCY_POLICY = 'Assess capability separately from whether the role serves the user’s career intent. Interpret the whole career and the responsibilities actually performed, not a checklist of exact CV phrases. Infer ordinary constituent duties where sustained work reasonably establishes them; do not demand a separate confirmation for every routine subtask. For example, repeated end-to-end delivery with customer discovery and prioritisation may establish routine discovery competence even when each interview technique is not named. Such inference establishes capability only; it does not authorise a different career direction or widen an accepted alternative. Do not invent a specific historical activity, metric, credential, management layer or specialist implementation expertise. Distinguish personal implementation, leading others and familiarity when the role requires a particular depth. Reserve clarification for a genuinely decisive gap that the broader record does not resolve. Express supported responsibility and capability directly in application materials without manufacturing historical examples.';

export const SALARY_POLICY = 'A positive saved salaryMinimum is a hard minimum, not an aspirational target. A comparable advertised fixed salary or range ceiling below it is a confirmed exclusion: skip with score 0, not recommend or clarify. Generic older notes that salary is not critical do not waive an explicit numeric minimum; change or clear that minimum only on a real candidate instruction. Do not assume negotiation, bonus or equity will bridge a stated shortfall. A range reaching the minimum may be considered, with the range tradeoff stated. Missing salary is not a rejection. Do not invent exchange rates, annual hours or workdays; mark non-comparable amounts as uncertain rather than claiming they meet the minimum.';

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
