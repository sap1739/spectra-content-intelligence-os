import { describe, expect, it, vi } from 'vitest';

import { executeAudioRender } from './executor';

/**
 * The executor's decisions — consent, refusal, skip, release — pinned with
 * fakes. Real mixing is proven in the API integration suite against a real
 * ffmpeg; what matters here is what happens when something is wrong.
 */

const SCOPE = { organizationId: 'org1', workspaceId: 'ws1' };
const VOICE = '33333333-3333-4333-8333-333333333333';
const ASSET = '11111111-1111-4111-8111-111111111111';

function uploadedScript() {
  return {
    schemaVersion: 1,
    normalize: true,
    targetLufs: -16,
    segments: [
      { id: 'a', kind: 'HOST', source: { kind: 'UPLOADED', mediaAssetId: ASSET }, gainDb: 0 },
    ],
  };
}

function spokenScript() {
  return {
    schemaVersion: 1,
    normalize: true,
    targetLufs: -16,
    segments: [
      {
        id: 'a',
        kind: 'HOST',
        source: { kind: 'TEXT_TO_SPEECH', voiceProfileId: VOICE, text: 'Hello there' },
        gainDb: 0,
      },
    ],
  };
}

function renderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    ...SCOPE,
    episodeId: 'e1',
    kind: 'EPISODE_MIX',
    status: 'QUEUED',
    script: uploadedScript(),
    attempt: 0,
    cancelRequestedAt: null,
    startedAt: null,
    createdById: null,
    episode: { id: 'e1', consentScope: 'PODCAST' },
    ...overrides,
  };
}

function fakes(row: ReturnType<typeof renderRow> | null, voice?: Record<string, unknown> | null) {
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    audioRender: {
      findUnique: vi.fn(async () => row),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { count: 1 };
      }),
    },
    podcastEpisode: { updateMany: vi.fn(async () => ({ count: 1 })) },
    voiceProfile: { findFirst: vi.fn(async () => voice ?? null) },
    mediaAsset: { findFirst: vi.fn(async () => null), create: vi.fn() },
    transcript: { create: vi.fn() },
    budgetReservation: { updateMany: vi.fn(async () => ({ count: 0 })) },
  };
  const renderer = {
    id: 'ffmpeg',
    capabilities: vi.fn(),
    mix: vi.fn(),
    waveform: vi.fn(),
    probeAudio: vi.fn(async () => ({ durationMs: 1000, audioCodec: 'mp3' })),
  };
  const storage = {
    ensureBucket: vi.fn(),
    putObject: vi.fn(),
    getObject: vi.fn(),
    deleteObject: vi.fn(),
  };
  return { prisma, renderer, storage, updates };
}

function deps(f: ReturnType<typeof fakes>, extra: Record<string, unknown> = {}) {
  return {
    prisma: f.prisma as never,
    storage: f.storage as never,
    renderer: f.renderer as never,
    ...extra,
  };
}

describe('executeAudioRender — consent', () => {
  it('refuses a cloned voice with no consent, and synthesises nothing', async () => {
    const f = fakes(renderRow({ script: spokenScript() }), {
      id: VOICE,
      kind: 'CLONED',
      consents: [],
    });
    const synthesize = vi.fn();

    const result = await executeAudioRender(
      deps(f, { synthesis: { available: true, synthesize } }),
      'r1',
    );

    expect(result).toMatchObject({ status: 'FAILED', failureReason: 'VOICE_CONSENT_MISSING' });
    expect(synthesize).not.toHaveBeenCalled();
    expect(f.renderer.mix).not.toHaveBeenCalled();
    expect(f.updates.at(-1)).toMatchObject({
      status: 'FAILED',
      failureReason: 'VOICE_CONSENT_MISSING',
      mediaAssetId: null,
    });
  });

  it('refuses a voice whose consent was revoked after the render was queued', async () => {
    // The whole point of re-checking at render time rather than at save time.
    const f = fakes(renderRow({ script: spokenScript() }), {
      id: VOICE,
      kind: 'CLONED',
      consents: [
        {
          status: 'GRANTED',
          scopes: ['PODCAST'],
          expiresAt: new Date('2099-01-01'),
          revokedAt: new Date('2026-10-01'),
        },
      ],
    });

    const result = await executeAudioRender(
      deps(f, { synthesis: { available: true, synthesize: vi.fn() } }),
      'r1',
    );

    expect(result.failureReason).toBe('VOICE_CONSENT_MISSING');
  });

  it('refuses a voice whose consent does not cover this episode’s use', async () => {
    const f = fakes(
      renderRow({
        script: spokenScript(),
        episode: { id: 'e1', consentScope: 'PAID_ADVERTISING' },
      }),
      {
        id: VOICE,
        kind: 'CLONED',
        consents: [
          {
            status: 'GRANTED',
            scopes: ['PODCAST'],
            expiresAt: new Date('2099-01-01'),
            revokedAt: null,
          },
        ],
      },
    );

    const result = await executeAudioRender(
      deps(f, { synthesis: { available: true, synthesize: vi.fn() } }),
      'r1',
    );

    expect(result.failureReason).toBe('VOICE_CONSENT_MISSING');
  });

  it('does not ask for consent for a stock voice', async () => {
    const f = fakes(renderRow({ script: spokenScript() }), {
      id: VOICE,
      kind: 'STOCK',
      consents: [],
    });
    const synthesize = vi.fn(async () => undefined);
    f.renderer.mix.mockRejectedValue(new Error('stop after consent'));

    await executeAudioRender(deps(f, { synthesis: { available: true, synthesize } }), 'r1');

    expect(synthesize).toHaveBeenCalledTimes(1);
  });
});

