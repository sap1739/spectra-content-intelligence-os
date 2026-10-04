import { createHash } from 'node:crypto';

import {
  type SceneText,
  type Storyboard,
  type VideoFormat,
  type VideoScene,
  videoFormatByKey,
} from '@spectra/contracts';

/**
 * Storyboard → render plan. Pure and deterministic: the same storyboard and
 * format always produce the same plan, which is what makes renders idempotent
 * and the FFmpeg argument tests exact.
 */

export class VideoPlanError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join(' '));
    this.name = 'VideoPlanError';
    this.problems = problems;
  }
}

export interface PlannedText {
  /** Stable key — the renderer writes the text to a file named after it. */
  key: string;
  text: string;
  /** Pixel font size, derived from the scene's size ratio and the frame. */
  fontSizePx: number;
  color: string;
  /** Baseline box: x is centred by ffmpeg, y is absolute. */
  yPx: number;
  background: 'NONE' | 'BAND' | 'BOX';
  /** Horizontal padding inside the box, in pixels. */
  padPx: number;
}

export interface PlannedScene {
  index: number;
  id: string;
  startMs: number;
  durationMs: number;
  background:
    | { kind: 'COLOR'; color: string }
    | {
        kind: 'IMAGE';
        mediaAssetId: string;
        motion: 'NONE' | 'ZOOM_IN' | 'ZOOM_OUT';
        fit: 'COVER' | 'CONTAIN';
        padColor: string;
      };
  texts: PlannedText[];
  caption: string | null;
}

export interface CaptionCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface VideoRenderPlan {
  format: VideoFormat;
  /** Final duration after transitions have eaten their overlap. */
  totalDurationMs: number;
  transitionMs: number;
  scenes: PlannedScene[];
  cues: CaptionCue[];
  burnCaptions: boolean;
  audio: { mediaAssetId: string; gainDb: number; fadeOutMs: number } | null;
  /** Every image asset the renderer must fetch, in scene order, deduplicated. */
  imageAssetIds: string[];
  /** What the plan had to do differently. Never a silent substitution. */
  warnings: string[];
}

/** Scenes in render order: intro, body, outro. */
function orderedScenes(storyboard: Storyboard): VideoScene[] {
  const scenes: VideoScene[] = [];
  if (storyboard.intro) scenes.push(storyboard.intro);
  scenes.push(...storyboard.scenes);
  if (storyboard.outro) scenes.push(storyboard.outro);
  return scenes;
}

function planText(
  scene: VideoScene,
  slot: 'heading' | 'body',
  text: SceneText,
  format: VideoFormat,
): PlannedText {
  const fontSizePx = Math.max(12, Math.round(format.height * text.sizeRatio));
  // A comfortable margin that scales with the frame rather than a magic number.
  const margin = Math.round(format.height * 0.08);
  const yPx =
    text.position === 'TOP'
      ? margin
      : text.position === 'BOTTOM'
        ? format.height - margin - fontSizePx
        : Math.round((format.height - fontSizePx) / 2) + (slot === 'body' ? fontSizePx + 12 : 0);
  return {
    key: `${scene.id}-${slot}`,
    text: text.text,
    fontSizePx,
    color: text.color,
    yPx: Math.max(0, Math.min(yPx, format.height - fontSizePx)),
    background: text.background,
    padPx: Math.round(fontSizePx * 0.35),
  };
}

/**
 * Builds the plan, or throws with EVERY problem at once — a storyboard with
 * three faults should not take three attempts to fix.
 */
