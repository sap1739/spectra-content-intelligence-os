import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createCampaignInputSchema,
  upsertCampaignBriefInputSchema,
  type CreateCampaignInput,
  type UpsertCampaignBriefInput,
} from '@spectra/contracts';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { StrategyService } from './strategy.service';
import type { Principal, TenantContext } from '../auth/types';

@ApiTags('strategy')
@Controller({ path: 'workspaces/:workspaceId/campaigns', version: '1' })
export class CampaignsController {
  constructor(private readonly strategy: StrategyService) {}

  @Get()
  @RequirePermissions('campaign:read')
  @ApiOperation({ summary: 'List campaigns with their brief and content count' })
  list(@CurrentTenant() tenant: TenantContext) {
    return this.strategy.listCampaigns(tenant);
  }

  @Post()
  @RequirePermissions('campaign:write')
  @ApiOperation({ summary: 'Create a campaign' })
  create(
    @Body(new ZodValidationPipe(createCampaignInputSchema)) body: CreateCampaignInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.strategy.createCampaign(tenant, principal, body);
  }

  @Get(':campaignId')
  @RequirePermissions('campaign:read')
  @ApiOperation({ summary: 'Get a campaign' })
  get(
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @CurrentTenant() tenant: TenantContext,
  ) {
    return this.strategy.getCampaign(tenant, campaignId);
  }

  @Put(':campaignId/brief')
  @RequirePermissions('campaign:write')
  @ApiOperation({ summary: 'Create or update the campaign brief' })
  upsertBrief(
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Body(new ZodValidationPipe(upsertCampaignBriefInputSchema)) body: UpsertCampaignBriefInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.strategy.upsertBrief(tenant, principal, campaignId, body);
  }
}
