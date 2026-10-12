import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectCvQuality, unsupportedNumbers } from '../src/mcp/cv-quality.mjs';

const baseline = (...texts) => ({ sourceDocumentId: 'synthetic-source', sourceHash: 'synthetic-hash',
  entries: texts.map((text, index) => ({ id: `entry-${index}`, original: text, text })) });
const check = (report, id) => report.checks.find(item => item.id === id);
const words = count => Array.from({ length: count }, (_, index) => `word${index}`).join(' ');
const inspect = (...texts) => inspectCvQuality({ baseline: baseline(...texts), heading: { contact: 'candidate@example.test' } });

function assertExactQuotes(report, draft) {
  for (const issue of report.issues) {
    const entry = draft.entries.find(item => item.id === issue.entryId);
    assert.ok(entry, `Missing source entry for ${issue.code}`);
    assert.ok(issue.quote.length > 0);
    assert.ok(entry.text.includes(issue.quote), `Quote for ${issue.code} is not an exact draft substring`);
    assert.ok(issue.message.length > 0);
  }
}

test('email is available from the heading or current body, without inferring missing sections', () => {
  const body = baseline('Candidate\ncandidate@example.test');
  const bodyReport = inspectCvQuality({ baseline: body });
  assert.equal(check(bodyReport, 'contact_email').status, 'pass');
  assert.deepEqual(check(bodyReport, 'contact_email').entryIds, ['entry-0']);
  const headerReport = inspect('Built a service.');
  assert.equal(check(headerReport, 'contact_email').status, 'pass');
  assert.deepEqual(check(headerReport, 'contact_email').entryIds, []);
  assert.ok(headerReport.checks.every(item => item.status === 'pass'));
  const missing = inspectCvQuality({ baseline: baseline('Candidate\n+1 555 0100') });
  assert.deepEqual(missing.checks.filter(item => item.status === 'warning').map(item => item.id), ['contact_email']);
  assert.deepEqual(missing.issues, []); // Absence has no exact quote to attribute.
  assert.match(missing.disclaimer, /not an ATS score/);
  assert.equal(Object.hasOwn(missing, 'score'), false);
});

test('rendered contact text overrides suppressed or cleared original headers', () => {
  const draft = baseline('Candidate\nold@example.test', '- Built reliable services.');
  const suppressed = inspectCvQuality({ baseline: draft, heading: { contact: 'old@example.test' }, renderedText: 'Candidate\n- Built reliable services.' });
  assert.equal(check(suppressed, 'contact_email').status, 'warning');
  assert.deepEqual(check(suppressed, 'contact_email').entryIds, []);
  const replacement = inspectCvQuality({ baseline: draft, renderedText: 'Candidate\nnew@example.test\n- Built reliable services.' });
  assert.equal(check(replacement, 'contact_email').status, 'pass');
  assert.deepEqual(check(replacement, 'contact_email').entryIds, []);
  assert.equal(check(inspectCvQuality({ baseline: draft, renderedText: '' }), 'contact_email').status, 'warning');
});

test('long bullets and dense paragraphs use strict word thresholds and exact multiline quotes', () => {
  const longBullet = `• Built ${words(23)}\r\n  ${words(22)}`;
  const draft = baseline(longBullet, `- ${words(45)}`, words(101), words(100));
  const report = inspectCvQuality({ baseline: draft, heading: { contact: 'candidate@example.test' } });
  assert.deepEqual(report.issues.filter(item => item.code === 'long_bullet').map(item => item.quote), [longBullet]);
  assert.deepEqual(report.issues.filter(item => item.code === 'dense_paragraph').map(item => item.entryId), ['entry-2']);
  assert.match(report.issues.find(item => item.code === 'long_bullet').message, /46 words/);
  assert.match(report.issues.find(item => item.code === 'dense_paragraph').message, /101 words/);
  assertExactQuotes(report, draft);
});

test('exact bullet duplication is separate from repeated action-verb openings', () => {
  const draft = baseline('- Built reliable services.\n• Built reliable services.\n1. Built deployment tools.',
    '* Designed review workflows.\n- Designed release workflows.', '- Built reliable Services.');
  const report = inspectCvQuality({ baseline: draft });
  assert.deepEqual(report.issues.filter(item => item.code === 'repeated_bullet').map(item => item.quote),
    ['- Built reliable services.', '• Built reliable services.']);
  assert.equal(report.issues.filter(item => item.code === 'repeated_action_verb').length, 4);
  assert.deepEqual(check(report, 'repeated_action_verb').entryIds, ['entry-0', 'entry-2']);
  assertExactQuotes(report, draft);
  assert.equal(check(inspect('- Built one service.\n- Built another service.'), 'repeated_action_verb').status, 'pass');
  assert.equal(check(inspect('- Python tooling\n- Python services\n- Python scripts'), 'repeated_action_verb').status, 'pass');
});

test('placeholders are narrowly scoped and retain exact casing and quotes', () => {
  const draft = baseline('TODO: confirm the outcome. TBD start date. [Your Name] [insert supported result] [x%]',
    'Used [Python] and [AWS], array[index], [2018–2024], and todo lists.');
  const report = inspectCvQuality({ baseline: draft });
  assert.deepEqual(report.issues.filter(item => item.code === 'placeholder_text').map(item => item.quote),
    ['TODO', 'TBD', '[Your Name]', '[insert supported result]', '[x%]']);
  assert.deepEqual(check(report, 'placeholder_text').entryIds, ['entry-0']);
  assertExactQuotes(report, draft);
});

test('inspection reads current wording, is deterministic, and never mutates baseline or heading', () => {
  const draft = baseline('TODO: replace [Name]\nold@example.test');
  draft.entries[0].text = '- Shipped a documented service.';
  const heading = { name: 'Synthetic Candidate', contact: 'current@example.test' };
  const snapshot = structuredClone({ draft, heading });
  Object.freeze(draft.entries[0]);
  Object.freeze(draft.entries);
  Object.freeze(draft);
  Object.freeze(heading);
  const first = inspectCvQuality({ baseline: draft, heading });
  assert.deepEqual(first, inspectCvQuality({ baseline: draft, heading }));
  assert.deepEqual(first.issues, []);
  assert.deepEqual({ draft, heading }, snapshot);
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
