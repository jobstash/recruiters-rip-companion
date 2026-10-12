import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';

const documents = createRequire(import.meta.url)('../src/generated/document-engine.cjs');

function inputFor(text, presentation) {
  const source = documents.buildCvBaseline({ id: 'synthetic-source', contentHash: 'synthetic-hash', sourceText: text });
  return { heading: { name: 'Jane Candidate', contact: 'jane@example.test' },
    baseline: documents.applyCvBaselineChanges(source, []), ...(presentation ? { presentation } : {}) };
}

async function textPdf(lines) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const page = pdf.addPage();
  lines.forEach((text, index) => page.drawText(text, { x: 54, y: 790 - index * 16, size: 11, font }));
  return Buffer.from(await pdf.save());
}

const sourceText = 'Jane Candidate\njane@example.test\n\nSummary\nBuilt reliable data services.\n\nExperience\nAcme | Engineer | London | 2018 – 2024\n• Delivered migration work.\n• Maintained operational documentation.\n\nEducation\nUniversity | Computing | 2014 – 2018\nCompleted a computing degree.';

for (const template of ['classic', 'modern']) {
  for (const paper of ['A4', 'LETTER']) {
    test(`${template}/${paper} renders its measured dimensions, readable font and complete text`, async () => {
      const input = inputFor(sourceText, { template, paper });
      const expectedText = documents.renderCareerCvText(input);
      assert.equal(typeof expectedText, 'string');
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
      for (const page of parsed.getPages()) {
        assert.deepEqual(page.getSize(), paper === 'A4' ? { width: 595.28, height: 841.89 } : { width: 612, height: 792 });
      }
      const fontDictionary = parsed.getPages()[0].node.Resources().lookup(PDFName.of('Font'));
      const fontNames = fontDictionary.values().map(ref => parsed.context.lookup(ref).get(PDFName.of('BaseFont')).toString());
      assert.ok(fontNames.some(name => name.includes(template === 'classic' ? 'Times-Roman' : 'Helvetica')));
      const fidelity = await documents.validateCareerPdfText({ bytes, expectedText });
      assert.equal(fidelity.passed, true, JSON.stringify(fidelity));
      assert.equal(fidelity.orderPreserved, true);
      assert.deepEqual(fidelity.missingTokens, []);
      assert.equal(fidelity.expectedTokens, fidelity.recoveredTokens);
      assert.equal(fidelity.pages, layout.pages);
      assert.deepEqual(bytes, before, 'validation must not detach or mutate export bytes');
    });
  }
}


test('text and both PDF templates honor explicit header replacements without provenance', async () => {
  const input = inputFor('Jane Candidate\njane@example.test | +44 123 456 789\n\nSummary\nOwned platform migrations.');
  input.headerOverride = { sourceNames: ['Jane Candidate'], sourceContactValues: ['jane@example.test', '+44 123 456 789'],
    untouchedContactKinds: ['phone'], name: 'Janet Candidate', contact: 'janet@example.test', location: 'Bristol' };
  const expectedText = documents.renderCareerCvText(input);
  assert.equal(expectedText, 'Janet Candidate\n+44 123 456 789\njanet@example.test\nBristol\n\nSummary\n\nOwned platform migrations.\n');
  assert.doesNotMatch(expectedText, /synthetic-source|synthetic-hash|jane@example|Jane Candidate/);
  for (const template of ['classic', 'modern']) {
    const bytes = await documents.renderCareerCvPdf({ ...input, presentation: { template, paper: 'A4' } });
    const result = await documents.validateCareerPdfText({ bytes, expectedText });
    assert.equal(result.passed, true, JSON.stringify(result));
  }
  input.headerOverride = { ...input.headerOverride, name: null, contact: null, location: null, untouchedContactKinds: [] };
  assert.equal(documents.renderCareerCvText(input), 'Summary\n\nOwned platform migrations.\n');
});

for (const template of ['classic', 'modern']) {
  test(`${template} preserves multi-page reading order and wrapped experience fields without a page cap`, async () => {
    const company = 'Synthetic Research and Development Organisation with a deliberately long company name';
    const role = 'Principal Engineer responsible for distributed platform engineering and operational reliability';
    const achievements = Array.from({ length: 180 }, (_, index) => `• Achievement ${index + 1}: implemented reliable systems with explicit ownership and documented operational procedures.`).join('\n');
    const input = inputFor(`Experience\n${company} | ${role} | Remote | 2018 – 2024\n${achievements}\n\nSkills\n${'longidentifier'.repeat(40)}\n\nFinal preserved paragraph.`, { template, paper: 'LETTER' });
    const expectedText = documents.renderCareerCvText(input);
    const layout = await documents.measureCareerCvLayout(input);
    const bytes = await documents.renderCareerCvPdf(input);
    const result = await documents.validateCareerPdfText({ bytes, expectedText });
    assert.ok(result.pages > 3);
    assert.equal(result.pages, layout.pages);
    assert.equal(layout.maxPages, null);
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.ok(expectedText.indexOf(company) < expectedText.indexOf(role));
    assert.ok(expectedText.indexOf('Achievement 180') < expectedText.indexOf('Final preserved paragraph.'));
  });
}

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

test('ordinary roles stay with all their bullets across page boundaries', async () => {
  const require = createRequire(import.meta.url);
  const { PDFParse } = require('pdf-parse');
  const roles = Array.from({ length: 7 }, (_, index) => {
    const company = `Company${String.fromCharCode(65 + index)}`;
    return { company, text: `${company} | Engineer | 2018 – 2024\n` +
      Array.from({ length: 9 }, (_, bullet) => `• ${company} achievement ${bullet + 1}: delivered reliable services.`).join('\n') };
  });
  for (const template of ['classic', 'modern']) {
    const input = inputFor(`Experience\n${roles.map(role => role.text).join('\n\n')}`, { template, paper: 'LETTER' });
    const bytes = await documents.renderCareerCvPdf(input);
    const parser = new PDFParse({ data: Uint8Array.from(bytes) });
    try {
      const { pages } = await parser.getText({ pageJoiner: '' });
      for (const { company } of roles) {
        const rolePages = pages.filter(page => page.text.includes(company));
        assert.equal(rolePages.length, 1, `${company} should remain together`);
        for (let bullet = 1; bullet <= 9; bullet++) assert.ok(rolePages[0].text.includes(`${company} achievement ${bullet}`));
      }
    } finally { await parser.destroy(); }
  }
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
