import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  resolveContradictionInputSchema,
  reviewClaimInputSchema,
  type ResolveContradictionInput,
  type ReviewClaimInput,
} from '@spectra/contracts';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ClaimsService } from './claims.service';
import type { Principal, TenantContext } from '../auth/types';

@ApiTags('research')
@Controller({ path: 'workspaces/:workspaceId/claims', version: '1' })
export class ClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  @Get('review-queue')
  @RequirePermissions('research:review')
  @ApiOperation({
    summary: 'Claims awaiting human review before they may ground content',
    description:
      'Populated by contradicted or stale time-sensitive claims. A claim here is excluded from evidence packs until a reviewer decides.',
  })
  reviewQueue(@CurrentTenant() tenant: TenantContext) {
    return this.claims.reviewQueue(tenant);
  }

  @Get(':claimId/reviews')
  @RequirePermissions('research:read')
  @ApiOperation({ summary: 'Append-only review history for one claim' })
  history(
    @CurrentTenant() tenant: TenantContext,
    @Param('claimId', ParseUUIDPipe) claimId: string,
  ) {
    return this.claims.reviewHistory(tenant, claimId);
  }

  @Post(':claimId/review')
  @RequirePermissions('research:review')
  @ApiOperation({
    summary: 'Approve, reject, or request more research for a claim',
    description:
      'A reviewer decision overrides the automated assessment and is appended to an immutable log. Rejection and more-research requests require a note.',
  })
  review(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('claimId', ParseUUIDPipe) claimId: string,
    @Body(new ZodValidationPipe(reviewClaimInputSchema)) body: ReviewClaimInput,
  ) {
    return this.claims.review(tenant, principal, claimId, body);
  }

  @Post('contradictions/:contradictionId/resolve')
  @RequirePermissions('research:review')
  @ApiOperation({ summary: 'Mark a contradiction resolved or dismissed (never deleted)' })
  resolveContradiction(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('contradictionId', ParseUUIDPipe) contradictionId: string,
    @Body(new ZodValidationPipe(resolveContradictionInputSchema)) body: ResolveContradictionInput,
  ) {
    return this.claims.resolveContradiction(tenant, principal, contradictionId, body);
  }
}
