import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { OpsService } from './ops.service';
import type { Principal, TenantContext } from '../auth/types';

@ApiTags('operations')
@Controller({ path: 'workspaces/:workspaceId/ops', version: '1' })
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  @Get('queue')
  @RequirePermissions('ops:read')
  @ApiOperation({
    summary: 'Queue depth and failure counts',
    description:
      'Reports `reachable: false` with a reason when the queue cannot be reached, rather than zeros — an empty queue and an unreachable one are different situations.',
  })
  queue() {
    return this.ops.queueStatus();
  }

  @Get('failed-jobs')
  @RequirePermissions('ops:read')
  @ApiOperation({
    summary: 'Failed and dead-lettered jobs for this tenant, grouped by category',
    description:
      'Covers research, content generation, publishing and embedding jobs. A job with no recorded tenant is never listed.',
  })
  failedJobs(@CurrentTenant() tenant: TenantContext, @Query('limit') limit?: string) {
    const parsed = Number.parseInt(limit ?? '50', 10);
    return this.ops.failedJobs(tenant, Number.isFinite(parsed) ? Math.min(parsed, 200) : 50);
  }

  @Post('failed-jobs/:jobId/retry')
  @RequirePermissions('ops:retry')
  @ApiOperation({
    summary: 'Re-run a failed job',
    description:
      'Retries the ORIGINAL job, so its idempotency key is unchanged and the executor’s budget pre-flight runs again on execution.',
  })
  retry(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('jobId') jobId: string,
  ) {
    return this.ops.retry(tenant, principal, jobId);
  }
}
