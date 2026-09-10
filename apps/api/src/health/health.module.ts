import { Module } from '@nestjs/common';

import { OpsService } from '../ops/ops.service';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/** Prisma/Redis come from the global InfraModule. */
@Module({
  controllers: [HealthController],
  providers: [HealthService, OpsService],
})
export class HealthModule {}
