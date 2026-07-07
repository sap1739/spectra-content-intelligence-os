import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF-contained fetch for research providers.
 *
 * Controls: http(s) only; hostname + resolved-IP checks against private/
 * loopback/link-local/metadata ranges; manual redirect following with
 * re-validation per hop; timeout; response size cap.
 *
 * Known limitation (documented in SECURITY.md): DNS resolution is checked
 * once before fetching — a TOCTOU rebinding window remains. Acceptable for
 * user-supplied feed URLs in Phase 2; a pinned-IP dialer closes it later.
 */

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Test/dev escape hatch for localhost fixture servers. NEVER in prod. */
  allowPrivateHosts?: boolean;
  userAgent?: string;
  maxRedirects?: number;
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

export class FetchLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchLimitError';
  }
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);
const BLOCKED_SUFFIXES = ['.local', '.internal', '.localdomain'];

function isPrivateIpv4(ip: string): boolean {
  const octets = ip.split('.').map(Number);
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fe80:') || // link-local
    lower.startsWith('fc') || // unique local fc00::/7
    lower.startsWith('fd') ||
    lower.startsWith('::ffff:') // v4-mapped — re-check the v4 part
  );
}

function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) {
    if (ip.toLowerCase().startsWith('::ffff:')) {
      const v4 = ip.slice(ip.lastIndexOf(':') + 1);
      return isIP(v4) === 4 ? isPrivateIpv4(v4) : true;
    }
    return isPrivateIpv6(ip);
  }
  return false;
}

/** Validates protocol/hostname shape. Throws UnsafeUrlError on violations. */
export function assertSafeUrl(rawUrl: string, allowPrivateHosts = false): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError(`Unsupported protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError('Credentials in URLs are not allowed');
  }
  if (allowPrivateHosts) return url;

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s))) {
    throw new UnsafeUrlError(`Blocked hostname: ${hostname}`);
  }
  if (isIP(hostname) && isPrivateIp(hostname)) {
    throw new UnsafeUrlError(`Blocked private address: ${hostname}`);
  }
  return url;
}

async function assertResolvesPublic(url: URL): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) return; // literal already validated
  let address: string;
  try {
    ({ address } = await lookup(hostname));
  } catch {
    throw new UnsafeUrlError(`Cannot resolve hostname: ${hostname}`);
  }
  if (isPrivateIp(address)) {
    throw new UnsafeUrlError(`Hostname resolves to a private address: ${hostname}`);
  }
}

export interface SafeFetchResult {
  status: number;
  contentType: string;
  body: Buffer;
  finalUrl: string;
}

export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const {
    timeoutMs = 10_000,
    maxBytes = 2 * 1024 * 1024,
    allowPrivateHosts = false,
    userAgent = 'SpectraResearchBot/0.1 (+https://github.com/sap1739/spectra-content-intelligence-os)',
    maxRedirects = 3,
  } = options;

  let url = assertSafeUrl(rawUrl, allowPrivateHosts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('fetch timeout')), timeoutMs);

  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (!allowPrivateHosts) {
        await assertResolvesPublic(url);
      }
      const response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': userAgent,
          accept:
            'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5',
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new FetchLimitError('Redirect without location');
        url = assertSafeUrl(new URL(location, url).toString(), allowPrivateHosts);
        continue;
      }

      const chunks: Buffer[] = [];
      let received = 0;
      if (response.body) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          received += chunk.byteLength;
          if (received > maxBytes) {
            controller.abort();
            throw new FetchLimitError(`Response exceeds ${maxBytes} bytes`);
          }
          chunks.push(Buffer.from(chunk));
        }
      }
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        body: Buffer.concat(chunks),
        finalUrl: url.toString(),
      };
    }
    throw new FetchLimitError(`Too many redirects (> ${maxRedirects})`);
  } finally {
    clearTimeout(timer);
  }
}
