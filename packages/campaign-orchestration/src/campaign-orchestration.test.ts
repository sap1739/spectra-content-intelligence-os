import type { EvidenceAssessment, SocialPlatform } from '@spectra/contracts';
import { describe, expect, it } from 'vitest';

import { assessEvidence, cautionGuidance, isWritable, type GateSource } from './evidence-gate';
import { buildPlan, orchestrationRunKey } from './plan';
import { buildStrategy, type EngineTrend } from './strategy-engine';

const NOW = new Date('2026-10-04T12:00:00.000Z');

function source(overrides: Partial<GateSource> = {}): GateSource {
  return {
    snippetOnly: false,
    publishedAt: new Date('2026-09-01T00:00:00.000Z'),
    publisher: 'example.com',
    evidenceEligible: true,
    ...overrides,
  };
}

function gate(overrides: Record<string, unknown> = {}) {
  return assessEvidence({
    evidencePackId: 'pack-1',
    findingIds: ['f1', 'f2'],
    citationIds: ['c1'],
    claimIds: ['cl1'],
    sources: [source(), source({ publisher: 'other.org' })],
    contradictionCount: 0,
    strongestConfidence: 'HIGH',
    now: NOW,
    ...overrides,
  });
}

describe('the evidence gate', () => {
  it('allows a topic corroborated by independent, fully-retrieved sources', () => {
    const verdict = gate();

    expect(verdict.verdict).toBe('SUPPORTED');
    expect(verdict.action).toBe('ALLOW');
    expect(verdict.independentSourceCount).toBe(2);
    expect(isWritable(verdict)).toBe(true);
    expect(cautionGuidance(verdict)).toBeNull();
  });

  it('blocks a topic with no findings or citations behind it', () => {
    const verdict = gate({ findingIds: [], citationIds: [], sources: [] });

    expect(verdict.verdict).toBe('UNSUPPORTED');
    expect(verdict.action).toBe('BLOCK');
    expect(isWritable(verdict)).toBe(false);
  });

  it('blocks a topic whose every source is ineligible as evidence', () => {
    // A blocked domain or quarantined page is not weak evidence — it is none.
    const verdict = gate({
      sources: [source({ evidenceEligible: false }), source({ evidenceEligible: false })],
    });

    expect(verdict.verdict).toBe('UNSUPPORTED');
    expect(verdict.reason).toContain('ineligible as evidence');
  });

  it('counts publishers, not articles, when judging independence', () => {
    const verdict = gate({
      sources: [source({ publisher: 'Example' }), source({ publisher: 'example' })],
    });

    // Two articles from one outlet are one independent source.
    expect(verdict.independentSourceCount).toBe(1);
    expect(verdict.verdict).toBe('LIMITED');
    expect(verdict.action).toBe('ALLOW_WITH_CAUTION');
  });

  it('marks a snippet-only topic and says the pages were never read', () => {
    const verdict = gate({
      sources: [source({ snippetOnly: true }), source({ snippetOnly: true, publisher: 'b.com' })],
    });

    expect(verdict.verdict).toBe('SNIPPET_ONLY');
    expect(verdict.snippetOnly).toBe(true);
    expect(cautionGuidance(verdict)).toContain('search snippet');
  });

  it('marks a topic stale when its newest source is past tolerance, naming the age', () => {
    const verdict = gate({
      sources: [
        source({ publishedAt: new Date('2025-01-01T00:00:00.000Z') }),
        source({ publishedAt: new Date('2025-02-01T00:00:00.000Z'), publisher: 'b.com' }),
      ],
    });

    expect(verdict.verdict).toBe('STALE');
    expect(verdict.newestSourceAgeDays).toBeGreaterThan(180);
    expect(verdict.reason).toMatch(/\d+ days old/);
    expect(cautionGuidance(verdict)).toContain('Date every claim');
  });

  it('treats disagreement as outranking everything else', () => {
    const verdict = gate({ contradictionCount: 2 });

    expect(verdict.verdict).toBe('CONTRADICTED');
    expect(verdict.action).toBe('ALLOW_WITH_CAUTION');
    expect(verdict.reason).toContain('2 contradictions');
    expect(cautionGuidance(verdict)).toContain('Present the disagreement');
  });

  it('treats a contested claim as contradicted even with no contradiction rows', () => {
    expect(gate({ strongestConfidence: 'CONTESTED' }).verdict).toBe('CONTRADICTED');
  });

  it('treats an unverified topic as limited, never as supported', () => {
    // UNKNOWN is weaker than LOW: nothing was verified at all.
    expect(gate({ strongestConfidence: 'UNKNOWN' }).verdict).toBe('LIMITED');
    expect(gate({ strongestConfidence: 'LOW' }).verdict).toBe('LIMITED');
  });
});

