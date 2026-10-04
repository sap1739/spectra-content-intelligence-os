import type { RenderPlan } from '@spectra/design-studio';
import type { VideoRenderPlan } from '@spectra/video-studio';

import type {
  AspectRatioTarget,
  AudioMixSpec,
  AudiogramSpec,
  FfmpegJobSpec,
  HtmlToImageSpec,
  ImageRenderSpec,
  MediaAssetRef,
  RemotionRenderSpec,
  SubtitleRenderSpec,
  SvgRenderSpec,
  TenantScope,
  ThumbnailSpec,
} from '@spectra/contracts';

/**
 * Media rendering ports — INTERFACES ONLY in Phase 1.
 * Planned engines per docs/MEDIA_PIPELINE_STRATEGY.md:
 *  - ImageRenderer → sharp; SvgRenderer → resvg/sharp;
 *  - HtmlToImageRenderer → headless chromium against sandboxed templates;
 *  - VideoProcessor → ffmpeg; CompositionRenderer → Remotion;
 *  - SubtitleRenderer/AudioMixer/AudiogramGenerator → ffmpeg filtergraphs.
 * All renderers read inputs from and write outputs to tenant-scoped object
 * storage keys; nothing is fetched from arbitrary URLs (SSRF containment).
 */

export interface RenderResult {
  asset: MediaAssetRef;
  durationMs: number;
  engine: string;
  engineVersion?: string;
}

export interface MediaRendererIdentity {
  readonly id: string;
  readonly displayName: string;
}

export interface ImageRenderer extends MediaRendererIdentity {
  render(spec: ImageRenderSpec): Promise<RenderResult>;
  /** Convenience port for plain resizing. */
  resize(
    tenant: TenantScope,
    inputStorageKey: string,
    width: number,
    height: number,
  ): Promise<RenderResult>;
  /** Platform-specific aspect-ratio conversion. */
  convertAspectRatio(
    tenant: TenantScope,
    inputStorageKey: string,
    target: AspectRatioTarget,
  ): Promise<RenderResult>;
}

export interface SvgRenderer extends MediaRendererIdentity {
  render(spec: SvgRenderSpec): Promise<RenderResult>;
}

export interface HtmlToImageRenderer extends MediaRendererIdentity {
  render(spec: HtmlToImageSpec): Promise<RenderResult>;
}

export interface VideoProcessor extends MediaRendererIdentity {
  process(spec: FfmpegJobSpec): Promise<RenderResult>;
}

export interface CompositionRenderer extends MediaRendererIdentity {
  render(spec: RemotionRenderSpec): Promise<RenderResult>;
}

export interface SubtitleRenderer extends MediaRendererIdentity {
  render(spec: SubtitleRenderSpec): Promise<RenderResult>;
}

export interface AudioMixer extends MediaRendererIdentity {
  mix(spec: AudioMixSpec): Promise<RenderResult>;
}

export interface ThumbnailGenerator extends MediaRendererIdentity {
  generate(spec: ThumbnailSpec): Promise<RenderResult>;
}

export interface AudiogramGenerator extends MediaRendererIdentity {
  /** Waveform/audiogram video or image from an audio asset. */
  generate(spec: AudiogramSpec): Promise<RenderResult>;
}

/**
 * Visual design rendering (Phase 7A, ADR-0040). The plan is produced and
 * validated by @spectra/design-studio; the renderer turns one page of it into
 * real pixels. Assets are loaded through a caller-supplied, tenant-checked
 * loader — a renderer never resolves storage keys or URLs itself.
 */
export interface DesignRenderAssets {
  loadImage(assetId: string): Promise<Buffer>;
  loadFont(assetId: string): Promise<Buffer>;
}

export interface DesignPageRender {
  buffer: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  /** The JPEG quality actually used (it may be lowered to meet a byte limit). */
  quality: number | null;
  warnings: string[];
  durationMs: number;
}

export interface DesignRenderer extends MediaRendererIdentity {
  readonly engineVersion: string;
  renderPage(
    plan: RenderPlan,
    pageIndex: number,
    output: { format: 'png' | 'jpeg'; quality: number; maxWidth?: number | null },
    assets: DesignRenderAssets,
  ): Promise<DesignPageRender>;
}

/**
 * Video rendering (Phase 7B, ADR-0041). The plan is produced and validated by
 * @spectra/video-studio; the renderer turns it into a real MP4. Inputs arrive
 * as local files the caller already fetched and tenant-checked — a renderer
 * never resolves a storage key, and never fetches a URL.
 */
export interface VideoEngineCapability {
  /** False when no engine binary is configured or reachable. */
  available: boolean;
  /** Why it is unavailable, or what the engine is when it is. */
  reason: string;
  engine: string;
  engineVersion: string | null;
  /** The H.264 encoder the adapter would use, when it found one. */
  videoCodec: string | null;
  /** Capabilities a storyboard can need, each either present or explained. */
  features: {
    textOverlays: boolean;
    burnedCaptions: boolean;
    crossfades: boolean;
    audioBed: boolean;
    thumbnails: boolean;
  };
  /** Named reasons for every feature that is false. */
  missing: string[];
}

export interface VideoRenderInputs {
  /** Local file for each image asset the plan referenced, by asset id. */
  imageFiles: Record<string, string>;
  /** Local file for the audio bed, when the plan has one. */
  audioFile?: string;
  /** A directory the renderer may write scratch files into. */
  workDir: string;
  /** Where the finished MP4 must be written. */
  outputPath: string;
}

export interface VideoRenderProgress {
  percent: number;
  /** Encoded position in the output timeline. */
  renderedMs: number;
  note?: string;
}

export interface VideoRenderOptions {
  crf: number;
  /** Observed cooperatively: an abort stops the engine and cleans up. */
  signal?: AbortSignal;
  onProgress?: (progress: VideoRenderProgress) => void;
}

export interface VideoRenderOutput {
  outputPath: string;
  sizeBytes: number;
  durationMs: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
  /** The caption sidecar, when one was asked for. */
  captionPath?: string;
  thumbnailPath?: string;
  durationRenderMs: number;
  warnings: string[];
}

export interface VideoRenderer extends MediaRendererIdentity {
  capabilities(): Promise<VideoEngineCapability>;
  /** Encodes one plan. Rejects with a typed error; never returns a partial file. */
  render(
    plan: VideoRenderPlan,
    inputs: VideoRenderInputs,
    options: VideoRenderOptions,
  ): Promise<VideoRenderOutput>;
  /** A still frame from a rendered video, for a poster image. */
  extractThumbnail(videoPath: string, atMs: number, outputPath: string): Promise<void>;
}
