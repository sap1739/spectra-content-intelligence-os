import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { startOrchestrationInputSchema, type StartOrchestrationInput } from '@spectra/contracts';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { OrchestrationService } from './orchestration.service';
import type { Principal, TenantContext } from '../auth/types';

@ApiTags('campaign-orchestration')
@Controller({ path: 'workspaces/:workspaceId/campaign-orchestration', version: '1' })
export class OrchestrationController {
  constructor(private readonly orchestration: OrchestrationService) {}

  @Get('capabilities')
  @RequirePermissions('campaign:read')
  @ApiOperation({
    summary: 'What a run can do here — the strategy engine, and whether drafts can be written',
  })
  capabilities() {
    return this.orchestration.capabilities();
  }

  @Get('runs')
  @RequirePermissions('campaign:read')
  @ApiOperation({ summary: 'Orchestration runs in this workspace, newest first' })
  listRuns(@CurrentTenant() tenant: TenantContext) {
    return this.orchestration.listRuns(tenant);
  }

  @Get('runs/:runId')
  @RequirePermissions('campaign:read')
  @ApiOperation({ summary: 'One run: its stages, strategy, plan and per-item outcomes' })
  getRun(@Param('runId', ParseUUIDPipe) id: string, @CurrentTenant() tenant: TenantContext) {
    return this.orchestration.getRun(tenant, id);
  }

  @Get('runs/:runId/items')
  @RequirePermissions('campaign:read')
  @ApiOperation({ summary: 'The content a run produced, with each item’s evidence lineage' })
  runItems(@Param('runId', ParseUUIDPipe) id: string, @CurrentTenant() tenant: TenantContext) {
    return this.orchestration.runItems(tenant, id);
  }

  @Post('runs')
  @HttpCode(202)
  @RequirePermissions('campaign:orchestrate')
  @ApiOperation({
    summary: 'Queue a research-backed campaign build — budget-checked before anything is created',
  })
  startRun(
    @Body(new ZodValidationPipe(startOrchestrationInputSchema)) body: StartOrchestrationInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.orchestration.startRun(tenant, principal, body);
  }

  @Post('runs/:runId/cancel')
  @RequirePermissions('campaign:orchestrate')
  @ApiOperation({ summary: 'Cancel a queued or running orchestration' })
  cancelRun(
    @Param('runId', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.orchestration.cancelRun(tenant, principal, id);
  }
}
