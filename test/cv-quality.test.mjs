import test from 'node:test';
import assert from 'node:assert/strict';
import { cvDocumentTexts, inspectCvQuality } from '../src/mcp/cv-quality.mjs';

const words = count => Array.from({ length: count }, (_, index) => `word${index}`).join(' ');
const heading = { name: 'Jane Candidate', contact: 'jane@example.test' };
const cv = (overrides = {}) => ({ headline: 'Platform Engineer', summary: 'Builds reliable data services.',
  experience: [{ employer: 'Acme', role: 'Engineer', startDate: '2018', endDate: '2024', bullets: ['Built reliable services.'] }], ...overrides });
const codes = issues => issues.map(issue => `${issue.code}@${issue.field}`);

test('a clean structured CV has no notes and inspection never mutates its input', () => {
  const document = Object.freeze(cv());
  const snapshot = structuredClone(document);
  assert.deepEqual(inspectCvQuality({ document, heading }), []);
  assert.deepEqual(document, snapshot);
});

test('missing profile contact details are reported against the header', () => {
  assert.deepEqual(codes(inspectCvQuality({ document: cv() })), ['missing_email@header', 'missing_name@header']);
  assert.deepEqual(codes(inspectCvQuality({ document: cv(), heading: { name: 'Jane', contact: '+44 20 7946 0000' } })), ['missing_email@header']);
});

test('long bullets, long summaries and overlong documents are flagged by field', () => {
  const document = cv({ summary: words(101), highlights: [`Highlight ${words(45)}`],
    experience: [{ employer: 'Acme', role: 'Engineer', startDate: '2018', endDate: '2024', bullets: [words(45), words(46)] }] });
  assert.deepEqual(codes(inspectCvQuality({ document, heading })),
    ['long_summary@summary', 'long_bullet@highlights[0]', 'long_bullet@experience[0].bullets[1]']);
  const long = cv({ experience: Array.from({ length: 6 }, () => ({ employer: 'Acme', role: 'Engineer', startDate: '2018', endDate: '2024',
    bullets: Array.from({ length: 6 }, (_, index) => `${index} ${words(40)}`) })) });
  assert.ok(codes(inspectCvQuality({ document: long, heading })).includes('long_document@document'));
});

test('repeated bullets and opening verbs are flagged across sections', () => {
  const document = cv({ highlights: ['Built reliable services.'],
    experience: [{ employer: 'Acme', role: 'Engineer', startDate: '2018', endDate: '2024',
      bullets: ['built reliable services.', 'Led a migration.', 'Led hiring.', 'Led on-call.'] }] });
  const issues = codes(inspectCvQuality({ document, heading }));
  assert.deepEqual(issues.filter(item => item.startsWith('repeated_bullet')), ['repeated_bullet@highlights[0]', 'repeated_bullet@experience[0].bullets[0]']);
  assert.equal(issues.filter(item => item.startsWith('repeated_action_verb')).length, 3);
});

test('placeholders are found in any field without flagging ordinary brackets', () => {
  const document = cv({ headline: 'TODO headline', skills: [{ label: 'Tools', items: ['[insert tool]', 'array[index]', '[Python]'] }] });
  const issues = inspectCvQuality({ document, heading }).filter(issue => issue.code === 'placeholder_text');
  assert.deepEqual(issues.map(issue => issue.field), ['headline', 'skills[0].items[0]']);
  assert.match(issues[1].message, /\[insert tool\]/);
});

test('document texts enumerate every authored field and mark dates', () => {
  const texts = cvDocumentTexts(cv({ education: [{ institution: 'University', startDate: '2014' }], languages: [{ language: 'Italian', proficiency: 'native' }],
    certifications: ['AWS'], additional: [{ title: 'Open source', items: ['Maintainer.'] }] }));
  assert.deepEqual(texts.filter(item => item.date).map(item => item.field),
    ['experience[0].startDate', 'experience[0].endDate', 'education[0].startDate']);
  for (const field of ['headline', 'experience[0].employer', 'experience[0].bullets[0]', 'education[0].institution', 'languages[0].proficiency', 'certifications[0]', 'additional[0].title', 'additional[0].items[0]'])
    assert.ok(texts.some(item => item.field === field), field);
  assert.deepEqual(cvDocumentTexts(cv({ highlights: ['Shipped.'] })).filter(item => item.claim).map(item => item.field), ['highlights[0]', 'experience[0].bullets[0]']);
});

