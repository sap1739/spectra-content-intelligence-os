import { randomUUID } from 'node:crypto';

import {
  AnalyticsProviderError,
  DEFAULT_ANALYTICS_STALE_AFTER_MS,
  analyticsRetryDelayMs,
  isStructuralReason,
  sanitizeErrorMessage,
  sanitizeProviderMetadata,
  snapshotCompleteness,
  staleAfterFrom,
  type AnalyticsFetchResult,
  type AnalyticsProvider,
} from '@spectra/analytics-core';
import type {
  AnalyticsErrorCode,
  AnalyticsSyncStatus,
  AnalyticsSyncTarget,
  AnalyticsSyncTrigger,
  AnalyticsTargetOutcome,
  AnalyticsTargetResult,
  SocialPlatform,
} from '@spectra/contracts';
import type { Prisma, SpectraPrismaClient } from '@spectra/database';
import type { Logger } from '@spectra/logging';
import {
  BudgetBlockedError,
  reconcile,
  release,
  reserve,
  type UsageRecorder,
} from '@spectra/metering';

import {
  isAnalyticsUnavailable,
  type AnalyticsTargetAccount,
  type ResolveAnalyticsProvider,
} from './resolver';

/**
 * Analytics sync runs (ADR-0039): requested once (idempotent), executed by the
 * worker or directly by tests, retried with backoff when a platform rate
 * limits, and always finished with an honest status — SUCCEEDED, PARTIAL,
 * FAILED, or UNAVAILABLE when there was nothing a provider could read.
 */

export const DEFAULT_ANALYTICS_MAX_ATTEMPTS = 3;
/** Published posts older than this are not re-synced by a workspace or account run. */
export const ANALYTICS_LOOKBACK_DAYS = 90;
/** Upper bound on posts per run, so one workspace cannot monopolize a platform's quota. */
export const ANALYTICS_MAX_POSTS_PER_RUN = 100;
/** A RUNNING run older than this is presumed abandoned by a crashed worker. */
const RUN_LEASE_MS = 15 * 60_000;
const MAX_RESULTS = 200;

export class AnalyticsTargetNotFoundError extends Error {
  constructor() {
    super('Analytics sync target not found');
    this.name = 'AnalyticsTargetNotFoundError';
  }
}

export interface RequestAnalyticsSyncInput {
  organizationId: string;
  workspaceId: string;
  target: AnalyticsSyncTarget;
  socialAccountId?: string | null;
  scheduleEntryId?: string | null;
  trigger?: AnalyticsSyncTrigger;
  requestedById?: string | null;
  /** Client-supplied (Idempotency-Key header) or derived; namespaced by workspace. */
  idempotencyKey?: string | null;
  maxAttempts?: number;
}

/**
 * Creates a run, or returns the one already covering this request:
 * the same idempotency key, or an unfinished run for the same target. The
 * target is checked against the tenant first — a foreign or missing account
 * or entry is the same "not found".
 */
