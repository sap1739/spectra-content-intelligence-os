import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createDesignInputSchema,
  createDesignTemplateInputSchema,
  designReviewInputSchema,
  exportDesignInputSchema,
  updateDesignInputSchema,
  updateDesignTemplateInputSchema,
  type CreateDesignInput,
  type CreateDesignTemplateInput,
  type DesignReviewInput,
  type ExportDesignInput,
  type UpdateDesignInput,
  type UpdateDesignTemplateInput,
} from '@spectra/contracts';
import type { FastifyReply } from 'fastify';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { StudioService } from './studio.service';
import type { Principal, TenantContext } from '../auth/types';

@ApiTags('studio')
@Controller({ path: 'workspaces/:workspaceId/studio', version: '1' })
export class StudioController {
  constructor(private readonly studio: StudioService) {}

  @Get('capabilities')
  @RequirePermissions('design:read')
  @ApiOperation({
    summary:
      'What the design renderer does (and does not): engine, outputs, fonts, no AI image generation',
  })
  capabilities() {
    return this.studio.capabilities();
  }

  @Get('formats')
  @RequirePermissions('design:read')
  @ApiOperation({ summary: 'Output sizes: platform presets and print sizes' })
  formats() {
    return this.studio.formats();
  }

  @Get('templates')
  @RequirePermissions('design:read')
  @ApiOperation({ summary: 'Built-in and workspace visual templates' })
  templates(@CurrentTenant() tenant: TenantContext) {
    return this.studio.listTemplates(tenant);
  }

  @Get('templates/:templateId')
  @RequirePermissions('design:read')
  template(@CurrentTenant() tenant: TenantContext, @Param('templateId', ParseUUIDPipe) id: string) {
    return this.studio.getTemplate(tenant, id);
  }

  @Post('templates')
  @RequirePermissions('design:write')
  @ApiOperation({ summary: 'Create a workspace template from a layout or a copy of a built-in' })
  createTemplate(
    @Body(new ZodValidationPipe(createDesignTemplateInputSchema)) body: CreateDesignTemplateInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.studio.createTemplate(tenant, principal, body);
  }

  @Patch('templates/:templateId')
  @RequirePermissions('design:write')
  @ApiOperation({ summary: 'Update a workspace template (a layout change bumps its version)' })
  updateTemplate(
    @Param('templateId', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateDesignTemplateInputSchema)) body: UpdateDesignTemplateInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.studio.updateTemplate(tenant, principal, id, body);
  }

  @Delete('templates/:templateId')
  @RequirePermissions('design:write')
  archiveTemplate(
    @Param('templateId', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.studio.archiveTemplate(tenant, principal, id);
  }

  @Get('designs')
  @RequirePermissions('design:read')
  @ApiOperation({ summary: 'List designs, optionally for one content item or campaign' })
  designs(
    @CurrentTenant() tenant: TenantContext,
    @Query('contentItemId', new ParseUUIDPipe({ optional: true })) contentItemId?: string,
    @Query('campaignId', new ParseUUIDPipe({ optional: true })) campaignId?: string,
  ) {
    return this.studio.listDesigns(tenant, {
      ...(contentItemId ? { contentItemId } : {}),
      ...(campaignId ? { campaignId } : {}),
    });
  }

  @Get('designs/:designId')
  @RequirePermissions('design:read')
  design(@CurrentTenant() tenant: TenantContext, @Param('designId', ParseUUIDPipe) id: string) {
    return this.studio.getDesign(tenant, id);
  }

  @Post('designs')
  @RequirePermissions('design:write')
  @ApiOperation({ summary: 'Create a design from a template for a brand and output size' })
  createDesign(
    @Body(new ZodValidationPipe(createDesignInputSchema)) body: CreateDesignInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.studio.createDesign(tenant, principal, body);
  }

  @Patch('designs/:designId')
  @RequirePermissions('design:write')
  @ApiOperation({ summary: 'Edit a design (changing visuals returns an approved design to draft)' })
  updateDesign(
    @Param('designId', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateDesignInputSchema)) body: UpdateDesignInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.studio.updateDesign(tenant, principal, id, body);
  }

  @Delete('designs/:designId')
  @RequirePermissions('design:write')
  archiveDesign(
    @Param('designId', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.studio.archiveDesign(tenant, principal, id);
  }

  @Get('designs/:designId/preview')
  @RequirePermissions('design:read')
  @ApiOperation({ summary: 'A real PNG render of one page, scaled for the editor (not stored)' })
  async preview(
    @Param('designId', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
    @Res() reply: FastifyReply,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
  ) {
    const result = await this.studio.preview(tenant, id, page ?? 0);
    await reply
      .header('content-type', 'image/png')
      .header('cache-control', 'private, no-store')
      .header('x-design-page-count', String(result.pageCount))
      .header('x-design-warnings', encodeURIComponent(JSON.stringify(result.warnings)))
      .send(result.buffer);
  }

  @Post('designs/:designId/exports')
  @HttpCode(201)
  @RequirePermissions('design:write')
  @ApiOperation({
    summary: 'Render and store PNG/JPEG pages or a PDF (idempotent for unchanged inputs)',
  })
  exportDesign(
    @Param('designId', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(exportDesignInputSchema)) body: ExportDesignInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.studio.exportDesign(tenant, principal, id, body);
  }

  @Get('renders/:renderId/url')
  @RequirePermissions('design:read')
  @ApiOperation({ summary: 'A 15-minute signed download URL for an export' })
  renderUrl(@Param('renderId', ParseUUIDPipe) id: string, @CurrentTenant() tenant: TenantContext) {
    return this.studio.renderUrl(tenant, id);
  }

  @Post('designs/:designId/submit')
  @RequirePermissions('design:write')
  @ApiOperation({ summary: 'Submit a draft design (with at least one export) for review' })
  submit(
    @Param('designId', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.studio.submit(tenant, principal, id);
  }

  @Post('designs/:designId/approve')
  @RequirePermissions('content:approve')
  @ApiOperation({ summary: 'Approve a design in review' })
  approve(
    @Param('designId', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(designReviewInputSchema)) body: DesignReviewInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.studio.approve(tenant, principal, id, body);
  }

  @Post('designs/:designId/request-changes')
  @RequirePermissions('content:approve')
  @ApiOperation({ summary: 'Send a design back to draft with a note' })
  requestChanges(
    @Param('designId', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(designReviewInputSchema)) body: DesignReviewInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.studio.requestChanges(tenant, principal, id, body);
  }
}