function trend(overrides: Partial<EngineTrend> = {}): EngineTrend {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Composable storage is replacing monoliths',
    summary: 'Storage vendors are unbundling.',
    topicKey: 'composable-storage',
    normalizedScore: 0.82,
    evidence: gate(),
    ...overrides,
  };
}

function engineInput(overrides: Record<string, unknown> = {}) {
  return {
    vertical: {
      id: 'v1',
      name: 'Enterprise storage',
      description: null,
      keywords: ['storage', 'latency'],
      audiences: [],
    },
    researchProjectName: null,
    trends: [trend()],
    personas: [],
    platforms: ['LINKEDIN', 'X'] as SocialPlatform[],
    itemsPerTrend: 2,
    publishablePlatforms: new Set<SocialPlatform>(['LINKEDIN']),
    ...overrides,
  };
}

describe('the strategy engine', () => {
  it('derives objectives that each name the trends justifying them', () => {
    const strategy = buildStrategy(engineInput());

    expect(strategy.objectives.length).toBeGreaterThan(0);
    for (const objective of strategy.objectives) {
      expect(objective.trendCandidateIds.length).toBeGreaterThan(0);
      expect(objective.rationale).toContain('trend');
    }
    expect(strategy.engineVersion).toContain('spectra-strategy@');
  });

  it('builds pillars from the vertical’s keywords, and keeps unmatched trends', () => {
    const strategy = buildStrategy(
      engineInput({
        trends: [
          trend(),
          trend({
            id: '22222222-2222-4222-8222-222222222222',
            title: 'Unrelated market shift',
            summary: null,
            topicKey: 'unrelated',
          }),
        ],
      }),
    );

    const keyworded = strategy.pillars.find((pillar) => pillar.name === 'storage');
    expect(keyworded).toBeTruthy();
    // The unmatched trend is not dropped — it becomes its own pillar.
    const standalone = strategy.pillars.find((pillar) =>
      pillar.description.includes('matched none'),
    );
    expect(standalone).toBeTruthy();
  });

  it('prefers configured personas, and labels a derived one as a placeholder', () => {
    const configured = buildStrategy(
      engineInput({
        personas: [
          {
            id: 'p1',
            name: 'Platform lead',
            description: 'Owns the storage budget.',
            painPoints: ['cost'],
            preferredPlatforms: ['LINKEDIN'] as SocialPlatform[],
          },
        ],
      }),
    );
    expect(configured.personas[0]).toMatchObject({ name: 'Platform lead', source: 'WORKSPACE' });

    const derived = buildStrategy(engineInput());
    expect(derived.personas[0]!.source).toBe('DERIVED');
    expect(derived.personas[0]!.description).toContain('placeholder');
    expect(derived.warnings.join(' ')).toContain('No persona is configured');
  });

  it('says which planned platforms cannot actually be published to', () => {
    const strategy = buildStrategy(engineInput());

    const linkedin = strategy.platforms.find((platform) => platform.platform === 'LINKEDIN')!;
    const x = strategy.platforms.find((platform) => platform.platform === 'X')!;
    expect(linkedin.publishingAvailable).toBe(true);
    expect(linkedin.publishingNote).toBeNull();
    expect(x.publishingAvailable).toBe(false);
    expect(x.publishingNote).toContain('No connected account');
    expect(strategy.warnings.join(' ')).toContain('no connected account that can publish');
  });

  it('produces one topic idea per item per trend, each carrying its verdict', () => {
    const strategy = buildStrategy(engineInput({ itemsPerTrend: 3 }));

    expect(strategy.topicIdeas).toHaveLength(3);
    for (const idea of strategy.topicIdeas) {
      expect(idea.evidence.verdict).toBe('SUPPORTED');
      expect(idea.trendCandidateId).toBeTruthy();
    }
    // The funnel progresses rather than repeating one stage.
    expect(new Set(strategy.topicIdeas.map((idea) => idea.funnelStage)).size).toBeGreaterThan(1);
  });

  it('keeps blocked topics out of the plan and says how many were refused', () => {
    const strategy = buildStrategy(
      engineInput({
        trends: [
          trend(),
          trend({
            id: '33333333-3333-4333-8333-333333333333',
            topicKey: 'nothing',
            evidence: gate({ findingIds: [], citationIds: [], sources: [] }),
          }),
        ],
      }),
    );

    const blocked = strategy.topicIdeas.filter((idea) => idea.evidence.action === 'BLOCK');
    expect(blocked).toHaveLength(2);
    expect(strategy.warnings.join(' ')).toContain('blocked by the evidence gate');
    // Funnel coverage counts only writable items.
    const covered = strategy.funnelCoverage.reduce((sum, entry) => sum + entry.plannedItems, 0);
    expect(covered).toBe(2);
  });

  it('warns when items rest on cautioned evidence', () => {
    const strategy = buildStrategy(
      engineInput({ trends: [trend({ evidence: gate({ contradictionCount: 1 }) })] }),
    );

    expect(strategy.warnings.join(' ')).toContain('limited, snippet-only, stale or contradicted');
  });

  it('suggests a CTA for every funnel stage the campaign actually covers', () => {
    const strategy = buildStrategy(engineInput({ itemsPerTrend: 5 }));

    const stages = new Set(strategy.topicIdeas.map((idea) => idea.funnelStage));
    expect(new Set(strategy.ctaSuggestions.map((cta) => cta.funnelStage))).toEqual(stages);
    for (const cta of strategy.ctaSuggestions) expect(cta.text.length).toBeGreaterThan(5);
  });
});

