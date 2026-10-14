import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';

const documents = createRequire(import.meta.url)('../src/generated/document-engine.cjs');

const heading = { name: 'Jane Candidate', contact: 'jane@example.test · +44 20 7946 0000 · London' };
const sample = () => ({
  headline: 'Senior Platform Engineer',
  summary: 'Platform engineer who builds reliable data services for regulated products.',
  highlights: ['Cut deployment time from 40 minutes to 8 minutes.'],
  experience: [{ employer: 'Acme', role: 'Engineer', location: 'London', startDate: '2018', endDate: 'Present',
    bullets: ['Delivered migration work.', 'Maintained operational documentation.'] }],
  education: [{ institution: 'University', qualification: 'BSc Computing', startDate: '2014', endDate: '2018', details: 'Completed a computing degree.' }],
  skills: [{ label: 'Programming', items: ['TypeScript', 'Go'] }],
  languages: [{ language: 'Italian', proficiency: 'native' }, { language: 'English', proficiency: 'fluent' }],
  certifications: ['AWS Solutions Architect'],
  additional: [{ title: 'Open source', items: ['Maintainer of a logging library.'] }],
});

async function textPdf(lines) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const page = pdf.addPage();
  lines.forEach((text, index) => page.drawText(text, { x: 54, y: 790 - index * 16, size: 11, font }));
  return Buffer.from(await pdf.save());
}

test('structured CV text uses the profile header and conventional section order', () => {
  assert.equal(documents.renderCareerCvText({ document: sample(), heading }), [
    'Jane Candidate', 'Senior Platform Engineer', 'jane@example.test · +44 20 7946 0000 · London',
    '', 'Summary', '', 'Platform engineer who builds reliable data services for regulated products.',
    '', 'Key achievements', '', '• Cut deployment time from 40 minutes to 8 minutes.',
    '', 'Experience', '', 'Acme', 'Engineer', '2018 – Present', 'London', '• Delivered migration work.', '• Maintained operational documentation.',
    '', 'Skills', '', 'Programming: TypeScript, Go',
    '', 'Languages', '', 'Italian (native) · English (fluent)',
    '', 'Education', '', 'University', 'BSc Computing', '2014 – 2018', 'Completed a computing degree.',
    '', 'Certifications', '', '• AWS Solutions Architect',
    '', 'Open source', '', '• Maintainer of a logging library.',
  ].join('\n') + '\n');
});

test('optional sections are omitted and the header needs no profile values', () => {
  const minimal = { headline: 'Engineer', summary: 'Builds services.',
    experience: [{ employer: 'Acme', role: 'Engineer', startDate: '2018', endDate: '2024', bullets: ['Built services.'] }] };
  const presentation = documents.buildStructuredCvPresentation(minimal, {});
  assert.deepEqual(presentation.header, { headline: 'Engineer', contactLines: [] });
  assert.deepEqual(presentation.blocks.filter(block => block.kind === 'section').map(block => block.title), ['Summary', 'Experience']);
  assert.equal(documents.renderCareerCvText({ document: minimal, heading: {} }),
    'Engineer\n\nSummary\n\nBuilds services.\n\nExperience\n\nAcme\nEngineer\n2018 – 2024\n• Built services.\n');
});

for (const template of ['classic', 'modern']) {
  for (const paper of ['A4', 'LETTER']) {
    test(`${template}/${paper} renders its measured dimensions, readable font and complete text`, async () => {
      const input = { document: sample(), heading, presentation: { template, paper } };
      const expectedText = documents.renderCareerCvText(input);
      const layout = await documents.measureCareerCvLayout(input);
      const bytes = await documents.renderCareerCvPdf(input);
      const before = Buffer.from(bytes);
      const parsed = await PDFDocument.load(bytes);
      assert.equal(layout.fits, true);
      assert.equal(layout.template, template);
      assert.equal(layout.paper, paper);
      assert.equal(layout.fontSize, 11);
      assert.equal(layout.maxPages, null);
      assert.equal(layout.pages, parsed.getPageCount());
      assert.equal(parsed.getTitle(), 'Jane Candidate');
      for (const page of parsed.getPages()) {
        assert.deepEqual(page.getSize(), paper === 'A4' ? { width: 595.28, height: 841.89 } : { width: 612, height: 792 });
      }
      const fontDictionary = parsed.getPages()[0].node.Resources().lookup(PDFName.of('Font'));
      const fontNames = fontDictionary.values().map(ref => parsed.context.lookup(ref).get(PDFName.of('BaseFont')).toString());
      assert.ok(fontNames.some(name => name.includes(template === 'classic' ? 'Times-Roman' : 'Helvetica')));
      const fidelity = await documents.validateCareerPdfText({ bytes, expectedText });
      assert.equal(fidelity.passed, true, JSON.stringify(fidelity));
      assert.deepEqual(fidelity.missingTokens, []);
      assert.equal(fidelity.pages, layout.pages);
      assert.deepEqual(bytes, before, 'validation must not detach or mutate export bytes');
    });
  }
}

test('non-Latin text falls back to the embedded font and still round-trips', async () => {
  const document = { ...sample(), summary: 'Ingegnera di piattaforma. Работала с распределёнными системами.' };
  const input = { document, heading: { name: 'Jane Candidate' }, presentation: { template: 'classic', paper: 'A4' } };
  const result = await documents.validateCareerPdfText({ bytes: await documents.renderCareerCvPdf(input), expectedText: documents.renderCareerCvText(input) });
  assert.equal(result.passed, true, JSON.stringify(result));
});

