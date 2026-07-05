import { Module } from '@nestjs/common';

import { HealthModule } from './health/health.module';
import { MetaController } from './meta/meta.controller';

@Module({
  imports: [HealthModule],
  controllers: [MetaController],
})
export class AppModule {}
