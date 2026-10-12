import { BadRequestException } from "@nestjs/common";
import { PDFDocument, PDFFont, rgb, StandardFonts } from "pdf-lib";
import * as fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CvDraftBaseline } from "./cv-source-baseline";
import { buildCvPresentation, type CvHeaderOverride } from "./cv-document-layout";

// Match the codec's Node worker initialization before loading PDFParse.
const { getPath }: { getPath(): string } = require("pdf-parse/worker");
import { PDFParse } from "pdf-parse";
PDFParse.setWorker(getPath());

// PDF extraction commonly uses BLACK CIRCLE for a list marker. Render the
// equivalent typographic bullet; the owned source and baseline remain exact.
const cleanPdfText = (text: string): string => text
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  .replace(/\u25cf/g, "\u2022");

export const CAREER_CV_LAYOUT_VERSION = "careercup-serif-v4";
interface TextRun {
  rows: string[];
  font: PDFFont;
  size: number;
  leading: number;
  height: number;
}
export interface CareerCvPresentation {
  template: "classic" | "modern";
  paper: "A4" | "LETTER";
}
export interface CareerCvInput {
  heading: { name?: string; contact?: string; location?: string };
  baseline: CvDraftBaseline;
  headerOverride?: CvHeaderOverride;
  presentation?: CareerCvPresentation;
}
export interface CareerCvLayout {
  version: typeof CAREER_CV_LAYOUT_VERSION;
  fits: boolean;
  pages?: number;
  maxPages: null;
  paper: CareerCvPresentation["paper"];
  template: CareerCvPresentation["template"];
  fontSize: 11;
  error?: string;
}

export async function measureCareerCvLayout(input: CareerCvInput): Promise<CareerCvLayout> {
  const settings = input.presentation ?? { template: "classic" as const, paper: "A4" as const };
  try {
    const pdf = await layoutCareerCvPdf(input);
    return { version: CAREER_CV_LAYOUT_VERSION, fits: true, pages: pdf.getPageCount(), maxPages: null, ...settings, fontSize: 11 };
  } catch (error) {
    if (!(error instanceof BadRequestException)) throw error;
    return { version: CAREER_CV_LAYOUT_VERSION, fits: false, maxPages: null, ...settings, fontSize: 11, error: error.message };
  }
}

export async function renderCareerCvPdf(input: CareerCvInput): Promise<Buffer> {
  const pdf = await layoutCareerCvPdf(input);
  return Buffer.from(await pdf.save());
}

/** Text and PDF share the same source/header interpretation and reading order. */
export function renderCareerCvText({ heading, baseline, headerOverride }: CareerCvInput): string {
  const presentation = buildCvPresentation(baseline, heading, headerOverride);
  const lines = [presentation.header.name ?? "", ...presentation.header.contactLines].filter(Boolean);
  for (const block of presentation.blocks) {
    lines.push("");
    if (block.kind === "experience") {
      lines.push(block.company, block.role);
      if (block.dates) lines.push(block.dates);
      if (block.location) lines.push(block.location);
      for (const item of block.items) lines.push(`${item.kind === "bullet" ? "• " : ""}${item.text}`);
    } else lines.push(block.kind === "section" ? block.title : `${block.kind === "bullet" ? "• " : ""}${block.text}`);
  }
  return `${lines.join("\n").trim()}\n`;
}

