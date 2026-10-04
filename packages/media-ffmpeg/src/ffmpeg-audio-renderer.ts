import { stat } from 'node:fs/promises';

import type { AudiogramRenderJob } from '@spectra/contracts';
import {
  type AudioMixResources,
  type AudioRenderPlan,
  buildAudioMixArgs,
  buildAudiogramArgs,
  buildWaveformArgs,
} from '@spectra/audio-core';

import { probeEngine, runTool, type EngineProbe } from './binaries';
import { VideoRenderError } from './errors';
import { lastMeaningfulLine, runFfmpeg } from './spawn';
import type { FfmpegRendererOptions } from './ffmpeg-video-renderer';

/**
 * The audio half of the FFmpeg adapter: episode mixing, loudness
 * normalization, waveform pictures and audiograms.
 *
 * None of this generates audio. It arranges, mixes and measures files the
 * workspace already has — the same stance the design studio and the video
 * pipeline take, and the reason no synthesis provider is needed for any of it.
 */

export interface AudioEngineCapability {
  available: boolean;
  reason: string;
  engine: string;
  engineVersion: string | null;
  features: {
    mixing: boolean;
    /** EBU R128 loudness normalization. */
    normalization: boolean;
    waveform: boolean;
    audiogram: boolean;
    burnedCaptions: boolean;
  };
  /** The audio encoder the adapter will write with, when it found one. */
  audioCodec: string | null;
  missing: string[];
}

export interface AudioMixOutput {
  outputPath: string;
  sizeBytes: number;
  durationMs: number;
  audioCodec: string | null;
  /** Measured after the mix, so stored loudness describes real samples. */
  integratedLufs: number | null;
  durationRenderMs: number;
  warnings: string[];
}

const MP3_ENCODERS = ['libmp3lame', 'libshine'] as const;

export class FfmpegAudioRenderer {
  readonly id = 'ffmpeg';
  readonly displayName = 'FFmpeg (audio)';

  private probed: EngineProbe | null = null;

  constructor(private readonly options: FfmpegRendererOptions) {}

  private async engine(): Promise<EngineProbe> {
    this.probed ??= await probeEngine(this.options.ffmpegPath);
    return this.probed;
  }

  async capabilities(): Promise<AudioEngineCapability> {
    const probe = await this.engine();
    if (probe.error) {
      return {
        available: false,
        reason: `No usable ffmpeg at "${probe.path}": ${probe.error}. Set FFMPEG_PATH, or install ffmpeg on the worker host.`,
        engine: 'ffmpeg',
        engineVersion: null,
        audioCodec: null,
        features: {
          mixing: false,
          normalization: false,
          waveform: false,
          audiogram: false,
          burnedCaptions: false,
        },
        missing: ['No ffmpeg binary is configured or reachable.'],
      };
    }

    const audioCodec = MP3_ENCODERS.find((name) => probe.encoders.has(name)) ?? null;
    const missing: string[] = [];
    if (!audioCodec) {
      missing.push(
        `This ffmpeg build has no MP3 encoder (looked for ${MP3_ENCODERS.join(', ')}), so an episode cannot be written.`,
      );
    }
    const hasAmix = probe.filters.has('amix');
    const hasConcat = probe.filters.has('concat');
    const mixing = hasAmix && hasConcat;
    if (!mixing)
      missing.push('This build lacks the amix/concat filters, so segments cannot be joined.');
    const normalization = probe.filters.has('loudnorm');
    if (!normalization) {
      missing.push('This build has no loudnorm filter, so mixes cannot be loudness-normalized.');
    }
    const waveform = probe.filters.has('showwavespic');
    if (!waveform)
      missing.push('This build has no showwavespic filter, so waveforms cannot be drawn.');
    const audiogram = probe.filters.has('showwaves') && probe.encoders.has('aac');
    if (!audiogram) {
      missing.push(
        'This build lacks showwaves or an AAC encoder, so audiograms cannot be rendered.',
      );
    }
    const burnedCaptions = probe.filters.has('subtitles');
    if (!burnedCaptions) {
      missing.push(
        'This build has no subtitles filter (libass), so captions cannot be burned into an audiogram.',
      );
    }

    return {
      available: Boolean(audioCodec && mixing),
      reason:
        audioCodec && mixing
          ? `ffmpeg ${probe.version ?? 'unknown version'} at ${probe.path}, writing audio with ${audioCodec}.`
          : 'ffmpeg is installed but cannot mix or encode audio.',
      engine: 'ffmpeg',
      engineVersion: probe.version,
      audioCodec,
      features: { mixing, normalization, waveform, audiogram, burnedCaptions },
      missing,
    };
  }

  /** Refuses, before any work, a plan this build cannot honour. */
  private assertCanMix(plan: AudioRenderPlan, capability: AudioEngineCapability): void {
    if (!capability.available) {
      throw new VideoRenderError(
        capability.engineVersion ? 'ENGINE_MISSING_CAPABILITY' : 'ENGINE_NOT_CONFIGURED',
        capability.reason,
        capability.missing.join(' '),
      );
    }
    if (plan.normalize && !capability.features.normalization) {
      throw new VideoRenderError(
        'ENGINE_MISSING_CAPABILITY',
        'This episode asks to be loudness-normalized, which the installed ffmpeg build cannot do.',
        capability.missing.join(' '),
      );
    }
  }

