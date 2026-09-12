import type { AccountDiscoveryRegistry, SocialPublisherRegistry } from '@spectra/social-core';

import type { PinterestApiOptions } from './client';
import {
  DEFAULT_PINTEREST_API_BASE_URL,
  PINTEREST_API_VERSION,
  PINTEREST_PLATFORM,
  PINTEREST_PUBLISHING_SUMMARY,
} from './constants';
import { PinterestAccountDiscovery } from './discovery';

export interface PinterestAdapterOptions extends PinterestApiOptions {
  /** Why Pinterest cannot fetch images from this deployment, or null. */
  mediaProblem?: string | null;
}

export function pinterestApiOptionsFromEnv(
  env: { PINTEREST_API_BASE_URL?: string | undefined; PINTEREST_API_VERSION?: string | undefined },
  mediaProblem: string | null = null,
): PinterestAdapterOptions {
  return {
    apiBaseUrl: env.PINTEREST_API_BASE_URL ?? DEFAULT_PINTEREST_API_BASE_URL,
    version: env.PINTEREST_API_VERSION ?? PINTEREST_API_VERSION,
    mediaProblem,
  };
}

/**
 * Marks Pinterest publishing as wired (with a one-line summary of exactly what
 * it can post) and registers board discovery. Publishers are built per board at
 * publish time, from that connection's own token.
 */
export function registerPinterestAdapter(
  registries: { publishers: SocialPublisherRegistry; discovery: AccountDiscoveryRegistry },
  options: PinterestAdapterOptions,
): void {
  registries.publishers.markWired(PINTEREST_PLATFORM, PINTEREST_PUBLISHING_SUMMARY);
  registries.discovery.register(new PinterestAccountDiscovery(options));
}