export async function requestAnalyticsSync(
  prisma: SpectraPrismaClient,
  input: RequestAnalyticsSyncInput,
): Promise<{ run: Prisma.AnalyticsSyncRunGetPayload<object>; created: boolean }> {
  const scope = { organizationId: input.organizationId, workspaceId: input.workspaceId };
  const socialAccountId =
    input.target === 'SOCIAL_ACCOUNT' ? (input.socialAccountId ?? null) : null;
  const scheduleEntryId =
    input.target === 'SCHEDULE_ENTRY' ? (input.scheduleEntryId ?? null) : null;

  if (input.target === 'SOCIAL_ACCOUNT') {
    const account = socialAccountId
      ? await prisma.socialAccount.findFirst({
          where: { id: socialAccountId, ...scope },
          select: { id: true },
        })
      : null;
    if (!account) throw new AnalyticsTargetNotFoundError();
  }
  if (input.target === 'SCHEDULE_ENTRY') {
    const entry = scheduleEntryId
      ? await prisma.contentScheduleEntry.findFirst({
          where: { id: scheduleEntryId, ...scope },
          select: { id: true },
        })
      : null;
    if (!entry) throw new AnalyticsTargetNotFoundError();
  }

  const key = input.idempotencyKey
    ? `${input.trigger === 'SCHEDULED' ? 'scheduled' : 'manual'}:${input.workspaceId}:${input.idempotencyKey}`
    : null;
  if (key) {
    const existing = await prisma.analyticsSyncRun.findFirst({
      where: { ...scope, idempotencyKey: key },
    });
    if (existing) return { run: existing, created: false };
  }

  const active = await prisma.analyticsSyncRun.findFirst({
    where: {
      ...scope,
      target: input.target,
      socialAccountId,
      scheduleEntryId,
      status: { in: ['QUEUED', 'RUNNING'] },
      // A run waiting on a retry is still active: a second request joins it.
    },
    orderBy: { createdAt: 'desc' },
  });
  if (active) return { run: active, created: false };

  try {
    const run = await prisma.analyticsSyncRun.create({
      data: {
        ...scope,
        trigger: input.trigger ?? 'MANUAL',
        target: input.target,
        socialAccountId,
        scheduleEntryId,
        status: 'QUEUED',
        idempotencyKey: key ?? `run:${input.workspaceId}:${randomUUID()}`,
        requestedById: input.requestedById ?? null,
        maxAttempts: input.maxAttempts ?? DEFAULT_ANALYTICS_MAX_ATTEMPTS,
      },
    });
    return { run, created: true };
  } catch (error) {
    // Two identical requests raced on the unique key: return the winner.
    if (key && (error as { code?: string }).code === 'P2002') {
      const existing = await prisma.analyticsSyncRun.findFirst({
        where: { ...scope, idempotencyKey: key },
      });
      if (existing) return { run: existing, created: false };
    }
    throw error;
  }
}

export interface AnalyticsSyncDeps {
  prisma: SpectraPrismaClient;
  /** Omitted: every account resolves to UNCONFIGURED and the run is UNAVAILABLE. */
  resolveProvider?: ResolveAnalyticsProvider;
  usage?: UsageRecorder;
  logger?: Logger;
  now?: () => Date;
  staleAfterMs?: number;
  /** Backoff base for retries (tests shorten it). */
  retryBaseMs?: number;
}

export interface AnalyticsSyncOutcome {
  runId: string;
  status: AnalyticsSyncStatus | 'SKIPPED';
  /** Set when a retry was scheduled; the worker enqueues a delayed job for it. */
  nextAttemptAt: Date | null;
}

interface EntryTarget {
  id: string;
  contentItemId: string;
  campaignId: string | null;
  externalPostId: string;
  publishedAt: Date | null;
  socialAccountId: string;
  platform: string;
}

const ACCOUNT_SELECT = {
  id: true,
  organizationId: true,
  workspaceId: true,
  platform: true,
  kind: true,
  externalAccountId: true,
  displayName: true,
  encryptedToken: true,
  connectionId: true,
  deletedAt: true,
} as const;

/** Failures that stop further calls to the same account in this attempt. */
const STOP_ACCOUNT: ReadonlySet<AnalyticsErrorCode> = new Set([
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'REAUTH_REQUIRED',
]);

