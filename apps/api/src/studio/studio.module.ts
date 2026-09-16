import { Module } from '@nestjs/common';

import { StudioController } from './studio.controller';
import { StudioService } from './studio.service';

@Module({
  controllers: [StudioController],
  providers: [StudioService],
  exports: [StudioService],
})
export class StudioModule {}
