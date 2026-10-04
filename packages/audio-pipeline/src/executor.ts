import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type AudioFailureReason,
  type PodcastScript,
  podcastScriptSchema,
} from '@spectra/contracts';
import {
  VoiceConsentError,
  buildAudioRenderPlan,
  buildScriptTranscript,
  evaluateVoiceUsability,
  totalDurationMs,
  withResolvedDurations,
} from '@spectra/audio-core';
import type { SpectraPrismaClient } from '@spectra/database';
import type { Logger } from '@spectra/logging';
import { VideoRenderError } from '@spectra/media-ffmpeg';
import type { FfmpegAudioRenderer } from '@spectra/media-ffmpeg';
import { reconcile, release, type UsageRecorder } from '@spectra/metering';
import { type ObjectStorageProvider, buildObjectKey, validateUpload } from '@spectra/storage';

/**
 * Executing one audio render.
 *
 * Three rules, in the order they are enforced:
 *
 *  1. **Consent before anything.** Every cloned voice the script speaks with is
 *     re-checked here, against the database, at render time — not just when the
 *     episode was saved. A revoked consent stops a render that was already
 *     queued.
 *  2. **No fabricated speech.** A segment that asks to be spoken fails with
 *     `TTS_NOT_CONFIGURED` when no synthesis provider exists. Nothing is
 *     substituted, and silence is never passed off as a voice.
 *  3. **One terminal state, always with a reason**, and only SUCCEEDED has an
 *     asset.
 */

export interface AudioExecutorDeps {
  prisma: SpectraPrismaClient;
  storage: ObjectStorageProvider;
  renderer: FfmpegAudioRenderer;
  usage?: UsageRecorder;
  logger?: Logger;
  /** Registered synthesis adapters. Empty today — see ADR-0042. */
  synthesis?: {
    available: boolean;
    synthesize(input: { voiceProfileId: string; text: string; outputPath: string }): Promise<void>;
  };
  workRoot?: string;
  now?: () => Date;
}

export interface AudioExecutorContext {
  signal?: AbortSignal;
  reportProgress?: (percent: number) => Promise<void> | void;
  attempt?: number;
}

export interface AudioExecutionResult {
  status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'SKIPPED';
  renderId: string;
  mediaAssetId?: string;
  failureReason?: AudioFailureReason;
  skipped?: boolean;
}

function statusFor(reason: AudioFailureReason): 'FAILED' | 'CANCELLED' | 'TIMED_OUT' {
  if (reason === 'CANCELLED') return 'CANCELLED';
  if (reason === 'TIMEOUT') return 'TIMED_OUT';
  return 'FAILED';
}

function boundedDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  return detail.replace(/\s+/g, ' ').trim().slice(0, 500) || null;
}

/** Maps the ffmpeg adapter's video-shaped reasons onto audio ones. */
function reasonFromError(error: unknown, aborted: boolean): AudioFailureReason {
  if (error instanceof VoiceConsentError) return 'VOICE_CONSENT_MISSING';
  if (error instanceof VideoRenderError) {
    switch (error.reason) {
      case 'ENGINE_NOT_CONFIGURED':
        return 'ENGINE_NOT_CONFIGURED';
      case 'ENGINE_MISSING_CAPABILITY':
        return 'ENGINE_MISSING_CAPABILITY';
      case 'INPUT_UNAVAILABLE':
        return 'INPUT_UNAVAILABLE';
      case 'INPUT_UNSUPPORTED':
        return 'INPUT_UNSUPPORTED';
      case 'TIMEOUT':
        return 'TIMEOUT';
      case 'CANCELLED':
        return 'CANCELLED';
      case 'STORAGE_ERROR':
        return 'STORAGE_ERROR';
      default:
        return 'ENGINE_ERROR';
    }
  }
  return aborted ? 'CANCELLED' : 'ENGINE_ERROR';
}