export function buildVideoRenderPlan(storyboard: Storyboard, formatKey: string): VideoRenderPlan {
  const problems: string[] = [];
  const warnings: string[] = [];

  const format = videoFormatByKey(formatKey);
  if (!format) {
    throw new VideoPlanError([`Unknown video format "${formatKey}".`]);
  }

  const scenes = orderedScenes(storyboard);
  if (scenes.length === 0) problems.push('A storyboard needs at least one scene.');

  const transitionMs = storyboard.transitionMs;
  if (transitionMs > 0) {
    for (const scene of scenes) {
      // xfade consumes the tail of one scene and the head of the next; a
      // transition at least as long as a scene has nothing left to show.
      if (scene.durationMs <= transitionMs) {
        problems.push(
          `Scene "${scene.id}" is ${scene.durationMs}ms, which is not longer than the ${transitionMs}ms transition.`,
        );
      }
    }
  }

  const planned: PlannedScene[] = [];
  const cues: CaptionCue[] = [];
  const imageAssetIds: string[] = [];
  let cursorMs = 0;

  scenes.forEach((scene, index) => {
    const texts: PlannedText[] = [];
    if (scene.heading) texts.push(planText(scene, 'heading', scene.heading, format));
    if (scene.body) texts.push(planText(scene, 'body', scene.body, format));

    if (scene.background.kind === 'IMAGE') {
      if (!imageAssetIds.includes(scene.background.mediaAssetId)) {
        imageAssetIds.push(scene.background.mediaAssetId);
      }
    }

    planned.push({
      index,
      id: scene.id,
      startMs: cursorMs,
      durationMs: scene.durationMs,
      background: scene.background,
      texts,
      caption: scene.caption ?? null,
    });

    if (scene.caption) {
      cues.push({
        index: cues.length + 1,
        startMs: cursorMs,
        endMs: cursorMs + scene.durationMs,
        text: scene.caption,
      });
    }

    // Each transition overlaps the scenes it joins, so the timeline advances
    // by one scene minus one overlap.
    cursorMs += scene.durationMs - (index < scenes.length - 1 ? transitionMs : 0);
  });

  const totalDurationMs = cursorMs;
  const maxMs = format.maxDurationSeconds * 1000;
  if (totalDurationMs > maxMs) {
    problems.push(
      `This storyboard runs ${(totalDurationMs / 1000).toFixed(1)}s, longer than the ${format.maxDurationSeconds}s limit for ${format.label}.`,
    );
  }

  if (storyboard.burnCaptions && cues.length === 0) {
    problems.push('Captions cannot be burned in: no scene has caption text.');
  }

  if (problems.length > 0) throw new VideoPlanError(problems);

  if (cues.length > 0 && cues.length < scenes.length) {
    warnings.push(
      `${scenes.length - cues.length} of ${scenes.length} scenes have no caption text, so the caption file covers only part of the video.`,
    );
  }
  if (storyboard.audio && totalDurationMs < 1000) {
    warnings.push('The audio bed is longer than the video and will be cut at the end.');
  }

  return {
    format,
    totalDurationMs,
    transitionMs,
    scenes: planned,
    cues,
    burnCaptions: storyboard.burnCaptions,
    audio: storyboard.audio
      ? {
          mediaAssetId: storyboard.audio.mediaAssetId,
          gainDb: storyboard.audio.gainDb,
          fadeOutMs: storyboard.audio.fadeOutMs,
        }
      : null,
    imageAssetIds,
    warnings,
  };
}

/**
 * The idempotency key for a render: the plan plus the output settings plus the
 * version of every input asset. Unchanged inputs render once.
 */
export function videoRenderHash(
  plan: VideoRenderPlan,
  output: { crf: number; captions: string; thumbnail: boolean },
  assetVersions: Record<string, string>,
): string {
  const canonical = JSON.stringify({
    format: plan.format.key,
    totalDurationMs: plan.totalDurationMs,
    transitionMs: plan.transitionMs,
    burnCaptions: plan.burnCaptions,
    audio: plan.audio,
    scenes: plan.scenes.map((scene) => ({
      id: scene.id,
      durationMs: scene.durationMs,
      background: scene.background,
      caption: scene.caption,
      texts: scene.texts.map((text) => ({
        key: text.key,
        text: text.text,
        fontSizePx: text.fontSizePx,
        color: text.color,
        yPx: text.yPx,
        background: text.background,
      })),
    })),
    output,
    assets: Object.keys(assetVersions)
      .sort()
      .map((id) => [id, assetVersions[id]]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
