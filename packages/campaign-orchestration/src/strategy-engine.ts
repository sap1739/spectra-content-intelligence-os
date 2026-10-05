import {
  type CtaSuggestion,
  type EvidenceAssessment,
  type FunnelStage,
  type GeneratedCampaignStrategy,
  type PlatformStrategy,
  type SocialPlatform,
  type StrategyObjective,
  type StrategyPersona,
  type StrategyPillar,
  type TopicIdeaDraft,
} from '@spectra/contracts';
import { getPlatformCapability } from '@spectra/social-core';

/**
 * The strategy engine.
 *
 * Deliberately **deterministic and derived**, not generated. Objectives,
 * pillars, personas, funnel coverage, topic ideas, platform strategy and CTAs
 * all come from things that actually exist — the vertical's own configuration,
 * the trends that scored, the evidence packs behind them, and the declared
 * platform capability matrix.
 *
 * A language model could invent a more fluent persona, but it would be fiction,
 * and nothing downstream could trace it. Everything here points back at a row.
 */

export const STRATEGY_ENGINE_VERSION = 'spectra-strategy@1.0.0';

/** A scored trend the campaign may be built on. */
export interface EngineTrend {
  id: string;
  title: string;
  summary: string | null;
  topicKey: string | null;
  normalizedScore: number | null;
  /** The evidence verdict for this trend's topic, from the gate. */
  evidence: EvidenceAssessment;
}

/** The vertical's own configuration — operator-authored, therefore trusted. */
export interface EngineVertical {
  id: string;
  name: string;
  description: string | null;
  keywords: string[];
  /** Audience descriptions the operator configured, if any. */
  audiences: string[];
}

export interface EnginePersonaRecord {
  id: string;
  name: string;
  description: string | null;
  painPoints: string[];
  preferredPlatforms: SocialPlatform[];
}

export interface StrategyEngineInput {
  vertical: EngineVertical | null;
  researchProjectName: string | null;
  trends: EngineTrend[];
  /** Personas configured in the workspace, which take precedence over derived ones. */
  personas: EnginePersonaRecord[];
  platforms: SocialPlatform[];
  itemsPerTrend: number;
  /** Which platforms this deployment can actually publish to. */
  publishablePlatforms: ReadonlySet<SocialPlatform>;
  brandName?: string | null;
}

/**
 * The funnel shape a campaign walks. Early items build awareness, later ones
 * ask for something — a fixed, explainable progression rather than a guess.
 */
const FUNNEL_PROGRESSION: FunnelStage[] = [
  'AWARENESS',
  'AWARENESS',
  'CONSIDERATION',
  'CONSIDERATION',
  'CONVERSION',
];

function funnelFor(index: number): FunnelStage {
  return FUNNEL_PROGRESSION[index % FUNNEL_PROGRESSION.length]!;
}

/** CTAs by funnel stage. Suggestions an operator edits — never auto-published. */
const CTA_LIBRARY: Record<FunnelStage, { text: string; rationale: string }> = {
  AWARENESS: {
    text: 'Follow for more on this topic.',
    rationale: 'Awareness posts ask for attention, not a decision.',
  },
  CONSIDERATION: {
    text: 'Read the full breakdown.',
    rationale: 'Consideration posts send the reader to something longer.',
  },
  CONVERSION: {
    text: 'Book a walkthrough.',
    rationale: 'Conversion posts ask for a commitment with a clear next step.',
  },
  RETENTION: {
    text: 'See what changed this month.',
    rationale: 'Retention posts give an existing audience a reason to return.',
  },
  ADVOCACY: {
    text: 'Share this with someone who needs it.',
    rationale: 'Advocacy posts ask the audience to carry the message.',
  },
};

function slug(value: string, fallback: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || fallback;
}

/**
 * Pillars come from the vertical's keywords, grouped with the trends that match
 * them. A trend matching no keyword still gets a pillar of its own, because
 * dropping it would silently narrow the campaign.
 */
