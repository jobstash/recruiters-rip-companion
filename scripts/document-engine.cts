import { CandidateDocumentCodec, CandidateDocumentFile } from "../src/documents/candidate-document-codec";

export { measureCareerCvLayout, renderCareerCvPdf, renderCareerCvText, validateCareerPdfText, renderCareerPdf } from "../src/documents/career-pdf";
export { buildStructuredCvPresentation } from "../src/documents/cv-document-layout";
export { CandidateDocumentCodec };

const codec = new CandidateDocumentCodec();

/** The native picker supplies bytes; no caller-provided paths or URLs are read. */
export async function extractFile(file: CandidateDocumentFile) {
  if (file.mimetype === "text/plain") {
    if (!Buffer.isBuffer(file.buffer) || file.size !== file.buffer.length || file.size > 5 * 1024 * 1024)
      throw new Error("Choose a text CV no larger than 5 MiB.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(file.buffer);
    if (!text.trim() || text.length > 100000 || /[\x00-\x08\x0b\x0e-\x1f]/.test(text))
      throw new Error("Choose a readable UTF-8 text CV with at most 100000 characters.");
    return { text, pageCount: 1, provenance: { method: "plain_text", visibility: "text", limitations: "Plain text contains no visual layout. Original bytes are retained." } };
  }
  const { contentType } = codec.validate(file);
  return codec.extract(file.buffer, contentType);
}
