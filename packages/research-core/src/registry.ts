import type { AnyResearchProvider, ResearchProviderKind } from './providers';

export class ProviderNotFoundError extends Error {
  constructor(kind: string, id?: string) {
    super(
      id
        ? `No provider ${id} registered for kind ${kind}`
        : `No provider registered for kind ${kind}`,
    );
    this.name = 'ProviderNotFoundError';
  }
}

export class DuplicateProviderError extends Error {
  constructor(kind: string, id: string) {
    super(`Provider ${id} already registered for kind ${kind}`);
    this.name = 'DuplicateProviderError';
  }
}

/**
 * Runtime registry of research providers. Pipelines resolve providers by
 * kind (optionally by id), keeping domain logic independent of any vendor.
 */
export class ResearchProviderRegistry {
  private readonly providers = new Map<ResearchProviderKind, Map<string, AnyResearchProvider>>();

  register(provider: AnyResearchProvider): void {
    const byId = this.providers.get(provider.kind) ?? new Map<string, AnyResearchProvider>();
    if (byId.has(provider.id)) {
      throw new DuplicateProviderError(provider.kind, provider.id);
    }
    byId.set(provider.id, provider);
    this.providers.set(provider.kind, byId);
  }

  get<T extends AnyResearchProvider>(kind: T['kind'], id?: string): T {
    const byId = this.providers.get(kind);
    if (!byId || byId.size === 0) {
      throw new ProviderNotFoundError(kind, id);
    }
    if (id) {
      const provider = byId.get(id);
      if (!provider) throw new ProviderNotFoundError(kind, id);
      return provider as T;
    }
    return byId.values().next().value as T;
  }

  listByKind(kind: ResearchProviderKind): AnyResearchProvider[] {
    return [...(this.providers.get(kind)?.values() ?? [])];
  }

  listAll(): AnyResearchProvider[] {
    return [...this.providers.values()].flatMap((byId) => [...byId.values()]);
  }
}
