import { Injectable, type OnModuleInit } from '@nestjs/common';
import { accountDiscoveryRegistry, socialPublisherRegistry } from '@spectra/social-core';
import { linkedInApiOptionsFromEnv, registerLinkedInAdapter } from '@spectra/social-linkedin';

import { getApiEnv } from '../config/env';

/**
 * Registers the platform adapters this deployment runs (ADR-0035). Done at
 * module init rather than import time, so the adapters see the validated
 * environment the app was created with.
 */
@Injectable()
export class SocialAdaptersService implements OnModuleInit {
  onModuleInit(): void {
    registerLinkedInAdapter(
      { publishers: socialPublisherRegistry, discovery: accountDiscoveryRegistry },
      linkedInApiOptionsFromEnv(getApiEnv()),
    );
  }
}