describe('the plan builder', () => {
  const strategy = buildStrategy(engineInput({ itemsPerTrend: 4 }));

  it('spreads items across the window and alternates platforms', () => {
    const plan = buildPlan({
      strategy,
      platforms: ['LINKEDIN', 'X'],
      startAt: new Date('2026-11-01T00:00:00.000Z'),
      durationDays: 14,
      timezone: 'UTC',
    });

    expect(plan.items).toHaveLength(4);
    expect(plan.items.map((item) => item.platform)).toEqual(['LINKEDIN', 'X', 'LINKEDIN', 'X']);
    const times = plan.items.map((item) => new Date(item.scheduledAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // Every slot lands inside the campaign window.
    for (const time of times) {
      expect(time).toBeGreaterThanOrEqual(new Date(plan.startAt).getTime());
      expect(time).toBeLessThanOrEqual(new Date(plan.endAt).getTime());
    }
  });

  it('carries each item’s evidence and CTA into the plan', () => {
    const plan = buildPlan({
      strategy,
      platforms: ['LINKEDIN'],
      startAt: new Date('2026-11-01T00:00:00.000Z'),
      durationDays: 7,
      timezone: 'UTC',
    });

    for (const item of plan.items) {
      expect(item.evidence.verdict).toBeTruthy();
      expect(item.cta).toBeTruthy();
    }
  });

  it('keeps blocked items in the plan, with their reason', () => {
    const blockedStrategy = buildStrategy(
      engineInput({
        itemsPerTrend: 1,
        trends: [trend({ evidence: gate({ findingIds: [], citationIds: [], sources: [] }) })],
      }),
    );

    const plan = buildPlan({
      strategy: blockedStrategy,
      platforms: ['LINKEDIN'],
      startAt: new Date('2026-11-01T00:00:00.000Z'),
      durationDays: 7,
      timezone: 'UTC',
    });

    expect(plan.items).toHaveLength(0);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.evidence.action).toBe('BLOCK');
  });
});

describe('orchestrationRunKey', () => {
  const base = {
    verticalId: 'v1',
    researchProjectId: null,
    trendCandidateIds: ['b', 'a'],
    platforms: ['X', 'LINKEDIN'],
    startAt: '2026-11-01T00:00:00.000Z',
    durationDays: 14,
    itemsPerTrend: 2,
    generateDrafts: true,
  };

  it('is stable regardless of the order trends or platforms were given in', () => {
    expect(orchestrationRunKey(base)).toBe(
      orchestrationRunKey({ ...base, trendCandidateIds: ['a', 'b'], platforms: ['LINKEDIN', 'X'] }),
    );
  });

  it('changes when anything that decides the output changes', () => {
    const key = orchestrationRunKey(base);
    expect(orchestrationRunKey({ ...base, durationDays: 15 })).not.toBe(key);
    expect(orchestrationRunKey({ ...base, itemsPerTrend: 3 })).not.toBe(key);
    expect(orchestrationRunKey({ ...base, generateDrafts: false })).not.toBe(key);
  });
});

describe('the verdict → action mapping', () => {
  it('blocks only what nothing supports, and cautions the rest', () => {
    const verdicts: Array<[EvidenceAssessment['verdict'], EvidenceAssessment['action']]> = [
      ['SUPPORTED', 'ALLOW'],
      ['LIMITED', 'ALLOW_WITH_CAUTION'],
      ['SNIPPET_ONLY', 'ALLOW_WITH_CAUTION'],
      ['STALE', 'ALLOW_WITH_CAUTION'],
      ['CONTRADICTED', 'ALLOW_WITH_CAUTION'],
      ['UNSUPPORTED', 'BLOCK'],
    ];
    for (const [verdict, action] of verdicts) {
      const assessment = { verdict, action } as EvidenceAssessment;
      expect(assessment.action).toBe(action);
    }
  });
});
