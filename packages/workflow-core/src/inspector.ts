import type { Queue } from 'bullmq';
import type Redis from 'ioredis';

/**
 * Queue introspection for the operations dashboard (ADR-0033).
 *
 * Read-mostly: counts, failed jobs and dead-letter entries, plus a retry that
 * re-runs the ORIGINAL job rather than creating a new one. That distinction is
 * the whole safety story — see `retryFailed`.
 */

export type QueueJobState = 'waiting' | 'active' | 'delayed' | 'completed' | 'failed' | 'paused';

export interface QueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  paused: number;
  /** Entries that exhausted retries and were dead-lettered. */
  deadLettered: number;
}

export interface FailedJobSummary {
  id: string;
  /** Job name, e.g. `research.run.execute`. */
  name: string;
  attemptsMade: number;
  maxAttempts: number;
  /** Failure message from the last attempt, truncated. NEVER a payload dump. */
  reason: string;
  failedAt: string | null;
  correlationId: string | null;
  organizationId: string | null;
  workspaceId: string | null;
  /** The one identifying field from the payload, if the job carries one. */
  resourceId: string | null;
}

export interface ListFailedOptions {
  /** Tenant filter. Omitted => all tenants (operator/global view only). */
  organizationId?: string;
  workspaceId?: string;
  limit?: number;
}

export interface QueueInspectorPort {
  counts(): Promise<QueueCounts>;
  listFailed(options?: ListFailedOptions): Promise<FailedJobSummary[]>;
  listDeadLetters(options?: ListFailedOptions): Promise<FailedJobSummary[]>;
  /** Re-runs a failed job. Returns false when it no longer exists. */
  retryFailed(jobId: string): Promise<boolean>;
  /** True when the queue's backing store answered. */
  ping(): Promise<boolean>;
}

const MAX_REASON_LENGTH = 400;
const DEFAULT_LIMIT = 50;

interface StoredData {
  payload?: Record<string, unknown>;
  correlationId?: string;
  tenant?: { organizationId?: string; workspaceId?: string };
}

/** Payload keys that identify the work, in the order we prefer them. */
const RESOURCE_KEYS = ['runId', 'draftId', 'entryId', 'projectId', 'workspaceId'] as const;

export class BullMqQueueInspector implements QueueInspectorPort {
  constructor(
    private readonly queue: Queue,
    private readonly deadLetterQueue: Queue,
    private readonly connection: Redis,
  ) {}

  async counts(): Promise<QueueCounts> {
    const [counts, deadLettered] = await Promise.all([
      this.queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'paused'),
      this.deadLetterQueue.getJobCountByTypes('waiting', 'completed', 'failed'),
    ]);
    return {
      waiting: counts['waiting'] ?? 0,
      active: counts['active'] ?? 0,
      delayed: counts['delayed'] ?? 0,
      completed: counts['completed'] ?? 0,
      failed: counts['failed'] ?? 0,
      paused: counts['paused'] ?? 0,
      deadLettered: deadLettered ?? 0,
    };
  }

  async listFailed(options: ListFailedOptions = {}): Promise<FailedJobSummary[]> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    // Over-fetch, then tenant-filter in memory: BullMQ cannot index on payload
    // fields, and a caller must never see another tenant's jobs.
    const jobs = await this.queue.getFailed(0, Math.max(limit * 4, 200));
    return jobs
      .map((job) =>
        toSummary({
          id: String(job.id ?? ''),
          name: job.name,
          attemptsMade: job.attemptsMade,
          maxAttempts: job.opts.attempts ?? 1,
          reason: job.failedReason ?? 'unknown',
          failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
          data: job.data as StoredData,
        }),
      )
      .filter((summary) => matchesTenant(summary, options))
      .slice(0, limit);
  }

  async listDeadLetters(options: ListFailedOptions = {}): Promise<FailedJobSummary[]> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const jobs = await this.deadLetterQueue.getJobs(
      ['waiting', 'completed', 'failed'],
      0,
      Math.max(limit * 4, 200),
    );
    return jobs
      .map((job) => {
        const entry = job.data as {
          envelope?: { id?: string; name?: string; data?: StoredData };
          failedAt?: string;
          reason?: string;
        };
        return toSummary({
          id: String(entry.envelope?.id ?? job.id ?? ''),
          name: entry.envelope?.name ?? 'unknown',
          attemptsMade: 0,
          maxAttempts: 0,
          reason: entry.reason ?? 'unknown',
          failedAt: entry.failedAt ?? null,
          data: entry.envelope?.data ?? {},
        });
      })
      .filter((summary) => matchesTenant(summary, options))
      .slice(0, limit);
  }

  /**
   * Re-runs the ORIGINAL failed job.
   *
   * This is what makes retry safe. BullMQ's `retry()` moves the existing job
   * back to waiting with its id, name and payload intact — so the idempotency
   * key the job was enqueued under is unchanged, and the executor's own budget
   * pre-flight runs again on execution. Re-enqueuing a *copy* would break both:
   * a new id defeats idempotency, and nothing would re-check the budget.
   */
  async retryFailed(jobId: string): Promise<boolean> {
    const job = await this.queue.getJob(jobId);
    if (!job) return false;
    const state = await job.getState();
    if (state !== 'failed') return false;
    await job.retry();
    return true;
  }

  async ping(): Promise<boolean> {
    try {
      await this.connection.ping();
      return true;
    } catch {
      return false;
    }
  }
}

function toSummary(input: {
  id: string;
  name: string;
  attemptsMade: number;
  maxAttempts: number;
  reason: string;
  failedAt: string | null;
  data: StoredData;
}): FailedJobSummary {
  const payload = input.data.payload ?? {};
  let resourceId: string | null = null;
  for (const key of RESOURCE_KEYS) {
    const value = payload[key];
    if (typeof value === 'string') {
      resourceId = value;
      break;
    }
  }
  return {
    id: input.id,
    name: input.name,
    attemptsMade: input.attemptsMade,
    maxAttempts: input.maxAttempts,
    // Truncated, and only ever the message: a failure reason can be long, and
    // the payload itself is never surfaced.
    reason: input.reason.slice(0, MAX_REASON_LENGTH),
    failedAt: input.failedAt,
    correlationId: input.data.correlationId ?? null,
    organizationId: input.data.tenant?.organizationId ?? null,
    workspaceId: input.data.tenant?.workspaceId ?? null,
    resourceId,
  };
}

/**
 * Tenant filter.
 *
 * A job with NO recorded tenant is excluded from a tenant-scoped listing.
 * Failing closed matters more than completeness here: showing an unattributed
 * job to a tenant that may not own it is the worse error.
 */
function matchesTenant(summary: FailedJobSummary, options: ListFailedOptions): boolean {
  if (!options.organizationId) return true;
  if (summary.organizationId !== options.organizationId) return false;
  if (options.workspaceId && summary.workspaceId !== options.workspaceId) return false;
  return true;
}
