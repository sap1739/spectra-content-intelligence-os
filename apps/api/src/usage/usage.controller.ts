import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentTenant, RequirePermissions } from '../auth/decorators';
import { UsageReportService } from './usage.service';
import type { TenantContext } from '../auth/types';

@ApiTags('usage')
@Controller({ path: 'workspaces/:workspaceId/usage', version: '1' })
export class UsageController {
  constructor(private readonly usage: UsageReportService) {}

  @Get('summary')
  @RequirePermissions('analytics:read')
  @ApiOperation({
    summary: 'Measured provider usage with estimated cost (never a vendor invoice)',
  })
  summary(@CurrentTenant() tenant: TenantContext, @Query('days') days?: string) {
    const parsed = Number.parseInt(days ?? '30', 10);
    const window = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 365) : 30;
    return this.usage.summary(tenant, window);
  }
}
