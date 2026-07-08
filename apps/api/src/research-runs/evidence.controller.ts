import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentTenant, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../auth/types';

@ApiTags('research')
@Controller({ path: 'workspaces/:workspaceId/research-projects/:projectId', version: '1' })
export class EvidenceController {
  constructor(private readonly prisma: PrismaService) {}

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
  @ApiOperation({ summary: 'Extracted claims for a project (corroboration status included)' })
  listClaims(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentTenant() tenant: TenantContext,
  ) {
    return this.prisma.client.extractedClaim.findMany({
      where: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        projectId,
      },
      orderBy: [{ sourceCount: 'desc' }, { updatedAt: 'desc' }],
      take: 200,
    });
  }
}
