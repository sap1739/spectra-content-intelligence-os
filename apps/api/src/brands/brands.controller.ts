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
  createBrandInputSchema,
  updateBrandInputSchema,
  type CreateBrandInput,
  type UpdateBrandInput,
} from '@spectra/contracts';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { Principal, TenantContext } from '../auth/types';
import { BrandsService } from './brands.service';

@ApiTags('brands')
@Controller({ path: 'workspaces/:workspaceId/brands', version: '1' })
export class BrandsController {
  constructor(private readonly brands: BrandsService) {}

  @Get()
  @RequirePermissions('brand:read')
  @ApiOperation({ summary: 'List brands in the workspace' })
  list(@CurrentTenant() tenant: TenantContext) {
    return this.brands.list(tenant);
  }

  @Post()
  @RequirePermissions('brand:write')
  @ApiOperation({ summary: 'Create a brand' })
  create(
    @Body(new ZodValidationPipe(createBrandInputSchema)) body: CreateBrandInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.brands.create(tenant, principal, body);
  }

  @Get(':id')
  @RequirePermissions('brand:read')
  @ApiOperation({ summary: 'Get a brand' })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentTenant() tenant: TenantContext) {
    return this.brands.get(tenant, id);
  }

  @Patch(':id')
  @RequirePermissions('brand:write')
  @ApiOperation({ summary: 'Update a brand' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateBrandInputSchema)) body: UpdateBrandInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.brands.update(tenant, principal, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('brand:write')
  @ApiOperation({ summary: 'Archive (soft-delete) a brand' })
  async archive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.brands.archive(tenant, principal, id);
  }
}
