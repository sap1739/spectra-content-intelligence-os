/**
 * Queue-neutral job orchestration ports.
 *
 * Domain workflows depend on these interfaces only — the queue engine
 * (BullMQ today; Temporal or a managed platform later) is an adapter detail.
 * See docs/adr/0006-workflow-engine.md.
 */

export interface RetryPolicy {
  maxAttempts: number;
  backoff: {
    type: 'exponential' | 'fixed';
    delayMs: number;
    maxDelayMs?: number;
  };
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  backoff: { type: 'exponential', delayMs: 2000, maxDelayMs: 5 * 60 * 1000 },
};

export interface EnqueueOptions {
  /** Same idempotency key twice → second enqueue is a no-op. */
  idempotencyKey?: string;
  delayMs?: number;
  priority?: number;
  retry?: RetryPolicy;
  correlationId?: string;
  tenant?: { organizationId: string; workspaceId?: string };
}

export interface JobEnvelope<TPayload = unknown> {
  id: string;
  name: string;
  payload: TPayload;
  attempt: number;
  maxAttempts: number;
  correlationId?: string;
  tenant?: { organizationId: string; workspaceId?: string };
  enqueuedAt: string;
}

export interface JobProgress {
  percent: number;
  note?: string;
}

export interface JobContext {
  jobId: string;
  attempt: number;
  correlationId: string;
  /** Cooperative cancellation/timeout signal — long jobs must observe it. */
  signal: AbortSignal;
  reportProgress(progress: JobProgress): Promise<void>;
}

export type JobHandler<TPayload = unknown, TResult = unknown> = (
  envelope: JobEnvelope<TPayload>,
  context: JobContext,
) => Promise<TResult>;

export interface ScheduleOptions {
  /** Repeat every N milliseconds (mutually exclusive with cron). */
  everyMs?: number;
  /** Standard 5-field cron expression evaluated in UTC. */
  cron?: string;
  tenant?: { organizationId: string; workspaceId?: string };
}

export interface JobQueuePort {
  enqueue<TPayload>(name: string, payload: TPayload, options?: EnqueueOptions): Promise<string>;
  /** Registers a recurring job (heartbeats, scheduled research runs). */
  schedule<TPayload>(name: string, payload: TPayload, options: ScheduleOptions): Promise<string>;
  cancel(jobId: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface RegisterHandlerOptions {
  concurrency?: number;
  /** Per-execution timeout; the handler receives an aborted signal after it. */
  timeoutMs?: number;
  retry?: RetryPolicy;
}

export interface WorkerRuntimePort {
  register<TPayload, TResult>(
    name: string,
    handler: JobHandler<TPayload, TResult>,
    options?: RegisterHandlerOptions,
  ): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Jobs that exhaust retries land in a dead-letter queue for inspection/replay. */
export interface DeadLetterEntry<TPayload = unknown> {
  envelope: JobEnvelope<TPayload>;
  failedAt: string;
  reason: string;
}
