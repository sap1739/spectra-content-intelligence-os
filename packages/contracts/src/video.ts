import { z } from 'zod';

import { uuidSchema } from './common';
import { hexColorSchema } from './design';
import type { SocialPlatform } from './social';

/**
 * Video rendering contracts (Phase 7B, ADR-0041).
 *
 * A storyboard is composition DATA — scenes with durations, image or colour
 * backgrounds, text overlays and caption cues — never a filtergraph, a shell
 * string or markup. The planner turns it into a deterministic render plan and
 * the FFmpeg adapter turns that plan into a real MP4. Nothing here describes a
 * video that was not actually encoded: a render that did not finish carries a
 * failure reason, never a URL.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** What the storyboard is for. Shapes defaults and validation, not the engine. */
export const VIDEO_PROJECT_KINDS = [
  'SLIDESHOW',
  'VERTICAL_SHORT',
  'SQUARE_SOCIAL',
  'LANDSCAPE',
  'CAPTIONED',
  'AUDIOGRAM',
] as const;
export const videoProjectKindSchema = z.enum(VIDEO_PROJECT_KINDS);
export type VideoProjectKind = z.infer<typeof videoProjectKindSchema>;

export const VIDEO_PROJECT_STATUSES = ['DRAFT', 'READY', 'ARCHIVED'] as const;
export const videoProjectStatusSchema = z.enum(VIDEO_PROJECT_STATUSES);
export type VideoProjectStatus = z.infer<typeof videoProjectStatusSchema>;

/**
 * A render's life. Terminal states are SUCCEEDED, FAILED, CANCELLED and
 * TIMED_OUT — and only SUCCEEDED ever has an asset.
 */
export const VIDEO_RENDER_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
] as const;
export const videoRenderStatusSchema = z.enum(VIDEO_RENDER_STATUSES);
export type VideoRenderStatus = z.infer<typeof videoRenderStatusSchema>;

export const VIDEO_RENDER_TERMINAL_STATUSES = [
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
] as const satisfies readonly VideoRenderStatus[];

/**
 * Why a render did not produce a file. Every non-SUCCEEDED render carries
 * exactly one of these — "it failed" with no reason is not representable.
 */
export const VIDEO_FAILURE_REASONS = [
  /** No ffmpeg binary is configured or on PATH in this deployment. */
  'ENGINE_NOT_CONFIGURED',
  /** ffmpeg exists but lacks an encoder or filter this render needs. */
  'ENGINE_MISSING_CAPABILITY',
  /** A referenced media asset is gone, foreign, or not readable. */
  'INPUT_UNAVAILABLE',
  /** A referenced input is not a media type the engine can decode. */
  'INPUT_UNSUPPORTED',
  /** The storyboard itself is not renderable (validated before any work). */
  'INVALID_STORYBOARD',
  /** ffmpeg ran and exited non-zero. */
  'ENGINE_ERROR',
  /** The render exceeded its wall-clock limit and was stopped. */
  'TIMEOUT',
  /** A person or the system cancelled it. */
  'CANCELLED',
  /** Object storage refused or lost the output. */
  'STORAGE_ERROR',
  /** The workspace budget or an operation limit refused the render. */
  'BUDGET_REFUSED',
  /** The worker died, or the job exhausted its retries. */
  'WORKER_LOST',
] as const;
export const videoFailureReasonSchema = z.enum(VIDEO_FAILURE_REASONS);
export type VideoFailureReason = z.infer<typeof videoFailureReasonSchema>;

/** Human-readable text for a failure reason. The UI shows this verbatim. */
export const VIDEO_FAILURE_REASON_TEXT: Record<VideoFailureReason, string> = {
  ENGINE_NOT_CONFIGURED:
    'No video engine is configured in this deployment. Set FFMPEG_PATH, or install ffmpeg on the worker host.',
  ENGINE_MISSING_CAPABILITY:
    'The installed ffmpeg build is missing an encoder or filter this render needs.',
  INPUT_UNAVAILABLE: 'A media asset this storyboard references could not be read.',
  INPUT_UNSUPPORTED: 'A media asset this storyboard references is not a type the engine decodes.',
  INVALID_STORYBOARD: 'The storyboard could not be turned into a render plan.',
  ENGINE_ERROR: 'ffmpeg ran and reported an error.',
  TIMEOUT: 'The render took longer than its time limit and was stopped.',
  CANCELLED: 'The render was cancelled.',
  STORAGE_ERROR: 'The rendered file could not be stored.',
  BUDGET_REFUSED: 'The workspace budget refused this render before it started.',
  WORKER_LOST: 'The worker stopped before the render finished.',
};

