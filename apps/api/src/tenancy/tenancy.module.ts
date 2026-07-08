import { Module } from '@nestjs/common';

import { TeamController } from './team.controller';
import { TenancyController } from './tenancy.controller';
import { TenancyService } from './tenancy.service';

@Module({
  controllers: [TenancyController, TeamController],
  providers: [TenancyService],
})
export class TenancyModule {}