/** Both templates flow authored content at 11pt without a page cap. */
async function layoutCareerCvPdf(input: CareerCvInput): Promise<PDFDocument> {
  const { heading, baseline, headerOverride } = input;
  const { template, paper } = input.presentation ?? { template: "classic", paper: "A4" };
  const modern = template === "modern";
  const pdf = await PDFDocument.create();
  pdf.setTitle((headerOverride ? headerOverride.name : heading.name) || "Career CV");
  pdf.setProducer("JobStash");
  const regular = await pdf.embedFont(modern ? StandardFonts.Helvetica : StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(modern ? StandardFonts.HelveticaBold : StandardFonts.TimesRomanBold);
  const boldItalic = await pdf.embedFont(modern ? StandardFonts.HelveticaBoldOblique : StandardFonts.TimesRomanBoldItalic);
  const latin = new Set(regular.getCharacterSet());
  const presentation = buildCvPresentation(baseline, heading, headerOverride);
  const strings = [presentation.header.name ?? "", ...presentation.header.contactLines];
  for (const block of presentation.blocks) {
    if (block.kind === "experience") {
      strings.push(block.company, block.role, block.location ?? "", block.dates ?? "");
      for (const item of block.items) strings.push(item.text);
    } else strings.push(block.kind === "section" ? block.title : block.text);
  }
  let fallback: PDFFont | undefined;
  if (strings.some(text => [...cleanPdfText(text)].some(ch => !/\s/.test(ch) && !latin.has(ch.codePointAt(0)!)))) {
    pdf.registerFontkit(fontkit);
    fallback = await pdf.embedFont(await readFile(join(__dirname, "assets/NotoSans-Regular.ttf")), { subset: true });
    const supported = new Set(fallback.getCharacterSet());
    for (const text of strings)
      for (const ch of cleanPdfText(text))
        if (!/\s/.test(ch) && !latin.has(ch.codePointAt(0)!) && !supported.has(ch.codePointAt(0)!))
          throw new BadRequestException("An export character is not supported by the document fonts. Edit the text before exporting.");
  }
  const fontFor = (text: string, strong = false, italic = false): PDFFont =>
    fallback && [...cleanPdfText(text)].some(ch => !/\s/.test(ch) && !latin.has(ch.codePointAt(0)!))
      ? fallback : italic ? boldItalic : strong ? bold : regular;
  const wrap = (text: string, width: number, size: number, font: PDFFont): string[] => {
    const lines: string[] = [];
    for (const raw of cleanPdfText(text).split("\n")) {
      let current = "";
      for (const word of raw.split(/\s+/).filter(Boolean)) {
        const next = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) <= width) { current = next; continue; }
        if (current) lines.push(current);
        current = "";
        for (const ch of word) {
          if (current && font.widthOfTextAtSize(current + ch, size) > width) {
            lines.push(current);
            current = "";
          }
          current += ch;
        }
      }
      if (current) lines.push(current);
    }
    return lines;
  };
  const [pageWidth, pageHeight] = paper === "LETTER" ? [612, 792] : [595.28, 841.89];
  const left = 54, right = pageWidth - 54, top = pageHeight - 48, bottom = 48, body = 11, leading = 13.2;
  let page = pdf.addPage([pageWidth, pageHeight]), y = top;
  const ensure = (height: number): void => {
    if (y - height < bottom && y < top) {
      // Never shrink or discard authored content to meet an arbitrary page count.
      page = pdf.addPage([pageWidth, pageHeight]);
      y = top;
    }
  };
  const width = right - left;
  const run = (text: string, maxWidth: number, size = body, strong = false, italic = false): TextRun => {
    const font = fontFor(text, strong, italic);
    const rows = wrap(text, maxWidth, size, font);
    return { rows, font, size, leading: size * 1.2, height: rows.length * size * 1.2 };
  };
  const drawRow = (text: TextRun, index: number, x: number, maxWidth: number, align: "left" | "right" | "center" = "left") => {
    const line = text.rows[index];
    if (!line) return;
    const measured = text.font.widthOfTextAtSize(line, text.size);
    page.drawText(line, {
      x: align === "right" ? x + maxWidth - measured : align === "center" ? x + (maxWidth - measured) / 2 : x,
      y: y - text.size, font: text.font, size: text.size,
    });
  };
  const drawFlow = (text: TextRun, align: "left" | "center" = "left", keepAfter = 0) => {
    for (let index = 0; index < text.rows.length; index++) {
      ensure(text.leading + (index === text.rows.length - 1 ? keepAfter : 0));
      drawRow(text, index, left, width, align);
      y -= text.leading;
    }
  };
  if (presentation.header.name) {
    const name = run(presentation.header.name, width, 20, true);
    drawFlow(name, modern ? "left" : "center");
    y -= 4;
  }
  for (const text of presentation.header.contactLines) {
    const contact = run(text, width);
    drawFlow(contact, modern ? "left" : "center");
  }
  if (presentation.header.name || presentation.header.contactLines.length) y -= 12;

  const pendingSections: TextRun[] = [];
  const sectionHeight = () => pendingSections.reduce((height, section) => height + section.height + 10, 0);
  const drawSections = (keepAfter = leading * 2) => {
    for (let index = 0; index < pendingSections.length; index++) {
      const section = pendingSections[index];
      // Even exceptionally long authored headings flow, with their final row
      // attached to the first content rather than stranded at a page foot.
      drawFlow(section, "left", 10 + (index === pendingSections.length - 1 ? keepAfter : leading));
      y -= 2;
      page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.55 });
      y -= 8;
    }
    pendingSections.length = 0;
  };
  const prepareItem = (item: { kind: "paragraph" | "bullet"; text: string }) => ({
    kind: item.kind, text: run(item.text, width - (item.kind === "bullet" ? 12 : 0)),
  });
  const drawItem = (item: { kind: "paragraph" | "bullet"; text: TextRun }) => {
    const indent = item.kind === "bullet" ? 12 : 0;
    ensure(Math.min(Math.max(item.text.height, leading), leading * 2));
    for (let index = 0; index < Math.max(item.text.rows.length, 1); index++) {
      ensure(leading);
      if (item.kind === "bullet" && index === 0)
        page.drawText("•", { x: left + 2, y: y - body, font: regular, size: body });
      const text = item.text.rows[index];
      if (text) page.drawText(text, { x: left + indent, y: y - body, font: item.text.font, size: body });
      y -= leading;
    }
    y -= item.kind === "bullet" ? 3 : 5;
  };
  for (const block of presentation.blocks) {
    if (block.kind === "section") {
      pendingSections.push(run(block.title, width, 12, true));
      continue;
    }
    if (block.kind !== "experience") {
      const item = prepareItem(block);
      ensure(sectionHeight() + Math.min(Math.max(item.text.height, leading), leading * 2));
      drawSections();
      drawItem(item);
      continue;
    }
    const gap = 14;
    const dateWidth = 112;
    const companyWidth = (width - dateWidth - gap * 2) * 0.48;
    const roleWidth = width - dateWidth - gap * 2 - companyWidth;
    let company = run(block.company, companyWidth, body, true);
    let role = run(block.role, roleWidth, body, true, true);
    let dates = run(block.dates ?? "", dateWidth);
    const location = run(block.location ?? "", width);
    // Preserve the classic single-line heading. Wrapped fields must flow in
    // semantic order rather than interleaving company, role and date fragments.
    const stacked = modern || Math.max(company.rows.length, role.rows.length, dates.rows.length) > 1;
    if (stacked) {
      company = run(block.company, width, body, true);
      role = run(block.role, width, body, true, true);
      dates = run(block.dates ?? "", width);
    }
    const headerRows = stacked ? company.rows.length + role.rows.length + dates.rows.length
      : Math.max(company.rows.length, role.rows.length, dates.rows.length);
    const headerHeight = headerRows * leading + location.height + 5;
    const items = block.items.map(prepareItem);
    const firstContentHeight = Math.min(items[0]?.text.height ?? 0, leading * 2);
    // Keep an ordinary role together when it fits on one page. Longer career
    // entries still flow without truncation, keeping the heading with content.
    const groupHeight = sectionHeight() + headerHeight + 7 +
      items.reduce((height, item) => height + Math.max(item.text.height, leading) + (item.kind === "bullet" ? 3 : 5), 0);
    ensure(groupHeight <= top - bottom ? groupHeight : Math.min(sectionHeight() + headerHeight + firstContentHeight, top - bottom));
    drawSections(Math.min(headerHeight + firstContentHeight, leading * 3));
    if (stacked) {
      drawFlow(company, "left", leading);
      drawFlow(role, "left", leading);
      drawFlow(dates, "left", Math.min(location.height + 5 + firstContentHeight, top - bottom - leading));
    } else {
      ensure(leading + Math.min(location.height + 5 + firstContentHeight, top - bottom - leading));
      drawRow(company, 0, left, companyWidth);
      drawRow(role, 0, left + companyWidth + gap, roleWidth);
      drawRow(dates, 0, right - dateWidth, dateWidth, "right");
      y -= leading;
    }
    drawFlow(location, "left", 5 + firstContentHeight);
    y -= 5;
    for (const item of items) drawItem(item);
    y -= 7;
  }
  if (pendingSections.length) {
    ensure(sectionHeight());
    drawSections(0);
  }
  return pdf;
}

