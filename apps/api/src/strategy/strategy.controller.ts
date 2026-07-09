import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createPersonaInputSchema,
  createPillarInputSchema,
  createTopicIdeaInputSchema,
  updateTopicIdeaStatusInputSchema,
  type CreatePersonaInput,
  type CreatePillarInput,
  type CreateTopicIdeaInput,
  type UpdateTopicIdeaStatusInput,
} from '@spectra/contracts';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { StrategyService } from './strategy.service';
import type { Principal, TenantContext } from '../auth/types';

@ApiTags('strategy')
@Controller({ path: 'workspaces/:workspaceId/personas', version: '1' })
export class PersonasController {
  constructor(private readonly strategy: StrategyService) {}

  @Get()
  @RequirePermissions('strategy:read')
  @ApiOperation({ summary: 'List audience personas' })
  list(@CurrentTenant() tenant: TenantContext) {
    return this.strategy.listPersonas(tenant);
  }

  @Post()
  @RequirePermissions('strategy:write')
  @ApiOperation({ summary: 'Create an audience persona' })
  create(
    @Body(new ZodValidationPipe(createPersonaInputSchema)) body: CreatePersonaInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.strategy.createPersona(tenant, principal, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('strategy:write')
  @ApiOperation({ summary: 'Delete an audience persona' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.strategy.deletePersona(tenant, principal, id);
  }
}

@ApiTags('strategy')
@Controller({ path: 'workspaces/:workspaceId/content-pillars', version: '1' })
export class PillarsController {
  constructor(private readonly strategy: StrategyService) {}

  @Get()
  @RequirePermissions('strategy:read')
  @ApiOperation({ summary: 'List content pillars' })
  list(@CurrentTenant() tenant: TenantContext) {
    return this.strategy.listPillars(tenant);
  }

  @Post()
  @RequirePermissions('strategy:write')
  @ApiOperation({ summary: 'Create a content pillar' })
  create(
    @Body(new ZodValidationPipe(createPillarInputSchema)) body: CreatePillarInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.strategy.createPillar(tenant, principal, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('strategy:write')
  @ApiOperation({ summary: 'Delete a content pillar' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.strategy.deletePillar(tenant, principal, id);
  }
}

@ApiTags('strategy')
@Controller({ path: 'workspaces/:workspaceId/topic-ideas', version: '1' })
export class TopicIdeasController {
  constructor(private readonly strategy: StrategyService) {}

  @Get()
  @RequirePermissions('strategy:read')
  @ApiOperation({ summary: 'List topic ideas' })
  list(@CurrentTenant() tenant: TenantContext) {
    return this.strategy.listTopicIdeas(tenant);
  }

  @Post()
  @RequirePermissions('strategy:write')
  @ApiOperation({ summary: 'Create a topic idea, optionally traced to research' })
  create(
    @Body(new ZodValidationPipe(createTopicIdeaInputSchema)) body: CreateTopicIdeaInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.strategy.createTopicIdea(tenant, principal, body);
  }

  @Patch(':id')
  @RequirePermissions('strategy:write')
  @ApiOperation({ summary: 'Update a topic idea status (shortlist / discard / mark in use)' })
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateTopicIdeaStatusInputSchema)) body: UpdateTopicIdeaStatusInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.strategy.setTopicIdeaStatus(tenant, principal, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('strategy:write')
  @ApiOperation({ summary: 'Delete a topic idea' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.strategy.deleteTopicIdea(tenant, principal, id);
  }
}
