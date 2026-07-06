import { Controller, Get, Res, VERSION_NEUTRAL } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { Public } from '../auth/decorators';
import { HealthService } from './health.service';

@ApiTags('health')
@Public()
// Probes are infrastructure endpoints — exempt from URI versioning.
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Liveness probe — no dependencies touched' })
  @ApiOkResponse({ description: 'Process is alive' })
  liveness() {
    return this.health.liveness();
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe — checks Postgres, Redis and worker heartbeat' })
  @ApiOkResponse({ description: 'All required dependencies reachable' })
  @ApiServiceUnavailableResponse({ description: 'A required dependency is down' })
  async readiness(@Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.health.readiness();
    reply.status(result.status === 'down' ? 503 : 200);
    return result;
  }
}
