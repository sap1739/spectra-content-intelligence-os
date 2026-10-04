import type { PlannedScene, VideoRenderPlan } from './plan';

/**
 * Render plan → FFmpeg arguments. A pure function, which is the point: the
 * whole command line is unit-testable without a binary, and every argument is
 * an array element, so nothing is ever assembled into a shell string.
 *
 * Two rules this file exists to enforce:
 *  1. **No user text enters the filtergraph.** Scene text and captions are
 *     written to files by the caller; only paths Spectra generated appear here.
 *  2. **No user value is interpolated unescaped.** Colours are validated hex,
 *     numbers are numbers, and paths go through `escapeFilterPath`.
 */

export interface FfmpegRenderResources {
  /** Local file for each image asset the plan referenced. */
  imageFiles: Record<string, string>;
  /** Local file holding the text of each planned overlay, keyed by text key. */
  textFiles: Record<string, string>;
  /** A TTF/OTF the build can read — drawtext needs a file, not a family name. */
  fontFile: string;
  /** The audio bed, when the storyboard has one. */
  audioFile?: string;
  /** An SRT file, required only when the plan burns captions in. */
  captionFile?: string;
  outputPath: string;
}

export class FfmpegArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FfmpegArgsError';
  }
}

/** `#RRGGBB` → the `0xRRGGBB` ffmpeg wants. The input is schema-validated hex. */
function color(hex: string): string {
  return `0x${hex.replace('#', '').toUpperCase()}`;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

/**
 * Filtergraph escaping for a path: a backslash, colon, comma, quote or bracket
 * inside a filter argument would end it early.
 */
export function escapeFilterPath(path: string): string {
  return path.replace(/([\\':,[\]])/g, '\\$1');
}

function backgroundChain(scene: PlannedScene, plan: VideoRenderPlan): string[] {
  const { width, height, fps } = plan.format;
  const chain: string[] = [];
  if (scene.background.kind === 'IMAGE') {
    const { fit, padColor, motion } = scene.background;
    if (motion === 'NONE') {
      chain.push(
        fit === 'COVER'
          ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
          : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${color(padColor)}`,
      );
    } else {
      // zoompan samples a larger canvas so the push stays sharp; it also owns
      // the frame count, so the scene's duration is expressed in frames here.
      const frames = Math.max(1, Math.round((scene.durationMs / 1000) * fps));
      const upscaleW = width * 2;
      const upscaleH = height * 2;
      chain.push(
        fit === 'COVER'
          ? `scale=${upscaleW}:${upscaleH}:force_original_aspect_ratio=increase,crop=${upscaleW}:${upscaleH}`
          : `scale=${upscaleW}:${upscaleH}:force_original_aspect_ratio=decrease,pad=${upscaleW}:${upscaleH}:(ow-iw)/2:(oh-ih)/2:color=${color(padColor)}`,
      );
      const zoomExpr =
        motion === 'ZOOM_IN'
          ? `'min(zoom+0.0010,1.20)'`
          : `'if(lte(on,1),1.20,max(1.0,zoom-0.0010))'`;
      chain.push(
        `zoompan=z=${zoomExpr}:d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`,
      );
    }
  }
  chain.push('setsar=1', `fps=${fps}`, 'format=yuv420p');
  return chain;
}

function textChain(
  scene: PlannedScene,
  plan: VideoRenderPlan,
  resources: FfmpegRenderResources,
): string[] {
  const chain: string[] = [];
  for (const text of scene.texts) {
    const file = resources.textFiles[text.key];
    if (!file) {
      throw new FfmpegArgsError(`No text file was prepared for overlay "${text.key}".`);
    }
    if (text.background === 'BAND') {
      const bandY = Math.max(0, text.yPx - text.padPx);
      const bandH = Math.min(plan.format.height - bandY, text.fontSizePx + text.padPx * 2);
      chain.push(`drawbox=x=0:y=${bandY}:w=iw:h=${bandH}:color=0x000000@0.45:t=fill`);
    }
    const parts = [
      `fontfile=${escapeFilterPath(resources.fontFile)}`,
      `textfile=${escapeFilterPath(file)}`,
      `fontcolor=${color(text.color)}`,
      `fontsize=${text.fontSizePx}`,
      'x=(w-text_w)/2',
      `y=${text.yPx}`,
    ];
    if (text.background === 'BOX') {
      parts.push('box=1', 'boxcolor=0x000000@0.55', `boxborderw=${text.padPx}`);
    }
    chain.push(`drawtext=${parts.join(':')}`);
  }
  return chain;
}

export interface FfmpegArgs {
  args: string[];
  /** Total output duration, so a progress reader can turn time into percent. */
  totalDurationMs: number;
}

export interface FfmpegOutputSettings {
  /** Constant Rate Factor — lower is better quality and a bigger file. */
  crf: number;
  /**
   * The H.264 encoder to use. `libx264` is the default; a build without it can
   * pass a hardware encoder it does have (the adapter decides, never a user).
   */
  videoCodec: string;
}

export function buildFfmpegArgs(
  plan: VideoRenderPlan,
  resources: FfmpegRenderResources,
  output: FfmpegOutputSettings,
): FfmpegArgs {
  if (plan.scenes.length === 0) {
    throw new FfmpegArgsError('A render plan needs at least one scene.');
  }
  if (plan.burnCaptions && !resources.captionFile) {
    throw new FfmpegArgsError('This plan burns captions in, but no caption file was prepared.');
  }
  if (plan.audio && !resources.audioFile) {
    throw new FfmpegArgsError('This plan has an audio bed, but no audio file was prepared.');
  }

  const { width, height, fps } = plan.format;
  const args: string[] = ['-hide_banner', '-nostdin', '-y', '-nostats', '-progress', 'pipe:1'];

  // ---- inputs, one per scene, in plan order --------------------------------
  for (const scene of plan.scenes) {
    const duration = seconds(scene.durationMs);
    if (scene.background.kind === 'COLOR') {
      args.push(
        '-f',
        'lavfi',
        '-t',
        duration,
        '-i',
        `color=c=${color(scene.background.color)}:s=${width}x${height}:r=${fps}`,
      );
    } else {
      const file = resources.imageFiles[scene.background.mediaAssetId];
      if (!file) {
        throw new FfmpegArgsError(
          `No local file was prepared for image asset ${scene.background.mediaAssetId}.`,
        );
      }
      args.push('-loop', '1', '-t', duration, '-i', file);
    }
  }
  const audioInputIndex = plan.scenes.length;
  if (plan.audio && resources.audioFile) {
    args.push('-i', resources.audioFile);
  }

  // ---- filtergraph ---------------------------------------------------------
  const steps: string[] = [];
  plan.scenes.forEach((scene, index) => {
    const chain = [...backgroundChain(scene, plan), ...textChain(scene, plan, resources)];
    // A scene's own trim keeps zoompan and lavfi honest about its length.
    chain.push(`trim=duration=${seconds(scene.durationMs)}`, 'setpts=PTS-STARTPTS');
    steps.push(`[${index}:v]${chain.join(',')}[s${index}]`);
  });

  let videoLabel: string;
  if (plan.scenes.length === 1) {
    videoLabel = 's0';
  } else if (plan.transitionMs > 0) {
    // Chain crossfades: each join starts where the next scene starts, which the
    // plan already computed with the overlap subtracted.
    let current = 's0';
    plan.scenes.slice(1).forEach((scene, offsetIndex) => {
      const next = `x${offsetIndex}`;
      steps.push(
        `[${current}][s${offsetIndex + 1}]xfade=transition=fade:duration=${seconds(plan.transitionMs)}:offset=${seconds(scene.startMs)}[${next}]`,
      );
      current = next;
    });
    videoLabel = current;
  } else {
    const inputs = plan.scenes.map((_, index) => `[s${index}]`).join('');
    steps.push(`${inputs}concat=n=${plan.scenes.length}:v=1:a=0[cat]`);
    videoLabel = 'cat';
  }

  if (plan.burnCaptions && resources.captionFile) {
    steps.push(`[${videoLabel}]subtitles=filename=${escapeFilterPath(resources.captionFile)}[sub]`);
    videoLabel = 'sub';
  }
  // A final format pass: every encoder downstream wants a known pixel format.
  steps.push(`[${videoLabel}]format=yuv420p[vout]`);

  let audioLabel: string | null = null;
  if (plan.audio) {
    const fadeStartMs = Math.max(0, plan.totalDurationMs - plan.audio.fadeOutMs);
    const audioChain = [`volume=${plan.audio.gainDb}dB`];
    if (plan.audio.fadeOutMs > 0) {
      audioChain.push(`afade=t=out:st=${seconds(fadeStartMs)}:d=${seconds(plan.audio.fadeOutMs)}`);
    }
    audioChain.push(`atrim=duration=${seconds(plan.totalDurationMs)}`, 'asetpts=PTS-STARTPTS');
    steps.push(`[${audioInputIndex}:a]${audioChain.join(',')}[aout]`);
    audioLabel = 'aout';
  }

  args.push('-filter_complex', steps.join(';'), '-map', '[vout]');
  if (audioLabel) args.push('-map', `[${audioLabel}]`, '-c:a', 'aac', '-b:a', '128k');
  else args.push('-an');

  args.push(
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
    seconds(plan.totalDurationMs),
    resources.outputPath,
  );

  return { args, totalDurationMs: plan.totalDurationMs };
}
