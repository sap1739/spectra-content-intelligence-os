import { randomUUID } from 'node:crypto';

import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import {
  POST_TYPES,
  accountCapabilitySnapshotSchema,
  type PostType,
  type ScheduleEntryInput,
} from '@spectra/contracts';
import { TenantIsolationError } from '@spectra/security';
import { validateLinkedInPost } from '@spectra/social-linkedin';
import { JOB_NAMES } from '@spectra/workflow-core';

import { AuditService } from '../infra/audit.service';
import { QueueService } from '../infra/queue.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

const SCHEDULABLE_STATES = new Set(['APPROVED', 'SCHEDULED']);

interface TargetAccount {
  platform: string;
  capabilities: unknown;
}

interface AttachedAsset {
  id: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  widthPx: number | null;
  heightPx: number | null;
}

@Injectable()
export class CalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  private scope(tenant: TenantContext) {
    return {
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId as string,
    };
  }

  /** Calendar entries in an optional [from, to] window, with the item title. */
  list(tenant: TenantContext, from?: string, to?: string) {
    const where: Record<string, unknown> = { ...this.scope(tenant) };
    if (from || to) {
      where.scheduledAt = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      };
    }
    return this.prisma.client.contentScheduleEntry.findMany({
      where,
      orderBy: { scheduledAt: 'asc' },
      take: 500,
      include: {
        contentItem: { select: { title: true, contentType: true, lifecycleState: true } },
        mediaAsset: { select: { id: true, kind: true, mimeType: true } },
      },
    });
  }

  /**
   * Problems that would stop this entry publishing to `account`, found now
   * rather than at dispatch time. The executor re-checks when it runs, because
   * content and permissions can change in between.
   */
  private targetProblems(
    account: TargetAccount,
    item: { title: string; body: string | null },
    asset: AttachedAsset | null,
    altText: string | undefined,
  ): string[] {
    const problems: string[] = [];
    // Accounts found through discovery carry what they can publish; a manual
    // target has no snapshot and is left to the executor to judge.
    const snapshot = accountCapabilitySnapshotSchema.safeParse(account.capabilities);
    if (snapshot.success) {
      const postType: PostType | null = asset
        ? (POST_TYPES as readonly string[]).includes(asset.kind)
          ? (asset.kind as PostType)
          : null
        : 'TEXT';
      const support = postType ? snapshot.data.postTypes[postType] : null;
      if (!support) {
        problems.push(
          `${account.platform} cannot publish ${asset?.kind.toLowerCase()} attachments.`,
        );
      } else if (support.status === 'MISSING_PERMISSION' || support.status === 'NOT_IMPLEMENTED') {
        // UNKNOWN is let through: the platform did not say, so we do not guess.
        problems.push(support.reason);
      }
    } else if (asset && account.platform === 'WORDPRESS') {
      problems.push('WordPress publishing does not upload media; remove the image.');
    }
    if (account.platform === 'LINKEDIN') {
      const issues = validateLinkedInPost({
        idempotencyKey: 'schedule-check',
        title: item.title,
        body: item.body ?? '',
        ...(asset
          ? {
              media: [
                {
                  assetId: asset.id,
                  kind: asset.kind as 'IMAGE',
                  mimeType: asset.mimeType,
                  sizeBytes: asset.sizeBytes,
                  widthPx: asset.widthPx,
                  heightPx: asset.heightPx,
                  altText: altText ?? null,
                  load: async () => Buffer.alloc(0),
                },
              ],
            }
          : {}),
      });
      problems.push(...issues.map((issue) => issue.message));
    }
    return [...new Set(problems)];
  }

  async schedule(tenant: TenantContext, principal: Principal, input: ScheduleEntryInput) {
    const item = await this.prisma.client.contentItem.findFirst({
      where: { id: input.contentItemId, ...this.scope(tenant), deletedAt: null },
      select: { id: true, lifecycleState: true, title: true, body: true },
    });
    if (!item) throw new TenantIsolationError();

    if (!SCHEDULABLE_STATES.has(item.lifecycleState)) {
      throw new UnprocessableEntityException(
        `Only approved content can be scheduled (item is ${item.lifecycleState}).`,
      );
    }

    // A target account (optional) must belong to the tenant, and to the platform.
    let account: TargetAccount | null = null;
    if (input.socialAccountId) {
      account = await this.prisma.client.socialAccount.findFirst({
        where: { id: input.socialAccountId, ...this.scope(tenant), deletedAt: null },
        select: { platform: true, capabilities: true },
      });
      if (!account) throw new TenantIsolationError();
      if (account.platform !== input.platform) {
        throw new UnprocessableEntityException(
          `The target is a ${account.platform} account; this entry is for ${input.platform}.`,
        );
      }
    }

    // An attached image must belong to the tenant.
    let asset: AttachedAsset | null = null;
    if (input.mediaAssetId) {
      asset = await this.prisma.client.mediaAsset.findFirst({
        where: { id: input.mediaAssetId, ...this.scope(tenant) },
        select: {
          id: true,
          kind: true,
          mimeType: true,
          sizeBytes: true,
          widthPx: true,
          heightPx: true,
        },
      });
      if (!asset) throw new TenantIsolationError();
    }

    if (account) {
      const problems = this.targetProblems(account, item, asset, input.mediaAltText);
      if (problems.length > 0) throw new UnprocessableEntityException(problems.join(' '));
    }

    const entry = await this.prisma.client.contentScheduleEntry.create({
      data: {
        ...this.scope(tenant),
        contentItemId: item.id,
        platform: input.platform,
        scheduledAt: new Date(input.scheduledAt),
        note: input.note ?? null,
        socialAccountId: input.socialAccountId ?? null,
        mediaAssetId: asset?.id ?? null,
        mediaAltText: asset ? (input.mediaAltText ?? null) : null,
        idempotencyKey: randomUUID(),
        createdById: principal.userId,
      },
    });

    // First scheduling moves APPROVED → SCHEDULED.
    if (item.lifecycleState === 'APPROVED') {
      await this.prisma.client.contentItem.update({
        where: { id: item.id },
        data: { lifecycleState: 'SCHEDULED' },
      });
    }

    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'content_schedule.created',
      resourceType: 'ContentScheduleEntry',
      resourceId: entry.id,
      changes: {
        platform: input.platform,
        scheduledAt: input.scheduledAt,
        hasMedia: asset !== null,
      },
    });
    return entry;
  }

  /**
   * Queues an entry for immediate publishing. Requires a target account. The
   * worker attempts the post; with no adapter wired it resolves to UNSUPPORTED
   * (honest) — never a fabricated PUBLISHED.
   */
  async publishNow(tenant: TenantContext, principal: Principal, entryId: string) {
    const entry = await this.prisma.client.contentScheduleEntry.findFirst({
      where: { id: entryId, ...this.scope(tenant) },
      select: { id: true, status: true, socialAccountId: true, idempotencyKey: true },
    });
    if (!entry) throw new TenantIsolationError();
    if (!entry.socialAccountId) {
      throw new UnprocessableEntityException(
        'Attach a target social account before publishing this entry.',
      );
    }
    if (
      entry.status !== 'SCHEDULED' &&
      entry.status !== 'UNSUPPORTED' &&
      entry.status !== 'FAILED'
    ) {
      throw new UnprocessableEntityException(
        `Entry cannot be published from status ${entry.status}.`,
      );
    }

    const updated = await this.prisma.client.contentScheduleEntry.update({
      where: { id: entry.id },
      data: {
        status: 'QUEUED',
        ...(entry.idempotencyKey ? {} : { idempotencyKey: randomUUID() }),
      },
    });
    await this.queue.enqueue(
      JOB_NAMES.publicationPublish,
      { entryId: entry.id },
      {
        tenant: {
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId as string,
        },
      },
    );
    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'content_schedule.publish_queued',
      resourceType: 'ContentScheduleEntry',
      resourceId: entry.id,
    });
    return updated;
  }

  async cancel(tenant: TenantContext, principal: Principal, entryId: string) {
    const existing = await this.prisma.client.contentScheduleEntry.findFirst({
      where: { id: entryId, ...this.scope(tenant) },
      select: { id: true },
    });
    if (!existing) throw new TenantIsolationError();
    const entry = await this.prisma.client.contentScheduleEntry.update({
      where: { id: entryId },
      data: { status: 'CANCELLED' },
    });
    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'content_schedule.cancelled',
      resourceType: 'ContentScheduleEntry',
      resourceId: entryId,
    });
    return entry;
  }
}
