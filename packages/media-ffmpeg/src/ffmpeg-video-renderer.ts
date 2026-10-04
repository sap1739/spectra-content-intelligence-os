import { spawn } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  VideoEngineCapability,
  VideoRenderInputs,
  VideoRenderOptions,
  VideoRenderOutput,
  VideoRenderer,
} from '@spectra/media-core';
import { type VideoRenderPlan, buildFfmpegArgs, buildSrt } from '@spectra/video-studio';

import { type EngineProbe, probeEngine, runTool } from './binaries';
import { VideoRenderError } from './errors';

export interface FfmpegRendererOptions {
  ffmpegPath: string;
  ffprobePath: string;
  /**
   * A TTF/OTF file for text overlays. drawtext needs a file: builds without
   * fontconfig cannot resolve a family name, so Spectra never relies on one.
   */
  fontFile: string | null;
  /** Wall-clock ceiling for one encode. */
  timeoutMs: number;
}

/** Encoders we accept for H.264, best first. The adapter chooses, never a user. */
const H264_ENCODERS = ['libx264', 'h264_videotoolbox', 'libopenh264'] as const;

interface ProgressState {
  outTimeMs: number;
}

/** `-progress pipe:1` emits `key=value` lines; we only read the clock. */
function readProgress(chunk: string, state: ProgressState): boolean {
  let changed = false;
  for (const line of chunk.split('\n')) {
    const [key, value] = line.split('=');
    if (!key || value === undefined) continue;
    if (key.trim() === 'out_time_us' || key.trim() === 'out_time_ms') {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        // out_time_us is microseconds; out_time_ms is, despite the name, also
        // microseconds in every ffmpeg that emits it.
        state.outTimeMs = Math.round(parsed / 1000);
        changed = true;
      }
    }
  }
  return changed;
}

export class FfmpegVideoRenderer implements VideoRenderer {
  readonly id = 'ffmpeg';
  readonly displayName = 'FFmpeg';

  private probed: EngineProbe | null = null;

  constructor(private readonly options: FfmpegRendererOptions) {}

  private async engine(): Promise<EngineProbe> {
    this.probed ??= await probeEngine(this.options.ffmpegPath);
    return this.probed;
  }

  async capabilities(): Promise<VideoEngineCapability> {
    const probe = await this.engine();
    if (probe.error) {
      return {
        available: false,
        reason: `No usable ffmpeg at "${probe.path}": ${probe.error}. Set FFMPEG_PATH, or install ffmpeg on the worker host.`,
        engine: 'ffmpeg',
        engineVersion: null,
        videoCodec: null,
        features: {
          textOverlays: false,
          burnedCaptions: false,
          crossfades: false,
          audioBed: false,
          thumbnails: false,
        },
        missing: ['No ffmpeg binary is configured or reachable.'],
      };
    }

    const videoCodec = H264_ENCODERS.find((name) => probe.encoders.has(name)) ?? null;
    const missing: string[] = [];
    if (!videoCodec) {
      missing.push(
        `This ffmpeg build has no H.264 encoder (looked for ${H264_ENCODERS.join(', ')}), so it cannot write MP4 video.`,
      );
    }
    const hasDrawtext = probe.filters.has('drawtext');
    const hasFont = Boolean(this.options.fontFile);
    if (!hasDrawtext) missing.push('This build has no drawtext filter, so text overlays are off.');
    else if (!hasFont) {
      missing.push(
        'No font file is configured (VIDEO_FONT_FILE), and drawtext needs a file rather than a family name, so text overlays are off.',
      );
    }
    const hasSubtitles = probe.filters.has('subtitles');
    if (!hasSubtitles) {
      missing.push(
        'This build has no subtitles filter (libass), so captions can only be a sidecar file, not burned in.',
      );
    }
    const hasXfade = probe.filters.has('xfade');
    if (!hasXfade) missing.push('This build has no xfade filter, so scenes can only hard-cut.');
    const hasAac = probe.encoders.has('aac');
    if (!hasAac) missing.push('This build has no AAC encoder, so an audio bed cannot be written.');

    return {
      available: Boolean(videoCodec),
      reason: videoCodec
        ? `ffmpeg ${probe.version ?? 'unknown version'} at ${probe.path}, encoding H.264 with ${videoCodec}.`
        : 'ffmpeg is installed but cannot encode H.264.',
      engine: 'ffmpeg',
      engineVersion: probe.version,
      videoCodec,
      features: {
        textOverlays: hasDrawtext && hasFont,
        burnedCaptions: hasSubtitles,
        crossfades: hasXfade,
        audioBed: hasAac,
        thumbnails: true,
      },
      missing,
    };
  }

