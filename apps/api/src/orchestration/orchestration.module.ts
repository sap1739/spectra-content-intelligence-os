import { Module } from '@nestjs/common';

import { OrchestrationController } from './orchestration.controller';
import { OrchestrationService } from './orchestration.service';

@Module({
  controllers: [OrchestrationController],
  providers: [OrchestrationService],
  exports: [OrchestrationService],
})
export class OrchestrationModule {}
