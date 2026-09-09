import { describe, expect, it, vi } from 'vitest';

import { RobotsGateway, isPathAllowed, parseRobots, ROBOTS_USER_AGENT } from './robots';

const ALLOW_ALL = { disallow: [], allow: [], crawlDelaySeconds: null, retrieved: true };

describe('parseRobots', () => {
  it('reads the wildcard group', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /private\nCrawl-delay: 5');
    expect(rules.disallow).toEqual(['/private']);
    expect(rules.crawlDelaySeconds).toBe(5);
  });

  it('prefers an explicit group for our agent over the wildcard', () => {
    const rules = parseRobots(
      `User-agent: *\nDisallow: /\n\nUser-agent: ${ROBOTS_USER_AGENT}\nDisallow: /admin`,
    );
    // The specific group wins, so we are not blanket-blocked by the wildcard.
    expect(rules.disallow).toEqual(['/admin']);
  });

  it('treats an empty Disallow as "allow everything", not as a match-all prefix', () => {
    const rules = parseRobots('User-agent: *\nDisallow:');
    expect(rules.disallow).toEqual([]);
    expect(isPathAllowed(rules, '/anything')).toBe(true);
  });

  it('ignores comments and blank lines', () => {
    const rules = parseRobots('# comment\n\nUser-agent: *\n  Disallow: /x  # trailing\n');
    expect(rules.disallow).toEqual(['/x']);
  });

  it('groups consecutive user-agent lines together', () => {
    const rules = parseRobots(
      `User-agent: other\nUser-agent: ${ROBOTS_USER_AGENT}\nDisallow: /shared`,
    );
    expect(rules.disallow).toEqual(['/shared']);
  });
});

describe('isPathAllowed', () => {
  it('allows everything when there are no rules', () => {
    expect(isPathAllowed(ALLOW_ALL, '/anything')).toBe(true);
  });

  it('blocks a disallowed prefix', () => {
    const rules = { ...ALLOW_ALL, disallow: ['/private'] };
    expect(isPathAllowed(rules, '/private/report')).toBe(false);
    expect(isPathAllowed(rules, '/public/report')).toBe(true);
  });

  it('lets a longer Allow override a shorter Disallow', () => {
    const rules = { ...ALLOW_ALL, disallow: ['/docs'], allow: ['/docs/public'] };
    expect(isPathAllowed(rules, '/docs/private')).toBe(false);
    expect(isPathAllowed(rules, '/docs/public/a')).toBe(true);
  });

  it('supports * wildcards and $ anchors', () => {
    expect(isPathAllowed({ ...ALLOW_ALL, disallow: ['/*.pdf$'] }, '/a/b.pdf')).toBe(false);
    expect(isPathAllowed({ ...ALLOW_ALL, disallow: ['/*.pdf$'] }, '/a/b.pdf?x=1')).toBe(true);
    expect(isPathAllowed({ ...ALLOW_ALL, disallow: ['/x/*/y'] }, '/x/anything/y')).toBe(false);
  });
});

function gateway(response: { status: number; body: string } | Error) {
  const prisma = {
    robotsCacheEntry: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
    },
  };
  const fetchImpl = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return {
      status: response.status,
      contentType: 'text/plain',
      body: Buffer.from(response.body),
      finalUrl: 'https://example.com/robots.txt',
    };
  });
  return {
    prisma,
    fetchImpl,
    gw: new RobotsGateway({ prisma: prisma as never, fetchImpl: fetchImpl as never }),
  };
}

describe('RobotsGateway', () => {
  it('ALLOWS a permitted path', async () => {
    const { gw } = gateway({ status: 200, body: 'User-agent: *\nDisallow: /private' });
    const verdict = await gw.check('https://example.com/public/article');
    expect(verdict.decision).toBe('ALLOWED');
  });

  it('DISALLOWS a forbidden path and explains why', async () => {
    const { gw } = gateway({ status: 200, body: 'User-agent: *\nDisallow: /private' });
    const verdict = await gw.check('https://example.com/private/secret');
    expect(verdict.decision).toBe('DISALLOWED');
    expect(verdict.reason).toContain('disallows /private/secret');
  });

  it('reports UNAVAILABLE — not ALLOWED — when robots.txt cannot be fetched', async () => {
    const { gw } = gateway(new Error('ECONNREFUSED'));
    const verdict = await gw.check('https://example.com/a');
    // We proceed, but we did not verify permission and must not claim we did.
    expect(verdict.decision).toBe('UNAVAILABLE');
    expect(verdict.reason).toContain('could not be retrieved');
  });

  it('treats a 404 as "no rules" — a site with no robots.txt permits crawling', async () => {
    const { gw } = gateway({ status: 404, body: 'not found' });
    expect((await gw.check('https://example.com/a')).decision).toBe('ALLOWED');
  });

  it('treats a 5xx as UNAVAILABLE rather than assuming permission', async () => {
    const { gw } = gateway({ status: 503, body: '' });
    expect((await gw.check('https://example.com/a')).decision).toBe('UNAVAILABLE');
  });

  it('fetches robots.txt once per origin', async () => {
    const { gw, fetchImpl } = gateway({ status: 200, body: 'User-agent: *\nDisallow: /x' });
    await gw.check('https://example.com/a');
    await gw.check('https://example.com/b');
    await gw.check('https://example.com/c');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces Crawl-delay so the scheduler can honour it', async () => {
    const { gw } = gateway({ status: 200, body: 'User-agent: *\nCrawl-delay: 3' });
    expect((await gw.check('https://example.com/a')).crawlDelaySeconds).toBe(3);
  });

  it('refuses an unparseable URL rather than fetching it', async () => {
    const { gw } = gateway({ status: 200, body: '' });
    expect((await gw.check('not-a-url')).decision).toBe('DISALLOWED');
  });
});
