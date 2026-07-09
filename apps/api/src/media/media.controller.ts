import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { processImageInputSchema, type ProcessImageInput } from '@spectra/contracts';
import type { FastifyReply } from 'fastify';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MediaService } from './media.service';
import type { Principal, TenantContext } from '../auth/types';

@ApiTags('media')
@Controller({ path: 'workspaces/:workspaceId/media', version: '1' })
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get('status')
  @RequirePermissions('media:read')
  @ApiOperation({
    summary: 'Which media renderers are available (image real; video/audio not yet)',
  })
  status() {
    return this.media.status();
  }

  @Get()
  @RequirePermissions('media:read')
  @ApiOperation({ summary: 'List media assets in the workspace' })
  list(@CurrentTenant() tenant: TenantContext) {
    return this.media.list(tenant);
  }

  @Post('images')
  @RequirePermissions('media:write')
  @ApiOperation({ summary: 'Process an image through a sharp pipeline; stores a derived asset' })
  process(
    @Body(new ZodValidationPipe(processImageInputSchema)) body: ProcessImageInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.media.processImage(tenant, principal, body);
  }

  @Get(':assetId/content')
  @RequirePermissions('media:read')
  @ApiOperation({ summary: 'Stream the bytes of a media asset' })
  async content(
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @CurrentTenant() tenant: TenantContext,
    @Res() reply: FastifyReply,
  ) {
    const { buffer, mimeType } = await this.media.getContent(tenant, assetId);
    await reply
      .header('content-type', mimeType)
      .header('cache-control', 'private, max-age=300')
      .send(buffer);
  }
}
