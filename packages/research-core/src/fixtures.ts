import type { TenantScope } from '@spectra/contracts';

import type { DiscoveredSource, SearchQueryInput, WebSearchProvider } from './providers';

/**
 * Deterministic fixture provider for tests and offline development ONLY.
 * It returns exactly the sources it was constructed with — it performs no
 * network access and is not a research integration.
 */
export class FixtureWebSearchProvider implements WebSearchProvider {
  public readonly kind = 'web-search' as const;
  public readonly isFixture = true;

  constructor(
    public readonly id: string,
    public readonly displayName: string,
    private readonly fixtures: readonly DiscoveredSource[],
  ) {}

  async search(query: SearchQueryInput, _tenant: TenantScope): Promise<DiscoveredSource[]> {
    const limit = query.maxResults ?? this.fixtures.length;
    return this.fixtures.slice(0, limit);
  }
}
