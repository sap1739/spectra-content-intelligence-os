import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
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
      'Hybrid lexical search over embedded research findings (pgvector). Lexical embeddings in Phase 2 — semantic models arrive in Phase 3 (ADR-0016).',
  })
  search(
    @Param('workspaceId', ParseUUIDPipe) _workspaceId: string,
    @Query('q', new ZodValidationPipe(querySchema)) q: string,
    @Query('topK', new ZodValidationPipe(topKSchema)) topK: number,
    @CurrentTenant() tenant: TenantContext,
  ) {
    return this.knowledge.search(tenant, q, topK);
  }
}
