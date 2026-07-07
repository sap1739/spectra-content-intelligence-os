import { createHash } from 'node:crypto';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Tracking params stripped before hashing so shared links dedupe. */
const TRACKING_PARAM = /^(utm_|fbclid|gclid|mc_cid|mc_eid|ref$)/i;

/** Canonical URL form for exact-duplicate detection. */
export function normalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  const kept = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAM.test(key))
    .sort(([a], [b]) => a.localeCompare(b));
  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);
  let out = url.toString();
  if (out.endsWith('/') && url.pathname === '/' && !url.search) out = out.slice(0, -1);
  return out;
}

export function urlHash(rawUrl: string): string {
  return sha256Hex(normalizeUrl(rawUrl));
}

/** Normalized title key for near-duplicate clustering across publishers. */
export function titleKey(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      // eslint-disable-next-line no-misleading-character-class -- Devanagari/Bengali blocks intentionally include combining matras; without them every Bengali headline collapses to one key
      .replace(/[^a-z0-9\u0900-\u097f\u0980-\u09ff ]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}
