import { Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TenantIsolationError } from '@spectra/security';
import { z } from 'zod';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

const unacknowledgedSchema = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v === 'true');

@ApiTags('trends')
@Controller({ path: 'workspaces/:workspaceId/alerts', version: '1' })
export class AlertsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermissions('trend:read')
  @ApiOperation({ summary: 'Trend alerts for the workspace (newest first)' })
  list(
    @Param('workspaceId', ParseUUIDPipe) _workspaceId: string,
    @Query('unacknowledged', new ZodValidationPipe(unacknowledgedSchema))
    unacknowledgedOnly: boolean,
    @CurrentTenant() tenant: TenantContext,
  ) {
    return this.prisma.client.trendAlert.findMany({
      where: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        ...(unacknowledgedOnly ? { acknowledgedAt: null } : {}),
      },
      orderBy: { triggeredAt: 'desc' },
      take: 50,
      include: {
        trendCandidate: { select: { title: true, state: true, projectId: true } },
      },
    });
  }

  @Patch(':alertId/acknowledge')
  @RequirePermissions('trend:review')
  @ApiOperation({ summary: 'Acknowledge a trend alert' })
  async acknowledge(
    @Param('alertId', ParseUUIDPipe) alertId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    const alert = await this.prisma.client.trendAlert.findFirst({
      where: {
        id: alertId,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
      },
      select: { id: true },
    });
    if (!alert) throw new TenantIsolationError();
    return this.prisma.client.trendAlert.update({
      where: { id: alertId },
      data: { acknowledgedAt: new Date(), acknowledgedById: principal.userId },
    });
  }
}
