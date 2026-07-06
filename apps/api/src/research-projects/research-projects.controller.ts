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
  createResearchProjectInputSchema,
  updateResearchProjectInputSchema,
  type CreateResearchProjectInput,
  type UpdateResearchProjectInput,
} from '@spectra/contracts';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { Principal, TenantContext } from '../auth/types';
import { ResearchProjectsService } from './research-projects.service';

@ApiTags('research')
@Controller({ path: 'workspaces/:workspaceId/research-projects', version: '1' })
export class ResearchProjectsController {
  constructor(private readonly projects: ResearchProjectsService) {}

  @Get()
  @RequirePermissions('research:read')
  @ApiOperation({ summary: 'List research projects in the workspace' })
  list(@CurrentTenant() tenant: TenantContext) {
    return this.projects.list(tenant);
  }

  @Post()
  @RequirePermissions('research:run')
  @ApiOperation({ summary: 'Create a research project' })
  create(
    @Body(new ZodValidationPipe(createResearchProjectInputSchema))
    body: CreateResearchProjectInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.projects.create(tenant, principal, body);
  }

  @Get(':id')
  @RequirePermissions('research:read')
  @ApiOperation({ summary: 'Get a research project' })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentTenant() tenant: TenantContext) {
    return this.projects.get(tenant, id);
  }

  @Patch(':id')
  @RequirePermissions('research:run')
  @ApiOperation({ summary: 'Update a research project' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateResearchProjectInputSchema))
    body: UpdateResearchProjectInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.projects.update(tenant, principal, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('research:run')
  @ApiOperation({ summary: 'Archive (soft-delete) a research project' })
  async archive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.projects.archive(tenant, principal, id);
  }
}
