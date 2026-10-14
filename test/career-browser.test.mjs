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

test('career reads preserve complete evidence without exposing binary sources, credentials or prototype properties', async () => {
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
