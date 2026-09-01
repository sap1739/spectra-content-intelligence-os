import { Module } from '@nestjs/common';

import { UsageController } from './usage.controller';
import { UsageReportService } from './usage.service';

@Module({
  controllers: [UsageController],
  providers: [UsageReportService],
})
export class UsageModule {}
