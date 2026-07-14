import { Module } from '@nestjs/common';

import { SocialAccountsController, SocialController } from './social.controller';
import { SocialService } from './social.service';

@Module({
  controllers: [SocialController, SocialAccountsController],
  providers: [SocialService],
})
export class SocialModule {}
