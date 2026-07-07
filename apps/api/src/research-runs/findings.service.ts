import { Injectable } from '@nestjs/common';
import type { ReviewFindingInput } from '@spectra/contracts';
import { TenantIsolationError } from '@spectra/security';

import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

@Injectable()
export class FindingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(
    tenant: TenantContext,
    projectId: string,
    status?: 'PENDING_REVIEW' | 'VALIDATED' | 'REJECTED' | 'STALE',
  ) {
    return this.prisma.client.researchFinding.findMany({
      where: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        projectId,
        deletedAt: null,
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        source: {
          select: {
            url: true,
            title: true,
            publisher: true,
            publishedAt: true,
            retrievedAt: true,
          },
        },
      },
    });
  }

  async review(
    tenant: TenantContext,
    principal: Principal,
    projectId: string,
    findingId: string,
    input: ReviewFindingInput,
  ) {
    const existing = await this.prisma.client.researchFinding.findFirst({
      where: {
        id: findingId,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        projectId,
        deletedAt: null,
      },
      select: { id: true, status: true },
    });
    if (!existing) throw new TenantIsolationError();

    const finding = await this.prisma.client.researchFinding.update({
      where: { id: findingId },
      data: { status: input.status },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: `finding.${input.status.toLowerCase()}`,
      resourceType: 'ResearchFinding',
      resourceId: findingId,
      changes: { from: existing.status, to: input.status },
    });

    return finding;
  }
}