// ---------------------------------------------------------------------------
// Output formats
// ---------------------------------------------------------------------------

export interface VideoFormat {
  key: string;
  label: string;
  width: number;
  height: number;
  fps: number;
  platform: SocialPlatform | null;
  /** What the size is, and where the number comes from. */
  note: string;
  /** The longest render this preset allows, in seconds. */
  maxDurationSeconds: number;
}

/**
 * Sizes a platform documents, plus the two neutral landscape sizes. Durations
 * are Spectra's own rendering ceilings, not platform limits — a platform's
 * limit is enforced by its publishing adapter, which owns that knowledge.
 */
export const VIDEO_FORMATS: readonly VideoFormat[] = [
  {
    key: 'VERTICAL_1080x1920',
    label: 'Vertical 9:16 (1080×1920)',
    width: 1080,
    height: 1920,
    fps: 30,
    platform: null,
    note: 'Full-screen vertical: Reels, Shorts, TikTok, Stories.',
    maxDurationSeconds: 180,
  },
  {
    key: 'SQUARE_1080x1080',
    label: 'Square 1:1 (1080×1080)',
    width: 1080,
    height: 1080,
    fps: 30,
    platform: null,
    note: 'Square feed video for Instagram, Facebook and LinkedIn.',
    maxDurationSeconds: 300,
  },
  {
    key: 'PORTRAIT_1080x1350',
    label: 'Portrait 4:5 (1080×1350)',
    width: 1080,
    height: 1350,
    fps: 30,
    platform: null,
    note: 'Tall feed video — the largest feed footprint Instagram allows.',
    maxDurationSeconds: 300,
  },
  {
    key: 'LANDSCAPE_1920x1080',
    label: 'Landscape 16:9 (1920×1080)',
    width: 1920,
    height: 1080,
    fps: 30,
    platform: 'YOUTUBE',
    note: 'YouTube-style 1080p landscape.',
    maxDurationSeconds: 600,
  },
  {
    key: 'LANDSCAPE_1280x720',
    label: 'Landscape 16:9 (1280×720)',
    width: 1280,
    height: 720,
    fps: 30,
    platform: 'YOUTUBE',
    note: '720p landscape — a smaller file for the same framing.',
    maxDurationSeconds: 600,
  },
] as const;

export const videoFormatKeySchema = z.enum(
  VIDEO_FORMATS.map((format) => format.key) as [string, ...string[]],
);

export function videoFormatByKey(key: string): VideoFormat | undefined {
  return VIDEO_FORMATS.find((format) => format.key === key);
}

// ---------------------------------------------------------------------------
// Storyboard
// ---------------------------------------------------------------------------

/** Where a scene's picture comes from. A scene always has a background. */
export const sceneBackgroundSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('COLOR'), color: hexColorSchema }),
  z.object({
    kind: z.literal('IMAGE'),
    mediaAssetId: uuidSchema,
    /** Ken Burns: a slow push in. Off by default — motion is a choice. */
    motion: z.enum(['NONE', 'ZOOM_IN', 'ZOOM_OUT']).default('NONE'),
    /** How the image fills a frame it does not match. */
    fit: z.enum(['COVER', 'CONTAIN']).default('COVER'),
    /** Letterbox colour when `fit` is CONTAIN. */
    padColor: hexColorSchema.default('#000000'),
  }),
]);
export type SceneBackground = z.infer<typeof sceneBackgroundSchema>;

export const SCENE_TEXT_POSITIONS = ['TOP', 'CENTER', 'BOTTOM'] as const;
export const sceneTextPositionSchema = z.enum(SCENE_TEXT_POSITIONS);
export type SceneTextPosition = z.infer<typeof sceneTextPositionSchema>;

export const sceneTextSchema = z.object({
  text: z.string().min(1).max(280),
  position: sceneTextPositionSchema.default('CENTER'),
  color: hexColorSchema.default('#FFFFFF'),
  /** Height of one line as a fraction of the frame height. */
  sizeRatio: z.number().min(0.02).max(0.2).default(0.06),
  /** A translucent band behind the text so it stays readable on any picture. */
  background: z.enum(['NONE', 'BAND', 'BOX']).default('BAND'),
});
export type SceneText = z.infer<typeof sceneTextSchema>;

