import test from 'node:test';
import assert from 'node:assert/strict';
import { cvDocumentTexts, inspectCvQuality, unsupportedNumbers } from '../src/mcp/cv-quality.mjs';

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
});

test('numeric guards compare whole tokens, not substrings or unqualified values', () => {
  assert.deepEqual(unsupportedNumbers('Improved by 5%, then by 5%; handled 15.', ['Handled 5.']), ['5%', '15']);
  assert.deepEqual(unsupportedNumbers('Improved by 5%.', ['Improved by 15%.']), ['5%']);
  assert.deepEqual(unsupportedNumbers('Handled 5.', ['Improved by 5%.']), ['5']);
  assert.deepEqual(unsupportedNumbers('Improved by 5 %.', ['Improved by 5%.']), []);
  assert.deepEqual(unsupportedNumbers('Saved $5 and €5 and £5.', ['Saved 5.']), ['$5', '€5', '£5']);
  assert.deepEqual(unsupportedNumbers('Saved $5.', ['Saved €5.']), ['$5']);
  assert.deepEqual(unsupportedNumbers('Saved USD 5.', ['Saved USD5.']), []);
});

test('units, magnitudes, signs, and bounds remain part of numeric claims', () => {
  assert.deepEqual(unsupportedNumbers('5k; 5M; 5 million; 5ms; 5MB; 5%; 5+; -5; +5.', ['5']),
    ['5k', '5M', '5million', '5ms', '5MB', '5%', '5+', '-5', '+5']);
  assert.deepEqual(unsupportedNumbers('Latency 5 ms; capacity 5 MB; team 5 people.', ['Latency 5ms; capacity 5MB; team 5 people.']), []);
  assert.deepEqual(unsupportedNumbers('Capacity 5MB.', ['Capacity 5Mb.']), ['5MB']);
  assert.deepEqual(unsupportedNumbers('Temperature 5°C.', ['Temperature 5°F.']), ['5°C']);
  assert.deepEqual(unsupportedNumbers('Handled 5 million.', ['Handled 5000000.']), ['5million']);
});

test('grouping, decimals, and unicode spaces normalize without losing distinct values', () => {
  assert.deepEqual(unsupportedNumbers('Saved $1,234.50.', ['Saved $1234.50.']), []);
  assert.deepEqual(unsupportedNumbers('Saved €1.234,50.', ['Saved €1234.50.']), []);
  assert.deepEqual(unsupportedNumbers('Saved €1\u202f234,50.', ['Saved €1234.50.']), []);
  assert.deepEqual(unsupportedNumbers('Saved CHF 1’234.50.', ["Saved CHF 1234.50."]), []);
  assert.deepEqual(unsupportedNumbers('Improved by 12,5%.', ['Improved by 12.5%.']), []);
  assert.deepEqual(unsupportedNumbers('Measured 0,125.', ['Measured 0.125.']), []);
  assert.deepEqual(unsupportedNumbers('Measured 1.234.', ['Measured 1234.']), ['1.234']);
  assert.deepEqual(unsupportedNumbers('Measured 12.5%.', ['Measured 125%.']), ['12.5%']);
  assert.deepEqual(unsupportedNumbers('Processed 9007199254740993.', ['Processed 9007199254740992.']), ['9007199254740993']);
});

test('numeric dates and ranges remain whole while attached technical literals are not metrics', () => {
  assert.deepEqual(unsupportedNumbers('B2B, ISO27001, ISO-27001, RFC3339, ES2022, v2.3.4, 3D, 1.2.3.', []), []);
  assert.deepEqual(unsupportedNumbers('Worked 2018 – 2024; released 2024-01-30.', ['Worked 2018-2024; released 2024-01-30.']), []);
  assert.deepEqual(unsupportedNumbers('Worked 2018–2025.', ['Worked 2018-2024.']), ['2018-2025']);
  assert.deepEqual(unsupportedNumbers('Released 01/02/2024.', ['Released 02/01/2024.']), ['01/02/2024']);
  assert.deepEqual(unsupportedNumbers('Released 30.01.2024.', ['Released 30.01.2024.']), []);
  assert.deepEqual(unsupportedNumbers('Improved by 5–10%.', ['Improved by 5-10%.']), []);
  assert.deepEqual(unsupportedNumbers('Measured −5.', ['Measured -5.']), []);
  assert.deepEqual(unsupportedNumbers('Handled 5.', ['B2B; ISO27001; v5.0.']), ['5']);
});

test('numeric evidence is read-only and expressions are unique in first-appearance order', () => {
  const supporting = Object.freeze(['Handled 10 users.', 'Saved $500.']);
  const snapshot = [...supporting];
  const text = 'Handled 15 users; saved $600; handled 15 users; saved $500.';
  const result = unsupportedNumbers(text, supporting);
  assert.deepEqual(result, ['15users', '$600']);
  assert.deepEqual(unsupportedNumbers(text, supporting), result);
  assert.deepEqual(supporting, snapshot);
  assert.deepEqual(unsupportedNumbers('No numeric claims here.', []), []);
});
