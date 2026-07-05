import { generateCorrelationId } from '@spectra/observability';
import { Queue, Worker, type Job } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';

import {
  DEFAULT_RETRY_POLICY,
  type EnqueueOptions,
  type JobEnvelope,
  type JobHandler,
  type JobQueuePort,
  type RegisterHandlerOptions,
  type RetryPolicy,
  type ScheduleOptions,
  type WorkerRuntimePort,
} from './types';

// BullMQ queue names cannot contain ':' — it is the Redis key separator.
const DEAD_LETTER_SUFFIX = '-dead-letter';

export function createRedisConnection(redisUrl: string): Redis {
  // BullMQ requires maxRetriesPerRequest: null on blocking connections.
  return new IORedis(redisUrl, { maxRetriesPerRequest: null });
}

function toBullBackoff(retry: RetryPolicy) {
  return {
    type: retry.backoff.type === 'exponential' ? 'exponential' : 'fixed',
    delay: retry.backoff.delayMs,
  } as const;
}

interface StoredJobData<TPayload> {
  payload: TPayload;
  correlationId: string;
  tenant?: { organizationId: string; workspaceId?: string };
  enqueuedAt: string;
}

/** JobQueuePort backed by a single BullMQ queue. */
export class BullMqJobQueue implements JobQueuePort {
  private readonly queue: Queue;

  constructor(
    queueName: string,
    connection: Redis,
    private readonly defaultRetry: RetryPolicy = DEFAULT_RETRY_POLICY,
  ) {
    this.queue = new Queue(queueName, { connection });
  }

  async enqueue<TPayload>(
    name: string,
    payload: TPayload,
    options: EnqueueOptions = {},
  ): Promise<string> {
    const retry = options.retry ?? this.defaultRetry;
    const data: StoredJobData<TPayload> = {
      payload,
      correlationId: options.correlationId ?? generateCorrelationId(),
      ...(options.tenant ? { tenant: options.tenant } : {}),
      enqueuedAt: new Date().toISOString(),
    };
    const job = await this.queue.add(name, data, {
      // BullMQ dedupes by jobId — idempotency keys map directly onto it.
      ...(options.idempotencyKey ? { jobId: options.idempotencyKey } : {}),
      ...(options.delayMs !== undefined ? { delay: options.delayMs } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      attempts: retry.maxAttempts,
      backoff: toBullBackoff(retry),
      removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
      removeOnFail: false,
    });
    return job.id ?? 'unknown';
  }

  async schedule<TPayload>(
    name: string,
    payload: TPayload,
    options: ScheduleOptions,
  ): Promise<string> {
    const data: StoredJobData<TPayload> = {
      payload,
      correlationId: generateCorrelationId(),
      ...(options.tenant ? { tenant: options.tenant } : {}),
      enqueuedAt: new Date().toISOString(),
    };
    const job = await this.queue.upsertJobScheduler(
      `scheduler-${name}`,
      options.cron ? { pattern: options.cron, tz: 'UTC' } : { every: options.everyMs ?? 60000 },
      { name, data },
    );
    return job.id ?? `scheduler-${name}`;
  }

  async cancel(jobId: string): Promise<boolean> {
    const job = await this.queue.getJob(jobId);
    if (!job) return false;
    await job.remove();
    return true;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

interface Registration {
  handler: JobHandler<unknown, unknown>;
  options: RegisterHandlerOptions;
}

/** WorkerRuntimePort backed by a BullMQ Worker with dead-letter routing. */
export class BullMqWorkerRuntime implements WorkerRuntimePort {
  private readonly registrations = new Map<string, Registration>();
  private worker: Worker | null = null;
  private deadLetterQueue: Queue | null = null;

  constructor(
    private readonly queueName: string,
    private readonly connection: Redis,
    private readonly defaultConcurrency = 5,
  ) {}

  register<TPayload, TResult>(
    name: string,
    handler: JobHandler<TPayload, TResult>,
    options: RegisterHandlerOptions = {},
  ): void {
    if (this.worker) {
      throw new Error('Cannot register handlers after the worker has started');
    }
    this.registrations.set(name, {
      handler: handler as JobHandler<unknown, unknown>,
      options,
    });
  }

  async start(): Promise<void> {
    if (this.worker) return;
    this.deadLetterQueue = new Queue(`${this.queueName}${DEAD_LETTER_SUFFIX}`, {
      connection: this.connection,
    });

    this.worker = new Worker(
      this.queueName,
      async (job: Job) => {
        const registration = this.registrations.get(job.name);
        if (!registration) {
          throw new Error(`No handler registered for job ${job.name}`);
        }
        const data = job.data as StoredJobData<unknown>;
        const envelope: JobEnvelope = {
          id: job.id ?? 'unknown',
          name: job.name,
          payload: data.payload,
          attempt: job.attemptsMade + 1,
          maxAttempts: job.opts.attempts ?? 1,
          ...(data.correlationId ? { correlationId: data.correlationId } : {}),
          ...(data.tenant ? { tenant: data.tenant } : {}),
          enqueuedAt: data.enqueuedAt ?? new Date().toISOString(),
        };

        const abort = new AbortController();
        const timeoutMs = registration.options.timeoutMs;
        const timer = timeoutMs
          ? setTimeout(
              () => abort.abort(new Error(`Job timed out after ${timeoutMs}ms`)),
              timeoutMs,
            )
          : null;
        try {
          return await registration.handler(envelope, {
            jobId: envelope.id,
            attempt: envelope.attempt,
            correlationId: envelope.correlationId ?? 'unknown',
            signal: abort.signal,
            reportProgress: async (progress) => {
              await job.updateProgress({ percent: progress.percent, note: progress.note ?? null });
            },
          });
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
      {
        connection: this.connection,
        concurrency: this.defaultConcurrency,
      },
    );

    this.worker.on('failed', (job, error) => {
      // Route exhausted jobs to the dead-letter queue for inspection/replay.
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        void this.deadLetterQueue?.add('dead-letter', {
          envelope: { id: job.id, name: job.name, data: job.data },
          failedAt: new Date().toISOString(),
          reason: error?.message ?? 'unknown',
        });
      }
    });

    await this.worker.waitUntilReady();
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.deadLetterQueue?.close();
    this.worker = null;
    this.deadLetterQueue = null;
  }
}
