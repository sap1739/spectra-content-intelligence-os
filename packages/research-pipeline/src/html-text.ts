/**
 * Deterministic HTML → plain-text extraction for feed item content.
 * This is content extraction, not sanitization for display — output is
 * always treated as untrusted data downstream (injection scan + wrapping).
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
  reg: '®',
  trade: '™',
};

export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(
      /&([a-zA-Z]+);/g,
      (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match,
    );
}

export function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const withBreaks = withoutBlocks
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n');

  const stripped = withBreaks.replace(/<[^>]+>/g, ' ');

  return decodeEntities(stripped)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
