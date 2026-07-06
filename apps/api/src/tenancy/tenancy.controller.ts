import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createWorkspaceInputSchema, type CreateWorkspaceInput } from '@spectra/contracts';

import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import type { Principal, TenantContext } from '../auth/types';
import { TenancyService } from './tenancy.service';

@ApiTags('tenancy')
@Controller({ version: '1' })
export class TenancyController {
  constructor(private readonly tenancy: TenancyService) {}

  @Get('organizations')
  @ApiOperation({ summary: 'Organizations the caller belongs to' })
  listOrganizations(@CurrentPrincipal() principal: Principal) {
    return principal.memberships.map((m) => ({
      id: m.organizationId,
      name: m.organizationName,
      slug: m.organizationSlug,
      role: m.role,
    }));
  }

  @Get('organizations/:organizationId/workspaces')
  @ApiOperation({ summary: 'Workspaces in an organization visible to the caller' })
  listWorkspaces(
    @Param('organizationId', ParseUUIDPipe) _organizationId: string,
    @CurrentTenant() tenant: TenantContext,
  ) {
    return this.tenancy.listWorkspaces(tenant);
  }

  @Post('organizations/:organizationId/workspaces')
  @RequirePermissions('workspace:manage')
  @ApiOperation({ summary: 'Create a workspace' })
  createWorkspace(
    @Param('organizationId', ParseUUIDPipe) _organizationId: string,
    @Body(new ZodValidationPipe(createWorkspaceInputSchema)) body: CreateWorkspaceInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.tenancy.createWorkspace(tenant, principal, body);
  }
}
