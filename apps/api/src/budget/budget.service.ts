import { Injectable } from '@nestjs/common';
import type {
  BudgetPolicyInput,
  BudgetPreflightRequest,
  UpdateBudgetOperationLimitsInput,
} from '@spectra/contracts';
import {
  UNPRICED_REASON_TEXT,
  USAGE_KINDS,
  evaluateBudget,
  periodEndFor,
  periodStartFor,
  preflight,
  type BudgetDecision,
  type PreflightDecision,
  type UsageKind,
} from '@spectra/metering';

import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

/**
 * Budget policy: workspace ceiling, organization ceiling, per-operation limits,
 * pre-flight simulation and the unpriced-operation report.
 *
 * Every read is tenant-scoped. Organization aggregates span that organization's
 * workspaces only — never across tenants.
 */
@Injectable()
export class BudgetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ----- workspace ceiling -------------------------------------------------

  async get(tenant: TenantContext): Promise<BudgetDecision> {
    return evaluateBudget(this.prisma.client, {
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId as string,
    });
  }

  async update(
    tenant: TenantContext,
    principal: Principal,
    input: BudgetPolicyInput,
  ): Promise<BudgetDecision> {
    const organizationId = tenant.organizationId;
    const workspaceId = tenant.workspaceId as string;
    const data = {
      monthlyLimitMicros: input.monthlyLimitMicros,
      enforcement: input.enforcement,
      warnAtPercent: input.warnAtPercent,
      updatedById: principal.userId,
    };
    await this.prisma.client.workspaceBudget.upsert({
      where: { workspaceId },
      create: { organizationId, workspaceId, ...data },
      update: data,
    });
    await this.audit.record({
      organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'workspace_budget.updated',
      resourceType: 'WorkspaceBudget',
      resourceId: workspaceId,
      changes: { ...input },
    });
    return this.get(tenant);
  }

  // ----- organization ceiling ---------------------------------------------

  /** Org ceiling + aggregate spend across this organization's workspaces only. */
  async getOrganization(organizationId: string) {
    const now = new Date();
    const periodStart = periodStartFor(now);
    const periodEnd = periodEndFor(now);
    const window = { gte: periodStart, lt: periodEnd };

    const [budget, spend, unpriced, byWorkspace] = await Promise.all([
      this.prisma.client.organizationBudget.findFirst({ where: { organizationId } }),
      this.prisma.client.usageEvent.aggregate({
        where: { organizationId, occurredAt: window },
        _sum: { estimatedCostMicros: true },
        _count: { _all: true },
      }),
      this.prisma.client.usageEvent.count({
        where: { organizationId, occurredAt: window, estimatedCostMicros: null },
      }),
      this.prisma.client.usageEvent.groupBy({
        by: ['workspaceId'],
        where: { organizationId, occurredAt: window },
        _sum: { estimatedCostMicros: true },
        _count: { _all: true },
      }),
    ]);

    const usedMicros = spend._sum.estimatedCostMicros ?? 0;
    const limitMicros = budget?.monthlyLimitMicros ?? null;
    const configured = limitMicros !== null && limitMicros > 0;

    return {
      configured,
      enforcement: budget?.enforcement ?? 'OFF',
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      limitMicros,
      usedMicros,
      remainingMicros: configured ? (limitMicros as number) - usedMicros : null,
      usedPercent: configured ? Math.round((usedMicros / (limitMicros as number)) * 100) : null,
      warnAtPercent: budget?.warnAtPercent ?? 80,
      totalEvents: spend._count._all,
      unpricedEvents: unpriced,
      currency: budget?.currency ?? 'USD',
      workspaces: byWorkspace.map((row) => ({
        workspaceId: row.workspaceId,
        estimatedCostMicros: row._sum.estimatedCostMicros ?? 0,
        events: row._count._all,
      })),
      note: configured
        ? 'Estimated spend across this organization’s workspaces. Unpriced operations are excluded and counted separately.'
        : 'No organization-wide limit is configured, so no organization ceiling was checked.',
    };
  }

  async updateOrganization(organizationId: string, principal: Principal, input: BudgetPolicyInput) {
    const data = {
      monthlyLimitMicros: input.monthlyLimitMicros,
      enforcement: input.enforcement,
      warnAtPercent: input.warnAtPercent,
      updatedById: principal.userId,
    };
    await this.prisma.client.organizationBudget.upsert({
      where: { organizationId },
      create: { organizationId, ...data },
      update: data,
    });
    await this.audit.record({
      organizationId,
      actorUserId: principal.userId,
      action: 'organization_budget.updated',
      resourceType: 'OrganizationBudget',
      resourceId: organizationId,
      changes: { ...input },
    });
    return this.getOrganization(organizationId);
  }

  // ----- per-operation limits ---------------------------------------------

  /** Configured limits + this period's usage for every kind. */
  async operationLimits(tenant: TenantContext) {
    const organizationId = tenant.organizationId;
    const workspaceId = tenant.workspaceId as string;
    const now = new Date();
    const window = { gte: periodStartFor(now), lt: periodEndFor(now) };

    const [limits, usage, unknown] = await Promise.all([
      this.prisma.client.budgetOperationLimit.findMany({ where: { organizationId } }),
      this.prisma.client.usageEvent.groupBy({
        by: ['kind'],
        where: { organizationId, workspaceId, occurredAt: window },
        _sum: { requests: true, inputTokens: true, outputTokens: true, totalTokens: true },
        _count: { _all: true },
      }),
      this.prisma.client.usageEvent.groupBy({
        by: ['kind'],
        where: { organizationId, workspaceId, occurredAt: window, quantityUnknown: true },
        _count: { _all: true },
      }),
    ]);

    return {
      periodStart: window.gte.toISOString(),
      periodEnd: window.lt.toISOString(),
      kinds: USAGE_KINDS.map((kind) => {
        const wsLimit = limits.find((l) => l.workspaceId === workspaceId && l.kind === kind);
        const orgLimit = limits.find((l) => l.workspaceId === null && l.kind === kind);
        const used = usage.find((u) => u.kind === kind);
        const unknownCount = unknown.find((u) => u.kind === kind)?._count._all ?? 0;
        const measuredTokens =
          (used?._sum.inputTokens ?? 0) +
          (used?._sum.outputTokens ?? 0) +
          (used?._sum.totalTokens ?? 0);
        const requests = used?._sum.requests ?? 0;
        const maxRequests = wsLimit?.maxRequests ?? orgLimit?.maxRequests ?? null;
        const maxTokens = wsLimit?.maxTokens ?? orgLimit?.maxTokens ?? null;
        return {
          kind,
          requests,
          measuredTokens,
          // Counted as operations, deliberately NOT as zero tokens.
          unknownQuantityEvents: unknownCount,
          workspaceMaxRequests: wsLimit?.maxRequests ?? null,
          workspaceMaxTokens: wsLimit?.maxTokens ?? null,
          organizationMaxRequests: orgLimit?.maxRequests ?? null,
          organizationMaxTokens: orgLimit?.maxTokens ?? null,
          remainingRequests: maxRequests === null ? null : maxRequests - requests,
          remainingTokens: maxTokens === null ? null : maxTokens - measuredTokens,
        };
      }),
      note: 'Per-operation limits are independent of estimated spend, so they can bound operations that are free, unpriced or not vendor-billed.',
    };
  }

  async updateOperationLimits(
    tenant: TenantContext,
    principal: Principal,
    input: UpdateBudgetOperationLimitsInput,
    scope: 'WORKSPACE' | 'ORGANIZATION',
  ) {
    const organizationId = tenant.organizationId;
    const workspaceId = scope === 'WORKSPACE' ? (tenant.workspaceId as string) : null;

    // Not an upsert: `workspaceId` is nullable in the compound unique (NULL =
    // organization-scoped), which Prisma's upsert `where` cannot express.
    for (const limit of input.limits) {
      const existing = await this.prisma.client.budgetOperationLimit.findFirst({
        where: { organizationId, workspaceId, kind: limit.kind },
        select: { id: true },
      });
      if (existing) {
        await this.prisma.client.budgetOperationLimit.update({
          where: { id: existing.id },
          data: {
            maxRequests: limit.maxRequests,
            maxTokens: limit.maxTokens,
            updatedById: principal.userId,
          },
        });
      } else {
        await this.prisma.client.budgetOperationLimit.create({
          data: {
            organizationId,
            workspaceId,
            kind: limit.kind,
            maxRequests: limit.maxRequests,
            maxTokens: limit.maxTokens,
            updatedById: principal.userId,
          },
        });
      }
    }

    await this.audit.record({
      organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'budget_operation_limits.updated',
      resourceType: 'BudgetOperationLimit',
      resourceId: workspaceId ?? organizationId,
      changes: { scope, limits: input.limits },
    });

    return this.operationLimits(tenant);
  }

  // ----- simulation + unpriced report -------------------------------------

  /** What WOULD happen for this operation, without performing it. */
  simulate(tenant: TenantContext, input: BudgetPreflightRequest): Promise<PreflightDecision> {
    return preflight(this.prisma.client, {
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId as string,
      kind: input.kind as UsageKind,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      requests: input.requests,
      ...(input.estimatedInputTokens !== undefined
        ? { estimatedInputTokens: input.estimatedInputTokens }
        : {}),
      ...(input.estimatedOutputTokens !== undefined
        ? { estimatedOutputTokens: input.estimatedOutputTokens }
        : {}),
    });
  }

  /**
   * What this period's ceiling cannot see. Grouped by the REASON an operation
   * is unpriced, because "free" and "no rate configured" are different problems
   * and only one of them is a gap worth closing.
   */
  async unpricedReport(scope: { organizationId: string; workspaceId?: string }) {
    const now = new Date();
    const window = { gte: periodStartFor(now), lt: periodEndFor(now) };
    const where = {
      organizationId: scope.organizationId,
      ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
      occurredAt: window,
      estimatedCostMicros: null,
    };

    const [byReason, byKind, fallbackPriced] = await Promise.all([
      this.prisma.client.usageEvent.groupBy({
        by: ['unpricedReason'],
        where,
        _count: { _all: true },
      }),
      this.prisma.client.usageEvent.groupBy({
        by: ['kind', 'provider', 'model', 'unpricedReason'],
        where,
        _count: { _all: true },
        _sum: { requests: true },
      }),
      // Priced, but only by a conservative family fallback — over-stated.
      this.prisma.client.usageEvent.count({
        where: {
          organizationId: scope.organizationId,
          ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
          occurredAt: window,
          rateSource: 'FAMILY_FALLBACK_CONSERVATIVE',
        },
      }),
    ]);

    return {
      periodStart: window.gte.toISOString(),
      periodEnd: window.lt.toISOString(),
      byReason: byReason.map((r) => ({
        reason: r.unpricedReason,
        events: r._count._all,
        explanation: r.unpricedReason
          ? UNPRICED_REASON_TEXT[r.unpricedReason as keyof typeof UNPRICED_REASON_TEXT]
          : 'No reason recorded — this row predates unpriced-reason tracking.',
      })),
      operations: byKind.map((r) => ({
        kind: r.kind,
        provider: r.provider,
        model: r.model,
        reason: r.unpricedReason,
        events: r._count._all,
        requests: r._sum.requests ?? 0,
      })),
      conservativelyPricedEvents: fallbackPriced,
      note: 'Operations with NO_RATE_FOR_MODEL are real spend the cost ceiling cannot see — the gap to close. FREE_LOCAL, NOT_VENDOR_BILLED and COUNTER_ONLY are expected and cost nothing extra.',
    };
  }
}
