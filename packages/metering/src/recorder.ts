import type { TenantScope } from '@spectra/contracts';
import type { SpectraPrismaClient } from '@spectra/database';
import type { Logger } from '@spectra/logging';

import { RATE_VERSION, estimateCost } from './rates';

/** What kind of metered work an event covers (mirrors the UsageKind enum). */
export type UsageKind =
  | 'AI_GENERATION'
  | 'AI_EMBEDDING'
  | 'WEB_SEARCH'
  | 'NEWS_SEARCH'
  | 'PAGE_FETCH'
  // Whole-operation counters: capped by per-kind limits even when the spend
  // itself is metered elsewhere, free, or not priceable at all.
  | 'RESEARCH_RUN'
  | 'CONTENT_DRAFT'
  | 'DOCUMENT_EXTRACTION'
  | 'MEDIA_RENDER'
  | 'PUBLISH_ATTEMPT';

/** Every kind that can be capped by a per-operation monthly limit. */
export const USAGE_KINDS = [
  'AI_GENERATION',
  'AI_EMBEDDING',
  'WEB_SEARCH',
  'NEWS_SEARCH',
  'PAGE_FETCH',
  'RESEARCH_RUN',
  'CONTENT_DRAFT',
  'DOCUMENT_EXTRACTION',
  'MEDIA_RENDER',
  'PUBLISH_ATTEMPT',
] as const satisfies readonly UsageKind[];

export interface UsageRecord {
  kind: UsageKind;
  provider: string;
  model?: string | null;
  requests?: number;
  /** Omit (or null) when the provider did not report it — never pass 0 to mean "unknown". */
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  bytes?: number | null;
  resourceType?: string | null;
  resourceId?: string | null;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Records real provider usage.
 *
 * Metering must never break the work it measures: a failed write is logged and
 * swallowed. Losing a ledger row is bad; failing a research run the user paid
 * for because the meter hiccuped is worse.
 */
export interface UsageRecorder {
  record(tenant: TenantScope, usage: UsageRecord): Promise<void>;
}

export class PrismaUsageRecorder implements UsageRecorder {
  constructor(
    private readonly prisma: SpectraPrismaClient,
    private readonly logger?: Logger,
  ) {}

  async record(tenant: TenantScope, usage: UsageRecord): Promise<void> {
    const estimate = estimateCost({
      provider: usage.provider,
      model: usage.model ?? null,
      kind: usage.kind,
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      totalTokens: usage.totalTokens ?? null,
      requests: usage.requests ?? 1,
    });

    // "The provider should have told us a quantity and didn't" is recorded as
    // unknown, so a per-kind token limit never treats it as zero tokens used.
    const expectsTokens = usage.kind === 'AI_GENERATION' || usage.kind === 'AI_EMBEDDING';
    const quantityUnknown =
      expectsTokens &&
      usage.inputTokens == null &&
      usage.outputTokens == null &&
      usage.totalTokens == null;

    try {
      await this.prisma.usageEvent.create({
        data: {
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId ?? null,
          kind: usage.kind,
          provider: usage.provider,
          model: usage.model ?? null,
          requests: usage.requests ?? 1,
          inputTokens: usage.inputTokens ?? null,
          outputTokens: usage.outputTokens ?? null,
          totalTokens: usage.totalTokens ?? null,
          bytes: usage.bytes ?? null,
          estimatedCostMicros: estimate.micros,
          // Only stamp a version when an estimate was actually produced.
          rateVersion: estimate.micros === null ? null : RATE_VERSION,
          // Exactly one of these is always set: an estimate has a source, and a
          // null estimate has a reason. Neither is ever silently absent.
          rateSource: estimate.rateSource ?? null,
          unpricedReason: estimate.unpricedReason ?? null,
          quantityUnknown,
          resourceType: usage.resourceType ?? null,
          resourceId: usage.resourceId ?? null,
          correlationId: usage.correlationId ?? null,
          metadata: (usage.metadata ?? {}) as never,
        },
      });
    } catch (error) {
      this.logger?.warn(
        {
          kind: usage.kind,
          provider: usage.provider,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to record usage event — work continues, ledger row lost',
      );
    }
  }
}

/** Discards usage. For tests and for callers that genuinely have no ledger. */
export class NoopUsageRecorder implements UsageRecorder {
  async record(): Promise<void> {
    /* intentionally empty */
  }
}
