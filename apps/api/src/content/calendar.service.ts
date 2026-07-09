import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { ScheduleEntryInput } from '@spectra/contracts';
import { TenantIsolationError } from '@spectra/security';

import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

const SCHEDULABLE_STATES = new Set(['APPROVED', 'SCHEDULED']);

@Injectable()
export class CalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
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
      },
    });
  }

  async schedule(tenant: TenantContext, principal: Principal, input: ScheduleEntryInput) {
    const item = await this.prisma.client.contentItem.findFirst({
      where: { id: input.contentItemId, ...this.scope(tenant), deletedAt: null },
      select: { id: true, lifecycleState: true },
    });
    if (!item) throw new TenantIsolationError();

    if (!SCHEDULABLE_STATES.has(item.lifecycleState)) {
      throw new UnprocessableEntityException(
        `Only approved content can be scheduled (item is ${item.lifecycleState}).`,
      );
    }

    const entry = await this.prisma.client.contentScheduleEntry.create({
      data: {
        ...this.scope(tenant),
        contentItemId: item.id,
        platform: input.platform,
        scheduledAt: new Date(input.scheduledAt),
        note: input.note ?? null,
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
      changes: { platform: input.platform, scheduledAt: input.scheduledAt },
    });
    return entry;
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