describe('executeAudioRender — honest unavailability', () => {
  it('refuses a spoken script when no synthesis provider is configured', async () => {
    const f = fakes(renderRow({ script: spokenScript() }), {
      id: VOICE,
      kind: 'STOCK',
      consents: [],
    });

    const result = await executeAudioRender(deps(f), 'r1');

    expect(result).toMatchObject({ status: 'FAILED', failureReason: 'TTS_NOT_CONFIGURED' });
    // Nothing was mixed, and no silence was passed off as a voice.
    expect(f.renderer.mix).not.toHaveBeenCalled();
    expect(f.updates.at(-1)).toMatchObject({ mediaAssetId: null });
  });

  it('refuses a stored script that no longer validates', async () => {
    const f = fakes(renderRow({ script: { segments: 'nope' } }));

    const result = await executeAudioRender(deps(f), 'r1');

    expect(result.failureReason).toBe('INVALID_SCRIPT');
  });

  it('fails with INPUT_UNAVAILABLE for an asset outside this tenant, without fetching it', async () => {
    const f = fakes(renderRow());

    const result = await executeAudioRender(deps(f), 'r1');

    expect(result.failureReason).toBe('INPUT_UNAVAILABLE');
    expect(f.storage.getObject).not.toHaveBeenCalled();
  });

  it('refuses a non-audio asset rather than handing it to the engine', async () => {
    const f = fakes(renderRow());
    f.prisma.mediaAsset.findFirst.mockResolvedValue({
      id: ASSET,
      storageKey: 'org/org1/ws/ws1/media/x/a.png',
      mimeType: 'image/png',
    } as never);

    const result = await executeAudioRender(deps(f), 'r1');

    expect(result.failureReason).toBe('INPUT_UNSUPPORTED');
    expect(f.renderer.mix).not.toHaveBeenCalled();
  });
});

describe('executeAudioRender — lifecycle', () => {
  it('skips a render that already reached a terminal state', async () => {
    const f = fakes(renderRow({ status: 'SUCCEEDED' }));

    const result = await executeAudioRender(deps(f), 'r1');

    expect(result).toMatchObject({ status: 'SKIPPED', skipped: true });
    expect(f.prisma.audioRender.updateMany).not.toHaveBeenCalled();
  });

  it('honours a cancellation requested before the worker started', async () => {
    const f = fakes(renderRow({ cancelRequestedAt: new Date() }));

    const result = await executeAudioRender(deps(f), 'r1');

    expect(result).toMatchObject({ status: 'CANCELLED', failureReason: 'CANCELLED' });
    expect(f.renderer.mix).not.toHaveBeenCalled();
  });

  it('marks the row RUNNING with its attempt before any work', async () => {
    const f = fakes(renderRow());

    await executeAudioRender(deps(f), 'r1', { attempt: 3 });

    expect(f.updates[0]).toMatchObject({ status: 'RUNNING', attempt: 3, progressPercent: 0 });
  });

  it('releases the budget reservation when a render fails', async () => {
    const f = fakes(renderRow());

    await executeAudioRender(deps(f), 'r1');

    expect(f.prisma.budgetReservation.updateMany).toHaveBeenCalled();
  });

  it('puts the episode back to READY_TO_RENDER so it never looks like it has audio', async () => {
    const f = fakes(renderRow());

    await executeAudioRender(deps(f), 'r1');

    expect(f.prisma.podcastEpisode.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'READY_TO_RENDER' } }),
    );
  });

  it('bounds an unexpected error’s detail instead of storing a log dump', async () => {
    const f = fakes(renderRow());
    f.prisma.mediaAsset.findFirst.mockRejectedValue(new Error('x'.repeat(4000)));

    await executeAudioRender(deps(f), 'r1');

    const detail = f.updates.at(-1)!['failureDetail'] as string | null;
    expect((detail ?? '').length).toBeLessThanOrEqual(500);
  });
});
