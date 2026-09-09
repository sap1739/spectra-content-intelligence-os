import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FRESHNESS_DECAY,
  SNIPPET_ONLY_CONFIDENCE_FACTOR,
  diversityWeightFor,
  evaluateDomain,
  evaluateEligibility,
  evaluateFreshness,
} from './quality';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe('evaluateFreshness — decay and boundaries', () => {
  it('scores a brand-new source at ~1 and marks it FRESH', () => {
    const r = evaluateFreshness(NOW, NOW);
    expect(r.score).toBeCloseTo(1, 5);
    expect(r.status).toBe('FRESH');
    expect(r.ageDays).toBe(0);
  });

  it('halves the score at the configured half-life', () => {
    const r = evaluateFreshness(daysAgo(DEFAULT_FRESHNESS_DECAY.halfLifeDays), NOW);
    expect(r.score).toBeCloseTo(0.5, 5);
  });

  it('treats exactly freshWithinDays as still FRESH (inclusive lower boundary)', () => {
    expect(evaluateFreshness(daysAgo(DEFAULT_FRESHNESS_DECAY.freshWithinDays), NOW).status).toBe(
      'FRESH',
    );
  });

  it('treats one day past freshWithinDays as AGING', () => {
    expect(
      evaluateFreshness(daysAgo(DEFAULT_FRESHNESS_DECAY.freshWithinDays + 1), NOW).status,
    ).toBe('AGING');
  });

  it('treats exactly staleAfterDays as STALE (inclusive upper boundary)', () => {
    expect(evaluateFreshness(daysAgo(DEFAULT_FRESHNESS_DECAY.staleAfterDays), NOW).status).toBe(
      'STALE',
    );
  });

  it('treats one day before staleAfterDays as AGING, not STALE', () => {
    expect(evaluateFreshness(daysAgo(DEFAULT_FRESHNESS_DECAY.staleAfterDays - 1), NOW).status).toBe(
      'AGING',
    );
  });

  it('never decays below the configured floor', () => {
    const r = evaluateFreshness(daysAgo(5000), NOW);
    expect(r.score).toBe(DEFAULT_FRESHNESS_DECAY.minimumScore);
    expect(r.status).toBe('STALE');
  });

  it('reports UNKNOWN for an undated source rather than guessing an age', () => {
    const r = evaluateFreshness(null, NOW);
    expect(r.status).toBe('UNKNOWN');
    expect(r.ageDays).toBeNull();
    // Below FRESH and above the floor: uncertain, not certainly old.
    expect(r.score).toBe(DEFAULT_FRESHNESS_DECAY.unknownDateScore);
  });

  it('holds evergreen sources steady regardless of age', () => {
    const old = evaluateFreshness(daysAgo(2000), NOW, { evergreen: true });
    expect(old.status).toBe('EVERGREEN');
    expect(old.score).toBe(DEFAULT_FRESHNESS_DECAY.evergreenScore);
  });

  it('honours a custom decay config', () => {
    const r = evaluateFreshness(daysAgo(30), NOW, { config: { halfLifeDays: 30 } });
    expect(r.score).toBeCloseTo(0.5, 5);
  });

  it('does not treat a future publication date as negative age', () => {
    const r = evaluateFreshness(new Date(NOW.getTime() + 86_400_000), NOW);
    expect(r.ageDays).toBe(0);
    expect(r.score).toBeLessThanOrEqual(1);
  });
});

