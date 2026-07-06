import { Module } from '@nestjs/common';

import { VerticalsController } from './verticals.controller';
import { VerticalsService } from './verticals.service';

@Module({
  controllers: [VerticalsController],
  providers: [VerticalsService],
})
export class VerticalsModule {}
