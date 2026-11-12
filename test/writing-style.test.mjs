import test from 'node:test';
import assert from 'node:assert/strict';
import { writingTells, WRITING_STYLE } from '../src/mcp/writing-style.mjs';
import { CV_WRITING_GUIDE } from '../src/mcp/application-tools.mjs';
import { inspectCvQuality } from '../src/mcp/cv-quality.mjs';

const notes = text => writingTells([{ field: 'f', text }]);

test('stock AI wording is pointed out with a plain alternative where one exists', () => {
  const [note] = notes('Spearheaded a migration, leveraging Kubernetes to deliver seamless, cutting-edge releases.');
  assert.equal(note.code, 'ai_wording');
  for (const part of ['“Spearheaded” (try “led”)', '“leveraging” (try “used”)', '“seamless”', '“cutting-edge”']) assert.ok(note.message.includes(part), part);
  assert.match(notes('I am passionate about payments — and not just the APIs.')[0].message, /“passionate”.*“not just”.*a dash/);
  assert.match(notes('Results-driven engineer with a proven track record.')[0].message, /“Results-driven”, “proven track record”/);
});

test('plain wording, technical words, date ranges and the candidate’s own gap wording pass', () => {
  for (const text of ['Led a team of 12 engineers and cut deployment time from 40 to 8 minutes.', 'Built dynamic pricing in Go, 2019–2021.',
    'Kept a robust on-call rota.', 'Moved the fleet to the new region; nothing was lost.'])
    assert.deepEqual(notes(text), [], text);
  assert.deepEqual(writingTells([{ field: 'careerGaps[0].description', text: 'Spearheaded family care', setting: true }, { field: 'x.startDate', text: 'Mar 2019 — now', date: true }]), []);
});

test('a CV gets one note per field that reads as AI-written, alongside its other quality notes', () => {
  const issues = inspectCvQuality({ heading: { name: 'Jane Candidate', contact: 'jane@example.test' }, document: {
    headline: 'Platform engineer', summary: 'A passionate, results-driven engineer.',
    experience: [{ employer: 'Acme', role: 'Engineer', startDate: '2019', endDate: '2021', bullets: ['Utilized Kafka to build data services.', 'Ran the on-call rota.'] }] } });
  assert.deepEqual(issues.filter(issue => issue.code === 'ai_wording').map(issue => issue.field), ['summary', 'experience[0].bullets[0]']);
});

test('the host receives the writing rules every time it reads the writing guide', () => {
  assert.ok(CV_WRITING_GUIDE.includes(WRITING_STYLE));
  assert.match(WRITING_STYLE, /keep every supported fact, name, number and date/);
});
