import type { SpectraPrismaClient } from '@spectra/database';
import type { Logger } from '@spectra/logging';

import { safeFetch, type SafeFetchOptions } from './safe-fetch';

/**
 * robots.txt compliance (ADR-0030).
 *
 * Discovered pages are fetched from sites we have no relationship with. Before
 * 5F the pipeline fetched them regardless of what the site asked crawlers to do.
 * This module asks first, and honours the answer.
 *
 * Two honesty rules shape it:
 *
 * 1. **"Unavailable" is not "allowed."** When robots.txt cannot be retrieved we
 *    proceed (the widely-accepted convention for a missing file) but record
 *    `UNAVAILABLE`, never `ALLOWED` — we did not verify permission and must not
 *    claim we did.
 * 2. **A disallowed page is never fetched.** It stays snippet-only with a
 *    truthful reason. There is no override, no "just this once": bypassing
 *    robots would make every downstream provenance claim untrustworthy.
 */

export const ROBOTS_USER_AGENT = 'SpectraResearchBot';
const CACHE_TTL_MS = 24 * 60 * 60_000;
const ROBOTS_MAX_BYTES = 512 * 1024;

export type RobotsDecision = 'ALLOWED' | 'DISALLOWED' | 'UNAVAILABLE' | 'NOT_CHECKED';

export interface RobotsRules {
  disallow: string[];
  allow: string[];
  crawlDelaySeconds: number | null;
  /** FALSE when robots.txt could not be retrieved. */
  retrieved: boolean;
}

export interface RobotsVerdict {
  decision: RobotsDecision;
  /** Operator-facing explanation; always specific. */
  reason: string;
  crawlDelaySeconds: number | null;
}

/**
 * Parses robots.txt for our user-agent.
 *
 * Group selection follows the standard: the most specific matching agent wins,
 * so an explicit `SpectraResearchBot` group overrides `*`.
 */
export function parseRobots(text: string): RobotsRules {
  const lines = text.split(/\r?\n/);
  const groups: Array<{
    agents: string[];
    disallow: string[];
    allow: string[];
    delay: number | null;
  }> = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;

  for (const raw of lines) {
    const line = raw.split('#')[0]?.trim() ?? '';
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      // Consecutive user-agent lines share one group.
      if (!current || !lastWasAgent) {
        current = { agents: [], disallow: [], allow: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'disallow') current.disallow.push(value);
    else if (field === 'allow') current.allow.push(value);
    else if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.delay = n;
    }
  }

  const ua = ROBOTS_USER_AGENT.toLowerCase();
  const exact = groups.find((g) => g.agents.some((a) => a === ua || ua.startsWith(a)));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const chosen = exact ?? wildcard;

  return {
    // An empty Disallow value means "allow everything" — drop it so it does not
    // read as a prefix match on every path.
    disallow: (chosen?.disallow ?? []).filter((d) => d.length > 0),
    allow: chosen?.allow ?? [],
    crawlDelaySeconds: chosen?.delay ?? null,
    retrieved: true,
  };
}

/** Longest-match wins; an equal-length Allow beats Disallow (standard). */
export function isPathAllowed(rules: RobotsRules, pathname: string): boolean {
  const match = (patterns: string[]): number => {
    let best = -1;
    for (const pattern of patterns) {
      if (matchesRobotsPattern(pattern, pathname) && pattern.length > best) best = pattern.length;
    }
    return best;
  };
  const disallowed = match(rules.disallow);
  if (disallowed === -1) return true;
  return match(rules.allow) >= disallowed;
}

/** Supports the `*` wildcard and `$` end-anchor from the robots spec. */
function matchesRobotsPattern(pattern: string, pathname: string): boolean {
  if (pattern === '') return false;
  if (!pattern.includes('*') && !pattern.endsWith('$')) return pathname.startsWith(pattern);
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(pathname);
}

export interface RobotsGatewayOptions {
  prisma: SpectraPrismaClient;
  fetchOptions?: SafeFetchOptions;
  logger?: Logger;
  /** Test seam; defaults to the shared safeFetch. */
  fetchImpl?: typeof safeFetch;
  now?: () => Date;
}

