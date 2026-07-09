import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { scheduleEntryInputSchema, type ScheduleEntryInput } from '@spectra/contracts';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CalendarService } from './calendar.service';
import type { Principal, TenantContext } from '../auth/types';

@ApiTags('content')
@Controller({ path: 'workspaces/:workspaceId/calendar', version: '1' })
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get()
  @RequirePermissions('content:read')
  @ApiOperation({ summary: 'List calendar entries (optionally within a UTC window)' })
  list(
    @CurrentTenant() tenant: TenantContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.calendar.list(tenant, from, to);
  }

  @Post()
  @RequirePermissions('content:write')
  @ApiOperation({ summary: 'Schedule an approved content item onto the calendar' })
  schedule(
    @Body(new ZodValidationPipe(scheduleEntryInputSchema)) body: ScheduleEntryInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.calendar.schedule(tenant, principal, body);
  }

  @Delete(':entryId')
  @RequirePermissions('content:write')
  @ApiOperation({ summary: 'Cancel a scheduled calendar entry' })
  cancel(
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.calendar.cancel(tenant, principal, entryId);
  }
}
