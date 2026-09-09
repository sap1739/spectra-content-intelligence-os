import type { TenantScope } from '@spectra/contracts';
import { scanForPromptInjection } from '@spectra/knowledge-core';
import type {
  DocumentCitationAnchor,
  DocumentExtractionInput,
  DocumentExtractionProvider,
  DocumentExtractionResult,
  ExtractableDocumentType,
  ExtractedDocument,
  ExtractedDocumentMetadata,
  ExtractedPage,
  ExtractedSection,
} from '@spectra/research-core';

import { MAX_BYTES_BY_TYPE, isLegacyWord, resolveDocumentType, safeFilename } from './limits';

/**
 * First-party document extraction (ADR-0031).
 *
 * Turns PDF/DOCX/TXT/Markdown bytes into plain text with **citation anchors**:
 * a page number for PDFs, a section for DOCX/Markdown, a line range for text.
 * Anchors are the reason this exists — a claim drawn from a 200-page PDF has to
 * be traceable to the page it came from, or the citation is decorative.
 *
 * Three rules hold throughout:
 *
 * 1. **Limits before parsers.** MIME and size are checked before any bytes
 *    reach a parser, because a parser is the largest attack surface here.
 * 2. **Extracted text is untrusted.** It is prompt-injection scanned exactly
 *    like scraped web content. A PDF is not more trustworthy than a web page.
 * 3. **Partial is never reported as complete.** A PDF whose pages yield no text
 *    fails with NO_TEXT_LAYER rather than returning an empty-but-successful
 *    document; a partly-empty one succeeds carrying warnings.
 */
export class FirstPartyDocumentExtractor implements DocumentExtractionProvider {
  public readonly id = 'first-party-document-extraction';
  public readonly kind = 'document-extraction' as const;
  public readonly displayName = 'First-party document extraction (PDF/DOCX/TXT/Markdown)';

  supports(mimeType: string, filename?: string): boolean {
    return resolveDocumentType(mimeType, filename) !== null;
  }

  async extract(
    input: DocumentExtractionInput,
    _tenant: TenantScope,
  ): Promise<DocumentExtractionResult> {
    const filename = safeFilename(input.filename);
    const sizeBytes = input.bytes.byteLength;

    if (isLegacyWord(input.mimeType, filename)) {
      // Rejected explicitly rather than fed to the DOCX (OOXML) parser, which
      // would fail confusingly on the old binary format.
      return failure('UNSUPPORTED_MIME', {
        message:
          'Legacy .doc (binary Word) is not supported. Convert it to .docx or PDF to use it as evidence.',
        mimeType: input.mimeType,
        sizeBytes,
      });
    }

    const documentType = resolveDocumentType(input.mimeType, filename);
    if (!documentType) {
      return failure('UNSUPPORTED_MIME', {
        message: `No extractor exists for "${input.mimeType}". The source is kept, but its text was not read.`,
        mimeType: input.mimeType,
        sizeBytes,
      });
    }

    const limit = MAX_BYTES_BY_TYPE[documentType];
    if (sizeBytes > limit) {
      return failure('FILE_TOO_LARGE', {
        message: `The document is ${mb(sizeBytes)}MB, over the ${mb(limit)}MB limit for ${documentType}. It was not parsed.`,
        mimeType: input.mimeType,
        sizeBytes,
      });
    }
    if (sizeBytes === 0) {
      return failure('CORRUPT', {
        message: 'The document is empty (0 bytes).',
        mimeType: input.mimeType,
        sizeBytes,
      });
    }

    try {
      const parsed =
        documentType === 'PDF'
          ? await extractPdf(input.bytes)
          : documentType === 'DOCX'
            ? await extractDocx(input.bytes)
            : extractPlainText(input.bytes, documentType);

      if ('failureCode' in parsed) {
        return failure(parsed.failureCode, {
          message: parsed.message,
          mimeType: input.mimeType,
          sizeBytes,
        });
      }

      const metadata: ExtractedDocumentMetadata = {
        ...parsed.metadata,
        mimeType: input.mimeType,
        sizeBytes,
        ...(parsed.metadata.title ? {} : filename ? { title: filename } : {}),
      };

      // MANDATORY: document text reaches prompts exactly like web content.
      const injectionRisk = scanForPromptInjection(parsed.text, {
        kind: 'UPLOADED_DOCUMENT',
        refId: input.sourceRef,
      });

      const document: ExtractedDocument = {
        documentType,
        text: parsed.text,
        pages: parsed.pages,
        sections: parsed.sections,
        metadata,
        anchors: parsed.anchors,
        injectionRisk,
        warnings: parsed.warnings,
      };
      return { ok: true, document };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Encrypted PDFs surface as a password error from the parser.
      const code = /password|encrypt/i.test(message) ? 'ENCRYPTED' : 'PARSER_ERROR';
      return failure(code, {
        // The parser message can echo document content, so it is summarised
        // rather than passed through verbatim (never log document text).
        message:
          code === 'ENCRYPTED'
            ? 'The document is password-protected, so its text could not be read.'
            : `The ${documentType} could not be parsed.`,
        mimeType: input.mimeType,
        sizeBytes,
      });
    }
  }
}

