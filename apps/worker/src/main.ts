import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';

import { AnthropicTextGenerationProvider } from '@spectra/ai-anthropic';
import {
  ANALYTICS_ADAPTER_PLATFORMS,
  claimDueAnalyticsSyncs,
  createAnalyticsProviderResolver,
  executeAnalyticsSync,
  measuredEngagementForTopic,
} from '@spectra/analytics-pipeline';
import { VoyageEmbeddingProvider } from '@spectra/ai-voyage';
import { BraveNewsSearchProvider, BraveWebSearchProvider } from '@spectra/research-brave';
import { ResearchProviderRegistry } from '@spectra/research-core';
import { loadEnv, socialKeyRingFromEnv, storageEnvSchema, workerEnvSchema } from '@spectra/config';
import { executeContentDraft } from '@spectra/content-pipeline';
import { createPrismaClient } from '@spectra/database';
import { FirstPartyDocumentExtractor } from '@spectra/document-extract';
import { createLogger, withCorrelation } from '@spectra/logging';
import { PrismaUsageRecorder, expireStaleReservations } from '@spectra/metering';
import { METRICS, initTracing, metrics, withSpan } from '@spectra/telemetry';
import {
  claimDuePublications,
  createMediaLoader,
  createMediaUrlSigner,
  createPublisherResolver,
  executePublication,
  publicMediaLinkProblem,
} from '@spectra/publishing';
import { executeReembed, executeResearchRun } from '@spectra/research-pipeline';
import { FfmpegVideoRenderer, resolveVideoEngineOptions } from '@spectra/media-ffmpeg';
import { executeVideoRender } from '@spectra/video-pipeline';
import type { KeyRing } from '@spectra/security';
import { linkedInApiOptionsFromEnv } from '@spectra/social-linkedin';
import { metaGraphOptionsFromEnv } from '@spectra/social-meta';
import { pinterestApiOptionsFromEnv } from '@spectra/social-pinterest';
import { threadsApiOptionsFromEnv } from '@spectra/social-threads';
import { tikTokApiOptionsFromEnv } from '@spectra/social-tiktok';
import { xApiOptionsFromEnv } from '@spectra/social-x';
import { youTubeApiOptionsFromEnv } from '@spectra/social-youtube';
import { resolveOAuthPlatform } from '@spectra/social-oauth';
import { S3ObjectStorageProvider } from '@spectra/storage';
import {
  BullMqJobQueue,
  BullMqWorkerRuntime,
  JOB_NAMES,
  SYSTEM_QUEUE,
  createRedisConnection,
  type JobContext,
  type JobEnvelope,
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

  // Tracing is env-gated: with no OTEL_EXPORTER_OTLP_ENDPOINT nothing is
  // loaded and the worker runs exactly as before (ADR-0033).
  const tracing = await initTracing(
    {
      endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      serviceName: 'spectra-worker',
      environment: env.NODE_ENV,
    },
    logger,
  );
  logger.info({ tracingEnabled: tracing.enabled }, tracing.reason);

  // Separate connections: BullMQ blocking ops vs. plain state writes.
  const queueConnection = createRedisConnection(env.REDIS_URL);
  const workerConnection = createRedisConnection(env.REDIS_URL);
  const stateRedis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  stateRedis.on('error', (error) => logger.warn({ err: error.message }, 'Redis state error'));

  const queue = new BullMqJobQueue(QUEUE_NAME, queueConnection);
  const runtime = new BullMqWorkerRuntime(QUEUE_NAME, workerConnection, env.WORKER_CONCURRENCY);

  /**
   * Wraps a job handler with duration/failure metrics and a span.
   *
   * Only the job name, ids and outcome reach telemetry — never the payload,
   * which carries tenant identifiers and, for some jobs, content (ADR-0033).
   */
  const instrument =
    <TPayload, TResult>(
      jobName: string,
      handler: (envelope: JobEnvelope<TPayload>, context: JobContext) => Promise<TResult>,
    ) =>
    async (envelope: JobEnvelope<TPayload>, context: JobContext): Promise<TResult> => {
      const started = Date.now();
      try {
        const result = await withSpan(
          `job ${jobName}`,
          {
            'spectra.job.name': jobName,
            'spectra.job.id': context.jobId,
            'spectra.job.attempt': context.attempt,
            'spectra.correlation_id': context.correlationId,
            'spectra.organization_id': envelope.tenant?.organizationId,
            'spectra.workspace_id': envelope.tenant?.workspaceId,
          },
          () => handler(envelope, context),
        );
        metrics.observe(METRICS.workerJobDuration, Date.now() - started, {
          job: jobName,
          outcome: 'success',
        });
        return result;
      } catch (error) {
        metrics.observe(METRICS.workerJobDuration, Date.now() - started, {
          job: jobName,
          outcome: 'error',
        });
        metrics.increment(METRICS.workerJobFailures, { job: jobName });
        // A budget refusal is a product decision, not an outage. Counted
        // separately so a dashboard does not read "the platform is failing"
        // when the truth is "this workspace hit its limit".
        if (error instanceof Error && error.name === 'BudgetBlockedError') {
          metrics.increment(METRICS.budgetBlocked, { job: jobName, surface: 'worker' });
        }
        // The last attempt is the one that dead-letters (see BullMqWorkerRuntime).
        if (context.attempt >= (envelope.maxAttempts || 1)) {
          metrics.increment(METRICS.queueDeadLettered, { job: jobName });
        }
        throw error;
      }
    };

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
  const storageEnv = loadEnv(storageEnvSchema);
  const storage = new S3ObjectStorageProvider(storageEnv);
  await storage.ensureBucket();

  // Semantic embedder (Phase 5A). Env-gated: without VOYAGE_API_KEY the
  // pipeline resolves to the first-party lexical embedder and says so — it
  // never silently pretends retrieval is semantic.
  const embedder = new VoyageEmbeddingProvider({
    apiKey: env.VOYAGE_API_KEY,
    model: env.VOYAGE_EMBEDDING_MODEL,
    dimensions: env.VOYAGE_EMBEDDING_DIMENSIONS,
  });
  logger.info(
    { semantic: embedder.isConfigured, model: env.VOYAGE_EMBEDDING_MODEL },
    embedder.isConfigured
      ? 'Semantic embeddings enabled'
      : 'VOYAGE_API_KEY not set — retrieval stays lexical (matches words, not meaning)',
  );

  // One ledger for every metered operation this worker performs (Phase 5D).
  const usage = new PrismaUsageRecorder(prisma, logger);

  // Trend scoring reads measured engagement from stored platform analytics
  // (ADR-0039). No snapshots for a topic = the signal is unavailable and the
  // score stays research-only — never zero engagement.
  const measuredEngagement = (
    scope: { organizationId: string; workspaceId: string },
    topicKey: string,
  ) => measuredEngagementForTopic(prisma, scope, topicKey);

  // Document extraction (Phase 5G): first-party, no external service, so it is
  // always available — discovered PDFs/DOCX/TXT stop being snippet-only.
  const documentExtractor = new FirstPartyDocumentExtractor();

  // Discovery providers (Phase 5C). Registered only when configured, so the
  // pipeline's `listByKind` answers "what can actually run". Unconfigured means
  // runs use their own feeds and a search-only plan fails loudly rather than
  // reporting an empty success.
  const providerRegistry = new ResearchProviderRegistry();
  const braveWeb = new BraveWebSearchProvider({ apiKey: env.BRAVE_SEARCH_API_KEY });
  if (braveWeb.isConfigured) {
    providerRegistry.register(braveWeb);
    providerRegistry.register(new BraveNewsSearchProvider({ apiKey: env.BRAVE_SEARCH_API_KEY }));
  }
  logger.info(
    { liveSearch: braveWeb.isConfigured },
    braveWeb.isConfigured
      ? 'Live web/news discovery enabled'
      : 'BRAVE_SEARCH_API_KEY not set — research runs use configured feeds only',
  );

  runtime.register<{ runId: string }, unknown>(
    JOB_NAMES.researchRunExecute,
    instrument('research.run.execute', async (envelope, context) => {
      const jobLogger = withCorrelation(logger, context.correlationId);
      jobLogger.info(
        { runId: envelope.payload.runId, attempt: context.attempt },
        'Research run started',
      );
      const outcome = await executeResearchRun(
        {
          prisma,
          storage,
          embedder,
          providerRegistry,
          documentExtractor,
          usage,
          measuredEngagement,
          logger: jobLogger,
        },
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
    }),
    { concurrency: 2, timeoutMs: 4 * 60_000 },
  );

  // Recurring research: per-project schedulers fire this dispatcher, which
  // creates a run row and executes it. Stale schedulers self-remove when the
  // project is gone or its schedule was cleared.
  runtime.register<{ projectId: string }, unknown>(
    JOB_NAMES.researchRunScheduled,
    instrument('research.run.scheduled', async (envelope, context) => {
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
        {
          prisma,
          storage,
          embedder,
          providerRegistry,
          documentExtractor,
          usage,
          measuredEngagement,
          logger: jobLogger,
        },
        {
          runId: run.id,
          signal: context.signal,
          onProgress: async (percent, note) => {
            await context.reportProgress({ percent, ...(note ? { note } : {}) });
          },
        },
      );
    }),
    { concurrency: 1, timeoutMs: 4 * 60_000 },
  );

  // Evidence-grounded content drafting. The provider is env-gated — with no
  // ANTHROPIC_API_KEY the executor records the draft as FAILED (honest), never
  // fabricated text. The API's synchronous guard means unconfigured requests
  // 503 before a job is ever enqueued, so this path only runs when configured.
  const textProvider = new AnthropicTextGenerationProvider({
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL,
    maxOutputTokens: env.ANTHROPIC_MAX_OUTPUT_TOKENS,
  });

  runtime.register<{ draftId: string }, unknown>(
    JOB_NAMES.contentDraftGenerate,
    instrument('content.draft.generate', async (envelope, context) => {
      const jobLogger = withCorrelation(logger, context.correlationId);
      return executeContentDraft(
        { prisma, provider: textProvider, usage, logger: jobLogger },
        { draftId: envelope.payload.draftId },
      );
    }),
    { concurrency: 2, timeoutMs: 5 * 60_000 },
  );

  // Publishing dispatcher: claims due schedule entries (SCHEDULED, past due,
  // with a target account) and enqueues a publish job for each.
  runtime.register(
    JOB_NAMES.publicationDispatch,
    async (_envelope, context) => {
      const dueIds = await claimDuePublications(prisma, new Date());
      for (const entryId of dueIds) {
        await queue.enqueue(JOB_NAMES.publicationPublish, { entryId });
      }
      if (dueIds.length > 0) {
        withCorrelation(logger, context.correlationId).info(
          { claimed: dueIds.length },
          'Dispatched due publications',
        );
      }
      return { claimed: dueIds.length };
    },
    { concurrency: 1, timeoutMs: 60_000 },
  );

  // Live publisher resolution (createPublisherResolver, @spectra/publishing).
  // The worker holds the social token-encryption key (env-gated). WordPress
  // accounts carry a sealed application password; LinkedIn accounts discovered
  // over OAuth use their connection's token, refreshed before expiry where
  // LinkedIn issued a refresh token (ADR-0035). Facebook Pages and Instagram
  // accounts carry their own sealed Page token (ADR-0036); YouTube channels use
  // their connection's token and resume interrupted uploads (ADR-0037). Any
  // missing piece records an
  // honest UNSUPPORTED or FAILED with the reason. Decrypted secrets never leave
  // the resolver and are never logged. The ring includes retired keys, so
  // credentials sealed before a rotation stay publishable (ADR-0034).
  const socialRing: KeyRing | undefined = socialKeyRingFromEnv(env);
  if (!socialRing) {
    logger.warn(
      'SOCIAL_TOKEN_ENCRYPTION_KEY is not set — publishing resolves to UNSUPPORTED for all platforms',
    );
  }
  const linkedinOAuth = resolveOAuthPlatform(env, 'LINKEDIN');
  const facebookOAuth = resolveOAuthPlatform(env, 'FACEBOOK');
  const youtubeOAuth = resolveOAuthPlatform(env, 'YOUTUBE');
  const tiktokOAuth = resolveOAuthPlatform(env, 'TIKTOK');
  const threadsOAuth = resolveOAuthPlatform(env, 'THREADS');
  const xOAuth = resolveOAuthPlatform(env, 'X');
  const pinterestOAuth = resolveOAuthPlatform(env, 'PINTEREST');
  // Instagram fetches images itself, from a short-lived signed link to
  // storage — possible only when storage is reachable from the internet.
  const instagramMediaProblem = publicMediaLinkProblem(storageEnv.STORAGE_ENDPOINT);
  if (instagramMediaProblem) {
    logger.warn(
      'Object storage is not publicly reachable — Instagram publishing resolves to UNSUPPORTED',
    );
  }
  const resolvePublisher = createPublisherResolver({
    prisma,
    ring: socialRing,
    linkedin: {
      api: linkedInApiOptionsFromEnv(env),
      oauth: linkedinOAuth.configured ? linkedinOAuth.config : null,
    },
    meta: {
      api: metaGraphOptionsFromEnv(
        env,
        facebookOAuth.configured ? facebookOAuth.config.clientSecret : null,
      ),
      instagramMediaProblem,
    },
    youtube: {
      api: youTubeApiOptionsFromEnv(env),
      oauth: youtubeOAuth.configured ? youtubeOAuth.config : null,
    },
    tiktok: {
      api: tikTokApiOptionsFromEnv(env),
      oauth: tiktokOAuth.configured ? tiktokOAuth.config : null,
    },
    // Threads and Pinterest fetch the image themselves, from the same kind of
    // short-lived signed link Instagram uses.
    threads: {
      api: threadsApiOptionsFromEnv(
        env,
        publicMediaLinkProblem(storageEnv.STORAGE_ENDPOINT, 'Threads'),
      ),
      oauth: threadsOAuth.configured ? threadsOAuth.config : null,
    },
    x: { api: xApiOptionsFromEnv(env), oauth: xOAuth.configured ? xOAuth.config : null },
    pinterest: {
      api: pinterestApiOptionsFromEnv(
        env,
        publicMediaLinkProblem(storageEnv.STORAGE_ENDPOINT, 'Pinterest'),
      ),
      oauth: pinterestOAuth.configured ? pinterestOAuth.config : null,
    },
    logger,
  });
  // Attached images are read from tenant-rooted storage, key-checked per entry.
  const loadMedia = createMediaLoader(storage);
  const mediaUrl = instagramMediaProblem ? undefined : createMediaUrlSigner(storage);

  // Publish one entry. With no live publisher resolvable it records an honest
  // UNSUPPORTED; WordPress and connected LinkedIn, Meta and YouTube accounts
  // produce a real PUBLISHED/FAILED from the platform's own response.
  runtime.register<{ entryId: string }, unknown>(
    JOB_NAMES.publicationPublish,
    instrument('publication.publish', async (envelope, context) => {
      return executePublication(
        {
          prisma,
          resolvePublisher,
          loadMedia,
          ...(mediaUrl ? { mediaUrl } : {}),
          logger: withCorrelation(logger, context.correlationId),
        },
        { entryId: envelope.payload.entryId },
      );
    }),
    { concurrency: 3, timeoutMs: 2 * 60_000 },
  );

  // External analytics (ADR-0039). Providers read through the same sealed
  // connections as publishing; an account without an adapter, a connection or
  // a scope resolves to an honest UNAVAILABLE with the reason — nothing is
  // estimated in its place.
  const resolveAnalyticsProvider = createAnalyticsProviderResolver({
    prisma,
    ring: socialRing,
    youtube: {
      api: youTubeApiOptionsFromEnv(env),
      oauth: youtubeOAuth.configured ? youtubeOAuth.config : null,
      analyticsApiBaseUrl: env.YOUTUBE_ANALYTICS_API_BASE_URL,
    },
    linkedin: {
      api: linkedInApiOptionsFromEnv(env),
      oauth: linkedinOAuth.configured ? linkedinOAuth.config : null,
    },
    meta: {
      api: metaGraphOptionsFromEnv(
        env,
        facebookOAuth.configured ? facebookOAuth.config.clientSecret : null,
      ),
    },
    logger,
  });
  const analyticsDeps = {
    prisma,
    resolveProvider: resolveAnalyticsProvider,
    usage,
    staleAfterMs: env.ANALYTICS_STALE_AFTER_HOURS * 3_600_000,
  };

  // One sync attempt. A rate-limited or transiently failed run comes back with
  // `nextAttemptAt`, and a delayed job retries it then (the dispatcher below is
  // the safety net if that job is lost).
  runtime.register<{ runId: string }, unknown>(
    JOB_NAMES.analyticsSyncExecute,
    instrument('analytics.sync.execute', async (envelope, context) => {
      const jobLogger = withCorrelation(logger, context.correlationId);
      const outcome = await executeAnalyticsSync(
        { ...analyticsDeps, logger: jobLogger },
        { runId: envelope.payload.runId },
      );
      if (outcome.nextAttemptAt) {
        await queue.enqueue(
          JOB_NAMES.analyticsSyncExecute,
          { runId: outcome.runId },
          {
            delayMs: Math.max(0, outcome.nextAttemptAt.getTime() - Date.now()),
            idempotencyKey: `analytics-${outcome.runId}-${outcome.nextAttemptAt.getTime()}`,
            ...(envelope.tenant ? { tenant: envelope.tenant } : {}),
          },
        );
      }
      return outcome;
    }),
    { concurrency: 2, timeoutMs: 10 * 60_000 },
  );

  // One video render. The encoder is a subprocess, so the job's own abort
  // signal is what stops it: a timeout or a cancellation reaches ffmpeg itself
  // rather than leaving it running after the job gives up (ADR-0041).
  const videoRenderer = new FfmpegVideoRenderer(
    resolveVideoEngineOptions({
      ffmpegPath: env.FFMPEG_PATH ?? null,
      ffprobePath: env.FFPROBE_PATH ?? null,
      fontFile: env.VIDEO_FONT_FILE ?? null,
      timeoutMs: env.VIDEO_RENDER_TIMEOUT_MS,
    }),
  );
  const videoCapability = await videoRenderer.capabilities();
  logger.info(
    {
      available: videoCapability.available,
      engineVersion: videoCapability.engineVersion,
      videoCodec: videoCapability.videoCodec,
    },
    videoCapability.reason,
  );

  runtime.register<{ renderId: string }, unknown>(
    JOB_NAMES.videoRenderExecute,
    instrument('video.render.execute', async (envelope, context) => {
      const jobLogger = withCorrelation(logger, context.correlationId);
      return executeVideoRender(
        {
          prisma,
          storage,
          renderer: videoRenderer,
          usage,
          logger: jobLogger,
        },
        envelope.payload.renderId,
        {
          signal: context.signal,
          attempt: context.attempt,
          reportProgress: (percent) => context.reportProgress({ percent }),
        },
      );
    }),
    {
      // Encoding is CPU-bound: more than a couple at once makes every render
      // slower without finishing any sooner.
      concurrency: 2,
      timeoutMs: env.VIDEO_RENDER_TIMEOUT_MS + 60_000,
    },
  );

  // Due analytics runs: retries whose backoff elapsed, and — only when
  // ANALYTICS_SCHEDULED_SYNC_ENABLED — one scheduled run per workspace per
  // interval. Off by default, because every sync spends platform quota.
  runtime.register(
    JOB_NAMES.analyticsSyncDispatch,
    async (_envelope, context) => {
      const runIds = await claimDueAnalyticsSyncs(prisma, new Date(), {
        scheduled: env.ANALYTICS_SCHEDULED_SYNC_ENABLED,
        intervalMs: env.ANALYTICS_SYNC_INTERVAL_MINUTES * 60_000,
        platforms: [...ANALYTICS_ADAPTER_PLATFORMS],
      });
      for (const runId of runIds) {
        await queue.enqueue(
          JOB_NAMES.analyticsSyncExecute,
          { runId },
          { idempotencyKey: `analytics-dispatch-${runId}-${Math.floor(Date.now() / 60_000)}` },
        );
      }
      if (runIds.length > 0) {
        withCorrelation(logger, context.correlationId).info(
          { dispatched: runIds.length },
          'Dispatched due analytics syncs',
        );
      }
      return { dispatched: runIds.length };
    },
    { concurrency: 1, timeoutMs: 60_000 },
  );
  logger.info(
    {
      scheduledAnalytics: env.ANALYTICS_SCHEDULED_SYNC_ENABLED,
      intervalMinutes: env.ANALYTICS_SYNC_INTERVAL_MINUTES,
    },
    env.ANALYTICS_SCHEDULED_SYNC_ENABLED
      ? 'Scheduled analytics sync enabled'
      : 'Scheduled analytics sync disabled (ANALYTICS_SCHEDULED_SYNC_ENABLED) — manual syncs only',
  );

  // Backfill: re-embed a workspace's chunks into the ACTIVE collection. Needed
  // when the embedding model changes, otherwise search would point at a new,
  // empty collection and silently return nothing for existing findings.
  runtime.register<{ organizationId: string; workspaceId: string }, unknown>(
    JOB_NAMES.knowledgeReembed,
    instrument('knowledge.reembed', async (envelope, context) => {
      const jobLogger = withCorrelation(logger, context.correlationId);
      return executeReembed(
        { prisma, embedder, logger: jobLogger },
        {
          organizationId: envelope.payload.organizationId,
          workspaceId: envelope.payload.workspaceId,
        },
      );
    }),
    { concurrency: 1, timeoutMs: 15 * 60_000 },
  );

  // Stale budget holds: pre-flight already ignores expired reservations, so
  // this is hygiene rather than correctness — it keeps the table bounded and
  // interpretable after crashed workers.
  runtime.register(
    JOB_NAMES.budgetReservationSweep,
    async (_envelope, context) => {
      const released = await expireStaleReservations(prisma);
      if (released > 0) {
        withCorrelation(logger, context.correlationId).info(
          { released },
          'Released expired budget reservations',
        );
      }
      return { released };
    },
    { concurrency: 1, timeoutMs: 30_000 },
  );

  await runtime.start();
  await queue.schedule(HEARTBEAT_JOB_NAME, {}, { everyMs: env.WORKER_HEARTBEAT_INTERVAL_MS });
  // Scan for due publications every minute.
  await queue.schedule(JOB_NAMES.publicationDispatch, {}, { everyMs: 60_000 });
  // Sweep expired budget holds every five minutes.
  await queue.schedule(JOB_NAMES.budgetReservationSweep, {}, { everyMs: 5 * 60_000 });
  // Look for due analytics runs (retries, and scheduled syncs when enabled) every five minutes.
  await queue.schedule(JOB_NAMES.analyticsSyncDispatch, {}, { everyMs: 5 * 60_000 });

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
