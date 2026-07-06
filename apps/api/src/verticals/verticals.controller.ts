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
  createVerticalInputSchema,
  updateVerticalInputSchema,
  type CreateVerticalInput,
  type UpdateVerticalInput,
} from '@spectra/contracts';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { Principal, TenantContext } from '../auth/types';
import { VerticalsService } from './verticals.service';

@ApiTags('verticals')
@Controller({ path: 'workspaces/:workspaceId/verticals', version: '1' })
export class VerticalsController {
  constructor(private readonly verticals: VerticalsService) {}

  @Get()
  @RequirePermissions('vertical:read')
  @ApiOperation({ summary: 'List custom verticals in the workspace' })
  list(@CurrentTenant() tenant: TenantContext) {
    return this.verticals.list(tenant);
  }

  @Post()
  @RequirePermissions('vertical:write')
  @ApiOperation({ summary: 'Create a custom vertical' })
  create(
    @Body(new ZodValidationPipe(createVerticalInputSchema)) body: CreateVerticalInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.verticals.create(tenant, principal, body);
  }

  @Get(':id')
  @RequirePermissions('vertical:read')
  @ApiOperation({ summary: 'Get a custom vertical' })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentTenant() tenant: TenantContext) {
    return this.verticals.get(tenant, id);
  }

  @Patch(':id')
  @RequirePermissions('vertical:write')
  @ApiOperation({ summary: 'Update a custom vertical' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateVerticalInputSchema)) body: UpdateVerticalInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.verticals.update(tenant, principal, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('vertical:write')
  @ApiOperation({ summary: 'Archive (soft-delete) a custom vertical' })
  async archive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.verticals.archive(tenant, principal, id);
  }
}