export interface CareerPdfTextValidation {
  passed: boolean;
  expectedTokens: number;
  recoveredTokens: number;
  /** Missing occurrences, in expected order; repeated words retain multiplicity. */
  missingTokens: string[];
  /** Exact normalized sequence equality, including duplicate occurrences. */
  orderPreserved: boolean;
  pages: number;
}

function pdfTextTokens(text: string): Array<{ text: string; lineBreakBefore: boolean }> {
  const normalized = text.normalize("NFKC")
    .replace(/\r\n?|\f/g, "\n")
    .replace(/\u00ad/g, "")
    .replace(/[•●▪◦‣]/g, " ")
    .replace(/^[ \t]*[-*][ \t]+/gm, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
  const tokens: Array<{ text: string; lineBreakBefore: boolean }> = [];
  let previousEnd = 0;
  for (const match of normalized.matchAll(/[\p{L}\p{M}\p{N}_]+|[^\s]/gu)) {
    tokens.push({ text: match[0], lineBreakBefore: normalized.slice(previousEnd, match.index).includes("\n") });
    previousEnd = match.index! + match[0].length;
  }
  return tokens;
}

/**
 * Reparse the emitted bytes, not the layout model. This is a text-fidelity
 * check only: it makes no visual-review or universal ATS-compatibility claim.
 */
export async function validateCareerPdfText(
  { bytes, expectedText, pageNumberFooter = false }: { bytes: Uint8Array; expectedText: string; pageNumberFooter?: boolean },
): Promise<CareerPdfTextValidation> {
  const expected = pdfTextTokens(expectedText).map(token => token.text);
  let parser: PDFParse | undefined;
  let recovered: string[] = [];
  let pages = 0;
  try {
    // PDF.js transfers its input buffer; leave the caller's export intact.
    parser = new PDFParse({ data: Uint8Array.from(bytes), isEvalSupported: false,
      useWorkerFetch: false, stopAtErrors: true, verbosity: 0 });
    const result = await parser.getText({ pageJoiner: "", cellSeparator: " ", parseHyperlinks: false });
    pages = result.total;
    const extracted = pdfTextTokens(result.pages.map((page, index) => {
      if (!pageNumberFooter) return page.text;
      // Cover letters have a renderer-owned page counter; require its exact
      // page/total values at the page foot, never strip arbitrary footer text.
      const footer = new RegExp(`(?:^|\\n)\\s*${index + 1}\\s*/\\s*${result.total}\\s*$`);
      if (!footer.test(page.text)) throw new Error("The expected page counter is missing.");
      return page.text.replace(footer, "");
    }).join("\n"));
    for (let index = 0; index < extracted.length; index++) {
      let token = extracted[index].text;
      const target = expected[recovered.length];
      let joined = token, matchedEnd = index;
      // The renderer can split an overlong word across lines/pages without
      // inserting a hyphen. Rejoin only newline-separated word fragments that
      // form an exact expected token; never discard a fragment or punctuation.
      if (target !== token && target?.startsWith(token) && /^[\p{L}\p{M}\p{N}_]+$/u.test(token)) {
        for (let next = index + 1; next < extracted.length && extracted[next].lineBreakBefore; next++) {
          if (!/^[\p{L}\p{M}\p{N}_]+$/u.test(extracted[next].text)) break;
          joined += extracted[next].text;
          if (!target.startsWith(joined)) break;
          if (joined === target) { token = joined; matchedEnd = next; break; }
        }
      }
      recovered.push(token);
      index = matchedEnd;
    }
  } catch {
    // Corrupt/unreadable bytes fail closed with every expected token missing.
    recovered = [];
    pages = 0;
  } finally {
    if (parser) await parser.destroy().catch(() => {});
  }
  const available = new Map<string, number>();
  for (const token of recovered) available.set(token, (available.get(token) ?? 0) + 1);
  const missingTokens: string[] = [];
  for (const token of expected) {
    const count = available.get(token) ?? 0;
    if (count) available.set(token, count - 1);
    else missingTokens.push(token);
  }
  const orderPreserved = expected.length === recovered.length && expected.every((token, index) => token === recovered[index]);
  return { passed: pages > 0 && expected.length > 0 && orderPreserved,
    expectedTokens: expected.length, recoveredTokens: recovered.length, missingTokens, orderPreserved, pages };
}

export async function renderCareerPdf(
  title: string,
  paragraphs: string[],
): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(title);
  pdf.setProducer("JobStash");
  const font = await pdf.embedFont(
    await readFile(join(__dirname, "assets/NotoSans-Regular.ttf")),
    { subset: true },
  );
  const supported = new Set(font.getCharacterSet());
  for (const text of [title, ...paragraphs])
    for (const ch of cleanPdfText(text))
      if (!/\s/.test(ch) && !supported.has(ch.codePointAt(0)!))
        throw new BadRequestException(
          "An export character is not supported by the document font. Edit the text before exporting.",
        );
  let page = pdf.addPage([595.28, 841.89]);
  let y = 786;
  const line = (text: string, size: number): void => {
    if (y < 65) {
      page = pdf.addPage([595.28, 841.89]);
      y = 786;
    }
    page.drawText(text, { x: 52, y, font, size, color: rgb(0.12, 0.15, 0.18) });
    y -= size * 1.55;
  };
  const paragraph = (text: string, size: number): void => {
    const lines: string[] = [];
    for (const raw of cleanPdfText(text).split("\n")) {
      let current = "";
      for (const word of raw.split(/\s+/)) {
        const next = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) > 490) {
          if (current) lines.push(current);
          current = "";
          for (const ch of word) {
            if (font.widthOfTextAtSize(current + ch, size) > 490) {
              lines.push(current);
              current = "";
            }
            current += ch;
          }
        } else current = next;
      }
      if (current) lines.push(current);
    }
    // Keep each ordinary evidence paragraph together. Longer passages may span
    // pages, but leave room for at least two lines before starting one.
    const height = lines.length * size * 1.55;
    if (
      (y < 786 && y - Math.min(height, size * 1.55 * 2) < 65) ||
      (height <= 721 && y - height < 65)
    ) {
      page = pdf.addPage([595.28, 841.89]);
      y = 786;
    }
    for (const textLine of lines) line(textLine, size);
    y -= 12;
  };
  paragraph(title, 20);
  for (const text of paragraphs)
    for (const block of text.split(/\r?\n(?:[ \t]*\r?\n)+/))
      if (block.trim()) paragraph(block, 11);
  const pages = pdf.getPages();
  pages.forEach((p, i) =>
    p.drawText(`${i + 1} / ${pages.length}`, {
      x: 520,
      y: 30,
      font,
      size: 8,
      color: rgb(0.45, 0.45, 0.45),
    }),
  );
  return Buffer.from(await pdf.save());
}
