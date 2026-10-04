import { spawn } from 'node:child_process';

import { VideoRenderError } from './errors';

/**
 * One place that runs ffmpeg and watches it.
 *
 * Shared by the video and audio renderers so both get the same guarantees: real
 * progress from `-progress`, a wall-clock timeout and a cancellation that
 * **kill** the process rather than abandoning it, and a bounded failure note.
 */

export interface FfmpegRunOptions {
  /** Used to turn the encoder's clock into a percentage. */
  totalDurationMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: { percent: number; renderedMs: number }) => void;
}

interface ProgressState {
  outTimeMs: number;
}

/** `-progress pipe:1` emits `key=value` lines; only the clock is read. */
export function readProgress(chunk: string, state: ProgressState): boolean {
  let changed = false;
  for (const line of chunk.split('\n')) {
    const [key, value] = line.split('=');
    if (!key || value === undefined) continue;
    const name = key.trim();
    if (name === 'out_time_us' || name === 'out_time_ms') {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        // Both keys are microseconds in every ffmpeg that emits them.
        state.outTimeMs = Math.round(parsed / 1000);
        changed = true;
      }
    }
  }
  return changed;
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

export function runFfmpeg(
  binary: string,
  args: readonly string[],
  options: FfmpegRunOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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

    // SIGKILL rather than SIGTERM: a stuck encoder must not outlive its job.
    const stop = () => child.kill('SIGKILL');
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);

    if (options.signal?.aborted) {
      cancelled = true;
      stop();
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (readProgress(chunk.toString('utf8'), state) && options.onProgress) {
        const percent =
          options.totalDurationMs > 0
            ? Math.max(
                0,
                Math.min(99, Math.round((state.outTimeMs / options.totalDurationMs) * 100)),
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
            `The render exceeded its ${Math.round(options.timeoutMs / 1000)}s limit and was stopped.`,
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
