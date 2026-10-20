import test from 'node:test';
import assert from 'node:assert/strict';
import { createCareerState, hash } from '../src/mcp/state.mjs';
import { createCareerBrowser } from '../src/career-browser.mjs';
import { employmentHistory, openEmploymentProfile } from '../src/employment-browser.mjs';

const role = (overrides = {}) => ({ ref: 'profile:12', name: 'Example Labs', title: 'Senior Engineer', startDate: '2021-03', endDate: '2024-01', current: false, ...overrides });
function fixture() {
  const career = createCareerState();
  career.sources.cv = { id: 'cv', name: 'Jane CV.pdf', purpose: 'cv', archived: false, text: 'cv', contentHash: hash('cv') };
  career.sources.old = { id: 'old', name: 'Old CV.pdf', purpose: 'cv', archived: true, text: 'old', contentHash: hash('old') };
  career.introductions = { documents: {
    cv: { contentHash: hash('cv'), employment: [role(), role({ ref: 'organization:7', name: 'Second Co', title: 'Lead', startDate: '2024', endDate: null, current: true }),
      role({ title: 'Lead Engineer', startDate: '2015', endDate: '2016' })] },
    old: { contentHash: hash('old'), employment: [role({ ref: 'project:99', name: 'Archived Co' })] },
    gone: { contentHash: 'x', employment: [role({ ref: 'project:98', name: 'Deleted CV Co' })] },
  } };
  const state = { career };
  return { career, store: { get: () => structuredClone(state), update: () => assert.fail('read only') } };
}

test('career history lists current CV roles newest first, deduplicated, with readable periods', () => {
  const { career } = fixture();
  const rows = employmentHistory(career);
  assert.deepEqual(rows.map(row => [row.company, row.title, row.period, row.stale]), [
    ['Second Co', 'Lead', '2024 – Present', false],
    ['Example Labs', 'Senior Engineer', 'Mar 2021 – Jan 2024', false],
    ['Example Labs', 'Lead Engineer', '2015 – 2016', false],
  ]);
  career.sources.cv.contentHash = hash('changed');
  assert.ok(employmentHistory(career).every(row => row.stale));
});

test('the browser exposes Career as list and reader entries with a profile link', async () => {
  const { store } = fixture();
  const browser = createCareerBrowser({ store });
  const page = await browser.list({ kind: 'career', limit: 2 });
  assert.equal(page.total, 3);
  assert.equal(page.nextOffset, 2);
  assert.deepEqual(page.items[0], { ...page.items[0], title: 'Second Co', summary: 'Lead\n2024 – Present', profileLink: true });
  const detail = await browser.read({ kind: 'career', id: page.items[1].id });
  assert.deepEqual(detail.sections[0], { heading: 'Employment', fields: [
    { label: 'Company', value: 'Example Labs' }, { label: 'Title', value: 'Senior Engineer' }, { label: 'Dates', value: 'Mar 2021 – Jan 2024' }] });
  await assert.rejects(browser.read({ kind: 'career', id: 'missing' }), { code: 'NOT_FOUND' });
});

test('opening a profile resolves the saved ref through the platform and only opens a canonical JobStash slug', async () => {
  const { store } = fixture();
  const [entry] = employmentHistory(store.get().career);
  const calls = [];
  const opened = [];
  const run = (profile, args = { id: entry.id }) => openEmploymentProfile({ store,
    platform: async (operation, params) => { calls.push({ operation, params }); return profile; },
    openExternal: async url => { opened.push(url); } }, args);
  assert.deepEqual(await run({ slug: 'second-co', name: 'Second Co' }), { opened: true });
  assert.deepEqual(calls, [{ operation: 'employer_profile', params: { ref: 'organization:7' } }]);
  assert.deepEqual(opened, ['https://jobstash.xyz/profiles/second-co']);
  await assert.rejects(run({ slug: '../admin' }), { code: 'PROFILE_UNAVAILABLE' });
  await assert.rejects(run({ slug: 'x', url: 'https://evil.test' }, { id: 'nope' }), { code: 'NOT_FOUND' });
  await assert.rejects(run({ slug: 'x' }, { id: entry.id, url: 'https://evil.test' }), { code: 'INVALID_INPUT' });
  assert.equal(opened.length, 1);
});
