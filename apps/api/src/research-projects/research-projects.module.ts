import { Module } from '@nestjs/common';

import { ResearchProjectsController } from './research-projects.controller';
import { ResearchProjectsService } from './research-projects.service';

@Module({
  controllers: [ResearchProjectsController],
  providers: [ResearchProjectsService],
})
export class ResearchProjectsModule {}