function buildPillars(input: StrategyEngineInput): StrategyPillar[] {
  const pillars: StrategyPillar[] = [];
  const claimed = new Set<string>();

  for (const keyword of input.vertical?.keywords.slice(0, 6) ?? []) {
    const matching = input.trends.filter((trend) =>
      `${trend.title} ${trend.summary ?? ''}`.toLowerCase().includes(keyword.toLowerCase()),
    );
    if (matching.length === 0) continue;
    matching.forEach((trend) => claimed.add(trend.id));
    pillars.push({
      key: slug(keyword, `pillar-${pillars.length + 1}`),
      name: keyword,
      description: `${matching.length} selected trend${matching.length === 1 ? '' : 's'} fall under “${keyword}”, a keyword this vertical tracks.`,
      keywords: [keyword],
      trendCandidateIds: matching.map((trend) => trend.id),
    });
  }

  for (const trend of input.trends) {
    if (claimed.has(trend.id)) continue;
    pillars.push({
      key: slug(trend.topicKey ?? trend.title, `pillar-${pillars.length + 1}`),
      name: trend.title.slice(0, 200),
      description:
        'This trend matched none of the vertical’s configured keywords, so it stands as its own pillar rather than being dropped.',
      keywords: [],
      trendCandidateIds: [trend.id],
    });
  }

  return pillars;
}

/**
 * Personas prefer what the operator configured. Only when none exist does the
 * engine derive one, and it says so — a derived persona is a placeholder, not
 * research.
 */
function buildPersonas(input: StrategyEngineInput): StrategyPersona[] {
  if (input.personas.length > 0) {
    return input.personas.slice(0, 5).map((persona) => ({
      key: slug(persona.name, persona.id.slice(0, 8)),
      name: persona.name,
      description: persona.description ?? 'Configured in this workspace.',
      source: 'WORKSPACE' as const,
      painPoints: persona.painPoints.slice(0, 10),
      preferredPlatforms: persona.preferredPlatforms,
    }));
  }

  const audiences = input.vertical?.audiences ?? [];
  if (audiences.length > 0) {
    return audiences.slice(0, 5).map((audience, index) => ({
      key: slug(audience, `persona-${index + 1}`),
      name: audience,
      description: `An audience this vertical names. Spectra has not profiled it — add a persona to describe it properly.`,
      source: 'VERTICAL' as const,
      painPoints: [],
      preferredPlatforms: input.platforms,
    }));
  }

  return [
    {
      key: 'derived-audience',
      name: input.vertical?.name
        ? `People following ${input.vertical.name}`
        : 'The audience for this research',
      description:
        'No persona is configured and the vertical names no audience, so this is a placeholder derived from the campaign’s subject. Add a persona before relying on audience targeting.',
      source: 'DERIVED' as const,
      painPoints: [],
      preferredPlatforms: input.platforms,
    },
  ];
}

/**
 * Objectives follow the funnel stages the campaign will actually cover, each
 * justified by the trends that drive it.
 */
function buildObjectives(input: StrategyEngineInput, stages: FunnelStage[]): StrategyObjective[] {
  const unique = [...new Set(stages)];
  const trendIds = input.trends.map((trend) => trend.id);
  const subject = input.vertical?.name ?? input.researchProjectName ?? 'this research';

  const byStage: Record<FunnelStage, string> = {
    AWARENESS: `Put ${subject} in front of an audience that is not yet following it.`,
    CONSIDERATION: `Give readers already aware of ${subject} something substantial to weigh.`,
    CONVERSION: `Turn sustained interest in ${subject} into a concrete next step.`,
    RETENTION: `Give an existing audience a reason to keep paying attention to ${subject}.`,
    ADVOCACY: `Give the audience something worth passing on about ${subject}.`,
  };

  return unique.map((stage) => ({
    key: slug(stage, stage.toLowerCase()),
    name: byStage[stage],
    funnelStage: stage,
    rationale: `Derived from the ${trendIds.length} trend${trendIds.length === 1 ? '' : 's'} selected for this campaign and their scores.`,
    trendCandidateIds: trendIds,
  }));
}

/**
 * Platform strategy divides the planned items across platforms and states,
 * per platform, whether Spectra can actually publish there. A plan that counts
 * on a platform nobody can post to is worse than no plan.
 */
function buildPlatformStrategy(input: StrategyEngineInput, totalItems: number): PlatformStrategy[] {
  const count = input.platforms.length;
  return input.platforms.map((platform, index) => {
    const capability = getPlatformCapability(platform);
    const base = Math.floor(totalItems / count);
    const remainder = index < totalItems % count ? 1 : 0;
    const publishingAvailable = input.publishablePlatforms.has(platform);
    return {
      platform,
      plannedItems: base + remainder,
      rationale: capability?.notes
        ? `Planned against this platform’s declared limits: ${capability.notes}`
        : 'Planned against this platform’s declared capability record.',
      publishingAvailable,
      publishingNote: publishingAvailable
        ? null
        : `No connected account can publish to ${platform} in this workspace. Items are still planned and drafted, but scheduling them will not send anything until an account is connected.`,
    };
  });
}

