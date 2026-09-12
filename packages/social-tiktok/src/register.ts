import type { AccountDiscoveryRegistry, SocialPublisherRegistry } from '@spectra/social-core';

import type { TikTokApiOptions } from './client';
import {
  DEFAULT_TIKTOK_API_BASE_URL,
  TIKTOK_PLATFORM,
  TIKTOK_PUBLISHING_SUMMARY,
} from './constants';
import { TikTokAccountDiscovery } from './discovery';

export interface TikTokAdapterOptions extends TikTokApiOptions {
  /**
   * The operator's declaration that TikTok has audited this API client.
   * False (the default) means TikTok restricts posts to private viewing, and
   * every surface says so.
   */
  clientAudited: boolean;
  chunkBytes: number;
}

export function tikTokApiOptionsFromEnv(env: {
  TIKTOK_API_BASE_URL?: string | undefined;
  TIKTOK_API_CLIENT_AUDITED?: boolean | undefined;
  TIKTOK_UPLOAD_CHUNK_BYTES?: number | undefined;
}): TikTokAdapterOptions {
  return {
    apiBaseUrl: env.TIKTOK_API_BASE_URL ?? DEFAULT_TIKTOK_API_BASE_URL,
    clientAudited: env.TIKTOK_API_CLIENT_AUDITED ?? false,
    chunkBytes: env.TIKTOK_UPLOAD_CHUNK_BYTES ?? 10 * 1024 * 1024,
  };
}

/**
 * Marks TikTok publishing as wired (with a one-line summary of exactly what it
 * can post) and registers creator discovery. Publishers are built per account
 * at publish time, from that connection's own token.
 */
export function registerTikTokAdapter(
  registries: { publishers: SocialPublisherRegistry; discovery: AccountDiscoveryRegistry },
  options: TikTokAdapterOptions,
): void {
  registries.publishers.markWired(TIKTOK_PLATFORM, TIKTOK_PUBLISHING_SUMMARY);
  registries.discovery.register(new TikTokAccountDiscovery(options));
}
