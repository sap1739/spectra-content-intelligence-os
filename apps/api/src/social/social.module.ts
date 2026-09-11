import { Module } from '@nestjs/common';
import { socialPublisherRegistry } from '@spectra/social-core';
import { registerWordPressAdapter } from '@spectra/social-wordpress';

import { ConnectionsService } from './oauth/connections.service';
import { OAuthCallbackController, SocialOAuthController } from './oauth/oauth.controller';
import { OAuthConfigService } from './oauth/oauth-config.service';
import { OAuthService } from './oauth/oauth.service';
import { SocialAdaptersService } from './social-adapters.service';
import { SocialAccountsController, SocialController } from './social.controller';
import { SocialService } from './social.service';

// Advertise the platforms that have a real adapter, so GET /social/platforms
// honestly reports WordPress as wired. The worker builds a per-account publisher
// at publish time; here we only surface the capability signal.
registerWordPressAdapter(socialPublisherRegistry);

@Module({
  controllers: [
    SocialController,
    SocialAccountsController,
    SocialOAuthController,
    OAuthCallbackController,
  ],
  providers: [
    SocialAdaptersService,
    SocialService,
    OAuthConfigService,
    OAuthService,
    ConnectionsService,
  ],
})
export class SocialModule {}
