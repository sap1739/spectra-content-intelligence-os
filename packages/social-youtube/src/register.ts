import type { AccountDiscoveryRegistry, SocialPublisherRegistry } from '@spectra/social-core';

import type { YouTubeApiOptions } from './client';
import {
  DEFAULT_UPLOAD_CHUNK_BYTES,
  DEFAULT_YOUTUBE_API_BASE_URL,
  YOUTUBE_PLATFORM,
  YOUTUBE_PUBLISHING_SUMMARY,
} from './constants';
import { YouTubeAccountDiscovery } from './discovery';

export interface YouTubeAdapterOptions extends YouTubeApiOptions {
  /**
   * The operator's declaration that this deployment's Google Cloud project
   * passed the YouTube API Services audit. False (the default) means Google
   * may force uploads private, and every surface says so.
   */
  projectAudited: boolean;
  chunkBytes: number;
}

export function youTubeApiOptionsFromEnv(env: {
  YOUTUBE_API_BASE_URL?: string | undefined;
  YOUTUBE_API_PROJECT_AUDITED?: boolean | undefined;
  YOUTUBE_UPLOAD_CHUNK_BYTES?: number | undefined;
}): YouTubeAdapterOptions {
  return {
    apiBaseUrl: env.YOUTUBE_API_BASE_URL ?? DEFAULT_YOUTUBE_API_BASE_URL,
    projectAudited: env.YOUTUBE_API_PROJECT_AUDITED ?? false,
    chunkBytes: env.YOUTUBE_UPLOAD_CHUNK_BYTES ?? DEFAULT_UPLOAD_CHUNK_BYTES,
  };
}

/**
 * Marks YouTube publishing as wired (with a one-line summary of exactly what
 * it can publish) and registers channel discovery. Publishers are built per
 * account at publish time, from that connection's own token.
 */
export function registerYouTubeAdapter(
  registries: { publishers: SocialPublisherRegistry; discovery: AccountDiscoveryRegistry },
  options: YouTubeAdapterOptions,
): void {
  registries.publishers.markWired(YOUTUBE_PLATFORM, YOUTUBE_PUBLISHING_SUMMARY);
  registries.discovery.register(
    new YouTubeAccountDiscovery({ ...options, projectAudited: options.projectAudited }),
  );
}