export async function executeAnalyticsSync(
  deps: AnalyticsSyncDeps,
  input: { runId: string },
): Promise<AnalyticsSyncOutcome> {
  const { prisma } = deps;
  const clock = deps.now ?? (() => new Date());
  const now = clock();
  const logger = deps.logger?.child({ analyticsSyncRunId: input.runId });

  const run = await prisma.analyticsSyncRun.findUnique({ where: { id: input.runId } });
  if (!run) throw new Error(`Analytics sync run ${input.runId} not found`);
  const scope = { organizationId: run.organizationId, workspaceId: run.workspaceId };

  // Guarded claim: only a QUEUED run whose retry is due, or a RUNNING run whose
  // worker evidently died, is taken. A redelivered job for a finished or
  // in-flight run is a no-op.
  const claimed = await prisma.analyticsSyncRun.updateMany({
    where: {
      id: run.id,
      ...scope,
      OR: [
        { status: 'QUEUED', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        { status: 'RUNNING', startedAt: { lt: new Date(now.getTime() - RUN_LEASE_MS) } },
      ],
    },
    data: { status: 'RUNNING', attempt: { increment: 1 }, startedAt: now, nextAttemptAt: null },
  });
  if (claimed.count === 0) {
    logger?.info({ status: run.status }, 'Analytics sync not claimable — skipping re-delivery');
    return { runId: run.id, status: 'SKIPPED', nextAttemptAt: null };
  }
  const attempt = run.attempt + 1;

  // Budget pre-flight. No analytics provider wired today is billed per call,
  // so this normally allows with notice — but it counts against a per-kind
  // ANALYTICS_SYNC limit, and a paid provider added later cannot bypass it.
  const reservationKey = `analytics-${run.id}-${attempt}`;
  let budget;
  try {
    ({ decision: budget } = await reserve(prisma, {
      ...scope,
      kind: 'ANALYTICS_SYNC',
      provider: 'analytics',
      requests: 1,
      idempotencyKey: reservationKey,
      resourceType: 'ANALYTICS_SYNC_RUN',
      resourceId: run.id,
      ttlMs: RUN_LEASE_MS,
    }));
  } catch (error) {
    if (!(error instanceof BudgetBlockedError)) throw error;
    budget = error.decision;
  }
  if (budget.blocked) {
    await prisma.analyticsSyncRun.updateMany({
      where: { id: run.id, ...scope },
      data: {
        status: 'FAILED',
        errorCode: 'BUDGET',
        errorMessage: sanitizeErrorMessage(budget.reason),
        finishedAt: clock(),
      },
    });
    logger?.warn('Analytics sync refused — budget limit');
    return { runId: run.id, status: 'FAILED', nextAttemptAt: null };
  }

  const results: AnalyticsTargetResult[] = [];
  let providerCalled = false;
  let retryable: {
    code: AnalyticsErrorCode;
    message: string;
    retryAfterSeconds: number | null;
  } | null = null;
  let runError: { code: AnalyticsErrorCode; message: string } | null = null;

  const targets = await loadTargets(prisma, run, now);
  if ('empty' in targets) {
    runError = { code: targets.code, message: targets.message };
  } else {
    for (const { account, entries } of targets.groups) {
      const resolved = deps.resolveProvider
        ? await deps.resolveProvider(account)
        : ({
            unavailable: true,
            availability: 'UNCONFIGURED',
            errorCode: 'UNCONFIGURED',
            reason:
              'Analytics providers are not configured on this worker. No analytics were fetched.',
          } as const);

      if (isAnalyticsUnavailable(resolved)) {
        const outcome: AnalyticsTargetOutcome =
          resolved.errorCode === 'TRANSIENT' ? 'FAILED' : 'UNAVAILABLE';
        if (resolved.errorCode === 'TRANSIENT') {
          retryable ??= { code: 'TRANSIENT', message: resolved.reason, retryAfterSeconds: null };
        }
        if (run.target !== 'SCHEDULE_ENTRY') {
          results.push(
            result('ACCOUNT', account, null, outcome, resolved.errorCode, resolved.reason, null),
          );
        }
        for (const entry of entries) {
          results.push(
            result(
              'CONTENT',
              account,
              entry.id,
              outcome,
              resolved.errorCode,
              resolved.reason,
              null,
            ),
          );
        }
        continue;
      }

      const provider = resolved;
      const capability = provider.capability();
      let stopped: { code: AnalyticsErrorCode; message: string } | null = null;

      const attemptFetch = async (
        level: 'ACCOUNT' | 'CONTENT',
        entry: EntryTarget | null,
        fetch: () => Promise<AnalyticsFetchResult>,
      ) => {
        if (stopped) {
          results.push(
            result(
              level,
              account,
              entry?.id ?? null,
              'FAILED',
              stopped.code,
              stopped.message,
              null,
            ),
          );
          return;
        }
        providerCalled = true;
        try {
          const fetched = await fetch();
          const snapshotId = await storeSnapshot(prisma, {
            run: { id: run.id, ...scope },
            account,
            provider,
            level,
            entry,
            fetched,
            retrievedAt: clock(),
            staleAfterMs: deps.staleAfterMs ?? DEFAULT_ANALYTICS_STALE_AFTER_MS,
          });
          const completeness = snapshotCompleteness(fetched.metrics);
          const outcome: AnalyticsTargetOutcome =
            completeness === 'COMPLETE'
              ? 'SUCCEEDED'
              : completeness === 'PARTIAL'
                ? 'PARTIAL'
                : 'UNAVAILABLE';
          results.push(
            result(
              level,
              account,
              entry?.id ?? null,
              outcome,
              null,
              outcome === 'UNAVAILABLE'
                ? `No metric could be read. ${
                    fetched.metrics.find(
                      (metric) =>
                        metric.unavailableReason && !isStructuralReason(metric.unavailableReason),
                    )?.detail ?? 'The platform reports nothing readable for this target.'
                  }`
                : null,
              snapshotId,
            ),
          );
        } catch (error) {
          const failure =
            error instanceof AnalyticsProviderError
              ? error
              : new AnalyticsProviderError(
                  'PROVIDER_ERROR',
                  'The analytics request failed unexpectedly.',
                );
          const message = sanitizeErrorMessage(failure.message);
          results.push(
            result(level, account, entry?.id ?? null, 'FAILED', failure.code, message, null),
          );
          if (failure.retryable) {
            retryable ??= {
              code: failure.code,
              message,
              retryAfterSeconds: failure.retryAfterSeconds,
            };
          }
          if (STOP_ACCOUNT.has(failure.code)) stopped = { code: failure.code, message };
          logger?.warn(
            { platform: account.platform, level, code: failure.code },
            'Analytics fetch failed',
          );
        }
      };

      if (run.target !== 'SCHEDULE_ENTRY' && capability.levels.account.supported) {
        await attemptFetch('ACCOUNT', null, () => provider.fetchAccountAnalytics());
      }
      for (const entry of entries) {
        await attemptFetch('CONTENT', entry, () =>
          provider.fetchContentAnalytics({
            externalContentId: entry.externalPostId,
            publishedAt: entry.publishedAt,
          }),
        );
      }
    }
  }

  const counts = {
    succeededCount: results.filter((r) => r.outcome === 'SUCCEEDED').length,
    partialCount: results.filter((r) => r.outcome === 'PARTIAL').length,
    failedCount: results.filter((r) => r.outcome === 'FAILED').length,
    unavailableCount: results.filter((r) => r.outcome === 'UNAVAILABLE').length,
  };
  let status = finalStatus(counts, results.length);
  const firstFailure = results.find((r) => r.outcome === 'FAILED' || r.outcome === 'UNAVAILABLE');
  runError ??= firstFailure?.errorCode
    ? {
        code: firstFailure.errorCode,
        message: firstFailure.message ?? 'Not every target could be read.',
      }
    : null;

  // Retry with backoff while attempts remain. The next attempt re-runs the
  // whole target set; snapshots are keyed per run and target, so what already
  // succeeded is rewritten with fresher numbers, never duplicated.
  let nextAttemptAt: Date | null = null;
  const retry = retryable as {
    code: AnalyticsErrorCode;
    message: string;
    retryAfterSeconds: number | null;
  } | null;
  if (retry && attempt < run.maxAttempts && status !== 'SUCCEEDED') {
    nextAttemptAt = new Date(
      now.getTime() +
        analyticsRetryDelayMs(attempt, retry.retryAfterSeconds, {
          ...(deps.retryBaseMs ? { baseMs: deps.retryBaseMs } : {}),
        }),
    );
    status = 'QUEUED';
    runError = { code: retry.code, message: retry.message };
  }

  await prisma.analyticsSyncRun.updateMany({
    where: { id: run.id, ...scope },
    data: {
      status,
      ...counts,
      results: results.slice(0, MAX_RESULTS) as unknown as Prisma.InputJsonValue,
      errorCode: runError?.code ?? null,
      errorMessage: runError ? sanitizeErrorMessage(runError.message) : null,
      retryAfterSeconds: retry?.retryAfterSeconds ?? null,
      nextAttemptAt,
      finishedAt: status === 'QUEUED' ? null : clock(),
    },
  });

  if (providerCalled) {
    await deps.usage?.record(scope, {
      kind: 'ANALYTICS_SYNC',
      provider: 'analytics',
      requests: 1,
      resourceType: 'ANALYTICS_SYNC_RUN',
      resourceId: run.id,
      metadata: { status, attempt },
    });
    await reconcile(prisma, scope, reservationKey, logger);
  } else {
    await release(prisma, scope, reservationKey, logger);
  }
  logger?.info({ status, ...counts, attempt }, 'Analytics sync attempt finished');
  return { runId: run.id, status, nextAttemptAt };
}

function finalStatus(
  counts: {
    succeededCount: number;
    partialCount: number;
    failedCount: number;
    unavailableCount: number;
  },
  total: number,
): AnalyticsSyncStatus {
  if (total === 0) return 'UNAVAILABLE';
  const { succeededCount, partialCount, failedCount, unavailableCount } = counts;
  if (succeededCount === total) return 'SUCCEEDED';
  if (succeededCount + partialCount > 0) return 'PARTIAL';
  if (failedCount > 0) return 'FAILED';
  return unavailableCount > 0 ? 'UNAVAILABLE' : 'FAILED';
}

function result(
  level: 'ACCOUNT' | 'CONTENT',
  account: AnalyticsTargetAccount,
  scheduleEntryId: string | null,
  outcome: AnalyticsTargetOutcome,
  errorCode: AnalyticsErrorCode | null,
  message: string | null,
  snapshotId: string | null,
): AnalyticsTargetResult {
  return {
    level,
    platform: account.platform,
    socialAccountId: account.id,
    scheduleEntryId,
    outcome,
    errorCode,
    message: message ? sanitizeErrorMessage(message) : null,
    snapshotId,
  };
}

type Targets =
  | { groups: Array<{ account: AnalyticsTargetAccount; entries: EntryTarget[] }> }
  | { empty: true; code: AnalyticsErrorCode; message: string };

async function loadTargets(
  prisma: SpectraPrismaClient,
  run: {
    organizationId: string;
    workspaceId: string;
    target: AnalyticsSyncTarget;
    socialAccountId: string | null;
    scheduleEntryId: string | null;
  },
  now: Date,
): Promise<Targets> {
  const scope = { organizationId: run.organizationId, workspaceId: run.workspaceId };
  const since = new Date(now.getTime() - ANALYTICS_LOOKBACK_DAYS * 86_400_000);
  const entrySelect = {
    id: true,
    contentItemId: true,
    externalPostId: true,
    publishedAt: true,
    socialAccountId: true,
    platform: true,
    status: true,
    contentItem: { select: { campaignId: true } },
  } as const;
  const toEntry = (row: {
    id: string;
    contentItemId: string;
    externalPostId: string | null;
    publishedAt: Date | null;
    socialAccountId: string | null;
    platform: string;
    contentItem: { campaignId: string | null } | null;
  }): EntryTarget => ({
    id: row.id,
    contentItemId: row.contentItemId,
    campaignId: row.contentItem?.campaignId ?? null,
    externalPostId: row.externalPostId as string,
    publishedAt: row.publishedAt,
    socialAccountId: row.socialAccountId as string,
    platform: row.platform,
  });

  if (run.target === 'SCHEDULE_ENTRY') {
    const entry = run.scheduleEntryId
      ? await prisma.contentScheduleEntry.findFirst({
          where: { id: run.scheduleEntryId, ...scope },
          select: entrySelect,
        })
      : null;
    if (!entry) {
      return {
        empty: true,
        code: 'NOT_FOUND',
        message: 'The schedule entry no longer exists. No analytics were fetched.',
      };
    }
    if (entry.status !== 'PUBLISHED' || !entry.externalPostId || !entry.socialAccountId) {
      return {
        empty: true,
        code: 'VALIDATION',
        message:
          'This entry has not been published with a platform post id, so there is nothing to read analytics for. No analytics were fetched.',
      };
    }
    const account = await prisma.socialAccount.findFirst({
      where: { id: entry.socialAccountId, ...scope, deletedAt: null },
      select: ACCOUNT_SELECT,
    });
    if (!account) {
      return {
        empty: true,
        code: 'NOT_CONNECTED',
        message:
          'The account this entry was published to has been disconnected. No analytics were fetched.',
      };
    }
    return { groups: [{ account: asTarget(account), entries: [toEntry(entry)] }] };
  }

  const accounts = await prisma.socialAccount.findMany({
    where: {
      ...scope,
      deletedAt: null,
      ...(run.target === 'SOCIAL_ACCOUNT' ? { id: run.socialAccountId ?? '' } : {}),
    },
    select: ACCOUNT_SELECT,
    orderBy: { createdAt: 'asc' },
  });
  if (accounts.length === 0) {
    return run.target === 'SOCIAL_ACCOUNT'
      ? {
          empty: true,
          code: 'NOT_CONNECTED',
          message: 'This account has been disconnected. No analytics were fetched.',
        }
      : {
          empty: true,
          code: 'NOT_CONNECTED',
          message:
            'No social accounts are connected in this workspace, so there is nothing to sync.',
        };
  }
  const entries = await prisma.contentScheduleEntry.findMany({
    where: {
      ...scope,
      status: 'PUBLISHED',
      externalPostId: { not: null },
      socialAccountId: { in: accounts.map((account) => account.id) },
      publishedAt: { gte: since },
    },
    select: entrySelect,
    orderBy: { publishedAt: 'desc' },
    take: ANALYTICS_MAX_POSTS_PER_RUN,
  });
  return {
    groups: accounts.map((account) => ({
      account: asTarget(account),
      entries: entries.filter((entry) => entry.socialAccountId === account.id).map(toEntry),
    })),
  };
}

function asTarget(row: {
  id: string;
  organizationId: string;
  workspaceId: string;
  platform: string;
  kind: string;
  externalAccountId: string;
  displayName: string;
  encryptedToken: string | null;
  connectionId: string | null;
}): AnalyticsTargetAccount {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    platform: row.platform as SocialPlatform,
    kind: row.kind,
    externalAccountId: row.externalAccountId,
    displayName: row.displayName,
    encryptedToken: row.encryptedToken,
    connectionId: row.connectionId,
  };
}

