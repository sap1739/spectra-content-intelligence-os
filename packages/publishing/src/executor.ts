import type { PublishFailureCode, SocialPlatform } from '@spectra/contracts';
import type { SpectraPrismaClient } from '@spectra/database';
import type { Logger } from '@spectra/logging';
import {
  BudgetBlockedError,
  reconcile,
  release,
  reserve,
  type UsageRecorder,
} from '@spectra/metering';
import {
  unsupportedMediaKinds,
  type PostPublisher,
  type PublishInput,
  type PublishMediaInput,
} from '@spectra/social-core';
import { METRICS, metrics } from '@spectra/telemetry';

/**
 * The subset of a SocialAccount a resolver needs to build a live publisher.
 * `encryptedToken` is a sealed per-account credential (WordPress); accounts
 * discovered over OAuth carry `connectionId` instead, and their token lives on
 * the connection (ADR-0034). Neither is ever logged.
 */
export interface PublishAccount {
  id: string;
  organizationId: string;
  workspaceId: string;
  platform: SocialPlatform;
  kind: string;
  externalAccountId: string;
  encryptedToken: string | null;
  connectionId: string | null;
  /**
   * Allow-listed metadata discovery recorded for this account (a handle, a
   * board's privacy). Used for things like a post's link — never a credential.
   */
  discoveryMetadata?: Record<string, unknown> | null;
}

/**
 * A resolver's honest "no": the target exists but cannot be published to now,
 * and why. Nothing is sent. UNSUPPORTED = the capability is not there (not
 * connected, no adapter); FAILED = it is, but this attempt cannot proceed
 * (expired authorization, missing permission).
 */
export interface PublisherUnavailable {
  unavailable: true;
  status: 'UNSUPPORTED' | 'FAILED';
  reason: string;
  failureCode: PublishFailureCode;
}

/**
 * Builds a live publisher for one account, `undefined` when no adapter exists
 * for it, or a `PublisherUnavailable` explaining why it cannot publish now.
 * Never a fabricated success.
 */
export type ResolvePublisher = (
  account: PublishAccount,
) => Promise<PostPublisher | PublisherUnavailable | undefined>;

/** Reads an asset's bytes from tenant-scoped storage, checked against the tenant. */
export type LoadMedia = (
  asset: { storageKey: string },
  tenant: { organizationId: string; workspaceId: string },
) => Promise<Buffer>;

/** A short-lived link a platform can fetch an asset from, checked against the tenant. */
export type MediaUrl = (
  asset: { storageKey: string },
  tenant: { organizationId: string; workspaceId: string },
) => Promise<string>;

export interface PublishDeps {
  prisma: SpectraPrismaClient;
  /**
   * Resolves a per-account live publisher. Omitted (e.g. in-process without the
   * decryption key) means no live publishing — every attempt is UNSUPPORTED.
   */
  resolvePublisher?: ResolvePublisher;
  /** Needed only for entries with an attached image. */
  loadMedia?: LoadMedia;
  /**
   * Needed only by platforms that fetch media themselves (Instagram). Omitted
   * where storage is not reachable from the internet.
   */
  mediaUrl?: MediaUrl;
  logger?: Logger;
  /** Records the publish attempt so per-kind limits can count it. */
  usage?: UsageRecorder;
  now?: () => Date;
}

function isUnavailable(value: PostPublisher | PublisherUnavailable): value is PublisherUnavailable {
  return (value as PublisherUnavailable).unavailable === true;
}

export interface ExecutePublicationInput {
  entryId: string;
}

export interface PublicationOutcome {
  status: 'PUBLISHED' | 'FAILED' | 'UNSUPPORTED' | 'SKIPPED';
  entryId: string;
}

/**
 * Attempts to publish one QUEUED schedule entry. If no live publisher can be
 * resolved for the target account, the entry resolves to UNSUPPORTED — an
 * honest terminal state, NOT a fabricated PUBLISHED. When a real adapter and a
 * stored credential exist (WordPress), the same path produces PUBLISHED/FAILED
 * from the platform's actual response.
 *
 * Idempotent: an entry not in QUEUED/PUBLISHING is skipped on re-delivery.
 */
export async function executePublication(
  deps: PublishDeps,
  input: ExecutePublicationInput,
): Promise<PublicationOutcome> {
  // Wrapped so the histogram covers the whole attempt, including the failure
  // path — a publish that fails slowly is the interesting case.
  return metrics.time(METRICS.publishAttemptDuration, {}, () => runPublication(deps, input));
}

