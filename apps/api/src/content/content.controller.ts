import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createContentItemInputSchema,
  generateDraftInputSchema,
  type CreateContentItemInput,
  type GenerateDraftInput,
} from '@spectra/contracts';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ContentService } from './content.service';
import type { Principal, TenantContext } from '../auth/types';

@ApiTags('content')
@Controller({ path: 'workspaces/:workspaceId/content-items', version: '1' })
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Get()
  @RequirePermissions('content:read')
  @ApiOperation({ summary: 'List content items in the workspace' })
  list(@CurrentTenant() tenant: TenantContext) {
    return this.content.list(tenant);
  }

  @Post()
  @RequirePermissions('content:write')
  @ApiOperation({ summary: 'Create a content item, optionally grounded on an evidence pack' })
  create(
    @Body(new ZodValidationPipe(createContentItemInputSchema)) body: CreateContentItemInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.content.create(tenant, principal, body);
  }

  @Get(':contentItemId')
  @RequirePermissions('content:read')
  @ApiOperation({ summary: 'Get a content item with its drafts' })
  get(
    @Param('contentItemId', ParseUUIDPipe) contentItemId: string,
    @CurrentTenant() tenant: TenantContext,
  ) {
    return this.content.get(tenant, contentItemId);
  }

  @Get(':contentItemId/drafts')
  @RequirePermissions('content:read')
  @ApiOperation({ summary: 'List generated drafts for a content item' })
  drafts(
    @Param('contentItemId', ParseUUIDPipe) contentItemId: string,
    @CurrentTenant() tenant: TenantContext,
  ) {
    return this.content.listDrafts(tenant, contentItemId);
  }

  @Post(':contentItemId/drafts')
  @RequirePermissions('content:write')
  @ApiOperation({
    summary:
      'Generate an evidence-grounded draft. 503 when AI is unconfigured — never fabricated text.',
  })
  generate(
    @Param('contentItemId', ParseUUIDPipe) contentItemId: string,
    @Body(new ZodValidationPipe(generateDraftInputSchema)) body: GenerateDraftInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.content.generate(tenant, principal, contentItemId, body);
  }
}
