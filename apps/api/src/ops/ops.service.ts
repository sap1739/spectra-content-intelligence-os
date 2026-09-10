import { Injectable, NotFoundException } from '@nestjs/common';
import { METRICS, metrics } from '@spectra/telemetry';
import {
  BullMqQueueInspector,
  DEAD_LETTER_SUFFIX,
  SYSTEM_QUEUE,
  type FailedJobSummary,
  type QueueCounts,
} from '@spectra/workflow-core';
import { Queue } from 'bullmq';

import { AuditService } from '../infra/audit.service';
import { RedisService } from '../redis/redis.service';
import type { Principal, TenantContext } from '../auth/types';

/**
 * Operations: queue health, failed jobs and safe retry (ADR-0033).
 *
 * Everything here is tenant-scoped. A failed job is only listed to the tenant
 * whose envelope recorded it, and a job with no recorded tenant is not listed
 * at all — see `matchesTenant` in the inspector for why that fails closed.
 */

/** Job names grouped for the dashboard, so an operator sees categories not ids. */
const JOB_CATEGORIES: Record<string, string> = {
  'research.run.execute': 'Research runs',
  'research.run.scheduled': 'Research runs',
  'content.draft.generate': 'Content generation',
  'publication.publish': 'Publishing',
  'publication.dispatch': 'Publishing',
  'knowledge.reembed': 'Embedding / re-embed',
};

@Injectable()
export class OpsService {
  private inspector: BullMqQueueInspector | null = null;
  private queues: { main: Queue; dead: Queue } | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {
    // Read at scrape time rather than pushed, so the number is never stale.
    // The getter THROWS when the queue cannot answer, which omits the series
    // entirely — "depth unknown" must not render as "depth 0" on a dashboard.
    metrics.gauge(METRICS.queueDepth, 'Jobs in the system queue, by state.', async () => {
      const counts = await this.getInspector().counts();
      return [
        { labels: { state: 'waiting' }, value: counts.waiting },
        { labels: { state: 'active' }, value: counts.active },
        { labels: { state: 'delayed' }, value: counts.delayed },
        { labels: { state: 'failed' }, value: counts.failed },
        { labels: { state: 'paused' }, value: counts.paused },
        { labels: { state: 'dead_lettered' }, value: counts.deadLettered },
      ];
    });
  }

  /** Lazily built so an unreachable Redis does not break API startup. */
  private getInspector(): BullMqQueueInspector {
    if (!this.inspector) {
      const connection = this.redis.client;
      const main = new Queue(SYSTEM_QUEUE, { connection });
      const dead = new Queue(`${SYSTEM_QUEUE}${DEAD_LETTER_SUFFIX}`, { connection });
      this.queues = { main, dead };
      this.inspector = new BullMqQueueInspector(main, dead, connection);
    }
    return this.inspector;
  }

  /**
   * Queue depth and failure counts.
   *
   * When the queue cannot be reached this reports `reachable: false` with the
   * reason rather than zeros — an empty queue and an unreachable one are
   * different operational situations and must not look alike.
   */
  async queueStatus(): Promise<{
    reachable: boolean;
    counts: QueueCounts | null;
    reason: string;
  }> {
    try {
      const counts = await this.getInspector().counts();
      return { reachable: true, counts, reason: 'Queue reachable.' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        reachable: false,
        counts: null,
        reason: `The job queue could not be reached (${message}). Counts are unknown, not zero.`,
      };
    }
  }

  /** Failed jobs and dead-letter entries for this tenant, grouped by category. */
  async failedJobs(tenant: TenantContext, limit = 50) {
    const scope = {
      organizationId: tenant.organizationId,
      ...(tenant.workspaceId ? { workspaceId: tenant.workspaceId } : {}),
      limit,
    };
    try {
      const inspector = this.getInspector();
      const [failed, deadLettered] = await Promise.all([
        inspector.listFailed(scope),
        inspector.listDeadLetters(scope),
      ]);
      return {
        reachable: true,
        failed: failed.map(withCategory),
        deadLettered: deadLettered.map(withCategory),
        note: 'Dead-lettered jobs exhausted their retries. Retrying re-runs the original job, so its idempotency key and budget checks still apply.',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        reachable: false,
        failed: [],
        deadLettered: [],
        note: `The job queue could not be reached (${message}). This is not an empty failure list — the queue is unavailable.`,
      };
    }
  }

  /**
   * Retries one failed job.
   *
   * Tenant-checked BEFORE the retry: the job's recorded organization must match
   * the caller's, so one tenant can never replay another's work.
   */
  async retry(tenant: TenantContext, principal: Principal, jobId: string) {
    const inspector = this.getInspector();
    const owned = await inspector.listFailed({
      organizationId: tenant.organizationId,
      ...(tenant.workspaceId ? { workspaceId: tenant.workspaceId } : {}),
      limit: 500,
    });
    const target = owned.find((job) => job.id === jobId);
    if (!target) {
      // Foreign and non-existent jobs are indistinguishable — no existence leak.
      throw new NotFoundException('Failed job not found');
    }

    const retried = await inspector.retryFailed(jobId);
    if (!retried) throw new NotFoundException('Failed job not found');

    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'ops.job.retried',
      resourceType: 'Job',
      resourceId: jobId,
    });
    // Labelled by job NAME (a bounded set); the job id would be unbounded.
    metrics.increment(METRICS.opsJobRetries, { job: target.name });

    return {
      retried: true,
      jobId,
      note: 'The original job was re-queued. Its idempotency key is unchanged and budget pre-flight runs again when it executes.',
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.queues?.main.close().catch(() => undefined);
    await this.queues?.dead.close().catch(() => undefined);
  }
}

function withCategory(job: FailedJobSummary): FailedJobSummary & { category: string } {
  return { ...job, category: JOB_CATEGORIES[job.name] ?? 'Other' };
}
