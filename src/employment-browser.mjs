import { fail, hash, readCareer } from './mcp/state.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const refPattern = /^(profile|organization|project):[1-9]\d{0,18}$/;
const datePattern = /^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/;
const monthFormat = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const dateLabel = value => typeof value !== 'string' || !datePattern.test(value) ? 'Not stated'
  : value.length === 4 ? value : monthFormat.format(new Date(`${value}-01T00:00:00Z`));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Current CV sources only; identical roles across CVs appear once. Separate tenures stay separate. */
export function employmentHistory(career) {
  const rows = new Map();
  for (const [sourceId, saved] of Object.entries(career.introductions?.documents ?? {})) {
    if (!Object.hasOwn(career.sources ?? {}, sourceId)) continue;
    const source = career.sources[sourceId];
    if (!record(source) || source.archived || source.purpose !== 'cv' || !record(saved) || !Array.isArray(saved.employment)) continue;
    for (const role of saved.employment) {
      if (!record(role) || typeof role.ref !== 'string' || !refPattern.test(role.ref) ||
          typeof role.title !== 'string' || !role.title.trim() || typeof role.name !== 'string' || !role.name.trim()) continue;
      const startDate = typeof role.startDate === 'string' && datePattern.test(role.startDate) ? role.startDate : null;
      const endDate = typeof role.endDate === 'string' && datePattern.test(role.endDate) ? role.endDate : null;
      const current = role.current === true;
      const id = hash([role.ref, role.title, startDate, endDate, current]);
      const entry = { id, ref: role.ref, company: role.name, title: role.title, startDate, endDate, current,
        period: `${dateLabel(startDate)} – ${current ? 'Present' : dateLabel(endDate)}`,
        sourceName: typeof source.name === 'string' ? source.name : 'CV', stale: saved.contentHash !== source.contentHash };
      if (!rows.has(id) || (rows.get(id).stale && !entry.stale)) rows.set(id, entry);
    }
  }
  return [...rows.values()].sort((a, b) => Number(b.current) - Number(a.current) ||
    compare(b.endDate ?? '', a.endDate ?? '') || compare(b.startDate ?? '', a.startDate ?? '') || compare(a.id, b.id));
}

/** The renderer supplies only a saved employment ID. It cannot supply an external URL or an arbitrary entity ref. */
export async function openEmploymentProfile({ store, platform, openExternal }, args) {
  if (!record(args) || Object.keys(args).some(key => key !== 'id') || typeof args.id !== 'string')
    fail('INVALID_INPUT', 'Choose a saved career entry.');
  const entry = employmentHistory(readCareer(store)).find(row => row.id === args.id);
  if (!entry) fail('NOT_FOUND', 'This career entry is no longer available. Refresh Career.');
  const page = await platform('employer_profile', { ref: entry.ref });
  // ecosystem.vision pages are keyed by the organization's or project's normalized name, never by a display name.
  if (!record(page) || !['organization', 'project'].includes(page.kind) ||
      typeof page.slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,299}$/.test(page.slug))
    fail('PROFILE_UNAVAILABLE', `${entry.company} has no public ecosystem.vision page yet.`);
  await openExternal(new URL(`/${page.kind}s/names/${page.slug}`, 'https://ecosystem.vision').href);
  return { opened: true };
}
