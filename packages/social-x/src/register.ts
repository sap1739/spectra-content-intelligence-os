import type { AccountDiscoveryRegistry, SocialPublisherRegistry } from '@spectra/social-core';

import type { XApiOptions } from './client';
import { DEFAULT_X_API_BASE_URL, X_PLATFORM, X_PUBLISHING_SUMMARY } from './constants';
import { XAccountDiscovery } from './discovery';

export function xApiOptionsFromEnv(env: { X_API_BASE_URL?: string | undefined }): XApiOptions {
  return { apiBaseUrl: env.X_API_BASE_URL ?? DEFAULT_X_API_BASE_URL };
}

/**
 * Marks X publishing as wired (with a one-line summary of exactly what it can
 * post) and registers account discovery. Publishers are built per account at
 * publish time, from that connection's own token.
 */
export function registerXAdapter(
  registries: { publishers: SocialPublisherRegistry; discovery: AccountDiscoveryRegistry },
  options: XApiOptions,
): void {
  registries.publishers.markWired(X_PLATFORM, X_PUBLISHING_SUMMARY);
  registries.discovery.register(new XAccountDiscovery(options));
}
