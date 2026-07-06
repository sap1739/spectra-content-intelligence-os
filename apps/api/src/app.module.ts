import { Module } from '@nestjs/common';

import { AuthModule } from './auth/auth.module';
import { BrandsModule } from './brands/brands.module';
import { HealthModule } from './health/health.module';
import { InfraModule } from './infra/infra.module';
import { MetaController } from './meta/meta.controller';
import { ResearchProjectsModule } from './research-projects/research-projects.module';
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
  ],
  controllers: [MetaController],
})
export class AppModule {}
