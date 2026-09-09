import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  budgetPolicyInputSchema,
  budgetPreflightRequestSchema,
  updateBudgetOperationLimitsInputSchema,
  type BudgetPolicyInput,
  type BudgetPreflightRequest,
  type UpdateBudgetOperationLimitsInput,
} from '@spectra/contracts';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { BudgetService } from './budget.service';
import type { Principal, TenantContext } from '../auth/types';

@ApiTags('usage')
@Controller({ path: 'workspaces/:workspaceId/budget', version: '1' })
export class BudgetController {
  constructor(private readonly budget: BudgetService) {}

  @Get()
  @RequirePermissions('analytics:read')
  @ApiOperation({
    summary: 'Workspace spend ceiling and its status for the current calendar month',
    description:
      'Evaluated against ESTIMATED cost, so it reports how many metered events had no known rate and therefore contributed nothing.',
  })
  get(@CurrentTenant() tenant: TenantContext) {
    return this.budget.get(tenant);
  }

  @Put()
  @RequirePermissions('workspace:manage')
  @ApiOperation({
    summary: 'Set the workspace monthly spend ceiling and enforcement mode',
    description:
      'OFF records only; WARN surfaces the breach but allows work; ENFORCE refuses new paid work with 403 budget-exceeded.',
  })
  update(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(budgetPolicyInputSchema)) body: BudgetPolicyInput,
  ) {
    return this.budget.update(tenant, principal, body);
  }

  @Get('operations')
  @RequirePermissions('analytics:read')
  @ApiOperation({
    summary: 'Per-operation monthly limits and usage against them',
    description:
      'Independent of estimated spend, so free/unpriced operations can still be bounded. Reports unmeasured token quantities separately — never as zero.',
  })
  operations(@CurrentTenant() tenant: TenantContext) {
    return this.budget.operationLimits(tenant);
  }

  @Put('operations')
  @RequirePermissions('workspace:manage')
  @ApiOperation({ summary: 'Set per-operation monthly limits for this workspace' })
  setOperations(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(updateBudgetOperationLimitsInputSchema))
    body: UpdateBudgetOperationLimitsInput,
  ) {
    return this.budget.updateOperationLimits(tenant, principal, body, 'WORKSPACE');
  }

  @Post('preflight')
  @RequirePermissions('analytics:read')
  @ApiOperation({
    summary: 'Simulate the budget decision for an operation without performing it',
    description:
      'Returns ALLOW, ALLOW_WITH_WARNING, BLOCK, REQUIRES_APPROVAL or UNKNOWN_COST_ALLOW_WITH_NOTICE.',
  })
  preflight(
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodValidationPipe(budgetPreflightRequestSchema)) body: BudgetPreflightRequest,
  ) {
    return this.budget.simulate(tenant, body);
  }

  @Get('unpriced')
  @RequirePermissions('analytics:read')
  @ApiOperation({
    summary: 'Operations this period the cost ceiling cannot see, grouped by why',
    description:
      'NO_RATE_FOR_MODEL is real spend missing from estimates; FREE_LOCAL, NOT_VENDOR_BILLED and COUNTER_ONLY are expected.',
  })
  unpriced(@CurrentTenant() tenant: TenantContext) {
    return this.budget.unpricedReport({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId as string,
    });
  }
}

@ApiTags('usage')
@Controller({ path: 'organizations/:organizationId/budget', version: '1' })
export class OrganizationBudgetController {
  constructor(private readonly budget: BudgetService) {}

  @Get()
  @RequirePermissions('org:budget:read')
  @ApiOperation({
    summary: 'Organization spend ceiling, aggregate spend and per-workspace breakdown',
    description:
      'Aggregates this organization’s workspaces only. The stricter of the workspace and organization ceilings wins at pre-flight.',
  })
  get(@CurrentTenant() tenant: TenantContext) {
    return this.budget.getOrganization(tenant.organizationId);
  }

  @Put()
  @RequirePermissions('org:budget:manage')
  @ApiOperation({ summary: 'Set the organization-wide monthly ceiling and enforcement mode' })
  update(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(budgetPolicyInputSchema)) body: BudgetPolicyInput,
  ) {
    return this.budget.updateOrganization(tenant.organizationId, principal, body);
  }

  @Get('unpriced')
  @RequirePermissions('org:usage:read')
  @ApiOperation({ summary: 'Organization-wide unpriced operation report' })
  unpriced(@CurrentTenant() tenant: TenantContext) {
    return this.budget.unpricedReport({ organizationId: tenant.organizationId });
  }
}
