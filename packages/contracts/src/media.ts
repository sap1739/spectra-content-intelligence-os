import { z } from 'zod';

import { isoDateTimeSchema, tenantScopeSchema, uuidSchema } from './common';
import { socialPlatformSchema } from './social';

/**
 * Media asset + rendering job contracts. Provider interfaces live in
 * @spectra/media-core; these are the data shapes they exchange.
 * No rendering is implemented in Phase 1.
 */

export const mediaKindSchema = z.enum(['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'OTHER']);

export const mediaAssetRefSchema = z
  .object({
    id: uuidSchema,
    kind: mediaKindSchema,
    /** Tenant-scoped object storage key. */
    storageKey: z.string().min(1),
    mimeType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    checksum: z.string().nullish(),
    widthPx: z.number().int().positive().nullish(),
    heightPx: z.number().int().positive().nullish(),
    durationMs: z.number().int().nonnegative().nullish(),
    createdAt: isoDateTimeSchema,
  })
  .merge(tenantScopeSchema);
export type MediaAssetRef = z.infer<typeof mediaAssetRefSchema>;

export const aspectRatioTargetSchema = z.object({
  name: z.string().min(1).max(100),
  platform: socialPlatformSchema.optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type AspectRatioTarget = z.infer<typeof aspectRatioTargetSchema>;

/** Sharp-oriented image operation pipeline. */
export const imageOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('resize'),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    fit: z.enum(['cover', 'contain', 'fill', 'inside', 'outside']).default('cover'),
  }),
  z.object({
    kind: z.literal('crop'),
    left: z.number().int().nonnegative(),
    top: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.object({ kind: z.literal('rotate'), degrees: z.number() }),
  z.object({
    kind: z.literal('overlay'),
    overlayStorageKey: z.string().min(1),
    gravity: z
      .enum([
        'north',
        'south',
        'east',
        'west',
        'center',
        'northeast',
        'northwest',
        'southeast',
        'southwest',
      ])
      .default('center'),
  }),
  z.object({
    kind: z.literal('format'),
    format: z.enum(['jpeg', 'png', 'webp', 'avif']),
    quality: z.number().int().min(1).max(100).optional(),
  }),
]);
export type ImageOperation = z.infer<typeof imageOperationSchema>;

export const imageRenderSpecSchema = z
  .object({
    inputStorageKey: z.string().min(1),
    operations: z.array(imageOperationSchema).min(1),
    outputFormat: z.enum(['jpeg', 'png', 'webp', 'avif']).default('webp'),
  })
  .merge(tenantScopeSchema);
export type ImageRenderSpec = z.infer<typeof imageRenderSpecSchema>;

export const svgRenderSpecSchema = z
  .object({
    /** Inline SVG or a storage key — exactly one must be provided. */
    svgMarkup: z.string().max(1000000).optional(),
    svgStorageKey: z.string().optional(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    outputFormat: z.enum(['png', 'webp']).default('png'),
  })
  .merge(tenantScopeSchema);
export type SvgRenderSpec = z.infer<typeof svgRenderSpecSchema>;

export const htmlToImageSpecSchema = z
  .object({
    /** Sandboxed template id + data; arbitrary URLs are not fetched (SSRF). */
    templateId: z.string().min(1),
    templateData: z.record(z.unknown()).default({}),
    viewportWidth: z.number().int().positive().default(1200),
    viewportHeight: z.number().int().positive().default(630),
    outputFormat: z.enum(['png', 'jpeg', 'webp']).default('png'),
  })
  .merge(tenantScopeSchema);
export type HtmlToImageSpec = z.infer<typeof htmlToImageSpecSchema>;

export const ffmpegJobSpecSchema = z
  .object({
    inputStorageKeys: z.array(z.string().min(1)).min(1),
    /** Declarative operations compiled to an ffmpeg filtergraph by the renderer. */
    operations: z
      .array(
        z.object({
          kind: z.enum([
            'trim',
            'concat',
            'scale',
            'overlay',
            'mix-audio',
            'extract-audio',
            'custom',
          ]),
          params: z.record(z.unknown()).default({}),
        }),
      )
      .default([]),
    outputContainer: z.enum(['mp4', 'webm', 'mov', 'mp3', 'wav']).default('mp4'),
    videoCodec: z.string().optional(),
    audioCodec: z.string().optional(),
  })
  .merge(tenantScopeSchema);
export type FfmpegJobSpec = z.infer<typeof ffmpegJobSpecSchema>;

export const remotionRenderSpecSchema = z
  .object({
    compositionId: z.string().min(1),
    inputProps: z.record(z.unknown()).default({}),
    codec: z.enum(['h264', 'h265', 'vp8', 'vp9']).default('h264'),
    durationInFrames: z.number().int().positive().optional(),
    fps: z.number().int().positive().default(30),
  })
  .merge(tenantScopeSchema);
export type RemotionRenderSpec = z.infer<typeof remotionRenderSpecSchema>;

export const subtitleRenderSpecSchema = z
  .object({
    mediaStorageKey: z.string().min(1),
    format: z.enum(['SRT', 'VTT', 'BURNED_IN']),
    language: z.string().min(2).max(35),
    styling: z.record(z.unknown()).default({}),
  })
  .merge(tenantScopeSchema);
export type SubtitleRenderSpec = z.infer<typeof subtitleRenderSpecSchema>;

export const audioMixSpecSchema = z
  .object({
    tracks: z
      .array(
        z.object({
          storageKey: z.string().min(1),
          gainDb: z.number().default(0),
          startAtMs: z.number().int().nonnegative().default(0),
        }),
      )
      .min(1),
    outputFormat: z.enum(['mp3', 'wav', 'aac']).default('mp3'),
  })
  .merge(tenantScopeSchema);
export type AudioMixSpec = z.infer<typeof audioMixSpecSchema>;

export const thumbnailSpecSchema = z
  .object({
    sourceStorageKey: z.string().min(1),
    /** For video sources: frame timestamp to capture. */
    atMs: z.number().int().nonnegative().optional(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .merge(tenantScopeSchema);
export type ThumbnailSpec = z.infer<typeof thumbnailSpecSchema>;

export const audiogramSpecSchema = z
  .object({
    audioStorageKey: z.string().min(1),
    coverImageStorageKey: z.string().optional(),
    waveformStyle: z.enum(['bars', 'line', 'circle']).default('bars'),
    width: z.number().int().positive().default(1080),
    height: z.number().int().positive().default(1080),
    captionText: z.string().max(2000).optional(),
  })
  .merge(tenantScopeSchema);
export type AudiogramSpec = z.infer<typeof audiogramSpecSchema>;