interface ParsedDocument {
  text: string;
  pages: ExtractedPage[];
  sections: ExtractedSection[];
  anchors: DocumentCitationAnchor[];
  metadata: Partial<ExtractedDocumentMetadata>;
  warnings: string[];
}

interface ParseFailure {
  failureCode: 'NO_TEXT_LAYER' | 'CORRUPT' | 'PARSER_ERROR';
  message: string;
}

/**
 * PDF → per-page text.
 *
 * `unpdf` wraps pdf.js for Node without a worker/canvas setup. Pages are kept
 * separate (not merged) precisely so each one can become a citation anchor.
 * Loaded via dynamic import because the library is ESM and this package emits
 * CJS.
 */
async function extractPdf(bytes: Uint8Array): Promise<ParsedDocument | ParseFailure> {
  const { extractText, getDocumentProxy, getMeta } = await import('unpdf');
  // pdf.js rejects a Node Buffer even though it subclasses Uint8Array, and
  // safeFetch hands us Buffers — copy into a plain Uint8Array. (A Buffer is a
  // view onto a pooled ArrayBuffer, so this must copy, not re-wrap.)
  const pdf = await getDocumentProxy(new Uint8Array(bytes));

  const [{ text: pageTexts, totalPages }, meta] = await Promise.all([
    extractText(pdf, { mergePages: false }),
    getMeta(pdf).catch(() => null),
  ]);

  const pages: ExtractedPage[] = [];
  const anchors: DocumentCitationAnchor[] = [];
  const warnings: string[] = [];
  let text = '';
  let emptyPages = 0;

  const rawPages = Array.isArray(pageTexts) ? pageTexts : [String(pageTexts ?? '')];
  for (let i = 0; i < rawPages.length; i += 1) {
    const pageNumber = i + 1;
    const pageText = normalizeWhitespace(String(rawPages[i] ?? ''));
    if (pageText.length === 0) {
      emptyPages += 1;
      continue;
    }
    const charStart = text.length;
    text += (text.length > 0 ? '\n\n' : '') + pageText;
    const charEnd = text.length;
    pages.push({ pageNumber, text: pageText, charStart, charEnd });
    anchors.push({
      kind: 'PAGE',
      pageNumber,
      charStart,
      charEnd,
      label: `p. ${pageNumber}`,
    });
  }

  if (pages.length === 0) {
    // A scanned PDF with no text layer. We do NOT OCR it; we say so, so the
    // source is honestly unusable rather than silently empty.
    return {
      failureCode: 'NO_TEXT_LAYER',
      message: `The PDF has no extractable text layer across its ${totalPages ?? rawPages.length} page(s) — it is most likely scanned images. OCR is not performed, so no text was extracted.`,
    };
  }
  if (emptyPages > 0) {
    warnings.push(
      `${emptyPages} of ${rawPages.length} page(s) contained no extractable text and are absent from the extracted content.`,
    );
  }

  const info = (meta?.info ?? {}) as Record<string, unknown>;
  return {
    text,
    pages,
    sections: [],
    anchors,
    metadata: {
      ...str(info['Title'], (v) => ({ title: v })),
      ...str(info['Author'], (v) => ({ author: v })),
      ...str(info['Producer'], (v) => ({ producer: v })),
      ...pdfDate(info['CreationDate'], (v) => ({ createdAt: v })),
      ...pdfDate(info['ModDate'], (v) => ({ modifiedAt: v })),
      pageCount: totalPages ?? rawPages.length,
    },
    warnings,
  };
}

/**
 * DOCX → ordered sections.
 *
 * Mammoth converts to semantic HTML, which preserves heading levels; we split
 * on headings so a citation can name the section it came from.
 */