  /**
   * Refuses, before any work, a plan this build cannot honour — so a storyboard
   * asking for burned captions on a build without libass is told exactly that
   * rather than silently losing its captions.
   */
  private assertCanRender(plan: VideoRenderPlan, capability: VideoEngineCapability): void {
    if (!capability.available || !capability.videoCodec) {
      throw new VideoRenderError(
        capability.engineVersion ? 'ENGINE_MISSING_CAPABILITY' : 'ENGINE_NOT_CONFIGURED',
        capability.reason,
        capability.missing.join(' '),
      );
    }
    const needs: string[] = [];
    const wantsText = plan.scenes.some((scene) => scene.texts.length > 0);
    if (wantsText && !capability.features.textOverlays) {
      needs.push('text overlays');
    }
    if (plan.burnCaptions && !capability.features.burnedCaptions) needs.push('burned-in captions');
    if (plan.transitionMs > 0 && !capability.features.crossfades) needs.push('crossfades');
    if (plan.audio && !capability.features.audioBed) needs.push('an audio bed');
    if (needs.length > 0) {
      throw new VideoRenderError(
        'ENGINE_MISSING_CAPABILITY',
        `This storyboard needs ${needs.join(', ')}, which the installed ffmpeg build does not provide.`,
        capability.missing.join(' '),
      );
    }
  }

  /**
   * Probes every input before the encode starts.
   *
   * This is not belt-and-braces: a corrupt image handed to `-loop 1` makes
   * ffmpeg wait forever rather than exit, so without this check a bad asset
   * would burn the whole render timeout and then report TIMEOUT — which is
   * true but useless. Probing first turns it into INPUT_UNSUPPORTED in a
   * second, naming the asset.
   */
  private async assertInputsDecodable(
    plan: VideoRenderPlan,
    inputs: VideoRenderInputs,
  ): Promise<void> {
    for (const assetId of plan.imageAssetIds) {
      const file = inputs.imageFiles[assetId];
      if (!file) {
        throw new VideoRenderError(
          'INPUT_UNAVAILABLE',
          `The storyboard references media asset ${assetId}, which could not be read.`,
          null,
        );
      }
      const probe = await this.probeFile(file);
      if (!probe.width || !probe.height) {
        throw new VideoRenderError(
          'INPUT_UNSUPPORTED',
          `Media asset ${assetId} is not an image this engine can decode.`,
          null,
        );
      }
    }
    if (plan.audio && inputs.audioFile) {
      const probe = await this.probeFile(inputs.audioFile);
      if (!probe.audioCodec) {
        throw new VideoRenderError(
          'INPUT_UNSUPPORTED',
          `The audio bed (asset ${plan.audio.mediaAssetId}) has no audio stream this engine can decode.`,
          null,
        );
      }
    }
  }

  async render(
    plan: VideoRenderPlan,
    inputs: VideoRenderInputs,
    options: VideoRenderOptions,
  ): Promise<VideoRenderOutput> {
    const started = Date.now();
    const capability = await this.capabilities();
    this.assertCanRender(plan, capability);

    await mkdir(inputs.workDir, { recursive: true });
    await this.assertInputsDecodable(plan, inputs);

    // User text never enters the filtergraph: it is written to files, and only
    // paths Spectra generated are interpolated into filter arguments.
    const textFiles: Record<string, string> = {};
    for (const scene of plan.scenes) {
      for (const text of scene.texts) {
        const file = join(inputs.workDir, `text-${encodeURIComponent(text.key)}.txt`);
        await writeFile(file, text.text, 'utf8');
        textFiles[text.key] = file;
      }
    }

    let captionFile: string | undefined;
    if (plan.cues.length > 0) {
      captionFile = join(inputs.workDir, 'captions.srt');
      await writeFile(captionFile, buildSrt(plan.cues), 'utf8');
    }

    const { args } = buildFfmpegArgs(
      plan,
      {
        imageFiles: inputs.imageFiles,
        textFiles,
        fontFile: this.options.fontFile ?? '',
        audioFile: inputs.audioFile,
        captionFile,
        outputPath: inputs.outputPath,
      },
      { crf: options.crf, videoCodec: capability.videoCodec! },
    );

    await this.spawnEncode(args, plan, options);

    const probe = await this.probeFile(inputs.outputPath);
    const size = await stat(inputs.outputPath).catch(() => null);
    if (!size || size.size === 0) {
      throw new VideoRenderError(
        'ENGINE_ERROR',
        'ffmpeg reported success but wrote no file.',
        null,
      );
    }

    return {
      outputPath: inputs.outputPath,
      sizeBytes: size.size,
      durationMs: probe.durationMs ?? plan.totalDurationMs,
      width: probe.width ?? plan.format.width,
      height: probe.height ?? plan.format.height,
      videoCodec: probe.videoCodec ?? capability.videoCodec!,
      audioCodec: probe.audioCodec,
      captionPath: captionFile,
      durationRenderMs: Date.now() - started,
      warnings: [...plan.warnings],
    };
  }

