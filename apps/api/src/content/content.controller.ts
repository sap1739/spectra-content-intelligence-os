import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createContentItemInputSchema,
  generateDraftInputSchema,
  reviewNoteInputSchema,
  updateContentBodyInputSchema,
  type CreateContentItemInput,
  type GenerateDraftInput,
  type ReviewNoteInput,
  type UpdateContentBodyInput,
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

  @Patch(':contentItemId')
  @RequirePermissions('content:write')
  @ApiOperation({ summary: 'Human edit — replace the body; moves the item to EDITING' })
  edit(
    @Param('contentItemId', ParseUUIDPipe) contentItemId: string,
    @Body(new ZodValidationPipe(updateContentBodyInputSchema)) body: UpdateContentBodyInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.content.updateBody(tenant, principal, contentItemId, body);
  }

  @Post(':contentItemId/submit')
  @RequirePermissions('content:write')
  @ApiOperation({ summary: 'Submit the item for review' })
  submit(
    @Param('contentItemId', ParseUUIDPipe) contentItemId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.content.submitForReview(tenant, principal, contentItemId);
  }

  @Post(':contentItemId/approve')
  @RequirePermissions('content:approve')
  @ApiOperation({ summary: 'Approve — moderated first (422 if flagged); honest SKIPPED if no AI' })
  approve(
    @Param('contentItemId', ParseUUIDPipe) contentItemId: string,
    @Body(new ZodValidationPipe(reviewNoteInputSchema)) body: ReviewNoteInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.content.approve(tenant, principal, contentItemId, body);
  }

  @Post(':contentItemId/request-changes')
  @RequirePermissions('content:review')
  @ApiOperation({ summary: 'Send the item back for changes' })
  requestChanges(
    @Param('contentItemId', ParseUUIDPipe) contentItemId: string,
    @Body(new ZodValidationPipe(reviewNoteInputSchema)) body: ReviewNoteInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.content.requestChanges(tenant, principal, contentItemId, body);
  }

  @Post(':contentItemId/reject')
  @RequirePermissions('content:review')
  @ApiOperation({ summary: 'Reject the item (archives it)' })
  reject(
    @Param('contentItemId', ParseUUIDPipe) contentItemId: string,
    @Body(new ZodValidationPipe(reviewNoteInputSchema)) body: ReviewNoteInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.content.reject(tenant, principal, contentItemId, body);
  }
}
