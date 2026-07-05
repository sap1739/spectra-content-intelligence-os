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
