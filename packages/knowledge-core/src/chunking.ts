/**
 * Deterministic text chunking for RAG ingestion. Character-based windows with
 * overlap; splits prefer paragraph, then sentence boundaries. Deterministic:
 * the same input always yields the same chunks (stable re-indexing).
 */

export interface ChunkingOptions {
  /** Maximum characters per chunk. */
  maxChars: number;
  /** Characters of overlap between consecutive chunks. */
  overlapChars: number;
}

export const DEFAULT_CHUNKING: ChunkingOptions = { maxChars: 2000, overlapChars: 200 };

export interface TextChunk {
  index: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

function findBreakpoint(text: string, from: number, to: number): number {
  const window = text.slice(from, to);
  const paragraph = window.lastIndexOf('\n\n');
  if (paragraph > window.length * 0.3) return from + paragraph + 2;
  const sentence = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
  );
  if (sentence > window.length * 0.3) return from + sentence + 2;
  return to;
}

export function chunkText(text: string, options: ChunkingOptions = DEFAULT_CHUNKING): TextChunk[] {
  if (
    options.maxChars <= 0 ||
    options.overlapChars < 0 ||
    options.overlapChars >= options.maxChars
  ) {
    throw new Error('Invalid chunking options: require 0 <= overlapChars < maxChars');
  }
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length === 0) return [];

  const chunks: TextChunk[] = [];
  let start = 0;
  let index = 0;
  while (start < normalized.length) {
    const hardEnd = Math.min(start + options.maxChars, normalized.length);
    const end =
      hardEnd === normalized.length ? hardEnd : findBreakpoint(normalized, start, hardEnd);
    const body = normalized.slice(start, end).trim();
    if (body.length > 0) {
      chunks.push({ index, text: body, startOffset: start, endOffset: end });
      index += 1;
    }
    if (end >= normalized.length) break;
    start = Math.max(end - options.overlapChars, start + 1);
  }
  return chunks;
}
