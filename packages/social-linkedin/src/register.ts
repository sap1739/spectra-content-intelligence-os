import type { AccountDiscoveryRegistry, SocialPublisherRegistry } from '@spectra/social-core';

import type { LinkedInApiOptions } from './client';
import {
  DEFAULT_LINKEDIN_API_BASE_URL,
  DEFAULT_LINKEDIN_API_VERSION,
  LINKEDIN_PLATFORM,
  LINKEDIN_PUBLISHING_SUMMARY,
} from './constants';
import { LinkedInAccountDiscovery } from './discovery';

export function linkedInApiOptionsFromEnv(env: {
  LINKEDIN_API_BASE_URL?: string | undefined;
  LINKEDIN_API_VERSION?: string | undefined;
}): LinkedInApiOptions {
  return {
    apiBaseUrl: env.LINKEDIN_API_BASE_URL ?? DEFAULT_LINKEDIN_API_BASE_URL,
    version: env.LINKEDIN_API_VERSION ?? DEFAULT_LINKEDIN_API_VERSION,
  };
}

/**
 * Marks LinkedIn publishing as wired (with a one-line summary of exactly what
 * it can post) and registers account discovery. Publishers themselves are
 * built per account at publish time, from that account's own grant.
 */
export function registerLinkedInAdapter(
  registries: { publishers: SocialPublisherRegistry; discovery: AccountDiscoveryRegistry },
  options: LinkedInApiOptions,
): void {
  registries.publishers.markWired(LINKEDIN_PLATFORM, LINKEDIN_PUBLISHING_SUMMARY);
  registries.discovery.register(new LinkedInAccountDiscovery(options));
}
