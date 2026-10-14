export const ASSESSMENT_VERSION = 1;

export const COMPETENCY_POLICY = 'Assess capability at the responsibility level using the whole career: actual ownership, decisions, delivered products, workshops, customer work, analytics and seniority together. Infer ordinary constituent duties from demonstrated sustained scope; do not require a separate literal CV bullet for every routine subtask. End-to-end product ownership with discovery/design workshops, customer engagement and delivery supports routine product discovery, user interviews, usability validation, prioritisation and experimentation capability. Absence of those exact phrases is not a material gap, a reason to lower fit, or a candidate question. This is capability inference, not permission to invent a specific past study, A/B programme, vendor, metric, credential, management layer or implementation specialty. Reserve clarify for a genuinely decisive unknown that the broader record does not reasonably resolve. In CVs express supported responsibility/capability directly, cite the underlying scope privately, and do not manufacture historical examples.';

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
