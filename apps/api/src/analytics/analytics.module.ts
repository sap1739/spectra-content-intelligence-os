import { Module } from '@nestjs/common';

import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { ExternalAnalyticsService } from './external-analytics.service';

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, ExternalAnalyticsService],
})
export class AnalyticsModule {}
