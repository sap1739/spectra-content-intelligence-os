import type { SocialPlatform } from '@spectra/contracts';
import type {
  PostPublisher,
  PublishInput,
  PublishOutcome,
  SocialPublisherRegistry,
} from '@spectra/social-core';

/**
 * WordPress publisher — the first LIVE platform adapter.
 *
 * It posts to the WordPress REST API (`POST {site}/wp-json/wp/v2/posts`) using
 * an Application Password (WordPress 5.6+) over HTTP Basic auth. No OAuth dance:
 * the operator generates an application password in their WordPress profile and
 * stores `username:application-password` as this account's sealed credential.
 *
 * Honesty: this makes a real HTTP request to a real site. It is only ever
 * constructed for an account that has a stored credential (see the worker), so
 * an unconfigured platform still resolves to UNSUPPORTED rather than a fake
 * success. Failures from WordPress are surfaced verbatim (status + trimmed
 * body), never swallowed into a pretend "published".
 */

export const WORDPRESS_PLATFORM: SocialPlatform = 'WORDPRESS';
export const WORDPRESS_ADAPTER_VERSION = 'wordpress-rest-1.0.0';

/** Marks WordPress as having a real adapter available (the "wired" UI signal). */
export function registerWordPressAdapter(registry: SocialPublisherRegistry): void {
  registry.markWired(WORDPRESS_PLATFORM);
}

export interface WordPressCredentials {
  /** Base site URL, e.g. `https://blog.example.com` (http/https only). */
  siteUrl: string;
  username: string;
  /** WordPress application password (spaces allowed). */
  applicationPassword: string;
}

export class WordPressCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WordPressCredentialError';
  }
}

/**
 * Parses a sealed credential of the form `username:application password` into
 * structured credentials. Splits on the FIRST colon so the application password
 * may itself contain colons; usernames may not.
 */
export function parseWordPressCredential(siteUrl: string, secret: string): WordPressCredentials {
  const colon = secret.indexOf(':');
  if (colon < 1) {
    throw new WordPressCredentialError('credential must be "username:application-password"');
  }
  const username = secret.slice(0, colon).trim();
  const applicationPassword = secret.slice(colon + 1).trim();
  if (!username || !applicationPassword) {
    throw new WordPressCredentialError('credential is missing a username or application password');
  }
  return { siteUrl, username, applicationPassword };
}

function normalizeSiteUrl(siteUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(siteUrl);
  } catch {
    throw new WordPressCredentialError(`invalid WordPress site URL: ${siteUrl}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new WordPressCredentialError(`WordPress site URL must be http(s): ${siteUrl}`);
  }
  // Drop any trailing slash so we can append the REST path cleanly.
  return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
}

export interface WordPressPublisherOptions {
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Request timeout in ms (default 20s). */
  timeoutMs?: number;
}

export class WordPressPublisher implements PostPublisher {
  readonly platform: SocialPlatform = WORDPRESS_PLATFORM;
  readonly adapterVersion = WORDPRESS_ADAPTER_VERSION;

  private readonly siteUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(credentials: WordPressCredentials, options: WordPressPublisherOptions = {}) {
    this.siteUrl = normalizeSiteUrl(credentials.siteUrl);
    // Basic auth: base64("username:application password"). Never logged.
    this.authHeader = `Basic ${Buffer.from(
      `${credentials.username}:${credentials.applicationPassword}`,
    ).toString('base64')}`;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    const endpoint = `${this.siteUrl}/wp-json/wp/v2/posts`;
    let res: Response;
    try {
      res = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          authorization: this.authHeader,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          title: input.title || 'Untitled',
          content: input.body ?? '',
          status: 'publish',
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return {
        status: 'FAILED',
        failureReason: `WordPress request failed: ${errText(err)}`,
      };
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        status: 'FAILED',
        failureReason: `WordPress responded ${res.status} ${res.statusText}: ${trim(detail)}`,
      };
    }

    let post: WordPressPost;
    try {
      post = (await res.json()) as WordPressPost;
    } catch (err) {
      return {
        status: 'FAILED',
        failureReason: `WordPress returned an unreadable response: ${errText(err)}`,
      };
    }

    if (typeof post.id !== 'number' && typeof post.id !== 'string') {
      return {
        status: 'FAILED',
        failureReason: 'WordPress response did not include a post id',
      };
    }

    return {
      status: 'PUBLISHED',
      externalPostId: String(post.id),
      externalUrl: typeof post.link === 'string' ? post.link : undefined,
      publishedAt: post.date_gmt ? `${post.date_gmt}Z` : new Date().toISOString(),
    };
  }
}

interface WordPressPost {
  id?: number | string;
  link?: string;
  /** WordPress returns naive UTC (no offset) in date_gmt, e.g. 2026-07-14T12:00:00. */
  date_gmt?: string;
}

function trim(detail: string): string {
  const flat = detail.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