for (const template of ['classic', 'modern']) {
  test(`${template} preserves multi-page reading order and wrapped experience fields without a page cap`, async () => {
    const company = 'Synthetic Research and Development Organisation with a deliberately long company name';
    const role = 'Principal Engineer responsible for distributed platform engineering and operational reliability';
    const experience = Array.from({ length: 18 }, (_, index) => ({
      employer: index ? `Employer ${index}` : company, role: index ? 'Engineer' : role, location: 'Remote', startDate: '2018', endDate: '2024',
      bullets: Array.from({ length: 10 }, (_, bullet) => `Achievement ${index * 10 + bullet + 1}: implemented reliable systems with explicit ownership and documented operational procedures.`),
    }));
    const input = { document: { ...sample(), experience, additional: [{ title: 'Final section', items: ['Final preserved item.'] }] },
      heading, presentation: { template, paper: 'LETTER' } };
    const expectedText = documents.renderCareerCvText(input);
    const layout = await documents.measureCareerCvLayout(input);
    const bytes = await documents.renderCareerCvPdf(input);
    const result = await documents.validateCareerPdfText({ bytes, expectedText });
    assert.ok(result.pages > 3);
    assert.equal(result.pages, layout.pages);
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.ok(expectedText.indexOf(company) < expectedText.indexOf(role));
    assert.ok(expectedText.indexOf('Achievement 180') < expectedText.indexOf('Final preserved item.'));
  });
}

test('ordinary roles stay with all their bullets across page boundaries', async () => {
  const { PDFParse } = createRequire(import.meta.url)('pdf-parse');
  const experience = Array.from({ length: 7 }, (_, index) => {
    const employer = `Company${String.fromCharCode(65 + index)}`;
    return { employer, role: 'Engineer', startDate: '2018', endDate: '2024',
      bullets: Array.from({ length: 9 }, (_, bullet) => `${employer} achievement ${bullet + 1}: delivered reliable services.`) };
  });
  for (const template of ['classic', 'modern']) {
    const bytes = await documents.renderCareerCvPdf({ document: { headline: 'Engineer', summary: 'Builds services.', experience }, heading, presentation: { template, paper: 'LETTER' } });
    const parser = new PDFParse({ data: Uint8Array.from(bytes) });
    try {
      const { pages } = await parser.getText({ pageJoiner: '' });
      for (const { employer } of experience) {
        const rolePages = pages.filter(page => page.text.includes(employer));
        assert.equal(rolePages.length, 1, `${employer} should remain together`);
        for (let bullet = 1; bullet <= 9; bullet++) assert.ok(rolePages[0].text.includes(`${employer} achievement ${bullet}`));
      }
    } finally { await parser.destroy(); }
  }
});

test('validation normalizes Unicode, bullet styles and physical line wrapping, not content', async () => {
  const bytes = await textPdf(['• Café office', 'reli', 'ability']);
  const result = await documents.validateCareerPdfText({ bytes, expectedText: '● Cafe\u0301 ofﬁce\nreliability' });
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.expectedTokens, 3);
  assert.equal(result.recoveredTokens, 3);
});

test('corrupt bytes fail closed with missing-token diagnostics', async () => {
  const result = await documents.validateCareerPdfText({ bytes: Buffer.from('not a PDF'), expectedText: 'Alpha Beta Gamma' });
  assert.deepEqual(result, { passed: false, expectedTokens: 3, recoveredTokens: 0,
    missingTokens: ['Alpha', 'Beta', 'Gamma'], orderPreserved: false, pages: 0 });
});

for (const [label, lines, missing, count] of [
  ['dropped', ['Alpha Gamma'], ['Beta'], 2],
  ['duplicated', ['Alpha Beta Beta Gamma'], [], 4],
  ['reordered', ['Gamma Beta Alpha'], [], 3],
  ['invented footer', ['Alpha Beta Gamma', 'Private draft'], [], 5],
]) {
  test(`validation rejects ${label} actual PDF text`, async () => {
    const bytes = await textPdf(lines);
    const result = await documents.validateCareerPdfText({ bytes, expectedText: 'Alpha Beta Gamma' });
    assert.equal(result.passed, false);
    assert.equal(result.orderPreserved, false);
    assert.equal(result.expectedTokens, 3);
    assert.equal(result.recoveredTokens, count);
    assert.deepEqual(result.missingTokens, missing);
    assert.equal(result.pages, 1);
  });
}

test('missing-token diagnostics retain repeated occurrences and empty PDFs cannot pass', async () => {
  const bytes = await textPdf(['Alpha Beta']);
  const result = await documents.validateCareerPdfText({ bytes, expectedText: 'Alpha Alpha Beta Alpha' });
  assert.deepEqual(result.missingTokens, ['Alpha', 'Alpha']);
  assert.equal(result.passed, false);
  const empty = await documents.validateCareerPdfText({ bytes: await textPdf([]), expectedText: '' });
  assert.equal(empty.passed, false);
});

test('only an explicitly expected exact page counter can be omitted from fidelity comparison', async () => {
  const expectedText = 'Alpha Beta Gamma';
  const valid = await textPdf([expectedText, '1 / 1']);
  assert.equal((await documents.validateCareerPdfText({ bytes: valid, expectedText })).passed, false);
  assert.equal((await documents.validateCareerPdfText({ bytes: valid, expectedText, pageNumberFooter: true })).passed, true);
  for (const lines of [[expectedText, '1 / 2'], [expectedText, 'Private draft', '1 / 1'], [expectedText]]) {
    const result = await documents.validateCareerPdfText({ bytes: await textPdf(lines), expectedText, pageNumberFooter: true });
    assert.equal(result.passed, false);
  }
});
