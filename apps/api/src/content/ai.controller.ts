import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../auth/decorators';
import { AiTextService } from '../infra/ai.service';

/**
 * Honest AI capability status. Drives the UI availability state so the app
 * never implies generation works when no provider is configured.
 */
@ApiTags('content')
@Controller({ path: 'workspaces/:workspaceId/ai', version: '1' })
export class AiStatusController {
  constructor(private readonly ai: AiTextService) {}

  @Get('status')
  @RequirePermissions('content:read')
  @ApiOperation({ summary: 'Whether AI text generation is configured (no secrets exposed)' })
  status() {
    return this.ai.status();
  }
}
