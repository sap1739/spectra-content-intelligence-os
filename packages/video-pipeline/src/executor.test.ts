import type { VideoRenderPlan } from '@spectra/video-studio';
import { describe, expect, it, vi } from 'vitest';

import { executeVideoRender } from './executor';

/**
 * The executor's job is to move one row through its state machine and settle
 * its reservation. These tests use fakes rather than a real encoder, so they
 * pin the decisions — skip, fail, release — that a passing render never shows.
 * Real encoding is proven in `@spectra/media-ffmpeg` and the API suite.
 */

const SCOPE = { organizationId: 'org1', workspaceId: 'ws1' };

function renderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    ...SCOPE,
    projectId: 'p1',
    status: 'QUEUED',
    formatKey: 'SQUARE_1080x1080',
    storyboard: {
      schemaVersion: 1,
      transitionMs: 0,
      burnCaptions: false,
      scenes: [{ id: 'a', durationMs: 1000, background: { kind: 'COLOR', color: '#000000' } }],
    },
    crf: 23,
    captions: 'NONE',
    thumbnail: false,
    attempt: 0,
    cancelRequestedAt: null,
    startedAt: null,
    createdById: null,
    project: { id: 'p1', name: 'Clip' },
    ...overrides,
  };
}

function fakes(row: ReturnType<typeof renderRow> | null) {
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    videoRender: {
      findUnique: vi.fn(async () => row),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { count: 1 };
      }),
    },
    mediaAsset: { findFirst: vi.fn(async () => null), create: vi.fn() },
    budgetReservation: { updateMany: vi.fn(async () => ({ count: 0 })) },
    usageEvent: { create: vi.fn() },
  };
  const renderer = {
    id: 'ffmpeg',
    displayName: 'FFmpeg',
    capabilities: vi.fn(),
    render: vi.fn(),
    extractThumbnail: vi.fn(),
  };
  const storage = {
    providerId: 'fake',
    ensureBucket: vi.fn(),
    putObject: vi.fn(),
    getObject: vi.fn(),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
    createSignedUploadUrl: vi.fn(),
    createSignedDownloadUrl: vi.fn(),
  };
  return { prisma, renderer, storage, updates };
}

function deps(f: ReturnType<typeof fakes>) {
  return {
    prisma: f.prisma as never,
    storage: f.storage as never,
    renderer: f.renderer as never,
  };
}

