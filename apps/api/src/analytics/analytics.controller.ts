import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { analyticsSyncRequestSchema, type AnalyticsSyncRequest } from '@spectra/contracts';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AnalyticsService } from './analytics.service';
import { ExternalAnalyticsService } from './external-analytics.service';
import type { Principal, TenantContext } from '../auth/types';

@ApiTags('analytics')
@Controller({ path: 'workspaces/:workspaceId/analytics', version: '1' })
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly external: ExternalAnalyticsService,
  ) {}

  @Get('overview')
  @RequirePermissions('analytics:read')
  @ApiOperation({
    summary: 'Real first-party workspace metrics (content funnel, drafts, publications, research)',
  })
  overview(@CurrentTenant() tenant: TenantContext) {
    return this.analytics.overview(tenant);
  }

  @Get('providers')
  @RequirePermissions('analytics:read')
  @ApiOperation({
    summary:
      'Every platform’s analytics provider: implemented or not, configured, and each metric’s availability with the reason',
  })
  providers() {
    return this.external.providers();
  }

  @Get('availability')
  @RequirePermissions('analytics:read')
  @ApiOperation({
    summary:
      'Analytics availability for each connected account (missing scopes, reconnects, unsupported)',
  })
  availability(@CurrentTenant() tenant: TenantContext) {
    return this.external.availability(tenant);
  }

  @Post('sync')
  @HttpCode(202)
  @RequirePermissions('analytics:sync')
  @ApiOperation({
    summary:
      'Start a manual analytics sync for the workspace, one account or one published entry (idempotent; Idempotency-Key supported)',
  })
  sync(
    @Body(new ZodValidationPipe(analyticsSyncRequestSchema)) body: AnalyticsSyncRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.external.requestSync(tenant, principal, body, idempotencyKey);
  }

  @Get('sync-runs')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Recent analytics sync runs with per-target outcomes' })
  syncRuns(
    @CurrentTenant() tenant: TenantContext,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.external.syncRuns(tenant, limit);
  }

  @Get('sync-runs/:runId')
  @RequirePermissions('analytics:read')
  @ApiOperation({
    summary: 'One analytics sync run: status, attempts, errors, rate limits and outcomes',
  })
  syncRun(@CurrentTenant() tenant: TenantContext, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.external.syncRun(tenant, runId);
  }

  @Get('summary')
  @RequirePermissions('analytics:read')
  @ApiOperation({
    summary:
      'Workspace external analytics: sums of what platforms reported, with contributing/unavailable counts and freshness',
  })
  summary(@CurrentTenant() tenant: TenantContext) {
    return this.external.summary(tenant);
  }

  @Get('campaigns/:campaignId')
  @RequirePermissions('analytics:read')
  @ApiOperation({
    summary: 'Campaign analytics: Spectra’s sum over the campaign’s published posts',
  })
  campaign(
    @CurrentTenant() tenant: TenantContext,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
  ) {
    return this.external.campaign(tenant, campaignId);
  }

  @Get('content/:contentItemId')
  @RequirePermissions('analytics:read')
  @ApiOperation({
    summary: 'Per-post analytics for a content item, with history and why a post has none',
  })
  content(
    @CurrentTenant() tenant: TenantContext,
    @Param('contentItemId', ParseUUIDPipe) contentItemId: string,
  ) {
    return this.external.content(tenant, contentItemId);
  }

  @Get('unavailable-metrics')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Metrics that came back unavailable, grouped by platform and reason' })
  unavailable(@CurrentTenant() tenant: TenantContext) {
    return this.external.unavailable(tenant);
  }

  @Get('freshness')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Freshness of the latest snapshot per account and post' })
  freshness(@CurrentTenant() tenant: TenantContext) {
    return this.external.freshness(tenant);
  }

  @Get('provider-status')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Recent provider errors and rate limits from sync runs' })
  providerStatus(@CurrentTenant() tenant: TenantContext) {
    return this.external.providerStatus(tenant);
  }
}