/**
 * Writes one snapshot and its metric rows atomically. Keyed by run + level +
 * account + entry, so a redelivered or retried attempt replaces its own
 * snapshot instead of adding a second one. Provider metadata is redacted
 * again here, whatever the adapter sent.
 */
async function storeSnapshot(
  prisma: SpectraPrismaClient,
  input: {
    run: { id: string; organizationId: string; workspaceId: string };
    account: AnalyticsTargetAccount;
    provider: AnalyticsProvider;
    level: 'ACCOUNT' | 'CONTENT';
    entry: EntryTarget | null;
    fetched: AnalyticsFetchResult;
    retrievedAt: Date;
    staleAfterMs: number;
  },
): Promise<string> {
  const { run, account, entry, fetched } = input;
  const dedupeKey = `${run.id}:${input.level}:${account.id}:${entry?.id ?? '-'}`;
  const data = {
    organizationId: run.organizationId,
    workspaceId: run.workspaceId,
    syncRunId: run.id,
    platform: account.platform,
    providerId: input.provider.providerId,
    level: input.level,
    socialAccountId: account.id,
    scheduleEntryId: entry?.id ?? null,
    contentItemId: entry?.contentItemId ?? null,
    campaignId: entry?.campaignId ?? null,
    externalAccountId: account.externalAccountId,
    externalContentId: entry?.externalPostId ?? null,
    publishedAt: entry?.publishedAt ?? null,
    completeness: snapshotCompleteness(fetched.metrics),
    retrievedAt: input.retrievedAt,
    staleAfter: staleAfterFrom(input.retrievedAt, input.staleAfterMs),
    dataAsOf: fetched.dataAsOf,
    providerMetadata: sanitizeProviderMetadata(fetched.providerMetadata) as Prisma.InputJsonValue,
    notes: [...new Set(fetched.notes)].slice(0, 10).map((note) => note.slice(0, 1000)),
  };
  return prisma.$transaction(async (tx) => {
    const snapshot = await tx.analyticsSnapshot.upsert({
      where: { dedupeKey },
      create: { ...data, dedupeKey },
      update: data,
      select: { id: true },
    });
    await tx.analyticsMetricValue.deleteMany({
      where: { organizationId: run.organizationId, snapshotId: snapshot.id },
    });
    await tx.analyticsMetricValue.createMany({
      data: fetched.metrics.map((metric) => ({
        organizationId: run.organizationId,
        workspaceId: run.workspaceId,
        snapshotId: snapshot.id,
        metricKey: metric.key,
        sourceMetricName: metric.sourceMetricName,
        value: metric.value,
        unit: metric.unit,
        completeness: metric.completeness,
        unavailableReason: metric.unavailableReason,
        detail: metric.detail,
      })),
    });
    return snapshot.id;
  });
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * Runs the worker should execute now: retries whose backoff has elapsed, and
 * — when scheduled sync is enabled — one SCHEDULED workspace run per interval
 * for each workspace with a connected account on a platform that has an
 * analytics adapter. Idempotent per interval bucket, so several dispatchers
 * create each scheduled run once.
 *
 * The cross-tenant scans are raw SQL returning ids only (the model API would
 * rightly refuse an unscoped read); every write afterwards is tenant-scoped.
 */
export async function claimDueAnalyticsSyncs(
  prisma: SpectraPrismaClient,
  now: Date,
  options: {
    scheduled: boolean;
    intervalMs: number;
    platforms: readonly SocialPlatform[];
    limit?: number;
  },
): Promise<string[]> {
  const limit = options.limit ?? 50;
  const due = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "analytics_sync_runs"
     WHERE "status" = 'QUEUED' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now})
     ORDER BY "createdAt" ASC
     LIMIT ${limit}`;
  const ids = due.map((row) => row.id);
  if (!options.scheduled || options.platforms.length === 0) return ids;

  const bucket = Math.floor(now.getTime() / options.intervalMs);
  const workspaces = await prisma.$queryRaw<Array<{ organizationId: string; workspaceId: string }>>`
    SELECT DISTINCT a."organizationId", a."workspaceId"
      FROM "social_accounts" a
     WHERE a."deletedAt" IS NULL
       AND a."platform"::text = ANY(${options.platforms as string[]})
       AND NOT EXISTS (
         SELECT 1 FROM "analytics_sync_runs" r
          WHERE r."workspaceId" = a."workspaceId"
            AND r."trigger" = 'SCHEDULED'
            AND r."createdAt" > ${new Date(now.getTime() - options.intervalMs)}
       )
     LIMIT ${limit}`;
  for (const workspace of workspaces) {
    const { run, created } = await requestAnalyticsSync(prisma, {
      ...workspace,
      target: 'WORKSPACE',
      trigger: 'SCHEDULED',
      idempotencyKey: `interval-${bucket}`,
    });
    if (created) ids.push(run.id);
  }
  return ids;
}
