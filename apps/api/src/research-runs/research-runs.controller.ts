import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  scheduleResearchInputSchema,
  startResearchRunInputSchema,
  type ScheduleResearchInput,
  type StartResearchRunInput,
} from '@spectra/contracts';
import type { FastifyRequest } from 'fastify';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { Principal, TenantContext } from '../auth/types';
import { ResearchRunsService } from './research-runs.service';

@ApiTags('research')
@Controller({ path: 'workspaces/:workspaceId/research-projects/:projectId/runs', version: '1' })
export class ResearchRunsController {
  constructor(private readonly runs: ResearchRunsService) {}

  @Get()
  @RequirePermissions('research:read')
  @ApiOperation({ summary: 'List runs for a research project' })
  list(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentTenant() tenant: TenantContext,
  ) {
    return this.runs.list(tenant, projectId);
  }

  @Post()
  @RequirePermissions('research:run')
  @ApiOperation({ summary: 'Start a research run over the given RSS/Atom feeds' })
  start(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodValidationPipe(startResearchRunInputSchema)) body: StartResearchRunInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ) {
    const correlationId = request.headers['x-correlation-id'] as string | undefined;
    return this.runs.start(tenant, principal, projectId, body, correlationId);
  }

  @Put('schedule')
  @RequirePermissions('research:run')
  @ApiOperation({ summary: 'Enable/update a recurring run (every N minutes over fixed feeds)' })
  setSchedule(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodValidationPipe(scheduleResearchInputSchema)) body: ScheduleResearchInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.runs.setSchedule(tenant, principal, projectId, body);
  }

  @Delete('schedule')
  @RequirePermissions('research:run')
  @ApiOperation({ summary: 'Disable the recurring run for a project' })
  clearSchedule(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.runs.clearSchedule(tenant, principal, projectId);
  }

  @Get(':runId')
  @RequirePermissions('research:read')
  @ApiOperation({ summary: 'Get a research run (status, stage, stats)' })
  get(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentTenant() tenant: TenantContext,
  ) {
    return this.runs.get(tenant, projectId, runId);
  }
}
