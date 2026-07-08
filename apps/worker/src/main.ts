import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';

import { loadEnv, storageEnvSchema, workerEnvSchema } from '@spectra/config';
import { createPrismaClient } from '@spectra/database';
import { createLogger, withCorrelation } from '@spectra/logging';
import { executeResearchRun } from '@spectra/research-pipeline';
import { S3ObjectStorageProvider } from '@spectra/storage';
import {
  BullMqJobQueue,
  BullMqWorkerRuntime,
  JOB_NAMES,
  SYSTEM_QUEUE,
  createRedisConnection,
} from '@spectra/workflow-core';
import IORedis from 'ioredis';

import {
  HEARTBEAT_JOB_NAME,
  HEARTBEAT_REDIS_KEY,
  HEARTBEAT_TTL_SECONDS,
  buildHeartbeat,
} from './heartbeat';

const QUEUE_NAME = SYSTEM_QUEUE;

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

  // Research pipeline dependencies (Prisma + tenant-scoped object storage).
  const prisma = createPrismaClient({ datasourceUrl: env.DATABASE_URL });
  const storage = new S3ObjectStorageProvider(loadEnv(storageEnvSchema));
  await storage.ensureBucket();

  runtime.register<{ runId: string }, unknown>(
    JOB_NAMES.researchRunExecute,
    async (envelope, context) => {
      const jobLogger = withCorrelation(logger, context.correlationId);
      jobLogger.info(
        { runId: envelope.payload.runId, attempt: context.attempt },
        'Research run started',
      );
      const outcome = await executeResearchRun(
        { prisma, storage, logger: jobLogger },
        {
          runId: envelope.payload.runId,
          signal: context.signal,
          onProgress: async (percent, note) => {
            await context.reportProgress({ percent, ...(note ? { note } : {}) });
          },
        },
      );
      jobLogger.info(
        { runId: envelope.payload.runId, ...outcome.stats, status: outcome.status },
        'Research run finished',
      );
      return outcome;
    },
    { concurrency: 2, timeoutMs: 4 * 60_000 },
  );

  // Recurring research: per-project schedulers fire this dispatcher, which
  // creates a run row and executes it. Stale schedulers self-remove when the
  // project is gone or its schedule was cleared.
  runtime.register<{ projectId: string }, unknown>(
    JOB_NAMES.researchRunScheduled,
    async (envelope, context) => {
      const jobLogger = withCorrelation(logger, context.correlationId);
      const { projectId } = envelope.payload;
      const project = await prisma.researchProject.findUnique({ where: { id: projectId } });
      if (
        !project ||
        project.deletedAt !== null ||
        !project.scheduleEveryMinutes ||
        project.scheduleFeedUrls.length === 0
      ) {
        await queue.unschedule(`research-schedule-${projectId}`);
        jobLogger.info({ projectId }, 'Removed stale research schedule');
        return { skipped: true };
      }
      const run = await prisma.researchRun.create({
        data: {
          organizationId: project.organizationId,
          workspaceId: project.workspaceId,
          projectId: project.id,
          status: 'QUEUED',
          trigger: 'SCHEDULED',
          queryPlan: { feedUrls: project.scheduleFeedUrls },
        },
      });
      jobLogger.info({ projectId, runId: run.id }, 'Scheduled research run created');
      return executeResearchRun(
        { prisma, storage, logger: jobLogger },
        {
          runId: run.id,
          signal: context.signal,
          onProgress: async (percent, note) => {
            await context.reportProgress({ percent, ...(note ? { note } : {}) });
          },
        },
      );
    },
    { concurrency: 1, timeoutMs: 4 * 60_000 },
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
      await prisma.$disconnect();
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
