import type { EmbeddingInputType, EmbeddingProvider, ModelRef } from '@spectra/ai-core';
import type { TenantScope } from '@spectra/contracts';

/**
 * Voyage AI adapter for the ai-core EmbeddingProvider port — the first REAL
 * semantic embedder (ADR-0023). Replaces first-party lexical hashing
 * (ADR-0016), which matched words rather than meaning.
 *
 * Honesty contract:
 * - Without an API key the provider is UNAVAILABLE (`isConfigured === false`)
 *   and `embed` throws `EmbeddingProviderUnavailableError`. Callers fall back
 *   to the lexical embedder and SAY SO — retrieval quality is never silently
 *   misrepresented, and no vector is ever fabricated.
 * - The API key lives only in this adapter; it is never logged or serialised.
 * - A partial/short API response is an error, never silently zero-padded — a
 *   wrong-dimension vector would corrupt the collection.
 */

export const DEFAULT_VOYAGE_MODEL = 'voyage-4';
export const DEFAULT_VOYAGE_DIMENSIONS = 1024;
const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
/** API hard limit is 1000 texts; batch smaller to stay inside token limits. */
const DEFAULT_BATCH_SIZE = 128;
const DEFAULT_TIMEOUT_MS = 30_000;
/** voyage-4 family Matryoshka widths. */
export const SUPPORTED_VOYAGE_DIMENSIONS = [256, 512, 1024, 2048] as const;

export class EmbeddingProviderUnavailableError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(
      `Semantic embeddings are unavailable: provider "${providerId}" is not configured. ` +
        'Set VOYAGE_API_KEY to enable semantic retrieval.',
    );
    this.name = 'EmbeddingProviderUnavailableError';
    this.providerId = providerId;
  }
}

/** A real API failure — surfaced truthfully, never swallowed into empty vectors. */
export class EmbeddingRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingRequestError';
  }
}

export interface VoyageProviderConfig {
  /** Absent or empty => provider unavailable (honest, not fabricated). */
  apiKey?: string | undefined;
  /** Defaults to voyage-4. */
  model?: string;
  /** Matryoshka output width: 256 | 512 | 1024 | 2048. Defaults to 1024. */
  dimensions?: number;
  /** Texts per API call (defaults to 128; API ceiling is 1000). */
  batchSize?: number;
  timeoutMs?: number;
  /** Injectable for tests — no network in unit tests. */
  fetch?: typeof fetch;
}

interface VoyageResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  usage?: { total_tokens?: number };
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'voyage';
  readonly displayName = 'Voyage AI embeddings';
  readonly dimensions: number;
  readonly modelRef: ModelRef;

  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: VoyageProviderConfig = {}) {
    this.model = config.model?.trim() || DEFAULT_VOYAGE_MODEL;
    this.dimensions = config.dimensions ?? DEFAULT_VOYAGE_DIMENSIONS;
    if (!SUPPORTED_VOYAGE_DIMENSIONS.includes(this.dimensions as 256)) {
      throw new Error(
        `Unsupported embedding dimension ${this.dimensions}; expected one of ${SUPPORTED_VOYAGE_DIMENSIONS.join(', ')}`,
      );
    }
    this.apiKey = config.apiKey?.trim() || undefined;
    this.batchSize = Math.min(Math.max(config.batchSize ?? DEFAULT_BATCH_SIZE, 1), 1000);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    this.modelRef = { provider: this.id, model: this.model, version: String(this.dimensions) };
  }

  get isConfigured(): boolean {
    return this.apiKey !== undefined;
  }

  async embed(
    texts: readonly string[],
    _tenant: TenantScope,
    inputType: EmbeddingInputType = 'document',
  ): Promise<number[][]> {
    if (!this.apiKey) throw new EmbeddingProviderUnavailableError(this.id);
    if (texts.length === 0) return [];

    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      out.push(...(await this.embedBatch(batch, inputType)));
    }
    return out;
  }

  private async embedBatch(
    batch: readonly string[],
    inputType: EmbeddingInputType,
  ): Promise<number[][]> {
    let res: Response;
    try {
      res = await this.fetchImpl(VOYAGE_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey as string}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          input: batch,
          model: this.model,
          input_type: inputType,
          output_dimension: this.dimensions,
          truncation: true,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new EmbeddingRequestError(
        `Voyage embedding request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!res.ok) {
      // Body may echo the request but never the key (it is header-only).
      const detail = await res.text().catch(() => '');
      throw new EmbeddingRequestError(
        `Voyage responded ${res.status} ${res.statusText}: ${truncate(detail)}`,
      );
    }

    let body: VoyageResponse;
    try {
      body = (await res.json()) as VoyageResponse;
    } catch (error) {
      throw new EmbeddingRequestError(
        `Voyage returned an unreadable response: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const data = body.data;
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new EmbeddingRequestError(
        `Voyage returned ${data?.length ?? 0} embeddings for ${batch.length} inputs`,
      );
    }

    // Preserve request order: the API returns an explicit index per item.
    const ordered = new Array<number[]>(batch.length);
    for (let i = 0; i < data.length; i += 1) {
      const item = data[i] as { embedding?: number[]; index?: number };
      const slot = typeof item.index === 'number' ? item.index : i;
      const vector = item.embedding;
      if (!Array.isArray(vector) || vector.length !== this.dimensions) {
        throw new EmbeddingRequestError(
          `Voyage returned a ${vector?.length ?? 0}-dim vector; expected ${this.dimensions}`,
        );
      }
      if (slot < 0 || slot >= batch.length) {
        throw new EmbeddingRequestError(`Voyage returned out-of-range index ${slot}`);
      }
      ordered[slot] = vector;
    }
    if (ordered.some((v) => v === undefined)) {
      throw new EmbeddingRequestError('Voyage response was missing an embedding index');
    }
    return ordered;
  }
}

function truncate(detail: string): string {
  const flat = detail.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}
