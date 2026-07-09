import type { TextGenerationProvider } from '@spectra/ai-core';
import { describe, expect, it, vi } from 'vitest';

import { moderateContent } from './moderation';

const tenant = { organizationId: 'o', workspaceId: 'w' };

function provider(
  text: string,
  finishReason: 'stop' | 'content_filter' = 'stop',
): TextGenerationProvider {
  return {
    id: 'stub',
    displayName: 'Stub',
    modelRef: { provider: 'stub', model: 'm', version: '1' },
    generateText: vi.fn(async () => ({
      text,
      modelRef: { provider: 'stub', model: 'm', version: '1' },
      finishReason,
      usage: { inputTokens: 1, outputTokens: 1 },
    })),
  };
}

describe('moderateContent', () => {
  it('returns CLEAR for a safe verdict', async () => {
    const r = await moderateContent(
      provider('{"flagged": false, "categories": [], "reason": "clear"}'),
      tenant,
      'A friendly product announcement.',
    );
    expect(r.status).toBe('CLEAR');
    expect(r.categories).toEqual([]);
  });

  it('returns FLAGGED with the matching categories', async () => {
    const r = await moderateContent(
      provider('{"flagged": true, "categories": ["VIOLENCE","MADE_UP"], "reason": "threats"}'),
      tenant,
      'bad content',
    );
    expect(r.status).toBe('FLAGGED');
    // Unknown categories are dropped; only valid ones survive.
    expect(r.categories).toEqual(['VIOLENCE']);
  });

  it('extracts JSON even with surrounding prose', async () => {
    const r = await moderateContent(
      provider('Here is my verdict: {"flagged": false, "categories": []} — done.'),
      tenant,
      'ok',
    );
    expect(r.status).toBe('CLEAR');
  });

  it('returns ERROR (not silently CLEAR) when the response is unparseable', async () => {
    const r = await moderateContent(provider('not json at all'), tenant, 'x');
    expect(r.status).toBe('ERROR');
    expect(r.reason).toBeTruthy();
  });

  it('treats a model refusal as FLAGGED', async () => {
    const r = await moderateContent(provider('', 'content_filter'), tenant, 'x');
    expect(r.status).toBe('FLAGGED');
  });
});
