import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createWorkspaceInputSchema,
  updateOrganizationInputSchema,
  updateUserPreferencesInputSchema,
  updateWorkspaceInputSchema,
  type CreateWorkspaceInput,
  type UpdateOrganizationInput,
  type UpdateUserPreferencesInput,
  type UpdateWorkspaceInput,
} from '@spectra/contracts';

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

  @Patch('workspaces/:workspaceId')
  @RequirePermissions('workspace:manage')
  @ApiOperation({
    summary: 'Update workspace name, description or display timezone',
    description: 'Timezone is display-only; all timestamps remain stored in UTC.',
  })
  updateWorkspace(
    @Param('workspaceId', ParseUUIDPipe) _workspaceId: string,
    @Body(new ZodValidationPipe(updateWorkspaceInputSchema)) body: UpdateWorkspaceInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.tenancy.updateWorkspace(tenant, principal, body);
  }

  @Patch('organizations/:organizationId')
  @RequirePermissions('org:manage')
  @ApiOperation({
    summary: 'Rename the organization',
    description:
      'Only the name is editable — the organization record has no timezone or other settings columns.',
  })
  updateOrganization(
    @Param('organizationId', ParseUUIDPipe) _organizationId: string,
    @Body(new ZodValidationPipe(updateOrganizationInputSchema)) body: UpdateOrganizationInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.tenancy.updateOrganization(tenant, principal, body);
  }

  @Patch('me/preferences')
  @ApiOperation({
    summary: 'Update the caller’s own display name, timezone and locale',
    description: 'Always scoped to the authenticated user; never another account.',
  })
  updatePreferences(
    @Body(new ZodValidationPipe(updateUserPreferencesInputSchema))
    body: UpdateUserPreferencesInput,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.tenancy.updateUserPreferences(principal, body);
  }
}
