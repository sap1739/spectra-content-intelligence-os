import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentTenant, RequirePermissions } from '../auth/decorators';
import { AnalyticsService } from './analytics.service';
import type { TenantContext } from '../auth/types';

@ApiTags('analytics')
@Controller({ path: 'workspaces/:workspaceId/analytics', version: '1' })
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  @RequirePermissions('analytics:read')
  @ApiOperation({
    summary: 'Real first-party workspace metrics (content funnel, drafts, publications, research)',
  })
  overview(@CurrentTenant() tenant: TenantContext) {
    return this.analytics.overview(tenant);
  }
}
