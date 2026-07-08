import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ContentService } from './content.service';
import type { TenantContext } from '../auth/types';

/** Workspace-wide READY evidence packs — the grounding menu for content drafting. */
@ApiTags('content')
@Controller({ path: 'workspaces/:workspaceId/evidence-packs', version: '1' })
export class WorkspaceEvidencePacksController {
  constructor(private readonly content: ContentService) {}

  @Get()
  @RequirePermissions('content:read')
  @ApiOperation({ summary: 'List READY evidence packs available to ground content on' })
  list(@CurrentTenant() tenant: TenantContext) {
    return this.content.listEvidencePacks(tenant);
  }
}
