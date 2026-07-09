import { Module } from '@nestjs/common';

import { AiStatusController } from './ai.controller';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';
import { WorkspaceEvidencePacksController } from './evidence-packs.controller';

@Module({
  controllers: [
    ContentController,
    AiStatusController,
    WorkspaceEvidencePacksController,
    CalendarController,
  ],
  providers: [ContentService, CalendarService],
})
export class ContentModule {}
