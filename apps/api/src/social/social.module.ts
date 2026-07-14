import { Module } from '@nestjs/common';
import { socialPublisherRegistry } from '@spectra/social-core';
import { registerWordPressAdapter } from '@spectra/social-wordpress';

import { SocialAccountsController, SocialController } from './social.controller';
import { SocialService } from './social.service';

// Advertise the platforms that have a real adapter, so GET /social/platforms
// honestly reports WordPress as wired. The worker builds a per-account publisher
// at publish time; here we only surface the capability signal.
registerWordPressAdapter(socialPublisherRegistry);

@Module({
  controllers: [SocialController, SocialAccountsController],
  providers: [SocialService],
})
export class SocialModule {}