export async function executeAudioRender(
  deps: AudioExecutorDeps,
  renderId: string,
  context: AudioExecutorContext = {},
): Promise<AudioExecutionResult> {
  const now = deps.now ?? (() => new Date());
  const { prisma } = deps;

  const render = await prisma.audioRender.findUnique({
    where: { id: renderId },
    include: { episode: true },
  });
  if (!render) return { status: 'SKIPPED', renderId, skipped: true };

  const scope = { organizationId: render.organizationId, workspaceId: render.workspaceId };

  if (render.status !== 'QUEUED' && render.status !== 'RUNNING') {
    return { status: 'SKIPPED', renderId, skipped: true };
  }
  if (render.cancelRequestedAt) {
    await finishFailed(deps, scope, render.id, 'CANCELLED', null, now());
    return { status: 'CANCELLED', renderId, failureReason: 'CANCELLED' };
  }

  await prisma.audioRender.updateMany({
    where: { ...scope, id: render.id },
    data: {
      status: 'RUNNING',
      startedAt: render.startedAt ?? now(),
      attempt: context.attempt ?? render.attempt + 1,
      progressPercent: 0,
    },
  });

  const workDir = join(deps.workRoot ?? tmpdir(), `spectra-audio-${render.id}-${randomUUID()}`);
  let reservationSettled = false;
  const reservationKey = `audio-render-${render.id}`;

  try {
    await mkdir(workDir, { recursive: true });

    let script: PodcastScript;
    try {
      script = podcastScriptSchema.parse(render.script);
    } catch {
      throw new AudioStageError('INVALID_SCRIPT', 'The stored script no longer validates.');
    }
    let plan;
    try {
      plan = buildAudioRenderPlan(script);
    } catch (error: unknown) {
      throw new AudioStageError(
        'INVALID_SCRIPT',
        error instanceof Error ? error.message : 'The script could not be planned.',
      );
    }

    // ---- consent, before any work ------------------------------------------
    await assertVoicesConsented(
      deps,
      scope,
      plan.voiceProfileIds,
      render.episode.consentScope,
      now(),
    );

    // ---- synthesis, or an honest refusal ------------------------------------
    if (plan.requiresSynthesis && !deps.synthesis?.available) {
      const spoken = plan.segments.filter((segment) => segment.source.kind === 'TEXT_TO_SPEECH');
      throw new AudioStageError(
        'TTS_NOT_CONFIGURED',
        `${spoken.length} segment${spoken.length === 1 ? '' : 's'} ask to be spoken, and no speech-synthesis provider is configured in this deployment.`,
      );
    }

    // ---- inputs -------------------------------------------------------------
    const audioFiles: Record<string, string> = {};
    for (const assetId of plan.audioAssetIds) {
      audioFiles[assetId] = await fetchAudioAsset(deps, scope, assetId, workDir);
    }

    const spokenFiles: Record<string, string> = {};
    if (plan.requiresSynthesis && deps.synthesis?.available) {
      for (const segment of plan.segments) {
        if (segment.source.kind !== 'TEXT_TO_SPEECH') continue;
        const outputPath = join(workDir, `spoken-${segment.id}.mp3`);
        await deps.synthesis.synthesize({
          voiceProfileId: segment.source.voiceProfileId,
          text: segment.source.text,
          outputPath,
        });
        spokenFiles[segment.id] = outputPath;
      }
    }

    // ---- mix ----------------------------------------------------------------
    const outputPath = join(workDir, 'episode.mp3');
    // Measure each segment so the transcript timeline is real rather than
    // guessed from the script.
    const durations: Record<string, number> = {};
    for (const segment of plan.segments) {
      if (segment.source.kind === 'SILENCE') continue;
      const file =
        segment.source.kind === 'UPLOADED'
          ? audioFiles[segment.source.mediaAssetId]
          : spokenFiles[segment.id];
      if (!file) continue;
      const probe = await deps.renderer.probeAudio(file);
      if (probe.durationMs === null) {
        throw new AudioStageError(
          'INPUT_UNSUPPORTED',
          `Segment "${segment.id}" references a file the engine cannot decode as audio.`,
        );
      }
      durations[segment.id] = probe.durationMs;
    }
    const placed = withResolvedDurations(plan, durations);
    const estimatedMs = totalDurationMs(placed);

    let lastReported = -1;
    const mix = await deps.renderer.mix(
      plan,
      { audioFiles, spokenFiles, outputPath },
      {
        ...(context.signal ? { signal: context.signal } : {}),
        estimatedMs,
        onProgress: (progress) => {
          if (progress.percent <= lastReported) return;
          lastReported = progress.percent;
          void prisma.audioRender
            .updateMany({
              where: { ...scope, id: render.id },
              data: { progressPercent: progress.percent },
            })
            .catch(() => undefined);
          void context.reportProgress?.(progress.percent);
        },
      },
    );

    // ---- waveform (a convenience, never a reason to fail) --------------------
    let waveformAssetId: string | null = null;
    const warnings = [...mix.warnings];
    if (render.kind === 'EPISODE_MIX') {
      const waveformPath = join(workDir, 'waveform.png');
      try {
        await deps.renderer.waveform(outputPath, waveformPath);
        waveformAssetId = await storeAsset(
          deps,
          render,
          'waveform.png',
          await readFile(waveformPath),
          'image/png',
          'IMAGE',
          now(),
        );
      } catch {
        warnings.push('A waveform picture could not be drawn for this episode.');
      }
    }

    // ---- store --------------------------------------------------------------
    const mediaAssetId = await storeAsset(
      deps,
      render,
      'episode.mp3',
      await readFile(outputPath),
      'audio/mpeg',
      'AUDIO',
      now(),
      { durationMs: mix.durationMs },
    );

    // ---- transcript ---------------------------------------------------------
    // SCRIPT_DERIVED, and labelled as such: the words come from the script and
    // the timings from the measured segments. Nothing listened to the audio.
    const cues = buildScriptTranscript(placed);
    if (cues.length > 0) {
      await prisma.transcript.create({
        data: {
          ...scope,
          episodeId: render.episodeId,
          audioAssetId: mediaAssetId,
          source: 'SCRIPT_DERIVED',
          language: 'en',
          cues: cues as unknown as object,
        },
      });
    }

    reservationSettled = true;
    await reconcile(prisma, scope, reservationKey).catch(() => undefined);

    await deps.usage?.record(scope, {
      kind: 'MEDIA_RENDER',
      provider: 'ffmpeg',
      requests: 1,
      bytes: mix.sizeBytes,
      resourceType: 'AUDIO_RENDER',
      resourceId: render.id,
      metadata: {
        kind: render.kind,
        durationMs: mix.durationMs,
        segments: plan.segments.length,
      },
    });

    await prisma.audioRender.updateMany({
      where: { ...scope, id: render.id },
      data: {
        status: 'SUCCEEDED',
        progressPercent: 100,
        finishedAt: now(),
        failureReason: null,
        failureDetail: null,
        engine: deps.renderer.id,
        audioCodec: mix.audioCodec,
        durationMs: mix.durationMs,
        sizeBytes: mix.sizeBytes,
        integratedLufs: mix.integratedLufs,
        warnings,
        mediaAssetId,
        waveformAssetId,
      },
    });

    await prisma.podcastEpisode.updateMany({
      where: { ...scope, id: render.episodeId },
      data: {
        status: 'READY',
        audioAssetId: mediaAssetId,
        durationMs: mix.durationMs,
        integratedLufs: mix.integratedLufs,
      },
    });

    return { status: 'SUCCEEDED', renderId, mediaAssetId };
  } catch (error: unknown) {
    const reason =
      error instanceof AudioStageError
        ? error.reason
        : reasonFromError(error, Boolean(context.signal?.aborted));
    const detail =
      error instanceof AudioStageError
        ? boundedDetail(error.message)
        : error instanceof VideoRenderError
          ? boundedDetail(error.detail ?? error.message)
          : boundedDetail(error instanceof Error ? error.message : String(error));

    deps.logger?.warn(
      { renderId, reason, organizationId: scope.organizationId },
      'Audio render did not produce a file',
    );
    await finishFailed(deps, scope, render.id, reason, detail, now());
    // The episode goes back to where it was: a failed render must not leave it
    // looking like it has audio.
    await prisma.podcastEpisode
      .updateMany({
        where: { ...scope, id: render.episodeId, status: 'RENDERING' },
        data: { status: 'READY_TO_RENDER' },
      })
      .catch(() => undefined);
    return { status: statusFor(reason), renderId, failureReason: reason };
  } finally {
    if (!reservationSettled) {
      await release(prisma, scope, reservationKey).catch(() => undefined);
    }
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** A failure raised by this pipeline rather than by the engine. */
class AudioStageError extends Error {
  readonly reason: AudioFailureReason;
  constructor(reason: AudioFailureReason, message: string) {
    super(message);
    this.name = 'AudioStageError';
    this.reason = reason;
  }
}

/**
 * Re-checks consent against the database at render time.
 *
 * Checking at save time is not enough: a person can revoke consent after an
 * episode is queued, and that revocation must stop the render.
 */
async function assertVoicesConsented(
  deps: AudioExecutorDeps,
  scope: { organizationId: string; workspaceId: string },
  voiceProfileIds: readonly string[],
  consentScope: string,
  now: Date,
): Promise<void> {
  for (const voiceProfileId of voiceProfileIds) {
    const voice = await deps.prisma.voiceProfile.findFirst({
      where: { ...scope, id: voiceProfileId, deletedAt: null },
      include: { consents: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    if (!voice) {
      throw new AudioStageError(
        'INPUT_UNAVAILABLE',
        `Voice ${voiceProfileId} is not in this workspace, or no longer exists.`,
      );
    }
    const consent = voice.consents[0] ?? null;
    const verdict = evaluateVoiceUsability({
      voiceProfileId,
      kind: voice.kind,
      consent: consent
        ? {
            status: consent.status,
            scopes: consent.scopes,
            expiresAt: consent.expiresAt,
            revokedAt: consent.revokedAt,
          }
        : null,
      scope: consentScope as never,
      now,
    });
    if (!verdict.usable && verdict.reason) {
      throw new VoiceConsentError(verdict.reason, voiceProfileId, verdict.message ?? undefined);
    }
  }
}

/** Reads one tenant-owned audio asset to a local file, or says why it could not. */
async function fetchAudioAsset(
  deps: AudioExecutorDeps,
  scope: { organizationId: string; workspaceId: string },
  assetId: string,
  workDir: string,
): Promise<string> {
  const asset = await deps.prisma.mediaAsset.findFirst({
    where: { ...scope, id: assetId },
    select: { id: true, storageKey: true, mimeType: true },
  });
  if (!asset) {
    throw new AudioStageError(
      'INPUT_UNAVAILABLE',
      `Media asset ${assetId} is not in this workspace, or no longer exists.`,
    );
  }
  if (!asset.mimeType.startsWith('audio/')) {
    throw new AudioStageError(
      'INPUT_UNSUPPORTED',
      `Media asset ${assetId} is ${asset.mimeType}, which cannot be used as audio.`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = await deps.storage.getObject(asset.storageKey);
  } catch {
    throw new AudioStageError(
      'INPUT_UNAVAILABLE',
      `The stored file for media asset ${assetId} could not be read.`,
    );
  }
  const file = join(workDir, `input-${assetId}`);
  await writeFile(file, bytes);
  return file;
}

/** Stores one output as an ordinary tenant-rooted media asset. */
async function storeAsset(
  deps: AudioExecutorDeps,
  render: { id: string; organizationId: string; workspaceId: string; createdById: string | null },
  filename: string,
  body: Buffer,
  contentType: string,
  kind: 'AUDIO' | 'IMAGE' | 'VIDEO',
  at: Date,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const check = validateUpload({
    domain: 'renders',
    mimeType: contentType,
    sizeBytes: body.length,
  });
  if (!check.ok) throw new AudioStageError('STORAGE_ERROR', check.message);

  const key = buildObjectKey({
    organizationId: render.organizationId,
    workspaceId: render.workspaceId,
    domain: 'renders',
    resourceId: render.id,
    filename,
  });
  await deps.storage.ensureBucket();
  try {
    await deps.storage.putObject({ key, body, contentType });
  } catch {
    throw new AudioStageError('STORAGE_ERROR', 'The rendered audio could not be stored.');
  }
  const asset = await deps.prisma.mediaAsset.create({
    data: {
      organizationId: render.organizationId,
      workspaceId: render.workspaceId,
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
}

async function finishFailed(
  deps: AudioExecutorDeps,
  scope: { organizationId: string; workspaceId: string },
  renderId: string,
  reason: AudioFailureReason,
  detail: string | null,
  at: Date,
): Promise<void> {
  await deps.prisma.audioRender
    .updateMany({
      where: { ...scope, id: renderId },
      data: {
        status: statusFor(reason),
        finishedAt: at,
        failureReason: reason,
        failureDetail: detail,
        // A failed render has no asset, and never inherits one.
        mediaAssetId: null,
      },
    })
    .catch(() => undefined);
}