/** One topic idea per planned item, each carrying its own evidence verdict. */
function buildTopicIdeas(input: StrategyEngineInput, pillars: StrategyPillar[]): TopicIdeaDraft[] {
  const ideas: TopicIdeaDraft[] = [];
  const pillarFor = (trendId: string) =>
    pillars.find((pillar) => pillar.trendCandidateIds.includes(trendId))?.key ?? null;

  input.trends.forEach((trend, trendIndex) => {
    for (let n = 0; n < input.itemsPerTrend; n += 1) {
      const stage = funnelFor(trendIndex * input.itemsPerTrend + n);
      const angle =
        stage === 'AWARENESS'
          ? 'Introduce the development and why it matters now.'
          : stage === 'CONSIDERATION'
            ? 'Examine what the evidence does and does not show.'
            : 'Set out what to do about it, and for whom.';
      ideas.push({
        key: `${slug(trend.topicKey ?? trend.title, `topic-${trendIndex + 1}`)}-${n + 1}`,
        title:
          n === 0
            ? trend.title.slice(0, 300)
            : `${trend.title.slice(0, 260)} (${stage.toLowerCase()})`,
        angle,
        pillarKey: pillarFor(trend.id),
        funnelStage: stage,
        trendCandidateId: trend.id,
        topicKey: trend.topicKey,
        evidence: trend.evidence,
      });
    }
  });

  return ideas;
}

export function buildStrategy(input: StrategyEngineInput): GeneratedCampaignStrategy {
  const warnings: string[] = [];

  const pillars = buildPillars(input);
  const personas = buildPersonas(input);
  const topicIdeas = buildTopicIdeas(input, pillars);
  const writable = topicIdeas.filter((idea) => idea.evidence.action !== 'BLOCK');
  const stages = writable.map((idea) => idea.funnelStage);
  const objectives = buildObjectives(input, stages.length > 0 ? stages : ['AWARENESS']);
  const platforms = buildPlatformStrategy(input, writable.length);

  const funnelCoverage = (
    ['AWARENESS', 'CONSIDERATION', 'CONVERSION', 'RETENTION', 'ADVOCACY'] as FunnelStage[]
  )
    .map((stage) => ({
      stage,
      plannedItems: writable.filter((idea) => idea.funnelStage === stage).length,
    }))
    .filter((entry) => entry.plannedItems > 0);

  const ctaSuggestions: CtaSuggestion[] = [...new Set(stages)].map((stage) => ({
    funnelStage: stage,
    text: CTA_LIBRARY[stage].text,
    rationale: CTA_LIBRARY[stage].rationale,
  }));

  // Everything the engine could not do, said plainly rather than left implicit.
  const blocked = topicIdeas.length - writable.length;
  if (blocked > 0) {
    warnings.push(
      `${blocked} topic idea${blocked === 1 ? '' : 's'} were blocked by the evidence gate and are not in the plan.`,
    );
  }
  if (personas[0]?.source === 'DERIVED') {
    warnings.push(
      'No persona is configured for this workspace, so the audience is a placeholder derived from the campaign subject.',
    );
  }
  const unpublishable = platforms.filter((platform) => !platform.publishingAvailable);
  if (unpublishable.length > 0) {
    warnings.push(
      `${unpublishable.length} of ${platforms.length} planned platforms have no connected account that can publish: ${unpublishable.map((p) => p.platform).join(', ')}.`,
    );
  }
  const cautioned = writable.filter((idea) => idea.evidence.action === 'ALLOW_WITH_CAUTION');
  if (cautioned.length > 0) {
    warnings.push(
      `${cautioned.length} item${cautioned.length === 1 ? '' : 's'} rest on limited, snippet-only, stale or contradicted evidence and will be written with the matching caution.`,
    );
  }

  return {
    schemaVersion: 1,
    engineVersion: STRATEGY_ENGINE_VERSION,
    objectives,
    pillars,
    personas,
    funnelCoverage,
    topicIdeas,
    platforms,
    ctaSuggestions,
    warnings,
  };
}

export { CTA_LIBRARY };
