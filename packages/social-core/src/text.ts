function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Plain text for platforms that render no markup. HTML bodies (written for
 * WordPress, say) are flattened: paragraphs and line breaks become newlines,
 * list items become bullets, tags are dropped, basic entities decoded.
 */
export function toPlainText(body: string): string {
  const normalized = body.replace(/\r\n?/g, '\n');
  if (!/<\/?[a-z][^>]*>/i.test(normalized)) return normalized.trim();
  return decodeEntities(
    normalized
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
