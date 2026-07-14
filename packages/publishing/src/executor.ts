import type { SocialPlatform } from '@spectra/contracts';
import type { SpectraPrismaClient } from '@spectra/database';
import type { Logger } from '@spectra/logging';
import type { PostPublisher } from '@spectra/social-core';

/**
 * The subset of a SocialAccount a resolver needs to build a live publisher.
 * `encryptedToken` is the sealed credential — the resolver (in the worker)
 * decrypts it; it is never logged and never leaves that boundary.
 */
export interface PublishAccount {
  id: string;
  platform: SocialPlatform;
  externalAccountId: string;
  encryptedToken: string | null;
}

/**
 * Builds a live publisher for one account, or `undefined` when publishing is
 * not possible (no adapter for the platform, no stored credential, or no
 * decryption key). Returning `undefined` yields an honest UNSUPPORTED — never a
 * fabricated success. The worker wires this to the real WordPress adapter.
 */
export type ResolvePublisher = (account: PublishAccount) => Promise<PostPublisher | undefined>;

export interface PublishDeps {
  prisma: SpectraPrismaClient;
  /**
   * Resolves a per-account live publisher. Omitted (e.g. in-process without the
   * decryption key) means no live publishing — every attempt is UNSUPPORTED.
   */
  resolvePublisher?: ResolvePublisher;
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
  const { prisma } = deps;
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

  const publisher = await resolvePublisherFor(deps, entry.socialAccountId);
  if (!publisher) {
    // Honest: nothing published. Either no adapter for the platform, or the
    // account has no stored credential / no decryption key available.
    await prisma.contentScheduleEntry.update({
      where: { id: entry.id },
      data: {
        status: 'UNSUPPORTED',
        failureReason: `No live publisher is available for ${entry.platform}. Nothing was published.`,
      },
    });
    logger?.info({ platform: entry.platform }, 'No publisher resolved — marked UNSUPPORTED');
    return { status: 'UNSUPPORTED', entryId: entry.id };
  }

  // Publish the item's current best body. Failures are recorded truthfully; the
  // idempotencyKey makes retries safe.
  const item = await prisma.contentItem.findUnique({
    where: { id: entry.contentItemId },
    select: { title: true, body: true },
  });

  try {
    const outcome = await publisher.publish({
      idempotencyKey: entry.idempotencyKey ?? entry.id,
      title: item?.title ?? 'Untitled',
      body: item?.body ?? entry.note ?? '',
    });
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
      },
    });
    if (published) {
      await prisma.contentItem
        .update({ where: { id: entry.contentItemId }, data: { lifecycleState: 'PUBLISHED' } })
        .catch(() => undefined);
    }
    logger?.info({ platform: entry.platform, status: outcome.status }, 'Publish attempt complete');
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

async function resolvePublisherFor(
  deps: PublishDeps,
  socialAccountId: string | null,
): Promise<PostPublisher | undefined> {
  if (!socialAccountId || !deps.resolvePublisher) return undefined;
  const account = await deps.prisma.socialAccount.findUnique({
    where: { id: socialAccountId },
    select: { id: true, platform: true, externalAccountId: true, encryptedToken: true },
  });
  if (!account) return undefined;
  return deps.resolvePublisher(account as PublishAccount);
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
