import { generateCorrelationId } from '@spectra/observability';

import {
  DEFAULT_RETRY_POLICY,
  type DeadLetterEntry,
  type EnqueueOptions,
  type JobEnvelope,
  type JobHandler,
  type JobQueuePort,
  type RegisterHandlerOptions,
  type ScheduleOptions,
} from './types';

/**
 * In-memory adapter for unit tests and offline development. Implements the
 * same semantics as the BullMQ adapter: idempotent enqueue, bounded retries
 * and dead-letter capture — but runs jobs synchronously via `drain()`.
 */
export class InMemoryJobQueue implements JobQueuePort {
  private readonly jobs: Array<JobEnvelope & { options: EnqueueOptions }> = [];
  private readonly seenIdempotencyKeys = new Set<string>();
  private readonly handlers = new Map<
    string,
    { handler: JobHandler<unknown, unknown>; options: RegisterHandlerOptions }
  >();
  public readonly deadLetters: DeadLetterEntry[] = [];
  private counter = 0;

  register<TPayload, TResult>(
    name: string,
    handler: JobHandler<TPayload, TResult>,
    options: RegisterHandlerOptions = {},
  ): void {
    this.handlers.set(name, { handler: handler as JobHandler<unknown, unknown>, options });
  }

  async enqueue<TPayload>(
    name: string,
    payload: TPayload,
    options: EnqueueOptions = {},
  ): Promise<string> {
    if (options.idempotencyKey) {
      if (this.seenIdempotencyKeys.has(options.idempotencyKey)) {
        return options.idempotencyKey;
      }
      this.seenIdempotencyKeys.add(options.idempotencyKey);
    }
    this.counter += 1;
    const id = options.idempotencyKey ?? `job-${this.counter}`;
    const retry = options.retry ?? DEFAULT_RETRY_POLICY;
    this.jobs.push({
      id,
      name,
      payload,
      attempt: 0,
      maxAttempts: retry.maxAttempts,
      correlationId: options.correlationId ?? generateCorrelationId(),
      ...(options.tenant ? { tenant: options.tenant } : {}),
      enqueuedAt: new Date().toISOString(),
      options,
    });
    return id;
  }

  private readonly schedulers = new Set<string>();

  async schedule<TPayload>(
    name: string,
    payload: TPayload,
    options: ScheduleOptions,
  ): Promise<string> {
    // Scheduling in-memory registers a single immediate occurrence.
    const schedulerId = options.schedulerId ?? `scheduler-${name}`;
    this.schedulers.add(schedulerId);
    await this.enqueue(name, payload, {});
    return schedulerId;
  }

  async unschedule(schedulerId: string): Promise<boolean> {
    return this.schedulers.delete(schedulerId);
  }

  async cancel(jobId: string): Promise<boolean> {
    const index = this.jobs.findIndex((job) => job.id === jobId);
    if (index === -1) return false;
    this.jobs.splice(index, 1);
    return true;
  }

  async close(): Promise<void> {
    this.jobs.length = 0;
  }

  get pendingCount(): number {
    return this.jobs.length;
  }

  /** Executes all pending jobs, applying retry and dead-letter semantics. */
  async drain(): Promise<void> {
    while (this.jobs.length > 0) {
      const job = this.jobs.shift();
      if (!job) break;
      const registration = this.handlers.get(job.name);
      if (!registration) {
        this.deadLetters.push({
          envelope: job,
          failedAt: new Date().toISOString(),
          reason: `No handler registered for job ${job.name}`,
        });
        continue;
      }
      const envelope: JobEnvelope = { ...job, attempt: job.attempt + 1 };
      try {
        const abort = new AbortController();
        await registration.handler(envelope, {
          jobId: envelope.id,
          attempt: envelope.attempt,
          correlationId: envelope.correlationId ?? 'unknown',
          signal: abort.signal,
          reportProgress: async () => undefined,
        });
      } catch (error) {
        if (envelope.attempt < envelope.maxAttempts) {
          this.jobs.push({ ...job, attempt: envelope.attempt });
        } else {
          this.deadLetters.push({
            envelope,
            failedAt: new Date().toISOString(),
            reason: error instanceof Error ? error.message : 'unknown',
          });
        }
      }
    }
  }
}