  /** Runs the encode, streaming progress and observing cancellation. */
  private spawnEncode(
    args: string[],
    plan: VideoRenderPlan,
    options: VideoRenderOptions,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.ffmpegPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const state: ProgressState = { outTimeMs: 0 };
      let stderr = '';
      let settled = false;
      let cancelled = false;
      let timedOut = false;

      const finish = (error?: VideoRenderError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };

      const stop = () => {
        // SIGKILL rather than SIGTERM: a stuck encoder must not outlive its job.
        child.kill('SIGKILL');
      };

      const onAbort = () => {
        cancelled = true;
        stop();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, this.options.timeoutMs);

      if (options.signal?.aborted) {
        cancelled = true;
        stop();
      } else {
        options.signal?.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout.on('data', (chunk: Buffer) => {
        if (readProgress(chunk.toString('utf8'), state) && options.onProgress) {
          const percent =
            plan.totalDurationMs > 0
              ? Math.max(
                  0,
                  Math.min(99, Math.round((state.outTimeMs / plan.totalDurationMs) * 100)),
                )
              : 0;
          options.onProgress({ percent, renderedMs: state.outTimeMs });
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-8000);
      });

      child.on('error', (error: Error) =>
        finish(
          new VideoRenderError(
            'ENGINE_NOT_CONFIGURED',
            `ffmpeg could not be started: ${error.message}`,
            null,
          ),
        ),
      );

      child.on('close', (code) => {
        if (cancelled) {
          finish(new VideoRenderError('CANCELLED', 'The render was cancelled.', null));
          return;
        }
        if (timedOut) {
          finish(
            new VideoRenderError(
              'TIMEOUT',
              `The render exceeded its ${Math.round(this.options.timeoutMs / 1000)}s limit and was stopped.`,
              null,
            ),
          );
          return;
        }
        if (code !== 0) {
          finish(
            new VideoRenderError(
              'ENGINE_ERROR',
              `ffmpeg exited ${code}.`,
              lastMeaningfulLine(stderr),
            ),
          );
          return;
        }
        finish();
      });
    });
  }

  async extractThumbnail(videoPath: string, atMs: number, outputPath: string): Promise<void> {
    const result = await runTool(
      this.options.ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-ss',
        (Math.max(0, atMs) / 1000).toFixed(3),
        '-i',
        videoPath,
        '-frames:v',
        '1',
        '-q:v',
        '3',
        outputPath,
      ],
      { timeoutMs: 60_000 },
    );
    if (result.spawnError || result.code !== 0) {
      throw new VideoRenderError(
        'ENGINE_ERROR',
        'A poster frame could not be extracted from the rendered video.',
        lastMeaningfulLine(result.stderr),
      );
    }
  }

  /** ffprobe the finished file, so stored metadata describes real bytes. */
  async probeFile(path: string): Promise<{
    durationMs: number | null;
    width: number | null;
    height: number | null;
    videoCodec: string | null;
    audioCodec: string | null;
  }> {
    const result = await runTool(
      this.options.ffprobePath,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-show_entries',
        'stream=codec_type,codec_name,width,height',
        '-of',
        'json',
        path,
      ],
      { timeoutMs: 30_000 },
    );
    if (result.spawnError || result.code !== 0) {
      return { durationMs: null, width: null, height: null, videoCodec: null, audioCodec: null };
    }
    try {
      const parsed = JSON.parse(result.stdout) as {
        format?: { duration?: string };
        streams?: Array<{
          codec_type?: string;
          codec_name?: string;
          width?: number;
          height?: number;
        }>;
      };
      const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
      const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
      const duration = Number(parsed.format?.duration);
      return {
        durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : null,
        width: video?.width ?? null,
        height: video?.height ?? null,
        videoCodec: video?.codec_name ?? null,
        audioCodec: audio?.codec_name ?? null,
      };
    } catch {
      return { durationMs: null, width: null, height: null, videoCodec: null, audioCodec: null };
    }
  }
}

/**
 * ffmpeg's real complaint is in the last non-empty line; the rest is banner and
 * stream mapping. Bounded, so a failure note never becomes a log dump.
 */
export function lastMeaningfulLine(stderr: string): string | null {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines.at(-1);
  return last ? last.slice(0, 500) : null;
}
