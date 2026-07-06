import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/** Prisma/Redis come from the global InfraModule. */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
