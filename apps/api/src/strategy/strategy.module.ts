import { Module } from '@nestjs/common';

import { CampaignsController } from './campaigns.controller';
import { PersonasController, PillarsController, TopicIdeasController } from './strategy.controller';
import { StrategyService } from './strategy.service';

@Module({
  controllers: [CampaignsController, PersonasController, PillarsController, TopicIdeasController],
  providers: [StrategyService],
})
export class StrategyModule {}
