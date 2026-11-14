export interface CvDocument {
  headline: string;
  summary: string;
  highlights?: string[];
  experience: Array<{ employer: string; role: string; location?: string; startDate: string; endDate: string; bullets: string[] }>;
  /**
   * Periods without work, in the candidate's own words: what they did, optionally where, and one line about it.
   * Never employment, but shown among the roles in date order with the same layout, so the timeline reads unbroken.
   */
  careerGaps?: Array<{ activity: string; place?: string; description?: string; startDate: string; endDate: string }>;
  education?: Array<{ institution: string; qualification?: string; startDate?: string; endDate?: string; details?: string }>;
  skills?: Array<{ label: string; items: string[] }>;
  languages?: Array<{ language: string; proficiency: string }>;
  certifications?: string[];
  additional?: Array<{ title: string; items: string[] }>;
}
/** Derived from the saved profile at render time, never authored in the document. */
export interface CvHeading {
  name?: string;
  contact?: string;
  location?: string;
}

export interface CvTextBlock {
  kind: "paragraph" | "bullet";
  text: string;
}
export interface CvExperienceBlock {
  kind: "experience";
  company: string;
  role: string;
  location?: string;
  dates?: string;
  items: CvTextBlock[];
}
export type CvDocumentBlock = CvTextBlock | CvExperienceBlock | { kind: "section"; title: string };
export interface CvPresentation {
  header: { name?: string; headline?: string; contactLines: string[] };
  blocks: CvDocumentBlock[];
}

const clean = (value: string | undefined): string => value?.trim() ?? "";
const dateRange = (start?: string, end?: string): string => [clean(start), clean(end)].filter(Boolean).join(" – ");

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/**
 * Where a date as CVs write it ("Mar 2019", "03/2019", "2019-03", "2019", "Present") falls, in months.
 * A year alone uses `yearOnlyMonth`; text without a year has no position.
 */
function monthPosition(value: string | undefined, yearOnlyMonth: number): number | null {
  const text = clean(value).toLowerCase();
  if (/^(present|current|now|today|ongoing)$/.test(text)) return Number.POSITIVE_INFINITY;
  const year = /(?<!\d)(?:19|20)\d{2}(?!\d)/.exec(text);
  if (!year) return null;
  const named = MONTHS.findIndex(month => text.includes(month));
  const numbered = /(?<!\d)(0?[1-9]|1[0-2])[/.-](?:19|20)\d{2}(?!\d)|(?<!\d)(?:19|20)\d{2}[/.-](0?[1-9]|1[0-2])(?!\d)/.exec(text);
  const month = named >= 0 ? named + 1 : numbered ? Number(numbered[1] ?? numbered[2]) : yearOnlyMonth;
  return Number(year[0]) * 12 + month - 1;
}

/** One conventional, ATS-safe reading order shared by the text and PDF renderers. */
export function buildStructuredCvPresentation(document: CvDocument, heading: CvHeading = {}): CvPresentation {
  const contact = [clean(heading.contact), clean(heading.location)].filter(Boolean).join(" · ");
  const blocks: CvDocumentBlock[] = [];
  const section = (title: string, content: CvDocumentBlock[]) => {
    if (content.length) blocks.push({ kind: "section", title }, ...content);
  };
  const bullets = (items: string[] = []): CvTextBlock[] => items.map(clean).filter(Boolean).map(text => ({ kind: "bullet", text }));
  section("Summary", clean(document.summary) ? [{ kind: "paragraph", text: clean(document.summary) }] : []);
  section("Key achievements", bullets(document.highlights));
  const timeline = document.experience.map(entry => ({
    // A role given only a start year began in January at the earliest.
    start: monthPosition(entry.startDate, 1), gap: false,
    block: {
      kind: "experience" as const, company: clean(entry.employer), role: clean(entry.role),
      ...(clean(entry.location) ? { location: clean(entry.location) } : {}),
      ...(dateRange(entry.startDate, entry.endDate) ? { dates: dateRange(entry.startDate, entry.endDate) } : {}),
      items: bullets(entry.bullets),
    },
  }));
  // A gap begins where the earlier role ended, so it sits above the first role that started before it. It fills the
  // same places as a role: the place where an employer stands (or the activity alone), the activity where a job
  // title stands, the dates, and the description as its one bullet.
  for (const entry of document.careerGaps ?? []) {
    const activity = clean(entry.activity), place = clean(entry.place);
    // A gap given only a year began in December at the latest, the same reading that decides whether it counts.
    const start = monthPosition(entry.startDate, 12);
    const earlier = start === null ? -1 : timeline.findIndex(item => !item.gap && item.start !== null && item.start < start);
    timeline.splice(earlier < 0 ? timeline.length : earlier, 0, {
      start, gap: true,
      block: {
        kind: "experience" as const, company: place || activity, role: place ? activity : "",
        ...(dateRange(entry.startDate, entry.endDate) ? { dates: dateRange(entry.startDate, entry.endDate) } : {}),
        items: bullets([entry.description ?? ""]),
      },
    });
  }
  section("Experience", timeline.map(item => item.block));
  section("Skills", (document.skills ?? []).filter(group => group.items.some(item => clean(item))).map(group => ({
    kind: "paragraph" as const, text: `${clean(group.label)}: ${group.items.map(clean).filter(Boolean).join(", ")}`,
  })));
  const languages = (document.languages ?? []).map(entry => `${clean(entry.language)} (${clean(entry.proficiency)})`);
  section("Languages", languages.length ? [{ kind: "paragraph", text: languages.join(" · ") }] : []);
  section("Education", (document.education ?? []).map(entry => ({
    kind: "experience" as const, company: clean(entry.institution), role: clean(entry.qualification),
    ...(dateRange(entry.startDate, entry.endDate) ? { dates: dateRange(entry.startDate, entry.endDate) } : {}),
    items: clean(entry.details) ? [{ kind: "paragraph" as const, text: clean(entry.details) }] : [],
  })));
  section("Certifications", bullets(document.certifications));
  for (const extra of document.additional ?? []) section(clean(extra.title), bullets(extra.items));
  return {
    header: {
      ...(clean(heading.name) ? { name: clean(heading.name) } : {}),
      ...(clean(document.headline) ? { headline: clean(document.headline) } : {}),
      contactLines: contact ? [contact] : [],
    },
    blocks,
  };
}
