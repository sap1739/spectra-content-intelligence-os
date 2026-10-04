import type { VideoFailureReason } from '@spectra/contracts';

/**
 * Every way a render can fail, as a typed error carrying the reason code the
 * database and the UI will show. A render never fails anonymously.
 */
export class VideoRenderError extends Error {
  readonly reason: VideoFailureReason;
  /** Engine output, already trimmed — never the whole log, never a token. */
  readonly detail: string | null;

  constructor(reason: VideoFailureReason, message: string, detail?: string | null) {
    super(message);
    this.name = 'VideoRenderError';
    this.reason = reason;
    this.detail = detail ?? null;
  }
}
