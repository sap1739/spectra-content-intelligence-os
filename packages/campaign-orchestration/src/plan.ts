import { createHash } from 'node:crypto';

import type {
  CampaignPlan,
  GeneratedCampaignStrategy,
  PlannedItem,
  SocialPlatform,
} from '@spectra/contracts';

import { CTA_LIBRARY } from './strategy-engine';

/**
 * Strategy → plan → calendar. Pure and deterministic: the same strategy and
 * window always produce the same slots, which is what makes a retried run
 * idempotent and the tests exact.
 */

export interface PlanInput {
  strategy: GeneratedCampaignStrategy;
  platforms: SocialPlatform[];
  startAt: Date;
  durationDays: number;
  timezone: string;
}

/**
 * Posting hours, in UTC. Spread rather than clustered, so a campaign does not
 * publish everything at midnight. The operator edits the calendar afterwards;
 * these are a starting point, not a recommendation dressed as research.
 */
const SLOT_HOURS = [9, 13, 17];

export function buildPlan(input: PlanInput): CampaignPlan {
  const writable = input.strategy.topicIdeas.filter((idea) => idea.evidence.action !== 'BLOCK');
  const blocked = input.strategy.topicIdeas
    .filter((idea) => idea.evidence.action === 'BLOCK')
    .map((idea) => ({
      title: idea.title,
      topicKey: idea.topicKey,
      evidence: idea.evidence,
    }));

  const endAt = new Date(input.startAt.getTime() + input.durationDays * 86_400_000);

  // Spread the items evenly across the window rather than front-loading them:
  // with N items and D days, one lands every D/N days.
  const spacingMs =
    writable.length > 0
      ? Math.max(3_600_000, Math.floor((input.durationDays * 86_400_000) / writable.length))
      : 0;

  const items: PlannedItem[] = writable.map((idea, index) => {
    const platform = input.platforms[index % input.platforms.length]!;
    const rough = new Date(input.startAt.getTime() + spacingMs * index);
    const scheduled = new Date(rough);
    scheduled.setUTCHours(SLOT_HOURS[index % SLOT_HOURS.length]!, 0, 0, 0);
    // Keep the slot inside the window even after the hour is normalized.
    const clamped = scheduled < input.startAt ? new Date(input.startAt.getTime()) : scheduled;
    return {
      key: idea.key,
      title: idea.title,
      topicKey: idea.topicKey,
      platform,
      funnelStage: idea.funnelStage,
      pillarKey: idea.pillarKey,
      scheduledAt: (clamped > endAt ? endAt : clamped).toISOString(),
      evidence: idea.evidence,
      trendCandidateId: idea.trendCandidateId,
      cta: CTA_LIBRARY[idea.funnelStage]?.text ?? null,
    };
  });

  return {
    schemaVersion: 1,
    startAt: input.startAt.toISOString(),
    endAt: endAt.toISOString(),
    timezone: input.timezone,
    items,
    blocked,
  };
}

/**
 * The idempotency key for a run: the inputs that decide what gets built. A
 * retry with the same inputs reuses the run rather than creating a second
 * campaign.
 */
export function orchestrationRunKey(input: {
  verticalId: string | null;
  researchProjectId: string | null;
  trendCandidateIds: readonly string[];
  platforms: readonly string[];
  startAt: string;
  durationDays: number;
  itemsPerTrend: number;
  generateDrafts: boolean;
}): string {
  const canonical = JSON.stringify({
    verticalId: input.verticalId,
    researchProjectId: input.researchProjectId,
    trends: [...input.trendCandidateIds].sort(),
    platforms: [...input.platforms].sort(),
    startAt: input.startAt,
    durationDays: input.durationDays,
    itemsPerTrend: input.itemsPerTrend,
    generateDrafts: input.generateDrafts,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
