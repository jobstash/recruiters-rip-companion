export interface CvDocument {
  headline: string;
  summary: string;
  highlights?: string[];
  experience: Array<{ employer: string; role: string; location?: string; startDate: string; endDate: string; bullets: string[] }>;
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
  section("Experience", document.experience.map(entry => ({
    kind: "experience" as const, company: clean(entry.employer), role: clean(entry.role),
    ...(clean(entry.location) ? { location: clean(entry.location) } : {}),
    ...(dateRange(entry.startDate, entry.endDate) ? { dates: dateRange(entry.startDate, entry.endDate) } : {}),
    items: bullets(entry.bullets),
  })));
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
