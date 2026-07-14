import type { SpectraPrismaClient } from '@spectra/database';
import type { Logger } from '@spectra/logging';
import { socialPublisherRegistry } from '@spectra/social-core';
import type { SocialPublisherRegistry } from '@spectra/social-core';
import type { SocialPlatform } from '@spectra/contracts';

export interface PublishDeps {
  prisma: SpectraPrismaClient;
  /** Defaults to the shared empty registry — no live adapter in Phase 4B. */
  registry?: SocialPublisherRegistry;
  logger?: Logger;
  now?: () => Date;
}

export interface ExecutePublicationInput {
  entryId: string;
}

export interface PublicationOutcome {
  status: 'PUBLISHED' | 'FAILED' | 'UNSUPPORTED' | 'SKIPPED';
  entryId: string;
}

/**
 * Attempts to publish one QUEUED schedule entry through the social-core
 * registry. With no adapter wired for the platform, the entry resolves to
 * UNSUPPORTED — an honest terminal state, NOT a fabricated PUBLISHED. When a
 * real adapter exists (later phase) the same path produces PUBLISHED/FAILED.
 *
 * Idempotent: an entry not in QUEUED/PUBLISHING is skipped on re-delivery.
 */
export async function executePublication(
  deps: PublishDeps,
  input: ExecutePublicationInput,
): Promise<PublicationOutcome> {
  const { prisma } = deps;
  const registry = deps.registry ?? socialPublisherRegistry;
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger?.child({ entryId: input.entryId });

  const entry = await prisma.contentScheduleEntry.findUnique({ where: { id: input.entryId } });
  if (!entry) throw new Error(`Schedule entry ${input.entryId} not found`);
  if (entry.status !== 'QUEUED' && entry.status !== 'PUBLISHING') {
    logger?.info({ status: entry.status }, 'Entry not dispatchable — skipping re-delivery');
    return { status: 'SKIPPED', entryId: entry.id };
  }

  await prisma.contentScheduleEntry.update({
    where: { id: entry.id },
    data: { status: 'PUBLISHING', attemptCount: { increment: 1 }, lastAttemptAt: now() },
  });

  const publisher = registry.getPublisher(entry.platform as SocialPlatform);
  if (!publisher) {
    // Honest: nothing published. Not a failure of our system — no adapter exists.
    await prisma.contentScheduleEntry.update({
      where: { id: entry.id },
      data: {
        status: 'UNSUPPORTED',
        failureReason: `No live publisher is wired for ${entry.platform}. Nothing was published.`,
      },
    });
    logger?.info({ platform: entry.platform }, 'No publisher wired — marked UNSUPPORTED');
    return { status: 'UNSUPPORTED', entryId: entry.id };
  }

  // A real adapter is wired — attempt the post (future phase). Failures are
  // recorded truthfully; the idempotencyKey makes retries safe.
  try {
    const result = await publisher.createPost({
      idempotencyKey: entry.idempotencyKey ?? entry.id,
      accountId: entry.socialAccountId as string,
      channelVariantId: null,
      text: entry.note ?? null,
      externalMediaIds: [],
      link: null,
      scheduledFor: null,
      aiContentDisclosure: false,
      organizationId: entry.organizationId,
      workspaceId: entry.workspaceId,
    });
    const published = result.status === 'PUBLISHED';
    await prisma.contentScheduleEntry.update({
      where: { id: entry.id },
      data: {
        status: published ? 'PUBLISHED' : 'FAILED',
        externalPostId: result.externalPostId ?? null,
        externalUrl: result.externalUrl ?? null,
        publishedAt: published ? (result.publishedAt ? new Date(result.publishedAt) : now()) : null,
        failureReason: published ? null : (result.failureReason ?? 'Publish failed'),
      },
    });
    if (published) {
      await prisma.contentItem
        .update({ where: { id: entry.contentItemId }, data: { lifecycleState: 'PUBLISHED' } })
        .catch(() => undefined);
    }
    return { status: published ? 'PUBLISHED' : 'FAILED', entryId: entry.id };
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : 'Publish failed';
    await prisma.contentScheduleEntry.update({
      where: { id: entry.id },
      data: { status: 'FAILED', failureReason },
    });
    logger?.warn({ err: failureReason }, 'Publish attempt failed');
    return { status: 'FAILED', entryId: entry.id };
  }
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
