import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { reviewFindingInputSchema, type ReviewFindingInput } from '@spectra/contracts';
import { z } from 'zod';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { Principal, TenantContext } from '../auth/types';
import { FindingsService } from './findings.service';

const statusFilterSchema = z.enum(['PENDING_REVIEW', 'VALIDATED', 'REJECTED', 'STALE']).optional();

@ApiTags('research')
@Controller({
  path: 'workspaces/:workspaceId/research-projects/:projectId/findings',
  version: '1',
})
export class FindingsController {
  constructor(private readonly findings: FindingsService) {}

  @Get()
  @RequirePermissions('research:read')
  @ApiOperation({ summary: 'List findings for a project (optionally by review status)' })
  list(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('status', new ZodValidationPipe(statusFilterSchema))
    status: z.infer<typeof statusFilterSchema>,
    @CurrentTenant() tenant: TenantContext,
  ) {
    return this.findings.list(tenant, projectId, status);
  }

  @Patch(':findingId')
  @RequirePermissions('research:review')
  @ApiOperation({ summary: 'Review a finding: validate or reject' })
  review(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('findingId', ParseUUIDPipe) findingId: string,
    @Body(new ZodValidationPipe(reviewFindingInputSchema)) body: ReviewFindingInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.findings.review(tenant, principal, projectId, findingId, body);
  }
}
