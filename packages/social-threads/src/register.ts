import type { AccountDiscoveryRegistry, SocialPublisherRegistry } from '@spectra/social-core';

import type { ThreadsApiOptions } from './client';
import {
  DEFAULT_THREADS_API_BASE_URL,
  THREADS_API_VERSION,
  THREADS_PLATFORM,
  THREADS_PUBLISHING_SUMMARY,
} from './constants';
import { ThreadsAccountDiscovery } from './discovery';

export interface ThreadsAdapterOptions extends ThreadsApiOptions {
  /** Why Threads cannot fetch images from this deployment, or null. */
  mediaProblem?: string | null;
}

export function threadsApiOptionsFromEnv(
  env: { THREADS_API_BASE_URL?: string | undefined; THREADS_API_VERSION?: string | undefined },
  mediaProblem: string | null = null,
): ThreadsAdapterOptions {
  return {
    apiBaseUrl: env.THREADS_API_BASE_URL ?? DEFAULT_THREADS_API_BASE_URL,
    version: env.THREADS_API_VERSION ?? THREADS_API_VERSION,
    mediaProblem,
  };
}

/**
 * Marks Threads publishing as wired (with a one-line summary of exactly what
 * it can post) and registers profile discovery. Publishers are built per
 * account at publish time, from that connection's own token.
 */
export function registerThreadsAdapter(
  registries: { publishers: SocialPublisherRegistry; discovery: AccountDiscoveryRegistry },
  options: ThreadsAdapterOptions,
): void {
  registries.publishers.markWired(THREADS_PLATFORM, THREADS_PUBLISHING_SUMMARY);
  registries.discovery.register(new ThreadsAccountDiscovery(options));
}
