import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { ScheduleResearchInput, StartResearchRunInput } from '@spectra/contracts';
import { Prisma, type ResearchProject, type ResearchRun } from '@spectra/database';
import { TenantIsolationError } from '@spectra/security';
import { release, reserve } from '@spectra/metering';
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

    const scope = {
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId as string,
    };
    // Reserve BEFORE creating the row. The run id is minted here so the hold
    // can be keyed to it up front: decision and hold are then a single atomic
    // step (ADR-0029), rather than a check followed by a separate write that a
    // concurrent request could slip between. A BudgetBlockedError propagates as
    // 403, so an over-budget workspace never creates or queues the run.
    const runId = randomUUID();
    await reserve(this.prisma.client, {
      ...scope,
      kind: 'RESEARCH_RUN',
      provider: 'spectra',
      requests: 1,
      idempotencyKey: `research-run-${runId}`,
      resourceType: 'RESEARCH_RUN',
      resourceId: runId,
    });

    let run;
    try {
      run = await this.prisma.client.researchRun.create({
        data: {
          id: runId,
          ...scope,
          projectId,
          status: 'QUEUED',
          trigger: 'MANUAL',
          createdById: principal.userId,
          queryPlan: {
            feedUrls: input.feedUrls,
            searchQueries: input.searchQueries,
          } as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      // The run never existed, so nothing will ever reconcile this hold.
      await release(this.prisma.client, scope, `research-run-${runId}`);
      throw error;
    }

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
      changes: { feedUrls: input.feedUrls, searchQueries: input.searchQueries },
    });

    return run;
  }

  /** Enables a recurring run: cadence + feed set stored on the project. */
  async setSchedule(
    tenant: TenantContext,
    principal: Principal,
    projectId: string,
    input: ScheduleResearchInput,
  ): Promise<ResearchProject> {
    await this.assertProject(tenant, projectId);
    const project = await this.prisma.client.researchProject.update({
      where: { id: projectId },
      data: {
        scheduleEveryMinutes: input.everyMinutes,
        scheduleFeedUrls: input.feedUrls,
      },
    });
    await this.queue.schedule(
      JOB_NAMES.researchRunScheduled,
      { projectId },
      {
        schedulerId: `research-schedule-${projectId}`,
        everyMs: input.everyMinutes * 60_000,
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
      action: 'research_schedule.set',
      resourceType: 'ResearchProject',
      resourceId: projectId,
      changes: { everyMinutes: input.everyMinutes, feedUrls: input.feedUrls },
    });
    return project;
  }

  async clearSchedule(
    tenant: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<ResearchProject> {
    await this.assertProject(tenant, projectId);
    const project = await this.prisma.client.researchProject.update({
      where: { id: projectId },
      data: { scheduleEveryMinutes: null, scheduleFeedUrls: [] },
    });
    await this.queue.unschedule(`research-schedule-${projectId}`);
    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'research_schedule.cleared',
      resourceType: 'ResearchProject',
      resourceId: projectId,
    });
    return project;
  }

  /**
   * Per-source quality detail for one run (ADR-0030).
   *
   * Reports what the run could NOT do — robots-blocked, snippet-only, blocked
   * domains, duplicates — as prominently as what it could, so a partial run is
   * never mistaken for a thorough one.
   */
  async quality(tenant: TenantContext, projectId: string, runId: string) {
    await this.assertProject(tenant, projectId);
    const scope = {
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId as string,
    };
    const run = await this.prisma.client.researchRun.findFirst({
      where: { id: runId, projectId, ...scope },
      select: { id: true, status: true, stats: true, failureReason: true },
    });
    if (!run) throw new TenantIsolationError();

    const sources = await this.prisma.client.researchSource.findMany({
      where: { ...scope, runId, deletedAt: null },
      orderBy: [{ evidenceEligible: 'desc' }, { credibilityScore: 'desc' }],
      take: 200,
      select: {
        id: true,
        url: true,
        title: true,
        publisher: true,
        publishedAt: true,
        retrievedAt: true,
        category: true,
        credibilityScore: true,
        freshnessScore: true,
        stalenessStatus: true,
        snippetOnly: true,
        robotsDecision: true,
        robotsCheckedAt: true,
        evidenceEligible: true,
        evidenceExclusionReason: true,
        diversityWeight: true,
        duplicateOfSourceId: true,
        duplicateClusterKey: true,
        processingStatus: true,
        metadata: true,
      },
    });

    // Near-duplicate clusters, so an operator can see which "distinct" sources
    // are actually the same syndicated story.
    const clusters = new Map<string, { key: string; size: number; sourceIds: string[] }>();
    for (const s of sources) {
      const key = s.duplicateClusterKey ?? s.duplicateOfSourceId;
      if (!key) continue;
      const entry = clusters.get(key) ?? { key, size: 0, sourceIds: [] };
      entry.size += 1;
      entry.sourceIds.push(s.id);
      clusters.set(key, entry);
    }

    return {
      run,
      sources,
      duplicateClusters: [...clusters.values()].filter((c) => c.size > 1),
      note:
        'Counts describe what this run actually retrieved. Robots-blocked and snippet-only sources ' +
        'are kept with a truthful reason and weighted below fully-retrieved sources; they are never ' +
        'presented as equivalent evidence.',
    };
  }
}
