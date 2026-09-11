import type { AccountDiscoveryRegistry, SocialPublisherRegistry } from '@spectra/social-core';

import type { MetaGraphOptions } from './client';
import {
  DEFAULT_META_GRAPH_BASE_URL,
  DEFAULT_META_GRAPH_VERSION,
  FACEBOOK_PUBLISHING_SUMMARY,
  INSTAGRAM_PUBLISHING_SUMMARY,
} from './constants';
import { MetaAccountDiscovery } from './discovery';

/**
 * Graph API options. The app secret (the Facebook OAuth client secret, when
 * configured) enables appsecret_proof on every Graph call.
 */
export function metaGraphOptionsFromEnv(
  env: {
    META_GRAPH_API_BASE_URL?: string | undefined;
    META_GRAPH_API_VERSION?: string | undefined;
  },
  appSecret: string | null,
): MetaGraphOptions {
  return {
    apiBaseUrl: env.META_GRAPH_API_BASE_URL ?? DEFAULT_META_GRAPH_BASE_URL,
    version: env.META_GRAPH_API_VERSION ?? DEFAULT_META_GRAPH_VERSION,
    appSecret,
  };
}

/**
 * Marks Facebook Page and Instagram publishing as wired, each with a summary
 * of exactly what it can post, and registers discovery on the Facebook
 * connection that finds both. Publishers are built per account at publish
 * time, from that account's own sealed Page token.
 */
export function registerMetaAdapters(
  registries: { publishers: SocialPublisherRegistry; discovery: AccountDiscoveryRegistry },
  options: MetaGraphOptions,
): void {
  registries.publishers.markWired('FACEBOOK', FACEBOOK_PUBLISHING_SUMMARY);
  registries.publishers.markWired('INSTAGRAM', INSTAGRAM_PUBLISHING_SUMMARY);
  registries.discovery.register(new MetaAccountDiscovery(options));
}
