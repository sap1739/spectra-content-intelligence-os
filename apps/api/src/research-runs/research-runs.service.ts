import { Injectable } from '@nestjs/common';
import type { StartResearchRunInput } from '@spectra/contracts';
import { Prisma, type ResearchRun } from '@spectra/database';
import { TenantIsolationError } from '@spectra/security';
import { JOB_NAMES } from '@spectra/workflow-core';

import { AuditService } from '../infra/audit.service';
import { QueueService } from '../infra/queue.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

@Injectable()
export class ResearchRunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  private async assertProject(tenant: TenantContext, projectId: string) {
    const project = await this.prisma.client.researchProject.findFirst({
      where: {
        id: projectId,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        deletedAt: null,
      },
      select: { id: true, status: true },
    });
    if (!project) throw new TenantIsolationError();
    return project;
  }

  async list(tenant: TenantContext, projectId: string) {
    await this.assertProject(tenant, projectId);
    return this.prisma.client.researchRun.findMany({
      where: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        projectId,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async get(tenant: TenantContext, projectId: string, runId: string) {
    const run = await this.prisma.client.researchRun.findFirst({
      where: {
        id: runId,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        projectId,
      },
    });
    if (!run) throw new TenantIsolationError();
    return run;
  }

  /** Creates the run row and enqueues execution on the system queue. */
  async start(
    tenant: TenantContext,
    principal: Principal,
    projectId: string,
    input: StartResearchRunInput,
    correlationId?: string,
  ): Promise<ResearchRun> {
    await this.assertProject(tenant, projectId);

    const run = await this.prisma.client.researchRun.create({
      data: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        projectId,
        status: 'QUEUED',
        trigger: 'MANUAL',
        createdById: principal.userId,
        queryPlan: { feedUrls: input.feedUrls } as Prisma.InputJsonValue,
      },
    });

    await this.queue.enqueue(
      JOB_NAMES.researchRunExecute,
      { runId: run.id },
      {
        idempotencyKey: `research-run-${run.id}`,
        ...(correlationId ? { correlationId } : {}),
        tenant: {
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId as string,
        },
        retry: { maxAttempts: 2, backoff: { type: 'exponential', delayMs: 5000 } },
      },
    );

    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'research_run.started',
      resourceType: 'ResearchRun',
      resourceId: run.id,
      correlationId: correlationId ?? null,
      changes: { feedUrls: input.feedUrls },
    });

    return run;
  }
}
