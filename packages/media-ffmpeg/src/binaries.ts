import { spawn } from 'node:child_process';

/**
 * Locating and interrogating the engine.
 *
 * **No ffmpeg binary is vendored.** The path comes from configuration or PATH,
 * and the build is whatever the deployment installed — which is why every
 * capability below is detected at runtime rather than assumed (ADR-0041).
 */

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started at all. */
  spawnError: string | null;
}

export function runTool(
  binary: string,
  args: readonly string[],
  options: { timeoutMs?: number; signal?: AbortSignal; maxOutputBytes?: number } = {},
): Promise<RunResult> {
  const maxOutput = options.maxOutputBytes ?? 256 * 1024;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const child = spawn(binary, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < maxOutput) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Keep the tail: ffmpeg puts the actual error last.
      stderr = (stderr + chunk.toString('utf8')).slice(-maxOutput);
    });
    child.on('error', (error: Error) =>
      finish({ code: null, stdout, stderr, spawnError: error.message }),
    );
    child.on('close', (code) => finish({ code, stdout, stderr, spawnError: null }));

    if (options.timeoutMs) {
      timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
    }
    if (options.signal) {
      if (options.signal.aborted) child.kill('SIGKILL');
      else options.signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    }
  });
}

export interface EngineProbe {
  path: string;
  version: string | null;
  encoders: Set<string>;
  filters: Set<string>;
  /** Why the probe failed, when it did. */
  error: string | null;
}

function parseVersion(output: string): string | null {
  const match = /^ffmpeg version (\S+)/m.exec(output);
  return match?.[1] ?? null;
}

/** `ffmpeg -encoders` / `-filters` list one name per line in a fixed column. */
function parseNames(output: string, startAfter: string): Set<string> {
  const names = new Set<string>();
  const lines = output.split('\n');
  const start = lines.findIndex((line) => line.includes(startAfter));
  for (const line of lines.slice(start + 1)) {
    const match = /^\s*\S+\s+(\S+)/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

export async function probeEngine(binary: string, timeoutMs = 10_000): Promise<EngineProbe> {
  const version = await runTool(binary, ['-hide_banner', '-version'], { timeoutMs });
  if (version.spawnError || version.code !== 0) {
    return {
      path: binary,
      version: null,
      encoders: new Set(),
      filters: new Set(),
      error: version.spawnError ?? `exited ${version.code}`,
    };
  }
  const [encoders, filters] = await Promise.all([
    runTool(binary, ['-hide_banner', '-encoders'], { timeoutMs, maxOutputBytes: 1024 * 1024 }),
    runTool(binary, ['-hide_banner', '-filters'], { timeoutMs, maxOutputBytes: 1024 * 1024 }),
  ]);
  return {
    path: binary,
    version: parseVersion(version.stdout + version.stderr),
    encoders: parseNames(encoders.stdout, '------'),
    filters: parseNames(filters.stdout, '-----'),
    error: null,
  };
}
