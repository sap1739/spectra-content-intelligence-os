import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createWatchlistInputSchema, type CreateWatchlistInput } from '@spectra/contracts';
import { TenantIsolationError } from '@spectra/security';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

@ApiTags('trends')
@Controller({ path: 'workspaces/:workspaceId/watchlists', version: '1' })
export class WatchlistsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('trend:read')
  @ApiOperation({ summary: 'Trend watchlists for the workspace' })
  list(@CurrentTenant() tenant: TenantContext) {
    return this.prisma.client.trendWatchlist.findMany({
      where: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  @Post()
  @RequirePermissions('trend:review')
  @ApiOperation({ summary: 'Create a watchlist — alerts when watched topics cross the threshold' })
  async create(
    @Body(new ZodValidationPipe(createWatchlistInputSchema)) body: CreateWatchlistInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    const watchlist = await this.prisma.client.trendWatchlist.create({
      data: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        name: body.name,
        keywords: body.keywords,
        threshold: body.threshold,
        createdById: principal.userId,
      },
    });
    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'watchlist.created',
      resourceType: 'TrendWatchlist',
      resourceId: watchlist.id,
      changes: { name: body.name, keywords: body.keywords, threshold: body.threshold },
    });
    return watchlist;
  }

  @Delete(':watchlistId')
  @HttpCode(204)
  @RequirePermissions('trend:review')
  @ApiOperation({ summary: 'Delete a watchlist' })
  async remove(
    @Param('watchlistId', ParseUUIDPipe) watchlistId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    const existing = await this.prisma.client.trendWatchlist.findFirst({
      where: {
        id: watchlistId,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
      },
      select: { id: true },
    });
    if (!existing) throw new TenantIsolationError();
    await this.prisma.client.trendWatchlist.delete({ where: { id: watchlistId } });
    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'watchlist.deleted',
      resourceType: 'TrendWatchlist',
      resourceId: watchlistId,
    });
  }
}