async function runPublication(
  deps: PublishDeps,
  input: ExecutePublicationInput,
): Promise<PublicationOutcome> {
  const { prisma } = deps;
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger?.child({ entryId: input.entryId });

  const entry = await prisma.contentScheduleEntry.findUnique({ where: { id: input.entryId } });
  if (!entry) throw new Error(`Schedule entry ${input.entryId} not found`);
  if (entry.status !== 'QUEUED' && entry.status !== 'PUBLISHING') {
    logger?.info({ status: entry.status }, 'Entry not dispatchable — skipping re-delivery');
    return { status: 'SKIPPED', entryId: entry.id };
  }

  // Publishing pre-flight. Publishing is not currently a vendor-billed
  // operation, so this normally returns UNKNOWN_COST_ALLOW_WITH_NOTICE rather
  // than a cost decision — but it DOES count against a per-kind
  // PUBLISH_ATTEMPT limit, and the seam exists so a future paid publishing
  // provider cannot bypass budget enforcement by being added later.
  const tenant = { organizationId: entry.organizationId, workspaceId: entry.workspaceId };
  // Keyed on the entry + attempt so a retry of the SAME attempt re-uses its
  // hold, while a genuine re-publish takes a fresh one.
  const reservationKey = `publish-${entry.id}-${entry.attemptCount ?? 0}`;
  let budget;
  try {
    ({ decision: budget } = await reserve(prisma, {
      ...tenant,
      kind: 'PUBLISH_ATTEMPT',
      provider: String(entry.platform).toLowerCase(),
      requests: 1,
      idempotencyKey: reservationKey,
      resourceType: 'SCHEDULE_ENTRY',
      resourceId: entry.id,
      ttlMs: 10 * 60_000,
    }));
  } catch (error) {
    if (!(error instanceof BudgetBlockedError)) throw error;
    budget = error.decision;
  }
  if (budget.blocked) {
    await prisma.contentScheduleEntry.update({
      where: { id: entry.id },
      data: { status: 'FAILED', failureReason: budget.reason, failureCode: 'BUDGET' },
    });
    logger?.warn({ platform: entry.platform }, 'Publish refused — budget limit');
    return { status: 'FAILED', entryId: entry.id };
  }

  await prisma.contentScheduleEntry.update({
    where: { id: entry.id },
    data: { status: 'PUBLISHING', attemptCount: { increment: 1 }, lastAttemptAt: now() },
  });

  /** Ends the attempt without contacting the platform: the hold is returned, not counted. */
  const settleWithoutSending = async (
    status: 'UNSUPPORTED' | 'FAILED',
    failureReason: string,
    failureCode: PublishFailureCode | null,
  ): Promise<PublicationOutcome> => {
    await prisma.contentScheduleEntry.update({
      where: { id: entry.id },
      data: { status, failureReason, failureCode },
    });
    await release(prisma, tenant, reservationKey, logger);
    logger?.info(
      { platform: entry.platform, status, failureCode },
      'Publish attempt ended before sending',
    );
    return { status, entryId: entry.id };
  };

  const resolved = await resolvePublisherFor(deps, entry);
  if (!resolved) {
    // Honest: nothing published — no adapter for the platform, or no stored
    // credential / decryption key available.
    return settleWithoutSending(
      'UNSUPPORTED',
      `No live publisher is available for ${entry.platform}. Nothing was published.`,
      null,
    );
  }
  if (isUnavailable(resolved)) {
    return settleWithoutSending(resolved.status, resolved.reason, resolved.failureCode);
  }
  const publisher = resolved;

  // Publish the item's current best body. Failures are recorded truthfully; the
  // idempotencyKey makes retries safe.
  const item = await prisma.contentItem.findUnique({
    where: { id: entry.contentItemId },
    select: { title: true, body: true },
  });

  const media: PublishMediaInput[] = [];
  if (entry.mediaAssetId) {
    const asset = await prisma.mediaAsset.findFirst({
      where: {
        id: entry.mediaAssetId,
        organizationId: entry.organizationId,
        workspaceId: entry.workspaceId,
      },
      select: {
        id: true,
        kind: true,
        storageKey: true,
        mimeType: true,
        sizeBytes: true,
        widthPx: true,
        heightPx: true,
      },
    });
    if (!asset) {
      return settleWithoutSending(
        'FAILED',
        'The attached file no longer exists. Attach another or remove it. Nothing was published.',
        'VALIDATION',
      );
    }
    const loadMedia = deps.loadMedia;
    const mediaUrl = deps.mediaUrl;
    if (!loadMedia) {
      return settleWithoutSending(
        'UNSUPPORTED',
        'Media storage is not available to the publisher, so the attached file cannot be uploaded. Nothing was published.',
        'UNSUPPORTED_MEDIA',
      );
    }
    media.push({
      assetId: asset.id,
      kind: asset.kind,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      widthPx: asset.widthPx,
      heightPx: asset.heightPx,
      altText: entry.mediaAltText ?? null,
      load: () => loadMedia(asset, tenant),
      ...(mediaUrl ? { url: () => mediaUrl(asset, tenant) } : {}),
    });
  }

  // A cover image some platforms take separately from the media itself
  // (a YouTube custom thumbnail), loaded from the same tenant-checked storage.
  let thumbnail: PublishMediaInput | undefined;
  if (entry.thumbnailAssetId) {
    const asset = await prisma.mediaAsset.findFirst({
      where: {
        id: entry.thumbnailAssetId,
        organizationId: entry.organizationId,
        workspaceId: entry.workspaceId,
      },
      select: {
        id: true,
        kind: true,
        storageKey: true,
        mimeType: true,
        sizeBytes: true,
        widthPx: true,
        heightPx: true,
      },
    });
    const loadMedia = deps.loadMedia;
    if (!asset) {
      return settleWithoutSending(
        'FAILED',
        'The thumbnail image no longer exists. Attach another or remove it. Nothing was published.',
        'VALIDATION',
      );
    }
    if (!loadMedia) {
      return settleWithoutSending(
        'UNSUPPORTED',
        'Media storage is not available to the publisher, so the thumbnail cannot be uploaded. Nothing was published.',
        'UNSUPPORTED_MEDIA',
      );
    }
    thumbnail = {
      assetId: asset.id,
      kind: asset.kind,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      widthPx: asset.widthPx,
      heightPx: asset.heightPx,
      altText: null,
      load: () => loadMedia(asset, tenant),
    };
  }

  // Platform-specific fields the pipeline itself knows nothing about; the
  // adapter validates its own slice and ignores the rest.
  const metadata =
    entry.publishMetadata &&
    typeof entry.publishMetadata === 'object' &&
    !Array.isArray(entry.publishMetadata)
      ? (entry.publishMetadata as Record<string, unknown>)
      : undefined;

  const publishInput: PublishInput = {
    idempotencyKey: entry.idempotencyKey ?? entry.id,
    title: item?.title ?? 'Untitled',
    body: item?.body ?? entry.note ?? '',
    ...(media.length > 0 ? { media } : {}),
    ...(thumbnail ? { thumbnail } : {}),
    ...(metadata ? { metadata } : {}),
  };

  // Media the adapter cannot upload at all is UNSUPPORTED — a capability gap,
  // not a content error — and nothing is sent.
  const unsupported = unsupportedMediaKinds(publisher, media);
  if (unsupported.length > 0) {
    const kinds = [...new Set(unsupported.map((item) => item.kind.toLowerCase()))].join(', ');
    return settleWithoutSending(
      'UNSUPPORTED',
      `The ${entry.platform} adapter does not publish ${kinds} attachments. Nothing was published.`,
      'UNSUPPORTED_MEDIA',
    );
  }
  const issues = publisher.validate?.(publishInput) ?? [];
  if (issues.length > 0) {
    return settleWithoutSending(
      'FAILED',
      `${issues.map((issue) => issue.message).join(' ')} Nothing was published.`,
      'VALIDATION',
    );
  }

  try {
    const outcome = await metrics.time(
      METRICS.providerLatency,
      { provider: entry.platform, op: 'publish' },
      () => publisher.publish(publishInput),
    );
    const published = outcome.status === 'PUBLISHED';
    await prisma.contentScheduleEntry.update({
      where: { id: entry.id },
      data: {
        status: published ? 'PUBLISHED' : 'FAILED',
        externalPostId: outcome.externalPostId ?? null,
        externalUrl: outcome.externalUrl ?? null,
        publishedAt: published
          ? outcome.publishedAt
            ? new Date(outcome.publishedAt)
            : now()
          : null,
        failureReason: published ? null : (outcome.failureReason ?? 'Publish failed'),
        failureCode: published ? null : (outcome.failureCode ?? 'UNKNOWN'),
        // True of a success: what the platform did differently, or that it is
        // still processing. Never used to soften a failure.
        publishNote: published ? (outcome.note ?? null) : null,
      },
    });
    if (published) {
      await prisma.contentItem
        .update({ where: { id: entry.contentItemId }, data: { lifecycleState: 'PUBLISHED' } })
        .catch(() => undefined);
    }
    // Counter-only: priced as COUNTER_ONLY, never as a fake zero-cost row.
    await deps.usage?.record(
      { organizationId: entry.organizationId, workspaceId: entry.workspaceId },
      {
        kind: 'PUBLISH_ATTEMPT',
        provider: String(entry.platform).toLowerCase(),
        requests: 1,
        resourceType: 'SCHEDULE_ENTRY',
        resourceId: entry.id,
        metadata: { result: outcome.status },
      },
    );
    await reconcile(prisma, tenant, reservationKey, logger);
    logger?.info({ platform: entry.platform, status: outcome.status }, 'Publish attempt complete');
    return { status: published ? 'PUBLISHED' : 'FAILED', entryId: entry.id };
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : 'Publish failed';
    await prisma.contentScheduleEntry.update({
      where: { id: entry.id },
      data: { status: 'FAILED', failureReason, failureCode: 'UNKNOWN' },
    });
    // The publisher threw: it may or may not have reached the platform, so
    // reconcile rather than release — the attempt is recorded either way.
    await reconcile(prisma, tenant, reservationKey, logger);
    logger?.warn({ err: failureReason }, 'Publish attempt failed');
    return { status: 'FAILED', entryId: entry.id };
  }
}