async function extractDocx(bytes: Uint8Array): Promise<ParsedDocument | ParseFailure> {
  const mammoth = await import('mammoth');
  const { value: html, messages } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });

  const blocks = [...html.matchAll(/<(h[1-6]|p)[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => ({
    tag: (m[1] ?? 'p').toLowerCase(),
    content: decodeEntities(stripTags(m[2] ?? '')).trim(),
  }));

  const sections: ExtractedSection[] = [];
  const anchors: DocumentCitationAnchor[] = [];
  let text = '';
  let current: { heading?: string; level?: number; body: string[] } = { body: [] };

  const flush = () => {
    const body = current.body.join('\n\n').trim();
    if (!body && !current.heading) return;
    const order = sections.length;
    const headingLine = current.heading ? `${current.heading}\n\n` : '';
    const sectionText = `${headingLine}${body}`.trim();
    if (!sectionText) return;
    const charStart = text.length;
    text += (text.length > 0 ? '\n\n' : '') + sectionText;
    const charEnd = text.length;
    sections.push({
      order,
      ...(current.heading ? { heading: current.heading } : {}),
      ...(current.level ? { level: current.level } : {}),
      text: sectionText,
      charStart,
      charEnd,
    });
    anchors.push({
      kind: 'SECTION',
      sectionOrder: order,
      charStart,
      charEnd,
      label: current.heading ? `§ ${current.heading}` : `§ section ${order + 1}`,
    });
  };

  for (const block of blocks) {
    if (!block.content) continue;
    if (block.tag.startsWith('h')) {
      flush();
      current = { heading: block.content, level: Number(block.tag.slice(1)), body: [] };
    } else {
      current.body.push(block.content);
    }
  }
  flush();

  if (sections.length === 0) {
    return {
      failureCode: 'NO_TEXT_LAYER',
      message: 'The DOCX contained no readable paragraphs or headings.',
    };
  }

  const warnings = messages
    .filter((m) => m.type === 'warning')
    .slice(0, 5)
    .map((m) => `Converter warning: ${m.message}`);

  return { text, pages: [], sections, anchors, metadata: {}, warnings };
}

/** Plain text / Markdown → line-anchored chunks. */
function extractPlainText(
  bytes: Uint8Array,
  type: ExtractableDocumentType,
): ParsedDocument | ParseFailure {
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const text = decoded.replace(/\r\n/g, '\n').trim();
  if (text.length === 0) {
    return { failureCode: 'CORRUPT', message: 'The file contained no readable text.' };
  }

  // Anchor on blank-line-separated blocks, recording their real line numbers so
  // a citation can point at "lines 40–48" of the original file.
  const lines = text.split('\n');
  const sections: ExtractedSection[] = [];
  const anchors: DocumentCitationAnchor[] = [];
  let blockLines: string[] = [];
  let blockStartLine = 1;
  let cursor = 0;

  const flush = (endLine: number) => {
    const body = blockLines.join('\n').trim();
    if (!body) return;
    const order = sections.length;
    const charStart = text.indexOf(body, cursor);
    const start = charStart === -1 ? cursor : charStart;
    const charEnd = start + body.length;
    cursor = charEnd;
    // A Markdown ATX heading makes a better label than a line range.
    const headingMatch = type === 'MARKDOWN' ? /^#{1,6}\s+(.+)$/.exec(blockLines[0] ?? '') : null;
    const heading = headingMatch?.[1]?.trim();
    sections.push({
      order,
      ...(heading ? { heading } : {}),
      text: body,
      charStart: start,
      charEnd,
    });
    anchors.push({
      kind: heading ? 'SECTION' : 'LINE',
      ...(heading ? { sectionOrder: order } : {}),
      lineStart: blockStartLine,
      lineEnd: endLine,
      charStart: start,
      charEnd,
      label: heading ? `§ ${heading}` : `lines ${blockStartLine}-${endLine}`,
    });
    blockLines = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      flush(i);
      blockStartLine = i + 2;
      continue;
    }
    if (blockLines.length === 0) blockStartLine = i + 1;
    blockLines.push(line);
  }
  flush(lines.length);

  return { text, pages: [], sections, anchors, metadata: {}, warnings: [] };
}

// ----- helpers --------------------------------------------------------------

function failure(
  code:
    | 'UNSUPPORTED_MIME'
    | 'FILE_TOO_LARGE'
    | 'ENCRYPTED'
    | 'CORRUPT'
    | 'NO_TEXT_LAYER'
    | 'PARSER_ERROR',
  detail: { message: string; mimeType?: string; sizeBytes?: number },
): DocumentExtractionResult {
  return {
    ok: false,
    failure: {
      code,
      message: detail.message,
      ...(detail.mimeType ? { mimeType: detail.mimeType } : {}),
      ...(detail.sizeBytes !== undefined ? { sizeBytes: detail.sizeBytes } : {}),
    },
  };
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function str<T>(value: unknown, map: (v: string) => T): T | Record<string, never> {
  return typeof value === 'string' && value.trim().length > 0 ? map(value.trim()) : {};
}

/** PDF dates look like `D:20260115120000Z`. Anything else is left out. */
function pdfDate<T>(value: unknown, map: (v: string) => T): T | Record<string, never> {
  if (typeof value !== 'string') return {};
  const m = /^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/.exec(value.trim());
  if (!m) return {};
  const [, y, mo, d, h = '00', mi = '00', se = '00'] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${se}.000Z`;
  return Number.isNaN(Date.parse(iso)) ? {} : map(iso);
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
