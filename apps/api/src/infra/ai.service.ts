import { Injectable } from '@nestjs/common';
import { AnthropicTextGenerationProvider } from '@spectra/ai-anthropic';
import type { TextGenerationProvider } from '@spectra/ai-core';

import { getApiEnv } from '../config/env';

/**
 * Wraps the configured text-generation provider. Built once from validated env;
 * the API key never leaves the SDK client (never logged or serialised).
 *
 * When no key is configured the provider is honestly UNAVAILABLE — callers
 * surface an empty state and generation endpoints return 503, never fake text.
 */
@Injectable()
export class AiTextService {
  private readonly anthropic: AnthropicTextGenerationProvider;

  constructor() {
    const env = getApiEnv();
    this.anthropic = new AnthropicTextGenerationProvider({
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL,
      maxOutputTokens: env.ANTHROPIC_MAX_OUTPUT_TOKENS,
    });
  }

  get provider(): TextGenerationProvider {
    return this.anthropic;
  }

  get isConfigured(): boolean {
    return this.anthropic.isConfigured;
  }

  /** Non-secret capability descriptor for the honest UI availability state. */
  status(): { configured: boolean; provider: string; model: string } {
    return {
      configured: this.anthropic.isConfigured,
      provider: this.anthropic.modelRef.provider,
      model: this.anthropic.modelRef.model,
    };
  }
}
