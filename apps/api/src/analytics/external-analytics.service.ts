import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import {
  AnalyticsTargetNotFoundError,
  accountAvailability,
  analyticsProviderCatalog,
  campaignAnalytics,
  contentAnalytics,
  freshnessStatus,
  getSyncRun,
  listSyncRuns,
  providerStatus,
  requestAnalyticsSync,
  toSyncRun,
  unavailableMetrics,
  workspaceSummary,
} from '@spectra/analytics-pipeline';
import {
  ANALYTICS_METRIC_DEFINITIONS,
  SOCIAL_PLATFORMS,
  type AnalyticsSyncRequest,
  type SocialPlatform,
} from '@spectra/contracts';
import { TenantIsolationError } from '@spectra/security';
import { resolveOAuthPlatform } from '@spectra/social-oauth';
import { JOB_NAMES } from '@spectra/workflow-core';

import { getApiEnv } from '../config/env';
import { AuditService } from '../infra/audit.service';
import { QueueService } from '../infra/queue.service';
import { SocialCryptoService } from '../infra/social-crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,120}$/;

/**
 * External analytics (Phase 6H, ADR-0039): provider capabilities, manual sync
 * runs and the read models over stored snapshots. Every read is scoped by
 * organization and workspace; a foreign id is the same 404 as a missing one.
 */
@Injectable()
export class ExternalAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly crypto: SocialCryptoService,
  ) {}

  private scope(tenant: TenantContext) {
    return { organizationId: tenant.organizationId, workspaceId: tenant.workspaceId as string };
  }

  /** Whether a NEW connection can be made and read: OAuth client + credential storage. */
  private connectable(): Partial<Record<SocialPlatform, boolean>> {
    const env = getApiEnv();
    const key = this.crypto.isConfigured;
    const oauth = (platform: 'YOUTUBE' | 'LINKEDIN' | 'FACEBOOK') =>
      key && resolveOAuthPlatform(env, platform).configured;
    return {
      WORDPRESS: key,
      YOUTUBE: oauth('YOUTUBE'),
      LINKEDIN: oauth('LINKEDIN'),
      FACEBOOK: oauth('FACEBOOK'),
      INSTAGRAM: oauth('FACEBOOK'),
    };
  }

  /** Whether an EXISTING connection can be read: only credential storage matters. */
  private readable(): Partial<Record<SocialPlatform, boolean>> {
    const key = this.crypto.isConfigured;
    return { WORDPRESS: key, YOUTUBE: key, LINKEDIN: key, FACEBOOK: key, INSTAGRAM: key };
  }

  providers() {
    const platforms = SOCIAL_PLATFORMS as readonly SocialPlatform[];
    return {
      metricDefinitions: Object.values(ANALYTICS_METRIC_DEFINITIONS),
      providers: analyticsProviderCatalog(this.connectable(), platforms),
      scheduledSync: {
        enabled: getApiEnv().ANALYTICS_SCHEDULED_SYNC_ENABLED,
        intervalMinutes: getApiEnv().ANALYTICS_SYNC_INTERVAL_MINUTES,
      },
      firstParty: {
        source: 'FIRST_PARTY_MEASURED' as const,
        note: 'Content funnel, drafts, publications and research counts are Spectra’s own records (GET analytics/overview).',
      },
      note: 'A provider is live only when it is implemented, configured and connected with the scopes its metrics need. Each metric lists its own availability and reason.',
    };
  }

  async availability(tenant: TenantContext) {
    const accounts = await accountAvailability(
      this.prisma.client,
      this.scope(tenant),
      this.readable(),
      new Date(),
    );
    return {
      accounts,
      note:
        accounts.length === 0
          ? 'No social accounts are connected in this workspace, so no external analytics can be read.'
          : 'Availability comes from each connection’s grant and state. A sync may still find less if the platform refuses, and its run says why.',
    };
  }

  async requestSync(
    tenant: TenantContext,
    principal: Principal,
    body: AnalyticsSyncRequest,
    idempotencyKey: string | undefined,
  ) {
    if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new UnprocessableEntityException(
        'Idempotency-Key must be 8–120 characters of letters, digits, _ . : or -.',
      );
    }
    const scope = this.scope(tenant);
    let outcome;
    try {
      outcome = await requestAnalyticsSync(this.prisma.client, {
        ...scope,
        target: body.target,
        socialAccountId: body.target === 'SOCIAL_ACCOUNT' ? body.socialAccountId : null,
        scheduleEntryId: body.target === 'SCHEDULE_ENTRY' ? body.scheduleEntryId : null,
        trigger: 'MANUAL',
        requestedById: principal.userId,
        idempotencyKey: idempotencyKey ?? null,
        maxAttempts: getApiEnv().ANALYTICS_SYNC_MAX_ATTEMPTS,
      });
    } catch (error) {
      if (error instanceof AnalyticsTargetNotFoundError) throw new TenantIsolationError();
      throw error;
    }
    if (outcome.created) {
      await this.queue.enqueue(
        JOB_NAMES.analyticsSyncExecute,
        { runId: outcome.run.id },
        { idempotencyKey: `analytics-run-${outcome.run.id}`, tenant: scope },
      );
      await this.audit.record({
        ...scope,
        actorUserId: principal.userId,
        action: 'analytics_sync.requested',
        resourceType: 'AnalyticsSyncRun',
        resourceId: outcome.run.id,
        changes: { target: body.target },
      });
    }
    return { created: outcome.created, run: toSyncRun(outcome.run) };
  }

  async syncRun(tenant: TenantContext, runId: string) {
    const run = await getSyncRun(this.prisma.client, this.scope(tenant), runId);
    if (!run) throw new TenantIsolationError();
    return run;
  }

  syncRuns(tenant: TenantContext, limit?: number) {
    return listSyncRuns(this.prisma.client, this.scope(tenant), limit);
  }

  summary(tenant: TenantContext) {
    return workspaceSummary(this.prisma.client, this.scope(tenant), new Date());
  }

  async campaign(tenant: TenantContext, campaignId: string) {
    const result = await campaignAnalytics(
      this.prisma.client,
      this.scope(tenant),
      campaignId,
      new Date(),
    );
    if (!result) throw new TenantIsolationError();
    return result;
  }

  async content(tenant: TenantContext, contentItemId: string) {
    const result = await contentAnalytics(
      this.prisma.client,
      this.scope(tenant),
      contentItemId,
      new Date(),
    );
    if (!result) throw new TenantIsolationError();
    return result;
  }

  async unavailable(tenant: TenantContext) {
    return { metrics: await unavailableMetrics(this.prisma.client, this.scope(tenant)) };
  }

  freshness(tenant: TenantContext) {
    return freshnessStatus(this.prisma.client, this.scope(tenant), new Date());
  }

  providerStatus(tenant: TenantContext) {
    return providerStatus(this.prisma.client, this.scope(tenant));
  }
}