/**
 * Checks robots.txt for a URL, caching one decision per origin.
 *
 * The cache is shared across tenants because robots.txt is a property of the
 * remote site, not of any workspace — it contains no tenant data. It is keyed
 * by origin and expires, so a site that changes its rules is re-read.
 */
export class RobotsGateway {
  private readonly memo = new Map<string, RobotsRules>();

  constructor(private readonly options: RobotsGatewayOptions) {}

  async check(rawUrl: string): Promise<RobotsVerdict> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return {
        decision: 'DISALLOWED',
        reason: 'Invalid URL — not fetched.',
        crawlDelaySeconds: null,
      };
    }
    const origin = url.origin;
    const rules = await this.rulesFor(origin);

    if (!rules.retrieved) {
      // Convention: no robots.txt means no restrictions. Recorded as
      // UNAVAILABLE, because we did not actually verify permission.
      return {
        decision: 'UNAVAILABLE',
        reason: `robots.txt could not be retrieved from ${origin}; proceeding under the convention that a missing file imposes no restrictions.`,
        crawlDelaySeconds: rules.crawlDelaySeconds,
      };
    }

    const allowed = isPathAllowed(rules, url.pathname);
    return allowed
      ? {
          decision: 'ALLOWED',
          reason: `Allowed by ${origin}/robots.txt.`,
          crawlDelaySeconds: rules.crawlDelaySeconds,
        }
      : {
          decision: 'DISALLOWED',
          reason: `${origin}/robots.txt disallows ${url.pathname} for ${ROBOTS_USER_AGENT}. The page was not fetched.`,
          crawlDelaySeconds: rules.crawlDelaySeconds,
        };
  }

  private async rulesFor(origin: string): Promise<RobotsRules> {
    const cached = this.memo.get(origin);
    if (cached) return cached;

    const now = this.options.now?.() ?? new Date();
    const row = await this.options.prisma.robotsCacheEntry.findUnique({ where: { origin } });
    if (row && row.expiresAt > now) {
      const rules: RobotsRules = {
        disallow: row.disallow,
        allow: row.allow,
        crawlDelaySeconds: row.crawlDelaySeconds,
        retrieved: row.retrieved,
      };
      this.memo.set(origin, rules);
      return rules;
    }

    const rules = await this.fetchRules(origin);
    this.memo.set(origin, rules);

    const data = {
      disallow: rules.disallow,
      allow: rules.allow,
      crawlDelaySeconds: rules.crawlDelaySeconds,
      retrieved: rules.retrieved,
      fetchedAt: now,
      // A failed retrieval is cached briefly so one unreachable host does not
      // cost a robots fetch per page, but is retried far sooner than a success.
      expiresAt: new Date(now.getTime() + (rules.retrieved ? CACHE_TTL_MS : CACHE_TTL_MS / 24)),
    };
    await this.options.prisma.robotsCacheEntry
      .upsert({ where: { origin }, create: { origin, ...data }, update: data })
      .catch(() => undefined); // caching is an optimisation, never a blocker
    return rules;
  }

  private async fetchRules(origin: string): Promise<RobotsRules> {
    const fetcher = this.options.fetchImpl ?? safeFetch;
    try {
      const result = await fetcher(`${origin}/robots.txt`, {
        ...this.options.fetchOptions,
        maxBytes: ROBOTS_MAX_BYTES,
        timeoutMs: 5_000,
      });
      // 4xx (including 404) => no rules. 5xx => unknown, treated as unavailable.
      if (result.status >= 500) return unavailable();
      if (result.status >= 400)
        return { disallow: [], allow: [], crawlDelaySeconds: null, retrieved: true };
      return parseRobots(result.body.toString('utf8'));
    } catch (error) {
      this.options.logger?.debug(
        { origin, err: error instanceof Error ? error.message : String(error) },
        'robots.txt fetch failed',
      );
      return unavailable();
    }
  }
}

function unavailable(): RobotsRules {
  return { disallow: [], allow: [], crawlDelaySeconds: null, retrieved: false };
}
