import { Module } from '@nestjs/common';

import { FindingsController } from './findings.controller';
import { FindingsService } from './findings.service';
import { ResearchRunsController } from './research-runs.controller';
import { ResearchRunsService } from './research-runs.service';
import { TrendsController } from './trends.controller';

@Module({
  controllers: [ResearchRunsController, FindingsController, TrendsController],
  providers: [ResearchRunsService, FindingsService],
})
export class ResearchRunsModule {}
