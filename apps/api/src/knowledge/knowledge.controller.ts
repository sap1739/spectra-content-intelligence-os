import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { TenantContext } from '../auth/types';
import { KnowledgeService } from './knowledge.service';

const querySchema = z.string().min(2).max(500);
const topKSchema = z.coerce.number().int().min(1).max(50).default(10);

@ApiTags('knowledge')
@Controller({ path: 'workspaces/:workspaceId/knowledge', version: '1' })
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get('search')
  @RequirePermissions('knowledge:read')
  @ApiOperation({
    summary:
      'Hybrid search over embedded research findings (pgvector). Semantic when VOYAGE_API_KEY is set, otherwise first-party lexical — the response `retrieval` field states which (ADR-0023).',
  })
  search(
    @Param('workspaceId', ParseUUIDPipe) _workspaceId: string,
    @Query('q', new ZodValidationPipe(querySchema)) q: string,
    @Query('topK', new ZodValidationPipe(topKSchema)) topK: number,
    @CurrentTenant() tenant: TenantContext,
  ) {
    return this.knowledge.search(tenant, q, topK);
  }

  @Get('status')
  @RequirePermissions('knowledge:read')
  @ApiOperation({
    summary:
      'Active retrieval mode (semantic vs lexical) and how much of the workspace is actually indexed in that collection.',
  })
  status(
    @Param('workspaceId', ParseUUIDPipe) _workspaceId: string,
    @CurrentTenant() tenant: TenantContext,
  ) {
    return this.knowledge.status(tenant);
  }

  @Post('reembed')
  @RequirePermissions('knowledge:write')
  @ApiOperation({
    summary:
      'Backfill the active embedding collection. Required after changing embedding model, otherwise existing findings are absent from search.',
  })
  reembed(
    @Param('workspaceId', ParseUUIDPipe) _workspaceId: string,
    @CurrentTenant() tenant: TenantContext,
  ) {
    return this.knowledge.reembed(tenant);
  }
}
