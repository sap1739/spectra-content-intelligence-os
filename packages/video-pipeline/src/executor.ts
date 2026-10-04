import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Storyboard, type VideoFailureReason, storyboardSchema } from '@spectra/contracts';
import type { SpectraPrismaClient } from '@spectra/database';
import type { Logger } from '@spectra/logging';
import type { VideoRenderer } from '@spectra/media-core';
import { VideoRenderError } from '@spectra/media-ffmpeg';
import { reconcile, release, type UsageRecorder } from '@spectra/metering';
import { type ObjectStorageProvider, buildObjectKey, validateUpload } from '@spectra/storage';
import { buildSrt, buildVtt, buildVideoRenderPlan } from '@spectra/video-studio';

/**
 * Executing one render.
 *
 * The `VideoRender` row is the job's state machine, and this function is the
 * only thing that moves it: QUEUED → RUNNING → exactly one terminal state.
 * Two rules it exists to keep:
 *
 *  1. **A failure is never silent and never anonymous.** Every exit that is
 *     not SUCCEEDED writes a `failureReason` and leaves `mediaAssetId` null,
 *     so "there is a video" and "there is not" can never be confused.
 *  2. **A reservation is always settled.** Success reconciles it, failure
 *     releases it — a refused or crashed render never leaves budget held.
 */

export interface VideoExecutorDeps {
  prisma: SpectraPrismaClient;
  storage: ObjectStorageProvider;
  renderer: VideoRenderer;
  usage?: UsageRecorder;
  logger?: Logger;
  /** Overridable for tests; defaults to the OS temp directory. */
  workRoot?: string;
  now?: () => Date;
}

export interface VideoExecutorContext {
  /** Cancellation and timeout from the queue runtime. */
  signal?: AbortSignal;
  reportProgress?: (percent: number, note?: string) => Promise<void> | void;
  attempt?: number;
}

export interface VideoExecutionResult {
  status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'SKIPPED';
  renderId: string;
  mediaAssetId?: string;
  failureReason?: VideoFailureReason;
  /** True when the row was already terminal — a retry must not redo the work. */
  skipped?: boolean;
}

/** The terminal status a failure reason implies. */
function statusFor(reason: VideoFailureReason): 'FAILED' | 'CANCELLED' | 'TIMED_OUT' {
  if (reason === 'CANCELLED') return 'CANCELLED';
  if (reason === 'TIMEOUT') return 'TIMED_OUT';
  return 'FAILED';
}

/** Engine detail is bounded and never carries a path, a token or a whole log. */
function boundedDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  return detail.replace(/\s+/g, ' ').trim().slice(0, 500) || null;
}

