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
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createVideoProjectInputSchema,
  startVideoRenderInputSchema,
  updateVideoProjectInputSchema,
  type CreateVideoProjectInput,
  type StartVideoRenderInput,
  type UpdateVideoProjectInput,
} from '@spectra/contracts';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { VideoService } from './video.service';
import type { Principal, TenantContext } from '../auth/types';

@ApiTags('video')
@Controller({ path: 'workspaces/:workspaceId/video', version: '1' })
export class VideoController {
  constructor(private readonly video: VideoService) {}

  @Get('capabilities')
  @RequirePermissions('video:read')
  @ApiOperation({
    summary:
      'What the installed engine can render — and that Spectra composes video rather than generating it',
  })
  capabilities() {
    return this.video.capabilities();
  }

  @Get('formats')
  @RequirePermissions('video:read')
  @ApiOperation({ summary: 'Output sizes, frame rates and duration ceilings' })
  formats() {
    return this.video.formats();
  }

  @Get('projects')
  @RequirePermissions('video:read')
  @ApiOperation({ summary: 'Storyboards in this workspace, newest first' })
  listProjects(@CurrentTenant() tenant: TenantContext, @Query('status') status?: string) {
    return this.video.listProjects(tenant, status);
  }

  @Get('projects/:projectId')
  @RequirePermissions('video:read')
  @ApiOperation({ summary: 'One storyboard, its renders, and what a render would warn about' })
  getProject(
    @Param('projectId', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
  ) {
    return this.video.getProject(tenant, id);
  }

  @Post('projects')
  @HttpCode(201)
  @RequirePermissions('video:write')
  @ApiOperation({ summary: 'Create a storyboard; it is planned before it is stored' })
  createProject(
    @Body(new ZodValidationPipe(createVideoProjectInputSchema)) body: CreateVideoProjectInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.video.createProject(tenant, principal, body);
  }

  @Patch('projects/:projectId')
  @RequirePermissions('video:write')
  @ApiOperation({ summary: 'Edit a storyboard; finished renders keep their own snapshot' })
  updateProject(
    @Param('projectId', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateVideoProjectInputSchema)) body: UpdateVideoProjectInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.video.updateProject(tenant, principal, id, body);
  }

  @Delete('projects/:projectId')
  @RequirePermissions('video:write')
  @ApiOperation({ summary: 'Archive a storyboard' })
  archiveProject(
    @Param('projectId', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.video.archiveProject(tenant, principal, id);
  }

  @Post('projects/:projectId/renders')
  @HttpCode(202)
  @RequirePermissions('video:write')
  @ApiOperation({
    summary: 'Queue a render — budget-checked and capability-checked before the job exists',
  })
  startRender(
    @Param('projectId', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(startVideoRenderInputSchema)) body: StartVideoRenderInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.video.startRender(tenant, principal, id, body);
  }

  @Get('renders/:renderId')
  @RequirePermissions('video:read')
  @ApiOperation({ summary: 'A render’s status, progress and — if it failed — why' })
  getRender(@Param('renderId', ParseUUIDPipe) id: string, @CurrentTenant() tenant: TenantContext) {
    return this.video.getRender(tenant, id);
  }

  @Post('renders/:renderId/cancel')
  @RequirePermissions('video:write')
  @ApiOperation({ summary: 'Cancel a queued or running render' })
  cancelRender(
    @Param('renderId', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.video.cancelRender(tenant, principal, id);
  }

  @Get('renders/:renderId/url')
  @RequirePermissions('video:read')
  @ApiOperation({ summary: 'A 15-minute signed URL for the video, captions or poster frame' })
  renderUrl(
    @Param('renderId', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
    @Query('file') file?: string,
  ) {
    const which = file === 'captions' || file === 'poster' ? file : 'video';
    return this.video.renderUrl(tenant, id, which);
  }
}
