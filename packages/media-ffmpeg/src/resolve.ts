import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

import type { FfmpegRendererOptions } from './ffmpeg-video-renderer';

/**
 * Finding the engine without vendoring it.
 *
 * Spectra ships no ffmpeg binary (ADR-0041): the build belongs to the
 * deployment, so this resolves an explicit path first, then PATH, and reports
 * honestly when it finds nothing.
 */

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env['PATH'];
  if (!path) return null;
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Fonts shipped with the common worker base images, in preference order.
 * drawtext needs a file; a build without fontconfig cannot resolve a family.
 */
const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/Library/Fonts/Arial.ttf',
];

export function resolveFontFile(explicit?: string | null): string | null {
  if (explicit) return isExecutableOrReadable(explicit) ? explicit : null;
  return FONT_CANDIDATES.find((candidate) => isExecutableOrReadable(candidate)) ?? null;
}

function isExecutableOrReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ResolveVideoEngineInput {
  ffmpegPath?: string | null;
  ffprobePath?: string | null;
  fontFile?: string | null;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Always returns options — a missing binary is reported by the renderer's own
 * `capabilities()`, so "not configured" is a visible state rather than a crash
 * at construction.
 */
export function resolveVideoEngineOptions(
  input: ResolveVideoEngineInput = {},
): FfmpegRendererOptions {
  const env = input.env ?? process.env;
  const ffmpegPath =
    (input.ffmpegPath ?? env['FFMPEG_PATH'] ?? null) || findOnPath('ffmpeg', env) || 'ffmpeg';
  const ffprobePath =
    (input.ffprobePath ?? env['FFPROBE_PATH'] ?? null) || findOnPath('ffprobe', env) || 'ffprobe';
  return {
    ffmpegPath,
    ffprobePath,
    fontFile: resolveFontFile(input.fontFile ?? env['VIDEO_FONT_FILE'] ?? null),
    timeoutMs: input.timeoutMs ?? 15 * 60_000,
  };
}
