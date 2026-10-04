import { createHash } from 'node:crypto';

import type { PodcastScript, PodcastSegment, TranscriptCue } from '@spectra/contracts';

/**
 * Script → mix plan. Pure and deterministic, like the video planner: the same
 * script and inputs always produce the same plan, which is what makes renders
 * idempotent and the FFmpeg argument tests exact.
 */

export class AudioPlanError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join(' '));
    this.name = 'AudioPlanError';
    this.problems = problems;
  }
}

export interface PlannedSegment {
  index: number;
  id: string;
  kind: PodcastSegment['kind'];
  title: string | null;
  gainDb: number;
  source:
    | { kind: 'UPLOADED'; mediaAssetId: string }
    | { kind: 'SILENCE'; durationMs: number }
    | { kind: 'TEXT_TO_SPEECH'; voiceProfileId: string; text: string };
  /** Known only after the inputs are probed; silence knows its own length. */
  durationMs: number | null;
  /** Filled in once every preceding duration is known. */
  startMs: number | null;
}

export interface AudioRenderPlan {
  segments: PlannedSegment[];
  musicBed: {
    mediaAssetId: string;
    gainDb: number;
    fadeInMs: number;
    fadeOutMs: number;
  } | null;
  normalize: boolean;
  targetLufs: number;
  /** Every audio asset the renderer must fetch, in order, deduplicated. */
  audioAssetIds: string[];
  /** Voices the script asks to speak — each must pass the consent gate. */
  voiceProfileIds: string[];
  /** True when any segment needs a synthesis provider. */
  requiresSynthesis: boolean;
  warnings: string[];
}

export function buildAudioRenderPlan(script: PodcastScript): AudioRenderPlan {
  const problems: string[] = [];
  const warnings: string[] = [];
  const audioAssetIds: string[] = [];
  const voiceProfileIds: string[] = [];

  const segments: PlannedSegment[] = script.segments.map((segment, index) => {
    if (segment.source.kind === 'UPLOADED') {
      if (!audioAssetIds.includes(segment.source.mediaAssetId)) {
        audioAssetIds.push(segment.source.mediaAssetId);
      }
    } else if (segment.source.kind === 'TEXT_TO_SPEECH') {
      if (!voiceProfileIds.includes(segment.source.voiceProfileId)) {
        voiceProfileIds.push(segment.source.voiceProfileId);
      }
    }
    return {
      index,
      id: segment.id,
      kind: segment.kind,
      title: segment.title ?? null,
      gainDb: segment.gainDb,
      source: segment.source,
      durationMs: segment.source.kind === 'SILENCE' ? segment.source.durationMs : null,
      startMs: null,
    };
  });

  if (segments.length === 0) problems.push('An episode needs at least one segment.');
  if (segments.every((segment) => segment.source.kind === 'SILENCE')) {
    problems.push('Every segment is silence, so this episode would have nothing to play.');
  }
  if (script.musicBed && !audioAssetIds.includes(script.musicBed.mediaAssetId)) {
    audioAssetIds.push(script.musicBed.mediaAssetId);
  }

  if (problems.length > 0) throw new AudioPlanError(problems);

  const spoken = segments.filter((segment) => segment.source.kind === 'TEXT_TO_SPEECH');
  if (spoken.length > 0) {
    warnings.push(
      `${spoken.length} segment${spoken.length === 1 ? '' : 's'} ask to be spoken by a synthesis provider.`,
    );
  }
  if (script.musicBed) {
    warnings.push(
      'A music bed is mixed under the whole episode. Spectra does not check its licensing — that stays the operator’s responsibility.',
    );
  }

  return {
    segments,
    musicBed: script.musicBed
      ? {
          mediaAssetId: script.musicBed.mediaAssetId,
          gainDb: script.musicBed.gainDb,
          fadeInMs: script.musicBed.fadeInMs,
          fadeOutMs: script.musicBed.fadeOutMs,
        }
      : null,
    normalize: script.normalize,
    targetLufs: script.targetLufs,
    audioAssetIds,
    voiceProfileIds,
    requiresSynthesis: spoken.length > 0,
    warnings,
  };
}

/**
 * Lays the segments on a timeline once every duration is known. Returns a new
 * plan rather than mutating, so the pre-probe plan stays comparable.
 */
export function withResolvedDurations(
  plan: AudioRenderPlan,
  durationsMs: Record<string, number>,
): AudioRenderPlan {
  let cursor = 0;
  const segments = plan.segments.map((segment) => {
    const duration =
      segment.source.kind === 'SILENCE'
        ? segment.source.durationMs
        : (durationsMs[segment.id] ?? null);
    const placed = { ...segment, durationMs: duration, startMs: cursor };
    cursor += duration ?? 0;
    return placed;
  });
  return { ...plan, segments };
}

export function totalDurationMs(plan: AudioRenderPlan): number {
  return plan.segments.reduce((sum, segment) => sum + (segment.durationMs ?? 0), 0);
}

/**
 * A transcript built from the script and the measured segment durations.
 *
 * This is `SCRIPT_DERIVED`, never `MACHINE_TRANSCRIBED`: the words come from
 * what was written, and the timings from how long each segment actually runs.
 * Nothing here listened to the audio, and the source field says so.
 */
export function buildScriptTranscript(plan: AudioRenderPlan): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  for (const segment of plan.segments) {
    if (segment.source.kind !== 'TEXT_TO_SPEECH') continue;
    if (segment.startMs === null || segment.durationMs === null) continue;
    cues.push({
      startMs: segment.startMs,
      endMs: segment.startMs + segment.durationMs,
      segmentId: segment.id,
      speaker: segment.title ?? null,
      text: segment.source.text.slice(0, 5000),
    });
  }
  return cues;
}

/** The idempotency key: the plan plus the identity of every input asset. */
export function audioRenderHash(
  plan: AudioRenderPlan,
  output: { kind: string; waveform: boolean },
  assetVersions: Record<string, string>,
): string {
  const canonical = JSON.stringify({
    segments: plan.segments.map((segment) => ({
      id: segment.id,
      kind: segment.kind,
      gainDb: segment.gainDb,
      source: segment.source,
    })),
    musicBed: plan.musicBed,
    normalize: plan.normalize,
    targetLufs: plan.targetLufs,
    output,
    assets: Object.keys(assetVersions)
      .sort()
      .map((id) => [id, assetVersions[id]]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