export const MIN_SCENE_MS = 500;
export const MAX_SCENE_MS = 60_000;

export const videoSceneSchema = z.object({
  id: z.string().min(1).max(64),
  durationMs: z.number().int().min(MIN_SCENE_MS).max(MAX_SCENE_MS),
  background: sceneBackgroundSchema,
  /** Headline and supporting line, each drawn as its own overlay. */
  heading: sceneTextSchema.nullish(),
  body: sceneTextSchema.nullish(),
  /**
   * Spoken or on-screen words for this scene, used to build SRT/VTT cues.
   * Captions are authored, never transcribed — Spectra has no STT provider.
   */
  caption: z.string().max(500).nullish(),
});
export type VideoScene = z.infer<typeof videoSceneSchema>;

export const MAX_SCENES = 60;

export const storyboardSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    scenes: z.array(videoSceneSchema).min(1).max(MAX_SCENES),
    /** An optional title card before the first scene, and an end card after the last. */
    intro: videoSceneSchema.nullish(),
    outro: videoSceneSchema.nullish(),
    /** A crossfade between scenes, in milliseconds. 0 means hard cuts. */
    transitionMs: z.number().int().min(0).max(2000).default(0),
    /** A bed of audio under the whole video. */
    audio: z
      .object({
        mediaAssetId: uuidSchema,
        gainDb: z.number().min(-40).max(10).default(0),
        /** Fade the bed out over the last N ms. */
        fadeOutMs: z.number().int().min(0).max(10_000).default(1000),
      })
      .nullish(),
    /** Burn the caption cues into the picture as well as emitting a sidecar file. */
    burnCaptions: z.boolean().default(false),
  })
  .superRefine((storyboard, ctx) => {
    const ids = new Set<string>();
    for (const scene of [storyboard.intro, ...storyboard.scenes, storyboard.outro]) {
      if (!scene) continue;
      if (ids.has(scene.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scenes'],
          message: `Duplicate scene id "${scene.id}".`,
        });
      }
      ids.add(scene.id);
    }
    if (storyboard.burnCaptions) {
      const hasCaption = [storyboard.intro, ...storyboard.scenes, storyboard.outro].some(
        (scene) => scene?.caption,
      );
      if (!hasCaption) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['burnCaptions'],
          message: 'Captions cannot be burned in: no scene has caption text.',
        });
      }
    }
  });
export type Storyboard = z.infer<typeof storyboardSchema>;

// ---------------------------------------------------------------------------
// API inputs
// ---------------------------------------------------------------------------

export const createVideoProjectInputSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullish(),
  kind: videoProjectKindSchema,
  formatKey: videoFormatKeySchema,
  brandId: uuidSchema.nullish(),
  contentItemId: uuidSchema.nullish(),
  campaignId: uuidSchema.nullish(),
  storyboard: storyboardSchema,
});
export type CreateVideoProjectInput = z.infer<typeof createVideoProjectInputSchema>;

export const updateVideoProjectInputSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(1000).nullish(),
    formatKey: videoFormatKeySchema.optional(),
    brandId: uuidSchema.nullish(),
    contentItemId: uuidSchema.nullish(),
    campaignId: uuidSchema.nullish(),
    storyboard: storyboardSchema.optional(),
    status: videoProjectStatusSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update.');
export type UpdateVideoProjectInput = z.infer<typeof updateVideoProjectInputSchema>;

export const VIDEO_CAPTION_FORMATS = ['NONE', 'SRT', 'VTT'] as const;
export const videoCaptionFormatSchema = z.enum(VIDEO_CAPTION_FORMATS);
export type VideoCaptionFormat = z.infer<typeof videoCaptionFormatSchema>;

export const startVideoRenderInputSchema = z.object({
  /** Overrides the project's format for this render only. */
  formatKey: videoFormatKeySchema.optional(),
  /** Emit a caption sidecar alongside the MP4. */
  captions: videoCaptionFormatSchema.default('NONE'),
  /** Also extract a still frame as a poster image. */
  thumbnail: z.boolean().default(true),
  /** Where in the video the poster frame is taken from. */
  thumbnailAtMs: z.number().int().nonnegative().nullish(),
  /** Constant Rate Factor: lower is better quality and a bigger file. */
  crf: z.number().int().min(18).max(34).default(23),
});
export type StartVideoRenderInput = z.infer<typeof startVideoRenderInputSchema>;
