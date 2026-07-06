import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';

import { loadEnv, workerEnvSchema } from '@spectra/config';
import { createLogger, withCorrelation } from '@spectra/logging';
import { BullMqJobQueue, BullMqWorkerRuntime, createRedisConnection } from '@spectra/workflow-core';
import IORedis from 'ioredis';

import {
  HEARTBEAT_JOB_NAME,
  HEARTBEAT_REDIS_KEY,
  HEARTBEAT_TTL_SECONDS,
  buildHeartbeat,
} from './heartbeat';

const QUEUE_NAME = 'spectra-system';

// Local-dev convenience: load the repo-root .env (real environment variables
// always take precedence — production injects env via the platform).
const rootEnvFile = resolve(__dirname, '../../../.env');
if (existsSync(rootEnvFile)) {
  process.loadEnvFile(rootEnvFile);
}

async function main(): Promise<void> {
  const env = loadEnv(workerEnvSchema);
  const logger = createLogger({ name: 'worker', level: env.LOG_LEVEL });
  const startedAt = new Date();

  // Separate connections: BullMQ blocking ops vs. plain state writes.
  const queueConnection = createRedisConnection(env.REDIS_URL);
  const workerConnection = createRedisConnection(env.REDIS_URL);
  const stateRedis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  stateRedis.on('error', (error) => logger.warn({ err: error.message }, 'Redis state error'));

  const queue = new BullMqJobQueue(QUEUE_NAME, queueConnection);
  const runtime = new BullMqWorkerRuntime(QUEUE_NAME, workerConnection, env.WORKER_CONCURRENCY);

  runtime.register(
    HEARTBEAT_JOB_NAME,
    async (_envelope, context) => {
      const beat = buildHeartbeat({
        pid: process.pid,
        hostname: hostname(),
        startedAt,
        now: new Date(),
      });
      await stateRedis.set(HEARTBEAT_REDIS_KEY, JSON.stringify(beat), 'EX', HEARTBEAT_TTL_SECONDS);
      await context.reportProgress({ percent: 100 });
      withCorrelation(logger, context.correlationId).info(
        { uptimeSeconds: beat.uptimeSeconds, jobId: context.jobId },
        'worker heartbeat',
      );
      return beat;
    },
    { concurrency: 1, timeoutMs: 10_000 },
  );

  await runtime.start();
  await queue.schedule(HEARTBEAT_JOB_NAME, {}, { everyMs: env.WORKER_HEARTBEAT_INTERVAL_MS });

  // Immediate first beat so readiness sees the worker without waiting a cycle.
  await queue.enqueue(
    HEARTBEAT_JOB_NAME,
    {},
    { idempotencyKey: `boot-${process.pid}-${startedAt.getTime()}` },
  );

  logger.info(
    {
      queue: QUEUE_NAME,
      heartbeatIntervalMs: env.WORKER_HEARTBEAT_INTERVAL_MS,
      concurrency: env.WORKER_CONCURRENCY,
    },
    'Worker started',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down worker');
    try {
      await runtime.stop();
      await queue.close();
      stateRedis.disconnect();
      queueConnection.disconnect();
      workerConnection.disconnect();
      process.exit(0);
    } catch (error) {
      logger.error({ err: error instanceof Error ? error.message : error }, 'Shutdown error');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('Worker failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
