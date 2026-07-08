import Anthropic from '@anthropic-ai/sdk';
import type {
  ModelRef,
  TextGenerationProvider,
  TextGenerationRequest,
  TextGenerationResult,
} from '@spectra/ai-core';

/**
 * Anthropic Claude adapter for the ai-core TextGenerationProvider port.
 *
 * Honesty contract:
 * - Without an API key the provider is UNAVAILABLE (`isConfigured === false`).
 *   `generateText` then throws `AiProviderUnavailableError`; callers surface an
 *   honest "AI generation is not configured" state and never fabricate output.
 * - The API key is held only inside the SDK client; it is never logged, echoed
 *   in errors, or serialised.
 *
 * Prompt-injection defence is structural: trusted `instructions` become the
 * system prompt; untrusted `dataSections` (already wrapped by knowledge-core)
 * go in the user turn — the two are never concatenated.
 */

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface AnthropicProviderConfig {
  /** Absent or empty => provider is unavailable (honest, not fabricated). */
  apiKey?: string | undefined;
  /** Defaults to claude-opus-4-8. */
  model?: string;
  /** Hard ceiling on generated tokens per request. */
  maxOutputTokens?: number;
  /** Optional model version string recorded on results for attribution. */
  modelVersion?: string;
  /** Injectable client factory for tests (no network in unit tests). */
  clientFactory?: (apiKey: string) => Anthropic;
}

/** Thrown when generation is attempted while the provider is unconfigured. */
export class AiProviderUnavailableError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(
      `AI text generation is unavailable: provider "${providerId}" is not configured. ` +
        'Set ANTHROPIC_API_KEY to enable generation.',
    );
    this.name = 'AiProviderUnavailableError';
    this.providerId = providerId;
  }
}

/**
 * The Opus 4.x and Claude 5 families reject `temperature`/`top_p`/`top_k`
 * (HTTP 400) — sampling is managed internally. We forward sampling params
 * only for models known to accept them; the request's `temperature` is
 * otherwise ignored rather than causing a hard failure.
 */
function modelAcceptsSampling(model: string): boolean {
  return !/(opus-4-[6-9]|opus-5|sonnet-5|fable-5|mythos-5|haiku-4-5)/i.test(model);
}

function mapFinishReason(stopReason: string | null): TextGenerationResult['finishReason'] {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

export class AnthropicTextGenerationProvider implements TextGenerationProvider {
  readonly id = 'anthropic';
  readonly displayName = 'Anthropic Claude';
  readonly modelRef: ModelRef;

  private readonly client: Anthropic | undefined;
  private readonly model: string;
  private readonly maxOutputTokens: number;

  constructor(config: AnthropicProviderConfig = {}) {
    this.model = config.model?.trim() || DEFAULT_ANTHROPIC_MODEL;
    this.maxOutputTokens = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.modelRef = {
      provider: this.id,
      model: this.model,
      ...(config.modelVersion ? { version: config.modelVersion } : {}),
    };

    const apiKey = config.apiKey?.trim();
    if (apiKey) {
      const factory = config.clientFactory ?? ((key: string) => new Anthropic({ apiKey: key }));
      this.client = factory(apiKey);
    } else {
      this.client = undefined;
    }
  }

  /** True only when an API key is present — drives honest UI availability. */
  get isConfigured(): boolean {
    return this.client !== undefined;
  }

  async generateText(request: TextGenerationRequest): Promise<TextGenerationResult> {
    if (!this.client) {
      throw new AiProviderUnavailableError(this.id);
    }

    // Structural isolation: instructions are trusted (system); the wrapped
    // untrusted data sections are the user turn. Never concatenated.
    const system = request.instructions;
    const userContent =
      request.dataSections && request.dataSections.length > 0
        ? request.dataSections.join('\n\n')
        : '(No supporting data was provided. Do not invent facts, sources, or citations.)';

    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxOutputTokens ?? this.maxOutputTokens,
      system,
      messages: [{ role: 'user', content: userContent }],
      ...(request.stopSequences && request.stopSequences.length > 0
        ? { stop_sequences: request.stopSequences }
        : {}),
      ...(request.temperature !== undefined && modelAcceptsSampling(this.model)
        ? { temperature: request.temperature }
        : {}),
    });

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      text,
      modelRef: this.modelRef,
      finishReason: mapFinishReason(message.stop_reason),
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
    };
  }
}