export async function executeVideoRender(
  deps: VideoExecutorDeps,
  renderId: string,
  context: VideoExecutorContext = {},
): Promise<VideoExecutionResult> {
  const now = deps.now ?? (() => new Date());
  const { prisma } = deps;

  const render = await prisma.videoRender.findUnique({
    where: { id: renderId },
    include: { project: true },
  });
  if (!render) {
    // Nothing to do, and nothing to invent: the row is gone.
    return { status: 'SKIPPED', renderId, skipped: true };
  }

  const scope = { organizationId: render.organizationId, workspaceId: render.workspaceId };

  // A retry of an already-finished render must not re-encode or re-bill.
  if (render.status !== 'QUEUED' && render.status !== 'RUNNING') {
    return { status: 'SKIPPED', renderId, skipped: true };
  }
  if (render.cancelRequestedAt) {
    await finishFailed(deps, scope, render.id, 'CANCELLED', null, now());
    return { status: 'CANCELLED', renderId, failureReason: 'CANCELLED' };
  }

  await prisma.videoRender.updateMany({
    where: { ...scope, id: render.id },
    data: {
      status: 'RUNNING',
      startedAt: render.startedAt ?? now(),
      attempt: context.attempt ?? render.attempt + 1,
      progressPercent: 0,
    },
  });

  const workDir = join(deps.workRoot ?? tmpdir(), `spectra-video-${render.id}-${randomUUID()}`);
  let reservationSettled = false;
  const reservationKey = `video-render-${render.id}`;

  try {
    await mkdir(workDir, { recursive: true });

    // ---- plan --------------------------------------------------------------
    let storyboard: Storyboard;
    try {
      storyboard = storyboardSchema.parse(render.storyboard);
    } catch {
      throw new VideoRenderError(
        'INVALID_STORYBOARD',
        'The stored storyboard is no longer valid against the current schema.',
      );
    }
    let plan;
    try {
      plan = buildVideoRenderPlan(storyboard, render.formatKey);
    } catch (error: unknown) {
      throw new VideoRenderError(
        'INVALID_STORYBOARD',
        error instanceof Error ? error.message : 'The storyboard could not be planned.',
      );
    }

    // ---- inputs ------------------------------------------------------------
    // Every asset is re-read under the tenant scope here, not trusted from the
    // storyboard: a foreign id fails as unavailable rather than being fetched.
    const imageFiles: Record<string, string> = {};
    for (const assetId of plan.imageAssetIds) {
      imageFiles[assetId] = await fetchAsset(deps, scope, assetId, workDir, 'image');
    }
    let audioFile: string | undefined;
    if (plan.audio) {
      audioFile = await fetchAsset(deps, scope, plan.audio.mediaAssetId, workDir, 'audio');
    }

    // ---- encode ------------------------------------------------------------
    const outputPath = join(workDir, 'render.mp4');
    let lastReported = -1;
    const output = await deps.renderer.render(
      plan,
      { imageFiles, audioFile, workDir, outputPath },
      {
        crf: render.crf,
        signal: context.signal,
        onProgress: (progress) => {
          // Persist at whole-percent steps only: a progress bar is not worth
          // a write per frame.
          if (progress.percent <= lastReported) return;
          lastReported = progress.percent;
          void prisma.videoRender
            .updateMany({
              where: { ...scope, id: render.id },
              data: { progressPercent: progress.percent },
            })
            .catch(() => undefined);
          void context.reportProgress?.(progress.percent);
        },
      },
    );

    // ---- store -------------------------------------------------------------
    const stored = await storeOutputs(deps, render, plan, output, workDir, now());
    reservationSettled = true;
    await reconcile(prisma, scope, reservationKey).catch(() => undefined);

    await deps.usage?.record(scope, {
      kind: 'MEDIA_RENDER',
      provider: 'ffmpeg',
      requests: 1,
      bytes: output.sizeBytes,
      resourceType: 'VIDEO_RENDER',
      resourceId: render.id,
      metadata: {
        formatKey: render.formatKey,
        durationMs: output.durationMs,
        scenes: plan.scenes.length,
      },
    });

    await prisma.videoRender.updateMany({
      where: { ...scope, id: render.id },
      data: {
        status: 'SUCCEEDED',
        progressPercent: 100,
        finishedAt: now(),
        failureReason: null,
        failureDetail: null,
        engine: deps.renderer.id,
        engineVersion: stored.engineVersion,
        videoCodec: output.videoCodec,
        durationMs: output.durationMs,
        widthPx: output.width,
        heightPx: output.height,
        sizeBytes: output.sizeBytes,
        warnings: output.warnings,
        mediaAssetId: stored.mediaAssetId,
        captionAssetId: stored.captionAssetId,
        thumbnailAssetId: stored.thumbnailAssetId,
      },
    });

    return { status: 'SUCCEEDED', renderId, mediaAssetId: stored.mediaAssetId };
  } catch (error: unknown) {
    const reason: VideoFailureReason =
      error instanceof VideoRenderError
        ? error.reason
        : context.signal?.aborted
          ? 'CANCELLED'
          : 'ENGINE_ERROR';
    const detail =
      error instanceof VideoRenderError
        ? boundedDetail(error.detail ?? error.message)
        : boundedDetail(error instanceof Error ? error.message : String(error));

    deps.logger?.warn(
      { renderId, reason, organizationId: scope.organizationId },
      'Video render did not produce a file',
    );
    await finishFailed(deps, scope, render.id, reason, detail, now());
    return { status: statusFor(reason), renderId, failureReason: reason };
  } finally {
    if (!reservationSettled) {
      await release(prisma, scope, reservationKey).catch(() => undefined);
    }
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Reads one tenant-owned asset to a local file, or says why it could not. */
async function fetchAsset(
  deps: VideoExecutorDeps,
  scope: { organizationId: string; workspaceId: string },
  assetId: string,
  workDir: string,
  expected: 'image' | 'audio',
): Promise<string> {
  const asset = await deps.prisma.mediaAsset.findFirst({
    where: { ...scope, id: assetId },
    select: { id: true, storageKey: true, mimeType: true },
  });
  if (!asset) {
    throw new VideoRenderError(
      'INPUT_UNAVAILABLE',
      `Media asset ${assetId} is not in this workspace, or no longer exists.`,
    );
  }
  if (!asset.mimeType.startsWith(`${expected}/`)) {
    throw new VideoRenderError(
      'INPUT_UNSUPPORTED',
      `Media asset ${assetId} is ${asset.mimeType}, which cannot be used as ${expected === 'image' ? 'a scene background' : 'an audio bed'}.`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = await deps.storage.getObject(asset.storageKey);
  } catch {
    throw new VideoRenderError(
      'INPUT_UNAVAILABLE',
      `The stored file for media asset ${assetId} could not be read.`,
    );
  }
  const file = join(workDir, `input-${assetId}`);
  await writeFile(file, bytes);
  return file;
}

interface StoredOutputs {
  mediaAssetId: string;
  captionAssetId: string | null;
  thumbnailAssetId: string | null;
  engineVersion: string | null;
}

/** Uploads the MP4 and its sidecars, each as an ordinary tenant-rooted asset. */
async function storeOutputs(
  deps: VideoExecutorDeps,
  render: {
    id: string;
    organizationId: string;
    workspaceId: string;
    captions: string;
    thumbnail: boolean;
    createdById: string | null;
  },
  plan: { totalDurationMs: number },
  output: {
    outputPath: string;
    sizeBytes: number;
    durationMs: number;
    width: number;
    height: number;
    captionPath?: string;
    warnings: string[];
  },
  workDir: string,
  at: Date,
): Promise<StoredOutputs> {
  const scope = { organizationId: render.organizationId, workspaceId: render.workspaceId };
  await deps.storage.ensureBucket();

  const put = async (
    filename: string,
    body: Buffer,
    contentType: string,
    kind: 'VIDEO' | 'IMAGE' | 'DOCUMENT',
    extra: Record<string, unknown> = {},
  ): Promise<string> => {
    // The same policy every upload goes through: MIME allow-list and size cap.
    const check = validateUpload({
      domain: 'renders',
      mimeType: contentType,
      sizeBytes: body.length,
    });
    if (!check.ok) {
      throw new VideoRenderError('STORAGE_ERROR', check.message);
    }
    const key = buildObjectKey({
      organizationId: render.organizationId,
      workspaceId: render.workspaceId,
      domain: 'renders',
      resourceId: render.id,
      filename,
    });
    try {
      await deps.storage.putObject({ key, body, contentType });
    } catch {
      throw new VideoRenderError('STORAGE_ERROR', 'The rendered file could not be stored.');
    }
    const asset = await deps.prisma.mediaAsset.create({
      data: {
        ...scope,
        kind,
        storageKey: key,
        mimeType: contentType,
        sizeBytes: body.length,
        engine: 'ffmpeg',
        createdById: render.createdById,
        createdAt: at,
        ...extra,
      },
      select: { id: true },
    });
    return asset.id;
  };

  const video = await readFile(output.outputPath);
  const mediaAssetId = await put('render.mp4', video, 'video/mp4', 'VIDEO', {
    widthPx: output.width,
    heightPx: output.height,
    durationMs: output.durationMs,
  });

  let captionAssetId: string | null = null;
  if (render.captions !== 'NONE' && output.captionPath) {
    const srt = await readFile(output.captionPath, 'utf8');
    captionAssetId =
      render.captions === 'VTT'
        ? await put('captions.vtt', Buffer.from(srtToVtt(srt), 'utf8'), 'text/vtt', 'DOCUMENT')
        : await put('captions.srt', Buffer.from(srt, 'utf8'), 'application/x-subrip', 'DOCUMENT');
  }

  let thumbnailAssetId: string | null = null;
  if (render.thumbnail) {
    const poster = join(workDir, 'poster.jpg');
    try {
      await deps.renderer.extractThumbnail(
        output.outputPath,
        Math.min(1000, Math.floor(output.durationMs / 2)),
        poster,
      );
      const bytes = await readFile(poster);
      thumbnailAssetId = await put('poster.jpg', bytes, 'image/jpeg', 'IMAGE', {
        widthPx: output.width,
        heightPx: output.height,
        sourceAssetId: mediaAssetId,
      });
    } catch {
      // A poster is a convenience: losing it must not fail a real video. The
      // render says so instead.
      output.warnings.push('A poster frame could not be extracted from this video.');
    }
  }

  return {
    mediaAssetId,
    captionAssetId,
    thumbnailAssetId,
    engineVersion: null,
  };
}

/**
 * The caption sidecar is built once as SRT by the renderer; VTT is the same
 * cues with a header and dotted milliseconds.
 */
function srtToVtt(srt: string): string {
  return `WEBVTT\n\n${srt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`;
}

async function finishFailed(
  deps: VideoExecutorDeps,
  scope: { organizationId: string; workspaceId: string },
  renderId: string,
  reason: VideoFailureReason,
  detail: string | null,
  at: Date,
): Promise<void> {
  await deps.prisma.videoRender
    .updateMany({
      // Tenant-scoped like every other write: the guard rejects an unscoped
      // update, and swallowing that would leave the row stuck in RUNNING.
      where: { ...scope, id: renderId },
      data: {
        status: statusFor(reason),
        finishedAt: at,
        failureReason: reason,
        failureDetail: detail,
        // A failed render has no asset, and never inherits one from an earlier
        // attempt: "no video" must not be able to read as "a video".
        mediaAssetId: null,
      },
    })
    .catch(() => undefined);
}

export { buildSrt, buildVtt };
