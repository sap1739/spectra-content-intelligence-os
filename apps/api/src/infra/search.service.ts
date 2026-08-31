import { Injectable } from '@nestjs/common';
import { BraveNewsSearchProvider, BraveWebSearchProvider } from '@spectra/research-brave';
import { ResearchProviderRegistry } from '@spectra/research-core';

import { getApiEnv } from '../config/env';

/**
 * Live discovery providers (Phase 5B). Env-gated on BRAVE_SEARCH_API_KEY:
 * unconfigured means search discovery is honestly UNAVAILABLE and a run uses
 * only the operator's own RSS feeds — never invented results.
 *
 * Providers are registered only when configured, so `registry.listByKind()`
 * reflects what can actually run rather than what could exist in principle.
 */
@Injectable()
export class SearchProviderService {
  readonly registry = new ResearchProviderRegistry();
  private readonly configured: boolean;

  constructor() {
    const apiKey = getApiEnv().BRAVE_SEARCH_API_KEY;
    const web = new BraveWebSearchProvider({ apiKey });
    this.configured = web.isConfigured;
    if (this.configured) {
      this.registry.register(web);
      this.registry.register(new BraveNewsSearchProvider({ apiKey }));
    }
  }

  get isConfigured(): boolean {
    return this.configured;
  }

  /** Non-secret descriptor for the honest UI availability state. */
  status(): {
    liveSearchConfigured: boolean;
    providers: Array<{ id: string; kind: string; displayName: string }>;
    note: string;
  } {
    const providers = [
      ...this.registry.listByKind('web-search'),
      ...this.registry.listByKind('news-search'),
    ].map((p) => ({ id: p.id, kind: p.kind, displayName: p.displayName }));

    return {
      liveSearchConfigured: this.configured,
      providers,
      note: this.configured
        ? 'Live web and news discovery are enabled; research runs can search beyond the configured feeds.'
        : 'Live search discovery is unavailable (BRAVE_SEARCH_API_KEY is not set). Research runs use only the RSS feeds you configure — no result is invented.',
    };
  }
}
