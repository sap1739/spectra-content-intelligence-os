import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ClaimsService } from '../claims/claims.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../auth/types';

@ApiTags('research')
@Controller({ path: 'workspaces/:workspaceId/research-projects/:projectId', version: '1' })
export class EvidenceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly claims: ClaimsService,
  ) {}

  @Get('evidence-packs')
  @RequirePermissions('research:read')
  @ApiOperation({ summary: 'Evidence packs for a project (one per trend topic)' })
  listPacks(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentTenant() tenant: TenantContext,
  ) {
    return this.prisma.client.evidencePack.findMany({
      where: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        projectId,
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
  }

  @Get('claims')
  @RequirePermissions('research:read')
  @ApiOperation({
    summary: 'Verified claims for a project, with corroboration and contradictions',
    description:
      'Independent-source counts collapse syndicated copies, so repetition of one story does not read as corroboration (ADR-0032). Optional `eligibility` filter.',
  })
  listClaims(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentTenant() tenant: TenantContext,
    @Query('eligibility') eligibility?: string,
  ) {
    return this.claims.list(tenant, projectId, eligibility);
  }
}
