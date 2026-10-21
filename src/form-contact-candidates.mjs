// These are bounded excerpts for semantic selection, not asserted contact facts.
const MAX_CANDIDATES = 40;
const OTHER_CONTACT = /\b(?:references?|referees?|referrers?|employer contact|company contact|manager contact|supervisor contact|recruiter contact|emergency contact)\b/i;
const SECTION = /^(?:experience|employment|work history|education|skills|projects|publications|references?|referees?)\b/i;
const NAME_WORD = /[\p{L}\p{M}]+(?:['’.-][\p{L}\p{M}]+)*\.?/gu;

export function contactCandidates(career) {
  const candidates = [];
  let nameCandidates = 0;
  const add = (text, start, end, source, contactKeys, kind, contextStart = Math.max(0, start - 180), contextEnd = Math.min(text.length, end + 180)) => {
    if (candidates.length >= MAX_CANDIDATES || end <= start || end - start > 300) return;
    const value = text.slice(start, end);
    if (candidates.some(item => item.source === source && item.value === value && item.kind === kind)) return;
    const isName = kind === 'name part' || kind === 'full name' || kind === 'firstName' || kind === 'lastName';
    if (isName && nameCandidates >= 24) return;
    if (isName) nameCandidates++;
    candidates.push({ label: `Possible ${kind}`, value, source, contactKeys, kind,
      qualifiers: { status: 'Unverified excerpt; select only if context establishes applicant ownership and the requested meaning.',
        kind: kind === 'name part' ? 'name-fragment' : kind, start, end, context: text.slice(contextStart, contextEnd), contextStart } });
  };
  const name = (text, start, end, source, explicitKey) => {
    const value = text.slice(start, end), words = [...value.matchAll(NAME_WORD)];
    if (!words.length || words.length > 5 || !/^[\p{L}\p{M}\s.'’,-]+$/u.test(value)) return;
    add(text, start, end, source, [explicitKey ?? 'name'], explicitKey ?? 'full name');
    if (explicitKey) return;
    // Every contiguous proper part is offered; order and cultural interpretation belong to Decisions.
    for (let length = 1; length < words.length; length++) {
      for (let first = 0; first + length <= words.length; first++) {
        const last = words[first + length - 1];
        add(text, start + words[first].index, start + last.index + last[0].length, source, ['firstName', 'lastName'], 'name part', start, end);
      }
    }
  };
  const fullName = career.profile?.name;
  if (typeof fullName === 'string' && fullName.trim()) name(fullName, fullName.search(/\S/), fullName.trimEnd().length, 'profile.name');
  let sources = 0;
  for (const [id, source] of Object.entries(career.sources ?? {})) {
    if (source.purpose !== 'cv' || source.archived || typeof source.text !== 'string') continue;
    if (sources++ >= 4 || candidates.length >= MAX_CANDIDATES) break;
    const text = source.text.slice(0, 64000), origin = `cv:${id}`;
    const lines = [...text.matchAll(/[^\r\n]+/g)];
    let section = '', nameHeaders = 0;
    for (let index = 0; index < lines.length && candidates.length < MAX_CANDIDATES; index++) {
      const line = lines[index], trimmed = line[0].trim();
      if (SECTION.test(trimmed) || OTHER_CONTACT.test(trimmed)) section = trimmed;
      if (OTHER_CONTACT.test(trimmed) || OTHER_CONTACT.test(section)) continue;
      const nearby = lines.slice(Math.max(0, index - 1), index + 2).map(item => item[0]).join('\n');
      if (OTHER_CONTACT.test(nearby)) continue;
      for (const match of line[0].matchAll(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi)) {
        add(text, line.index + match.index, line.index + match.index + match[0].length, origin, ['email'], 'email');
      }
      for (const match of line[0].matchAll(/(?:\+\d[\d ().-]{6,}\d|\(?\d{2,4}\)?[ .-]\d[\d ().-]{4,}\d)(?:\s*(?:ext\.?|x)\s*\d{1,6})?/gi)) {
        const digits = match[0].replace(/\D/g, '').length;
        if (digits >= 7 && digits <= 20) add(text, line.index + match.index, line.index + match.index + match[0].length, origin, ['phone'], 'phone');
      }
      for (const match of line[0].matchAll(/(?:https?:\/\/|www\.|(?:linkedin\.com|github\.com)\/)[^\s<>"|]+/gi)) {
        const value = match[0].replace(/[),.;]+$/, '');
        const linkedin = /^(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[^/]+/i.test(value);
        add(text, line.index + match.index, line.index + match.index + value.length, origin, linkedin ? ['linkedinUrl'] : [], 'profile link');
      }
      const labeled = /^(?:(?:full|given|first|family|last)\s+name|name)\s*:\s*(.+)$/i.exec(trimmed);
      if (labeled && !section) {
        const key = /^(?:given|first)/i.test(trimmed) ? 'firstName' : /^(?:family|last)/i.test(trimmed) ? 'lastName' : undefined;
        const start = line.index + line[0].lastIndexOf(labeled[1]);
        name(text, start, start + labeled[1].length, origin, key);
      } else if (index < 8 && !section && nameHeaders < 2 && trimmed.length <= 100 && !/\b(?:curriculum vitae|resume|résumé|contact|engineer|developer|designer|analyst|summary|profile)\b/i.test(trimmed) && /^[\p{L}\p{M}\s.'’,-]+$/u.test(trimmed)) {
        const words = [...trimmed.matchAll(NAME_WORD)];
        if (words.length >= 2 && words.length <= 5) {
          nameHeaders++;
          const start = line.index + line[0].indexOf(trimmed);
          name(text, start, start + trimmed.length, origin);
        }
      }
    }
  }
  return candidates;
}