describe('executeVideoRender', () => {
  it('skips a render that is already terminal, so a retry never re-encodes it', async () => {
    const f = fakes(renderRow({ status: 'SUCCEEDED' }));

    const result = await executeVideoRender(deps(f), 'r1');

    expect(result).toMatchObject({ status: 'SKIPPED', skipped: true });
    expect(f.renderer.render).not.toHaveBeenCalled();
    expect(f.prisma.videoRender.updateMany).not.toHaveBeenCalled();
  });

  it('skips a render whose row is gone rather than inventing one', async () => {
    const f = fakes(null);

    const result = await executeVideoRender(deps(f), 'r1');

    expect(result.status).toBe('SKIPPED');
    expect(f.renderer.render).not.toHaveBeenCalled();
  });

  it('honours a cancellation requested before the worker picked the job up', async () => {
    const f = fakes(renderRow({ cancelRequestedAt: new Date() }));

    const result = await executeVideoRender(deps(f), 'r1');

    expect(result).toMatchObject({ status: 'CANCELLED', failureReason: 'CANCELLED' });
    expect(f.renderer.render).not.toHaveBeenCalled();
    // Terminal, with a reason and no asset.
    expect(f.updates.at(-1)).toMatchObject({
      status: 'CANCELLED',
      failureReason: 'CANCELLED',
      mediaAssetId: null,
    });
  });

  it('refuses a stored storyboard that no longer validates, naming it as the fault', async () => {
    const f = fakes(renderRow({ storyboard: { scenes: 'not an array' } }));
    f.renderer.capabilities.mockResolvedValue({ available: true });

    const result = await executeVideoRender(deps(f), 'r1');

    expect(result).toMatchObject({ status: 'FAILED', failureReason: 'INVALID_STORYBOARD' });
    expect(f.renderer.render).not.toHaveBeenCalled();
  });

  it('records the engine’s own reason when a render fails, and never an asset', async () => {
    const f = fakes(renderRow());
    const { VideoRenderError } = await import('@spectra/media-ffmpeg');
    f.renderer.render.mockRejectedValue(
      new VideoRenderError('ENGINE_MISSING_CAPABILITY', 'No libass in this build.', 'detail'),
    );

    const result = await executeVideoRender(deps(f), 'r1');

    expect(result).toMatchObject({
      status: 'FAILED',
      failureReason: 'ENGINE_MISSING_CAPABILITY',
    });
    const terminal = f.updates.at(-1)!;
    expect(terminal).toMatchObject({
      status: 'FAILED',
      failureReason: 'ENGINE_MISSING_CAPABILITY',
      mediaAssetId: null,
    });
    // The reservation is released rather than left holding budget.
    expect(f.prisma.budgetReservation.updateMany).toHaveBeenCalled();
  });

  it('maps a timeout and a cancellation to their own terminal states', async () => {
    const { VideoRenderError } = await import('@spectra/media-ffmpeg');

    const timedOut = fakes(renderRow());
    timedOut.renderer.render.mockRejectedValue(new VideoRenderError('TIMEOUT', 'Too long.', null));
    const cancelled = fakes(renderRow());
    cancelled.renderer.render.mockRejectedValue(
      new VideoRenderError('CANCELLED', 'Stopped.', null),
    );

    expect((await executeVideoRender(deps(timedOut), 'r1')).status).toBe('TIMED_OUT');
    expect((await executeVideoRender(deps(cancelled), 'r1')).status).toBe('CANCELLED');
    expect(timedOut.updates.at(-1)).toMatchObject({ status: 'TIMED_OUT' });
    expect(cancelled.updates.at(-1)).toMatchObject({ status: 'CANCELLED' });
  });

  it('bounds an unexpected error’s detail instead of storing a log dump', async () => {
    const f = fakes(renderRow());
    f.renderer.render.mockRejectedValue(new Error('x'.repeat(5000)));

    await executeVideoRender(deps(f), 'r1');

    const detail = f.updates.at(-1)!['failureDetail'] as string;
    expect(detail.length).toBeLessThanOrEqual(500);
  });

  it('marks the row RUNNING with its attempt before any encoding starts', async () => {
    const f = fakes(renderRow());
    f.renderer.render.mockRejectedValue(new Error('stop here'));

    await executeVideoRender(deps(f), 'r1', { attempt: 2 });

    expect(f.updates[0]).toMatchObject({ status: 'RUNNING', attempt: 2, progressPercent: 0 });
  });

  it('fails with INPUT_UNAVAILABLE when an asset is not in this tenant, without fetching it', async () => {
    const f = fakes(
      renderRow({
        storyboard: {
          schemaVersion: 1,
          transitionMs: 0,
          burnCaptions: false,
          scenes: [
            {
              id: 'a',
              durationMs: 1000,
              background: {
                kind: 'IMAGE',
                mediaAssetId: '11111111-1111-4111-8111-111111111111',
                motion: 'NONE',
                fit: 'COVER',
                padColor: '#000000',
              },
            },
          ],
        },
      }),
    );

    const result = await executeVideoRender(deps(f), 'r1');

    expect(result).toMatchObject({ status: 'FAILED', failureReason: 'INPUT_UNAVAILABLE' });
    expect(f.storage.getObject).not.toHaveBeenCalled();
    expect(f.renderer.render).not.toHaveBeenCalled();
  });
});

describe('plan shape the executor depends on', () => {
  it('passes the planned scenes straight to the renderer', async () => {
    const f = fakes(renderRow());
    let seen: VideoRenderPlan | null = null;
    f.renderer.render.mockImplementation(async (plan: VideoRenderPlan) => {
      seen = plan;
      throw new Error('stop after planning');
    });

    await executeVideoRender(deps(f), 'r1');

    expect(seen).not.toBeNull();
    expect(seen!.totalDurationMs).toBe(1000);
    expect(seen!.format.key).toBe('SQUARE_1080x1080');
  });
});
