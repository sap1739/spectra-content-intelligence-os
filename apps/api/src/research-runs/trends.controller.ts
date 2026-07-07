import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentTenant, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../auth/types';

@ApiTags('trends')
@Controller({ path: 'workspaces/:workspaceId/trends', version: '1' })
export class TrendsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermissions('trend:read')
  @ApiOperation({ summary: 'Trend candidates for the workspace, best score first' })
  list(
    @Param('workspaceId', ParseUUIDPipe) _workspaceId: string,
    @CurrentTenant() tenant: TenantContext,
  ) {
    return this.prisma.client.trendCandidate.findMany({
      where: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        deletedAt: null,
      },
      orderBy: [{ normalizedScore: { sort: 'desc', nulls: 'last' } }, { lastSeenAt: 'desc' }],
      take: 100,
    });
  }
}
