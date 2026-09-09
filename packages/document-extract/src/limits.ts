import type { ExtractableDocumentType } from '@spectra/research-core';

/**
 * MIME and size policy for document extraction (ADR-0031).
 *
 * Enforced BEFORE any parser touches the bytes: a parser is a large attack
 * surface, and the cheapest defence against a malicious or malformed document
 * is never handing it to one.
 */

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/** Per-type caps — a 25MB "text file" is not a text file. */
export const MAX_BYTES_BY_TYPE: Record<ExtractableDocumentType, number> = {
  PDF: MAX_DOCUMENT_BYTES,
  DOCX: 15 * 1024 * 1024,
  TXT: 5 * 1024 * 1024,
  MARKDOWN: 5 * 1024 * 1024,
};

const MIME_TO_TYPE: Record<string, ExtractableDocumentType> = {
  'application/pdf': 'PDF',
  'application/x-pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'text/plain': 'TXT',
  'text/markdown': 'MARKDOWN',
  'text/x-markdown': 'MARKDOWN',
};

const EXTENSION_TO_TYPE: Record<string, ExtractableDocumentType> = {
  pdf: 'PDF',
  docx: 'DOCX',
  txt: 'TXT',
  text: 'TXT',
  md: 'MARKDOWN',
  markdown: 'MARKDOWN',
};

/**
 * Resolves a document type from the served MIME type, falling back to the
 * filename extension.
 *
 * Deliberately NOT content-sniffing: we act on what the server declared or the
 * file is named. Guessing a type from bytes would mean parsing something the
 * source never claimed it was.
 */
export function resolveDocumentType(
  mimeType: string,
  filename?: string,
): ExtractableDocumentType | null {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  const byMime = MIME_TO_TYPE[base];
  if (byMime) return byMime;

  // application/octet-stream is common for downloads; fall back to the name.
  const ext = filename?.split('.').pop()?.toLowerCase();
  if (ext && EXTENSION_TO_TYPE[ext]) return EXTENSION_TO_TYPE[ext] ?? null;
  return null;
}

/** Legacy .doc is explicitly rejected rather than mis-parsed as DOCX. */
export function isLegacyWord(mimeType: string, filename?: string): boolean {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return base === 'application/msword' || (filename?.toLowerCase().endsWith('.doc') ?? false);
}

/** Control characters that would corrupt logs or citation labels. */
// eslint-disable-next-line no-control-regex -- removing control chars is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Sanitises a filename for logging and citation labels.
 *
 * Strips any directory component, so a crafted name such as `../../etc/passwd`
 * can never be used as a path segment downstream, and removes control
 * characters that would corrupt logs.
 */
export function safeFilename(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  const base = filename.split(/[/\\]/).pop() ?? '';
  const cleaned = base.replace(CONTROL_CHARS, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return undefined;
  return cleaned.slice(0, 255);
}