  async mix(
    plan: AudioRenderPlan,
    resources: AudioMixResources,
    options: {
      signal?: AbortSignal;
      onProgress?: (p: { percent: number }) => void;
      estimatedMs?: number;
    },
  ): Promise<AudioMixOutput> {
    const started = Date.now();
    const capability = await this.capabilities();
    this.assertCanMix(plan, capability);

    const { args } = buildAudioMixArgs(plan, resources);
    await runFfmpeg(this.options.ffmpegPath, args, {
      totalDurationMs: options.estimatedMs ?? 0,
      timeoutMs: this.options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress
        ? { onProgress: (p) => options.onProgress!({ percent: p.percent }) }
        : {}),
    });

    const size = await stat(resources.outputPath).catch(() => null);
    if (!size || size.size === 0) {
      throw new VideoRenderError(
        'ENGINE_ERROR',
        'ffmpeg reported success but wrote no audio.',
        null,
      );
    }
    const probe = await this.probeAudio(resources.outputPath);
    return {
      outputPath: resources.outputPath,
      sizeBytes: size.size,
      durationMs: probe.durationMs ?? 0,
      audioCodec: probe.audioCodec,
      integratedLufs: plan.normalize ? await this.measureLoudness(resources.outputPath) : null,
      durationRenderMs: Date.now() - started,
      warnings: [...plan.warnings],
    };
  }

  /** A waveform picture of a finished mix. */
  async waveform(audioPath: string, outputPath: string): Promise<void> {
    const { args } = buildWaveformArgs({ audioPath, outputPath });
    const result = await runTool(this.options.ffmpegPath, args, { timeoutMs: 120_000 });
    if (result.spawnError || result.code !== 0) {
      throw new VideoRenderError(
        'ENGINE_ERROR',
        'A waveform could not be drawn for this audio.',
        lastMeaningfulLine(result.stderr),
      );
    }
  }

  /** An audiogram: the audio pipeline's hand-off to video. */
  async audiogram(
    job: AudiogramRenderJob,
    resources: { audioPath: string; coverPath?: string; captionPath?: string; outputPath: string },
    format: { width: number; height: number; fps: number },
    options: {
      videoCodec: string;
      crf: number;
      signal?: AbortSignal;
      onProgress?: (p: { percent: number }) => void;
    },
  ): Promise<{ sizeBytes: number; durationMs: number }> {
    const capability = await this.capabilities();
    if (!capability.features.audiogram) {
      throw new VideoRenderError(
        capability.engineVersion ? 'ENGINE_MISSING_CAPABILITY' : 'ENGINE_NOT_CONFIGURED',
        'This ffmpeg build cannot render an audiogram.',
        capability.missing.join(' '),
      );
    }
    if (resources.captionPath && !capability.features.burnedCaptions) {
      throw new VideoRenderError(
        'ENGINE_MISSING_CAPABILITY',
        'This audiogram asks for burned-in captions, which the installed ffmpeg build cannot draw.',
        capability.missing.join(' '),
      );
    }

    const { args } = buildAudiogramArgs(
      {
        startMs: job.startMs,
        durationMs: job.durationMs,
        waveformStyle: job.waveformStyle,
        waveformColor: job.waveformColor,
        backgroundColor: job.backgroundColor,
      },
      resources,
      format,
      { videoCodec: options.videoCodec, crf: options.crf },
    );
    await runFfmpeg(this.options.ffmpegPath, args, {
      totalDurationMs: job.durationMs,
      timeoutMs: this.options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress
        ? { onProgress: (p) => options.onProgress!({ percent: p.percent }) }
        : {}),
    });
    const size = await stat(resources.outputPath).catch(() => null);
    if (!size || size.size === 0) {
      throw new VideoRenderError(
        'ENGINE_ERROR',
        'ffmpeg reported success but wrote no audiogram.',
        null,
      );
    }
    const probe = await this.probeAudio(resources.outputPath);
    return { sizeBytes: size.size, durationMs: probe.durationMs ?? job.durationMs };
  }

  /** Reads back what was actually written, so stored metadata is measured. */
  async probeAudio(path: string): Promise<{
    durationMs: number | null;
    audioCodec: string | null;
    sampleRate: number | null;
    channels: number | null;
  }> {
    const result = await runTool(
      this.options.ffprobePath,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-show_entries',
        'stream=codec_type,codec_name,sample_rate,channels',
        '-of',
        'json',
        path,
      ],
      { timeoutMs: 30_000 },
    );
    if (result.spawnError || result.code !== 0) {
      return { durationMs: null, audioCodec: null, sampleRate: null, channels: null };
    }
    try {
      const parsed = JSON.parse(result.stdout) as {
        format?: { duration?: string };
        streams?: Array<{
          codec_type?: string;
          codec_name?: string;
          sample_rate?: string;
          channels?: number;
        }>;
      };
      const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
      const duration = Number(parsed.format?.duration);
      return {
        durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : null,
        audioCodec: audio?.codec_name ?? null,
        sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
        channels: audio?.channels ?? null,
      };
    } catch {
      return { durationMs: null, audioCodec: null, sampleRate: null, channels: null };
    }
  }

  /**
   * Measures integrated loudness with `ebur128`. Reported so an operator can
   * see what the mix actually came out at, rather than trusting the target.
   */
  async measureLoudness(path: string): Promise<number | null> {
    const result = await runTool(
      this.options.ffmpegPath,
      ['-hide_banner', '-nostdin', '-i', path, '-filter_complex', 'ebur128', '-f', 'null', '-'],
      { timeoutMs: 120_000 },
    );
    if (result.spawnError) return null;
    const match = /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g;
    let last: number | null = null;
    for (const found of result.stderr.matchAll(match)) {
      const value = Number(found[1]);
      if (Number.isFinite(value)) last = value;
    }
    return last;
  }
}