describe('evaluateDomain — credibility controls', () => {
  const base = { trustedDomains: [], blockedDomains: [], policies: [] };

  it('defaults to a neutral prior', () => {
    const v = evaluateDomain('https://unknown.example/a', base);
    expect(v.stance).toBe('NEUTRAL');
    expect(v.credibility).toBe(0.5);
    expect(v.source).toBe('DEFAULT');
  });

  it('boosts a vertical-trusted domain, including subdomains', () => {
    const rules = { ...base, trustedDomains: ['gov.uk'] };
    expect(evaluateDomain('https://data.gov.uk/x', rules).credibility).toBe(0.9);
    expect(evaluateDomain('https://gov.uk/x', rules).stance).toBe('TRUSTED');
  });

  it('blocks a vertical-blocked domain', () => {
    const v = evaluateDomain('https://spam.example/a', {
      ...base,
      blockedDomains: ['spam.example'],
    });
    expect(v.stance).toBe('BLOCKED');
    expect(v.credibility).toBe(0);
  });

  it('lets BLOCKED win over TRUSTED when both lists name the domain', () => {
    const v = evaluateDomain('https://x.example/a', {
      ...base,
      trustedDomains: ['x.example'],
      blockedDomains: ['x.example'],
    });
    // An explicit exclusion must not be undone by an inclusion elsewhere.
    expect(v.stance).toBe('BLOCKED');
  });

  it('lets a workspace policy override the vertical list', () => {
    const v = evaluateDomain('https://x.example/a', {
      ...base,
      blockedDomains: ['x.example'],
      policies: [
        { domain: 'x.example', stance: 'TRUSTED', credibilityOverride: null, evergreen: false },
      ],
    });
    expect(v.stance).toBe('TRUSTED');
    expect(v.source).toBe('WORKSPACE_POLICY');
  });

  it('applies an explicit numeric credibility override', () => {
    const v = evaluateDomain('https://reg.example/a', {
      ...base,
      policies: [
        { domain: 'reg.example', stance: 'TRUSTED', credibilityOverride: 0.97, evergreen: true },
      ],
    });
    expect(v.credibility).toBe(0.97);
    expect(v.evergreen).toBe(true);
  });

  it('matches a policy on subdomains and ignores www', () => {
    const rules = {
      ...base,
      policies: [
        {
          domain: 'www.example.org',
          stance: 'BLOCKED' as const,
          credibilityOverride: null,
          evergreen: false,
        },
      ],
    };
    expect(evaluateDomain('https://news.example.org/a', rules).stance).toBe('BLOCKED');
  });
});

describe('evaluateEligibility', () => {
  const ok = {
    stance: 'NEUTRAL' as const,
    snippetOnly: false,
    robotsDecision: 'ALLOWED' as const,
    injectionBlocked: false,
    isDuplicate: false,
  };

  it('allows an ordinary source', () => {
    expect(evaluateEligibility(ok).eligible).toBe(true);
  });

  it('excludes a blocked domain with a reason', () => {
    const v = evaluateEligibility({ ...ok, stance: 'BLOCKED' });
    expect(v.eligible).toBe(false);
    expect(v.reason).toContain('blocked');
  });

  it('excludes an injection-quarantined source', () => {
    expect(evaluateEligibility({ ...ok, injectionBlocked: true }).eligible).toBe(false);
  });

  it('excludes a duplicate — the original carries the evidence', () => {
    expect(evaluateEligibility({ ...ok, isDuplicate: true }).eligible).toBe(false);
  });

  it('keeps a snippet-only source ELIGIBLE but weaker', () => {
    // A snippet is real evidence of a source's existence and gist; excluding it
    // would discard genuine findings. It is down-weighted, not dropped.
    expect(evaluateEligibility({ ...ok, snippetOnly: true }).eligible).toBe(true);
    expect(SNIPPET_ONLY_CONFIDENCE_FACTOR).toBeGreaterThan(0);
    expect(SNIPPET_ONLY_CONFIDENCE_FACTOR).toBeLessThan(1);
  });

  it('keeps a robots-blocked source eligible as snippet evidence', () => {
    // We never read the page, but the search result itself is attributable.
    expect(
      evaluateEligibility({ ...ok, robotsDecision: 'DISALLOWED', snippetOnly: true }).eligible,
    ).toBe(true);
  });
});

describe('diversityWeightFor', () => {
  it('gives a standalone source full weight', () => {
    expect(diversityWeightFor(1)).toBe(1);
  });

  it('splits one unit of diversity across a syndication cluster', () => {
    // Ten outlets running one wire story is ONE corroboration, not ten.
    expect(diversityWeightFor(10)).toBeCloseTo(0.1, 6);
    expect(diversityWeightFor(2)).toBe(0.5);
  });
});