async function resolvePublisherFor(
  deps: PublishDeps,
  entry: { socialAccountId: string | null; organizationId: string; workspaceId: string },
): Promise<PostPublisher | PublisherUnavailable | undefined> {
  if (!entry.socialAccountId || !deps.resolvePublisher) return undefined;
  const account = await deps.prisma.socialAccount.findUnique({
    where: { id: entry.socialAccountId },
    select: {
      id: true,
      organizationId: true,
      workspaceId: true,
      platform: true,
      kind: true,
      externalAccountId: true,
      encryptedToken: true,
      connectionId: true,
      discoveryMetadata: true,
      deletedAt: true,
    },
  });
  // Never publish across a tenant boundary, even if an entry points there.
  if (
    !account ||
    account.organizationId !== entry.organizationId ||
    account.workspaceId !== entry.workspaceId
  ) {
    return {
      unavailable: true,
      status: 'UNSUPPORTED',
      reason: 'The target account does not exist in this workspace. Nothing was published.',
      failureCode: 'NOT_CONNECTED',
    };
  }
  if (account.deletedAt) {
    return {
      unavailable: true,
      status: 'UNSUPPORTED',
      reason: 'The target account was disconnected. Nothing was published.',
      failureCode: 'NOT_CONNECTED',
    };
  }
  return deps.resolvePublisher({
    id: account.id,
    organizationId: account.organizationId,
    workspaceId: account.workspaceId,
    platform: account.platform as SocialPlatform,
    kind: account.kind,
    externalAccountId: account.externalAccountId,
    encryptedToken: account.encryptedToken,
    connectionId: account.connectionId,
    discoveryMetadata:
      account.discoveryMetadata &&
      typeof account.discoveryMetadata === 'object' &&
      !Array.isArray(account.discoveryMetadata)
        ? (account.discoveryMetadata as Record<string, unknown>)
        : null,
  });
}

/**
 * Claims due schedule entries for dispatch: SCHEDULED, past due, with a target
 * account, flipping them to QUEUED and returning their ids. Skips entries with
 * no `socialAccountId` (nothing to publish to).
 */
export async function claimDuePublications(
  prisma: SpectraPrismaClient,
  now: Date,
  limit = 50,
): Promise<string[]> {
  const due = await prisma.contentScheduleEntry.findMany({
    where: { status: 'SCHEDULED', scheduledAt: { lte: now }, socialAccountId: { not: null } },
    orderBy: { scheduledAt: 'asc' },
    take: limit,
    select: { id: true },
  });
  const ids: string[] = [];
  for (const { id } of due) {
    // Guarded flip — only claim if still SCHEDULED (safe under concurrent dispatchers).
    const claimed = await prisma.contentScheduleEntry.updateMany({
      where: { id, status: 'SCHEDULED' },
      data: { status: 'QUEUED' },
    });
    if (claimed.count === 1) ids.push(id);
  }
  return ids;
}
