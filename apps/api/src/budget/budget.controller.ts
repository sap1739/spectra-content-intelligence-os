import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  updateWorkspaceBudgetInputSchema,
  type UpdateWorkspaceBudgetInput,
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
      'Status is evaluated against ESTIMATED cost, so it reports how many metered events had no known rate and therefore contributed nothing to the total.',
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
    @Body(new ZodValidationPipe(updateWorkspaceBudgetInputSchema))
    body: UpdateWorkspaceBudgetInput,
  ) {
    return this.budget.update(tenant, principal, body);
  }
}
