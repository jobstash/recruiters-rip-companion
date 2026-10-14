import test from 'node:test';
import assert from 'node:assert/strict';
import { createCareerState } from '../src/mcp/state.mjs';
import { createCareerBrowser } from '../src/career-browser.mjs';
import { ASSESSMENT_VERSION } from '../src/mcp/assessment-policy.mjs';

function fixture() {
  const state = { privateKey: 'PRIVATE_KEY_SENTINEL', career: createCareerState() };
  const store = { get: () => structuredClone(state), update: () => assert.fail('Browsing must not write') };
  return { state, browser: createCareerBrowser({ store }) };
}

test('career reads return complete source text without exposing binary sources, credentials or prototype properties', async () => {
  const { state, browser } = fixture();
  const text = 'Complete source text. '.repeat(1500) + 'Final evidence sentence.';
  state.career.sources.saved = { id: 'saved', name: 'Original CV', purpose: 'cv', text, originalBase64: 'BINARY_SOURCE_SENTINEL' };
  const before = structuredClone(state);
  const detail = await browser.read({ kind: 'sources', id: 'saved' });
  assert.ok(detail.sections.some(section => section.text === text));
  assert.equal(JSON.stringify(detail).includes('BINARY_SOURCE_SENTINEL'), false);
  assert.equal(JSON.stringify(detail).includes('PRIVATE_KEY_SENTINEL'), false);
  for (const id of ['constructor', '__proto__', 'prototype'])
    await assert.rejects(browser.read({ kind: 'sources', id }), { code: 'INVALID_INPUT' });
  await assert.rejects(browser.read({ kind: 'sources', id: 'missing' }), { code: 'NOT_FOUND' });
  await assert.rejects(browser.list({ kind: 'sources', limit: 101 }), { code: 'INVALID_INPUT' });
  await assert.rejects(browser.list({ kind: 'sources', offset: -1 }), { code: 'INVALID_INPUT' });
  await assert.rejects(browser.read({ kind: 'sources', id: 'saved', path: '/private' }), { code: 'INVALID_INPUT' });
  assert.deepEqual(state, before);
});

test('rankings sort before pagination and keep skip judgments visible rather than presenting them as recommendations', async () => {
  const { state, browser } = fixture();
  state.career.matching = { jobs: {}, scores: {} };
  for (const [id, score, decision] of [['low', 40, 'skip'], ['high', 90, 'recommend'], ['middle', 70, 'clarify']]) {
    state.career.matching.jobs[id] = { title: id, company: 'Company', publishedAt: '2026-10-14T12:00:00Z' };
    state.career.matching.scores[id] = { score, decision, relocation: 'not_required', reason: `Saved reasoning for ${id}`, profileVersion: '0:0', assessmentVersion: ASSESSMENT_VERSION };
  }
  const first = await browser.list({ kind: 'rankings', limit: 2 });
  assert.deepEqual(first.items.map(item => item.id), ['high', 'middle']);
  const second = await browser.list({ kind: 'rankings', limit: 2, offset: first.nextOffset });
  assert.deepEqual(second.items.map(item => item.id), ['low']);
  assert.equal(second.nextOffset, null);
  assert.ok(second.items[0].sections.some(section => section.text?.includes('Saved reasoning for low')));
});

test('facts read as subject and answer; applications show the rendered CV and cover letter', async () => {
  const { state, browser } = fixture();
  Object.assign(state.career.profile, { name: 'Jane Candidate', email: 'jane@example.test', location: 'London' });
  state.career.facts.ab = { id: 'ab', kind: 'capability', subject: 'A/B testing', answer: 'Led it', detail: 'Checkout experiments', employer: 'Acme' };
  state.career.facts.k8s = { id: 'k8s', kind: 'yes_no', subject: 'Kubernetes in production', answer: 'No' };
  const document = { headline: 'Platform Engineer', summary: 'Builds data services.',
    experience: [{ employer: 'Acme', role: 'Engineer', startDate: '2019', endDate: 'Present', bullets: ['Built payment pipelines.'] }] };
  state.career.applications.app = { id: 'app', job: { title: 'Senior Engineer', company: 'Example Employer', description: 'Ad', url: 'https://example.test/job' },
    cv: { version: 2, document, presentation: { template: 'classic', paper: 'A4' }, createdAt: '2026-10-14T10:00:00Z' },
    cvHistory: [{ version: 1, document: { ...document, headline: 'Engineer' }, presentation: { template: 'classic', paper: 'A4' }, createdAt: '2026-10-13T10:00:00Z' }],
    coverLetter: { version: 1, paragraphs: ['Dear team,', 'I build payment pipelines.'], createdAt: '2026-10-14T10:00:00Z' }, coverLetterHistory: [], exports: [],
    createdAt: '2026-10-13T10:00:00Z', updatedAt: '2026-10-14T10:00:00Z' };

  const facts = await browser.list({ kind: 'facts' });
  assert.deepEqual(facts.items.map(({ title, summary }) => ({ title, summary })),
    [{ title: 'A/B testing', summary: 'Led it · Acme' }, { title: 'Kubernetes in production', summary: 'No' }]);
  const ab = await browser.read({ kind: 'facts', id: 'ab' });
  assert.equal(ab.title, 'A/B testing');
  assert.deepEqual(ab.sections[0].fields, [{ label: 'Answer', value: 'Led it' }, { label: 'Example', value: 'Checkout experiments' },
    { label: 'Role', value: 'Acme' }, { label: 'Kind', value: 'Capability' }]);
  assert.deepEqual((await browser.read({ kind: 'facts', id: 'k8s' })).sections[0].fields, [{ label: 'Answer', value: 'No' }, { label: 'Kind', value: 'Yes/no' }]);

  const detail = await browser.read({ kind: 'applications', id: 'app' });
  assert.equal(detail.title, 'Senior Engineer — Example Employer');
  const sections = Object.fromEntries(detail.sections.slice(1).map(section => [section.heading.split(' — ')[0], section.text]));
  assert.equal(sections.CV, 'Jane Candidate\nPlatform Engineer\njane@example.test · London\n\nSummary\n\nBuilds data services.\n\nExperience\n\nAcme\nEngineer\n2019 – Present\n• Built payment pipelines.\n');
  assert.match(sections['Earlier CV'], /^Jane Candidate\nEngineer\n/);
  assert.equal(sections['Cover letter'], 'Dear team,\n\nI build payment pipelines.');
});
