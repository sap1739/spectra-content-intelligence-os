import { Module } from '@nestjs/common';

import { AiStatusController } from './ai.controller';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';
import { WorkspaceEvidencePacksController } from './evidence-packs.controller';

@Module({
  controllers: [ContentController, AiStatusController, WorkspaceEvidencePacksController],
  providers: [ContentService],
})
export class ContentModule {}
