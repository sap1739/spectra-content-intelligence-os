import { Module } from '@nestjs/common';

import { ClaimsService } from '../claims/claims.service';

import { AlertsController } from './alerts.controller';
import { EvidenceController } from './evidence.controller';
import { FindingsController } from './findings.controller';
import { FindingsService } from './findings.service';
import { ResearchRunsController } from './research-runs.controller';
import { ResearchRunsService } from './research-runs.service';
import { TrendsController } from './trends.controller';
import { WatchlistsController } from './watchlists.controller';

@Module({
  controllers: [
    ResearchRunsController,
    FindingsController,
    TrendsController,
    EvidenceController,
    AlertsController,
    WatchlistsController,
  ],
  providers: [ResearchRunsService, FindingsService, ClaimsService],
})
export class ResearchRunsModule {}
