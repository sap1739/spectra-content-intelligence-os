import { Injectable, type OnModuleInit } from '@nestjs/common';
import { publicMediaLinkProblem } from '@spectra/publishing';
import { accountDiscoveryRegistry, socialPublisherRegistry } from '@spectra/social-core';
import { linkedInApiOptionsFromEnv, registerLinkedInAdapter } from '@spectra/social-linkedin';
import { metaGraphOptionsFromEnv, registerMetaAdapters } from '@spectra/social-meta';
import { resolveOAuthPlatform } from '@spectra/social-oauth';
import { pinterestApiOptionsFromEnv, registerPinterestAdapter } from '@spectra/social-pinterest';
import { registerThreadsAdapter, threadsApiOptionsFromEnv } from '@spectra/social-threads';
import { registerTikTokAdapter, tikTokApiOptionsFromEnv } from '@spectra/social-tiktok';
import { registerXAdapter, xApiOptionsFromEnv } from '@spectra/social-x';
import { registerYouTubeAdapter, youTubeApiOptionsFromEnv } from '@spectra/social-youtube';

import { getApiEnv } from '../config/env';

/**
 * Registers the platform adapters this deployment runs (ADR-0035, ADR-0036,
 * ADR-0037, ADR-0038).
 * Done at module init rather than import time, so the adapters see the
 * validated environment the app was created with.
 */
@Injectable()
export class SocialAdaptersService implements OnModuleInit {
  onModuleInit(): void {
    const env = getApiEnv();
    const registries = { publishers: socialPublisherRegistry, discovery: accountDiscoveryRegistry };
    registerLinkedInAdapter(registries, linkedInApiOptionsFromEnv(env));
    const facebook = resolveOAuthPlatform(env, 'FACEBOOK');
    registerMetaAdapters(
      registries,
      metaGraphOptionsFromEnv(env, facebook.configured ? facebook.config.clientSecret : null),
    );
    registerYouTubeAdapter(registries, youTubeApiOptionsFromEnv(env));
    registerTikTokAdapter(registries, tikTokApiOptionsFromEnv(env));
    // Threads and Pinterest fetch images from a link to this deployment's
    // storage, so discovery reports up front when that is impossible — in each
    // platform's own name, since the operator reads it on that platform's card.
    registerThreadsAdapter(
      registries,
      threadsApiOptionsFromEnv(env, publicMediaLinkProblem(env.STORAGE_ENDPOINT, 'Threads')),
    );
    registerXAdapter(registries, xApiOptionsFromEnv(env));
    registerPinterestAdapter(
      registries,
      pinterestApiOptionsFromEnv(env, publicMediaLinkProblem(env.STORAGE_ENDPOINT, 'Pinterest')),
    );
  }
}
