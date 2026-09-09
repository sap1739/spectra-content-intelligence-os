import { Injectable } from '@nestjs/common';
import type { UpdateWorkspaceBudgetInput } from '@spectra/contracts';
import { evaluateBudget, type BudgetDecision } from '@spectra/metering';

import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

/** Reads and updates the workspace spend ceiling, and reports its live status. */
@Injectable()
export class BudgetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Current budget configuration plus its evaluated status for this period. */
  async get(tenant: TenantContext): Promise<BudgetDecision> {
    return evaluateBudget(this.prisma.client, {
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId as string,
    });
  }

  async update(
    tenant: TenantContext,
    principal: Principal,
    input: UpdateWorkspaceBudgetInput,
  ): Promise<BudgetDecision> {
    const organizationId = tenant.organizationId;
    const workspaceId = tenant.workspaceId as string;

    await this.prisma.client.workspaceBudget.upsert({
      where: { workspaceId },
      create: {
        organizationId,
        workspaceId,
        monthlyLimitMicros: input.monthlyLimitMicros,
        enforcement: input.enforcement,
        warnAtPercent: input.warnAtPercent,
        updatedById: principal.userId,
      },
      update: {
        monthlyLimitMicros: input.monthlyLimitMicros,
        enforcement: input.enforcement,
        warnAtPercent: input.warnAtPercent,
        updatedById: principal.userId,
      },
    });

    await this.audit.record({
      organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'workspace_budget.updated',
      resourceType: 'WorkspaceBudget',
      resourceId: workspaceId,
      changes: {
        monthlyLimitMicros: input.monthlyLimitMicros,
        enforcement: input.enforcement,
        warnAtPercent: input.warnAtPercent,
      },
    });

    return this.get(tenant);
  }
}
