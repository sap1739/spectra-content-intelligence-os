import { createHash } from 'node:crypto';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Tracking/campaign params stripped before hashing so shared links dedupe.
 * Broadened in 5F: the same article arriving from a newsletter, a social share
 * and a search result was producing three "distinct" sources, which inflated
 * apparent source diversity (ADR-0030).
 */
// Prefix families (utm_campaign, vero_id, …) and exact keys, kept separate so
// `utm_` still matches every UTM variant rather than only the literal "utm_".
const TRACKING_PREFIX = /^(utm_|vero_|oly_|at_|pk_|piwik_|_hs)/i;
const TRACKING_EXACT =
  /^(fbclid|gclid|dclid|gbraid|wbraid|msclkid|twclid|igshid|mc_cid|mc_eid|s_cid|cmpid|campaign_id|ito|spm|scm|share|shared|src|source|ref|referrer)$/i;

function isTrackingParam(key: string): boolean {
  return TRACKING_PREFIX.test(key) || TRACKING_EXACT.test(key);
}

/** `www.` and `m.`/`amp.` host variants of the same site. */
const HOST_PREFIX = /^(www|m|amp)\./;

/** Canonical URL form for exact-duplicate detection. */
export function normalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = '';
  url.protocol = url.protocol.toLowerCase();
  // http and https of the same page are the same page.
  if (url.protocol === 'http:') url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase().replace(HOST_PREFIX, '');
  // Default ports carry no meaning.
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }

  // AMP and index documents address the same content as their canonical page.
  let pathname = url.pathname
    .replace(/\/amp\/?$/i, '/')
    .replace(/\.amp$/i, '')
    .replace(/\/index\.(html?|php|aspx?)$/i, '/');
  // Collapse duplicate slashes and drop a trailing one (except at the root).
  pathname = pathname.replace(/\/{2,}/g, '/');
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  url.pathname = pathname === '' ? '/' : pathname;

  const kept = [...url.searchParams.entries()]
    .filter(([key]) => !isTrackingParam(key))
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
