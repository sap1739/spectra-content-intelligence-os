import type { AudiogramRenderJob } from '@spectra/contracts';

import type { AudioRenderPlan } from './plan';

/**
 * Audio render plan → FFmpeg arguments. Pure, like the video builder, and for
 * the same reasons: the whole command is testable without a binary, every
 * argument is an array element, and nothing is ever assembled into a shell
 * string. Only numbers Spectra computed and paths Spectra generated appear in a
 * filtergraph — no user text ever does.
 */

export class AudioArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioArgsError';
  }
}

export interface AudioMixResources {
  /** Local file for each audio asset the plan referenced, by asset id. */
  audioFiles: Record<string, string>;
  /** Local file for a synthesised segment, by segment id. Empty today. */
  spokenFiles?: Record<string, string>;
  outputPath: string;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

function color(hex: string): string {
  return `0x${hex.replace('#', '').toUpperCase()}`;
}

/** Filtergraph escaping for a path — our own paths, escaped anyway. */
export function escapeFilterPath(path: string): string {
  return path.replace(/([\\':,[\]])/g, '\\$1');
}

/**
 * Builds the episode mix: every segment in order, each at its own gain,
 * concatenated, optionally under a music bed, optionally loudness-normalized.
 */
export function buildAudioMixArgs(
  plan: AudioRenderPlan,
  resources: AudioMixResources,
): { args: string[] } {
  if (plan.segments.length === 0) {
    throw new AudioArgsError('A render plan needs at least one segment.');
  }

  const args: string[] = ['-hide_banner', '-nostdin', '-y', '-nostats', '-progress', 'pipe:1'];
  const steps: string[] = [];
  const labels: string[] = [];

  plan.segments.forEach((segment, index) => {
    if (segment.source.kind === 'SILENCE') {
      // A generated silence, not a file of zeros somebody has to supply.
      args.push(
        '-f',
        'lavfi',
        '-t',
        seconds(segment.source.durationMs),
        '-i',
        'anullsrc=channel_layout=stereo:sample_rate=44100',
      );
    } else if (segment.source.kind === 'UPLOADED') {
      const file = resources.audioFiles[segment.source.mediaAssetId];
      if (!file) {
        throw new AudioArgsError(
          `No local file was prepared for audio asset ${segment.source.mediaAssetId}.`,
        );
      }
      args.push('-i', file);
    } else {
      const file = resources.spokenFiles?.[segment.id];
      if (!file) {
        // Reached only if a caller skipped the synthesis check; the pipeline
        // refuses such a plan long before here.
        throw new AudioArgsError(
          `Segment "${segment.id}" needs synthesised speech, and no audio was prepared for it.`,
        );
      }
      args.push('-i', file);
    }

    // One common chain per segment: a single sample format and rate, so concat
    // never has to reconcile mismatched inputs, then the segment's own gain.
    const chain = ['aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo'];
    if (segment.gainDb !== 0) chain.push(`volume=${segment.gainDb}dB`);
    chain.push('asetpts=PTS-STARTPTS');
    steps.push(`[${index}:a]${chain.join(',')}[s${index}]`);
    labels.push(`[s${index}]`);
  });

  let speechLabel = 's0';
  if (plan.segments.length > 1) {
    steps.push(`${labels.join('')}concat=n=${plan.segments.length}:v=0:a=1[speech]`);
    speechLabel = 'speech';
  }

  let mixLabel = speechLabel;
  if (plan.musicBed) {
    const bedFile = resources.audioFiles[plan.musicBed.mediaAssetId];
    if (!bedFile) {
      throw new AudioArgsError(
        `No local file was prepared for the music bed ${plan.musicBed.mediaAssetId}.`,
      );
    }
    const bedIndex = plan.segments.length;
    args.push('-i', bedFile);
    const bedChain = [
      'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo',
      `volume=${plan.musicBed.gainDb}dB`,
    ];
    if (plan.musicBed.fadeInMs > 0) {
      bedChain.push(`afade=t=in:st=0:d=${seconds(plan.musicBed.fadeInMs)}`);
    }
    // The bed loops to cover the episode and is cut to it: `duration=first`
    // below means the speech decides how long the mix is.
    steps.push(`[${bedIndex}:a]${bedChain.join(',')}[bed]`);
    steps.push(
      `[${speechLabel}][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixed]`,
    );
    mixLabel = 'mixed';
  }

  const tail: string[] = [];
  if (plan.normalize) {
    // EBU R128. A single pass: good enough for a spoken mix, and honest about
    // being a single pass rather than claiming measured two-pass accuracy.
    tail.push(`loudnorm=I=${plan.targetLufs}:TP=-1.5:LRA=11`);
  }
  tail.push('aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo');
  steps.push(`[${mixLabel}]${tail.join(',')}[out]`);

  args.push(
    '-filter_complex',
    steps.join(';'),
    '-map',
    '[out]',
    '-vn',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '128k',
    '-ar',
    '44100',
    resources.outputPath,
  );
  return { args };
}

/**
 * A waveform PNG for one audio file — the picture a producer scrubs against.
 * `showwavespic` renders the whole file as a single image.
 */
export function buildWaveformArgs(input: {
  audioPath: string;
  outputPath: string;
  width?: number;
  height?: number;
  color?: string;
  backgroundColor?: string;
}): { args: string[] } {
  const width = input.width ?? 1600;
  const height = input.height ?? 320;
  const wave = (input.color ?? '#0F766E').replace('#', '').toLowerCase();
  const background = color(input.backgroundColor ?? '#0B1220');
  return {
    args: [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-i',
      input.audioPath,
      '-filter_complex',
      `[0:a]showwavespic=s=${width}x${height}:colors=0x${wave}[fg];` +
        `color=c=${background}:s=${width}x${height}[bg];` +
        `[bg][fg]overlay=format=auto[out]`,
      '-map',
      '[out]',
      '-frames:v',
      '1',
      input.outputPath,
    ],
  };
}

/**
 * An audiogram: a moving waveform over a still background, optionally with the
 * episode's cover art and burned-in captions. This is the audio pipeline's
 * hand-off to the video one — it writes an MP4 the publishing adapters can use.
 */
export function buildAudiogramArgs(
  job: Required<Pick<AudiogramRenderJob, 'startMs' | 'durationMs' | 'waveformStyle'>> &
    Pick<AudiogramRenderJob, 'waveformColor' | 'backgroundColor'>,
  resources: {
    audioPath: string;
    coverPath?: string;
    captionPath?: string;
    outputPath: string;
  },
  format: { width: number; height: number; fps: number },
  output: { videoCodec: string; crf: number },
): { args: string[] } {
  const { width, height, fps } = format;
  const waveHeight = Math.round(height * 0.3);
  const mode =
    job.waveformStyle === 'LINE' ? 'line' : job.waveformStyle === 'POINT' ? 'p2p' : 'cline';
  const wave = (job.waveformColor ?? '#0F766E').replace('#', '').toLowerCase();
  const background = color(job.backgroundColor ?? '#0B1220');

  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-nostats',
    '-progress',
    'pipe:1',
    '-ss',
    seconds(job.startMs),
    '-t',
    seconds(job.durationMs),
    '-i',
    resources.audioPath,
  ];
  if (resources.coverPath) args.push('-loop', '1', '-i', resources.coverPath);

  const steps: string[] = [
    `color=c=${background}:s=${width}x${height}:r=${fps}[bg]`,
    `[0:a]showwaves=s=${width}x${waveHeight}:mode=${mode}:rate=${fps}:colors=0x${wave}[wave]`,
  ];

  let base = 'bg';
  if (resources.coverPath) {
    const coverSize = Math.round(Math.min(width, height) * 0.45);
    steps.push(
      `[1:v]scale=${coverSize}:${coverSize}:force_original_aspect_ratio=increase,crop=${coverSize}:${coverSize}[cover]`,
    );
    steps.push(`[bg][cover]overlay=x=(W-w)/2:y=(H*0.18)[withcover]`);
    base = 'withcover';
  }
  steps.push(`[${base}][wave]overlay=x=0:y=H-h-${Math.round(height * 0.08)}[composed]`);

  let label = 'composed';
  if (resources.captionPath) {
    steps.push(`[composed]subtitles=filename=${escapeFilterPath(resources.captionPath)}[subbed]`);
    label = 'subbed';
  }
  steps.push(`[${label}]format=yuv420p[vout]`);

  args.push(
    '-filter_complex',
    steps.join(';'),
    '-map',
    '[vout]',
    '-map',
    '0:a',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-c:v',
    output.videoCodec,
    ...(output.videoCodec === 'libx264' ? ['-preset', 'veryfast'] : []),
    '-crf',
    String(output.crf),
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-r',
    String(fps),
    '-t',
    seconds(job.durationMs),
    resources.outputPath,
  );
  return { args };
}
