import type { TenantScope } from '@spectra/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  EmbeddingProviderUnavailableError,
  EmbeddingRequestError,
  VoyageEmbeddingProvider,
} from './voyage-provider';

const TENANT: TenantScope = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
};

function vec(n: number, fill: number): number[] {
  return new Array<number>(n).fill(fill);
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('VoyageEmbeddingProvider', () => {
  it('is unavailable without an API key and never fabricates vectors', async () => {
    const provider = new VoyageEmbeddingProvider({ dimensions: 256 });
    expect(provider.isConfigured).toBe(false);
    await expect(provider.embed(['hello'], TENANT)).rejects.toBeInstanceOf(
      EmbeddingProviderUnavailableError,
    );
  });

  it('sends the documented request shape and returns the vectors', async () => {
    const fetchMock = vi.fn(async () =>
      ok({ data: [{ embedding: vec(1024, 0.1), index: 0 }], usage: { total_tokens: 4 } }),
    );
    const provider = new VoyageEmbeddingProvider({
      apiKey: 'test-key',
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(provider.isConfigured).toBe(true);

    const vectors = await provider.embed(['hello world'], TENANT, 'query');
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(1024);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.voyageai.com/v1/embeddings');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body as string)).toEqual({
      input: ['hello world'],
      model: 'voyage-4',
      input_type: 'query',
      output_dimension: 1024,
      truncation: true,
    });
  });

  it('defaults to document input type (asymmetric retrieval)', async () => {
    const fetchMock = vi.fn(async () => ok({ data: [{ embedding: vec(1024, 0.2), index: 0 }] }));
    const provider = new VoyageEmbeddingProvider({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await provider.embed(['passage'], TENANT);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).input_type).toBe('document');
  });

  it('batches large inputs and preserves overall order', async () => {
    const fetchMock = vi.fn(async (_u: unknown, init: RequestInit) => {
      const inputs = JSON.parse(init.body as string).input as string[];
      return ok({
        data: inputs.map((t, i) => ({ embedding: vec(256, Number(t)), index: i })),
      });
    });
    const provider = new VoyageEmbeddingProvider({
      apiKey: 'k',
      dimensions: 256,
      batchSize: 2,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const texts = ['1', '2', '3', '4', '5'];
    const vectors = await provider.embed(texts, TENANT);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 2 + 2 + 1
    expect(vectors).toHaveLength(5);
    // Each vector's fill value encodes its source text — order must survive batching.
    expect(vectors.map((v) => v[0])).toEqual([1, 2, 3, 4, 5]);
  });

  it('reorders by the response index rather than trusting arrival order', async () => {
    const fetchMock = vi.fn(async () =>
      ok({
        data: [
          { embedding: vec(256, 2), index: 1 },
          { embedding: vec(256, 1), index: 0 },
        ],
      }),
    );
    const provider = new VoyageEmbeddingProvider({
      apiKey: 'k',
      dimensions: 256,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const vectors = await provider.embed(['a', 'b'], TENANT);
    expect(vectors.map((v) => v[0])).toEqual([1, 2]);
  });

  it('rejects a wrong-dimension vector instead of storing a corrupt one', async () => {
    const fetchMock = vi.fn(async () => ok({ data: [{ embedding: vec(512, 0.1), index: 0 }] }));
    const provider = new VoyageEmbeddingProvider({
      apiKey: 'k',
      dimensions: 1024,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(provider.embed(['x'], TENANT)).rejects.toThrow(/512-dim vector; expected 1024/);
  });

  it('surfaces an API error truthfully', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('{"detail":"rate limited"}', { status: 429, statusText: 'Too Many Requests' }),
    );
    const provider = new VoyageEmbeddingProvider({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(provider.embed(['x'], TENANT)).rejects.toBeInstanceOf(EmbeddingRequestError);
    await expect(provider.embed(['x'], TENANT)).rejects.toThrow(/429.*rate limited/);
  });

  it('errors when the response count does not match the request', async () => {
    const fetchMock = vi.fn(async () => ok({ data: [{ embedding: vec(1024, 1), index: 0 }] }));
    const provider = new VoyageEmbeddingProvider({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(provider.embed(['a', 'b'], TENANT)).rejects.toThrow(/1 embeddings for 2 inputs/);
  });

  it('returns empty without calling the API for no input', async () => {
    const fetchMock = vi.fn();
    const provider = new VoyageEmbeddingProvider({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await provider.embed([], TENANT)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unsupported Matryoshka width at construction', () => {
    expect(() => new VoyageEmbeddingProvider({ apiKey: 'k', dimensions: 777 })).toThrow(
      /Unsupported embedding dimension/,
    );
  });
});
