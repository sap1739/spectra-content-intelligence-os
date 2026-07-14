import { Module } from '@nestjs/common';

import { AnalyticsModule } from './analytics/analytics.module';
import { AuthModule } from './auth/auth.module';
import { BrandsModule } from './brands/brands.module';
import { ContentModule } from './content/content.module';
import { HealthModule } from './health/health.module';
import { InfraModule } from './infra/infra.module';
import { MediaModule } from './media/media.module';
import { MetaController } from './meta/meta.controller';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { ResearchProjectsModule } from './research-projects/research-projects.module';
import { ResearchRunsModule } from './research-runs/research-runs.module';
import { SocialModule } from './social/social.module';
import { StrategyModule } from './strategy/strategy.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { VerticalsModule } from './verticals/verticals.module';

@Module({
  imports: [
    InfraModule,
    AuthModule,
    HealthModule,
    TenancyModule,
    VerticalsModule,
    BrandsModule,
    ResearchProjectsModule,
    ResearchRunsModule,
    KnowledgeModule,
    ContentModule,
    StrategyModule,
    MediaModule,
    SocialModule,
    AnalyticsModule,
  ],
  controllers: [MetaController],
})
export class AppModule {}
