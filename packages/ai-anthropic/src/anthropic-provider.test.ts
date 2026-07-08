import { describe, expect, it, vi } from 'vitest';

import {
  AiProviderUnavailableError,
  AnthropicTextGenerationProvider,
  DEFAULT_ANTHROPIC_MODEL,
} from './anthropic-provider';

const tenant = { organizationId: 'org-1', workspaceId: 'ws-1' };

describe('AnthropicTextGenerationProvider', () => {
  it('is unavailable without an API key and throws on generate', async () => {
    const provider = new AnthropicTextGenerationProvider();
    expect(provider.isConfigured).toBe(false);
    expect(provider.modelRef).toEqual({ provider: 'anthropic', model: DEFAULT_ANTHROPIC_MODEL });

    await expect(
      provider.generateText({ tenant, instructions: 'Write a haiku.' }),
    ).rejects.toBeInstanceOf(AiProviderUnavailableError);
  });

  it('treats a whitespace-only key as unconfigured', () => {
    expect(new AnthropicTextGenerationProvider({ apiKey: '   ' }).isConfigured).toBe(false);
  });

  it('sends instructions as system and data sections as the user turn', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Generated draft.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 120, output_tokens: 45 },
    });
    const provider = new AnthropicTextGenerationProvider({
      apiKey: 'sk-test',
      clientFactory: () => ({ messages: { create } }) as never,
    });

    expect(provider.isConfigured).toBe(true);
    const result = await provider.generateText({
      tenant,
      instructions: 'You are a brand copywriter.',
      dataSections: ['<<<UNTRUSTED evidence block>>>'],
    });

    expect(result.text).toBe('Generated draft.');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 45 });

    const call = create.mock.calls[0]?.[0];
    expect(call.system).toBe('You are a brand copywriter.');
    expect(call.messages).toEqual([{ role: 'user', content: '<<<UNTRUSTED evidence block>>>' }]);
    // Opus 4.x rejects sampling params — none forwarded for the default model.
    expect(call.temperature).toBeUndefined();
  });

  it('omits temperature for the default Opus model even when requested', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const provider = new AnthropicTextGenerationProvider({
      apiKey: 'sk-test',
      clientFactory: () => ({ messages: { create } }) as never,
    });
    await provider.generateText({ tenant, instructions: 'x', temperature: 0.7 });
    expect(create.mock.calls[0]?.[0].temperature).toBeUndefined();
  });

  it('forwards temperature for a legacy model that accepts sampling', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const provider = new AnthropicTextGenerationProvider({
      apiKey: 'sk-test',
      model: 'claude-3-5-sonnet-latest',
      clientFactory: () => ({ messages: { create } }) as never,
    });
    await provider.generateText({ tenant, instructions: 'x', temperature: 0.7 });
    expect(create.mock.calls[0]?.[0].temperature).toBe(0.7);
  });

  it('maps refusal and length stop reasons', async () => {
    const make = (stop: string) =>
      new AnthropicTextGenerationProvider({
        apiKey: 'sk-test',
        clientFactory: () =>
          ({
            messages: {
              create: vi.fn().mockResolvedValue({
                content: [{ type: 'text', text: '' }],
                stop_reason: stop,
                usage: { input_tokens: 1, output_tokens: 0 },
              }),
            },
          }) as never,
      });

    expect((await make('refusal').generateText({ tenant, instructions: 'x' })).finishReason).toBe(
      'content_filter',
    );
    expect(
      (await make('max_tokens').generateText({ tenant, instructions: 'x' })).finishReason,
    ).toBe('length');
  });
});
