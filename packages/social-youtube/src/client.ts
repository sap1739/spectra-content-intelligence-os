import { DEFAULT_YOUTUBE_API_BASE_URL } from './constants';

/**
 * A narrow YouTube Data API v3 client: JSON reads, the documented resumable
 * upload protocol, and thumbnail uploads.
 *
 * The access token travels in the Authorization header and never in a URL.
 * Redirects are refused, every call times out, and error messages carry
 * Google's status and `reason` with the token scrubbed out. The resumable
 * session URI Google hands back is checked against the API origin before any
 * bytes or token are sent to it.
 */

export interface YouTubeApiOptions {
  /** `https://www.googleapis.com`, or a local mock in tests. */
  apiBaseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  uploadTimeoutMs?: number;
}

export type YouTubeErrorKind =
  | 'AUTH'
  | 'PERMISSION'
  | 'QUOTA'
  | 'RATE_LIMIT'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'TRANSIENT'
  | 'UNKNOWN';

export class YouTubeApiError extends Error {
  constructor(
    public readonly kind: YouTubeErrorKind,
    public readonly httpStatus: number | null,
    /** Google's own `error.errors[].reason`, e.g. `quotaExceeded`. */
    public readonly reason: string | null,
    message: string,
    /** The write may have been applied despite the error (a timeout after sending). */
    public readonly ambiguous = false,
    /** The resumable session is gone; a retry must start a new one. */
    public readonly sessionExpired = false,
  ) {
    super(message);
    this.name = 'YouTubeApiError';
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;

const QUOTA = new Set(['quotaExceeded', 'dailyLimitExceeded']);
const RATE = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'uploadLimitExceeded',
  'uploadRateLimitExceeded',
]);
const AUTH = new Set([
  'authError',
  'authorizationRequired',
  'invalid_token',
  'youtubeSignupRequired',
]);
const PERMISSION = new Set([
  'forbidden',
  'insufficientPermissions',
  'insufficientFilePermissions',
  'accountClosed',
  'accountSuspended',
  'accountDelinquent',
]);

/** Google's error-handling guide, reason first and status second. */
function kindFor(reason: string | null, status: number): YouTubeErrorKind {
  if (reason) {
    if (QUOTA.has(reason)) return 'QUOTA';
    if (RATE.has(reason)) return 'RATE_LIMIT';
    if (AUTH.has(reason)) return 'AUTH';
    if (PERMISSION.has(reason)) return 'PERMISSION';
    if (reason.startsWith('invalid') || reason === 'badRequest') return 'VALIDATION';
    if (reason.endsWith('NotFound') || reason === 'notFound') return 'NOT_FOUND';
    if (reason === 'backendError' || reason === 'internalError') return 'TRANSIENT';
  }
  if (status === 401) return 'AUTH';
  if (status === 403) return 'PERMISSION';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'TRANSIENT';
  if (status >= 400) return 'VALIDATION';
  return 'UNKNOWN';
}

function clean(text: string, secret: string, max = 240): string {
  const printable = [...text]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : char;
    })
    .join('')
    .split(secret)
    .join('[redacted]');
  const flat = printable.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

interface GoogleErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    errors?: Array<{ reason?: unknown; message?: unknown }>;
    status?: unknown;
  };
}

function errorFrom(status: number, body: unknown, secret: string): YouTubeApiError {
  const error = (body as GoogleErrorBody | null)?.error ?? {};
  const first = Array.isArray(error.errors) ? error.errors[0] : undefined;
  const reason = typeof first?.reason === 'string' ? first.reason : null;
  const raw =
    typeof first?.message === 'string' && first.message
      ? first.message
      : typeof error.message === 'string'
        ? error.message
        : '';
  const detail = raw ? clean(raw, secret) : '';
  return new YouTubeApiError(
    kindFor(reason, status),
    status,
    reason,
    `YouTube responded ${status}${reason ? ` (${reason})` : ''}${detail ? `: ${detail}` : ''}`,
  );
}

/**
 * Google returns the resumable session URI in a Location header. Bytes and the
 * bearer token only go to the API's own origin (or a *.googleapis.com host).
 */
export function isAllowedSessionUrl(value: string, apiBaseUrl: string): boolean {
  let url: URL;
  let base: URL;
  try {
    url = new URL(value);
    base = new URL(apiBaseUrl);
  } catch {
    return false;
  }
  if (url.origin === base.origin) return true;
  return url.protocol === 'https:' && url.hostname.endsWith('.googleapis.com');
}

export interface UploadProgress {
  /** The upload finished and YouTube returned the video resource. */
  done: boolean;
  /** Bytes YouTube confirmed receiving, when it is not finished. */
  nextByte: number;
  video: unknown;
}

export class YouTubeClient {
  constructor(
    private readonly accessToken: string,
    private readonly options: YouTubeApiOptions,
  ) {}

  private get base(): string {
    return (this.options.apiBaseUrl || DEFAULT_YOUTUBE_API_BASE_URL).replace(/\/+$/, '');
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.accessToken}`, accept: 'application/json', ...extra };
  }

  /** A Data API read, e.g. `channels` or `videos`. */
  async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${this.base}/youtube/v3/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const { status, body } = await this.send(
      url.toString(),
      { method: 'GET', headers: this.headers() },
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      false,
    );
    if (status >= 400) throw errorFrom(status, body, this.accessToken);
    return body as T;
  }

  /**
   * Starts a resumable upload: the metadata goes in the body, the file's size
   * and type in headers, and Google answers with the session URI.
   */
  async initiateUpload(input: {
    part: string;
    /** Extra query parameters videos.insert takes, such as notifySubscribers. */
    params?: Record<string, string>;
    metadata: unknown;
    contentLength: number;
    contentType: string;
  }): Promise<string> {
    const target = new URL(`${this.base}/upload/youtube/v3/videos`);
    target.searchParams.set('uploadType', 'resumable');
    target.searchParams.set('part', input.part);
    for (const [key, value] of Object.entries(input.params ?? {})) {
      target.searchParams.set(key, value);
    }
    const url = target.toString();
    const { status, body, headers } = await this.send(
      url,
      {
        method: 'POST',
        headers: this.headers({
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-length': String(input.contentLength),
          'x-upload-content-type': input.contentType,
        }),
        body: JSON.stringify(input.metadata),
      },
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      false,
    );
    if (status >= 400) throw errorFrom(status, body, this.accessToken);
    const location = headers.get('location');
    if (!location || !isAllowedSessionUrl(location, this.base)) {
      throw new YouTubeApiError(
        'UNKNOWN',
        status,
        null,
        location
          ? 'YouTube returned an upload location outside its own API, which Spectra will not upload to'
          : 'YouTube did not return an upload location',
      );
    }
    return location;
  }

  /** Uploads one chunk. `start` is the offset of `bytes` within the file. */
  uploadChunk(
    sessionUrl: string,
    input: { bytes: Uint8Array; start: number; total: number; contentType: string },
  ): Promise<UploadProgress> {
    const end = input.start + input.bytes.byteLength - 1;
    return this.putToSession(
      sessionUrl,
      {
        'content-type': input.contentType,
        'content-range': `bytes ${input.start}-${end}/${input.total}`,
      },
      input.bytes,
      input.total,
    );
  }

  /** Asks how much of an interrupted upload YouTube already has. */
  probeUpload(sessionUrl: string, total: number): Promise<UploadProgress> {
    return this.putToSession(sessionUrl, { 'content-range': `bytes */${total}` }, undefined, total);
  }

  private async putToSession(
    sessionUrl: string,
    extraHeaders: Record<string, string>,
    body: Uint8Array | undefined,
    total: number,
  ): Promise<UploadProgress> {
    if (!isAllowedSessionUrl(sessionUrl, this.base)) {
      throw new YouTubeApiError(
        'VALIDATION',
        null,
        null,
        'The stored upload session is not a YouTube API address',
        false,
        true,
      );
    }
    const {
      status,
      body: parsed,
      headers,
    } = await this.send(
      sessionUrl,
      {
        method: 'PUT',
        headers: this.headers(extraHeaders),
        ...(body ? { body: body as unknown as RequestInit['body'] } : {}),
        // Google answers an incomplete upload with 308, which fetch counts as a
        // redirect status: 'error' would make every chunk a network error.
        // 'manual' still never follows one — an unexpected status is an error
        // below, and the session URL was checked against the API origin first.
        redirect: 'manual',
      },
      this.options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS,
      body !== undefined,
    );
    if (status === 200 || status === 201) return { done: true, nextByte: total, video: parsed };
    if (status === 308) {
      const range = headers.get('range');
      const match = range ? /bytes=0-(\d+)/.exec(range) : null;
      // No Range header means YouTube has nothing yet.
      return { done: false, nextByte: match?.[1] ? Number(match[1]) + 1 : 0, video: null };
    }
    if (status === 404) {
      throw new YouTubeApiError(
        'NOT_FOUND',
        status,
        null,
        'The upload session expired before the video finished uploading',
        false,
        true,
      );
    }
    throw errorFrom(status, parsed, this.accessToken);
  }

  /** Sets a custom thumbnail on an uploaded video. */
  async setThumbnail(videoId: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    const url = `${this.base}/upload/youtube/v3/thumbnails/set?uploadType=media&videoId=${encodeURIComponent(videoId)}`;
    const { status, body } = await this.send(
      url,
      {
        method: 'POST',
        headers: this.headers({ 'content-type': mimeType }),
        body: bytes as unknown as RequestInit['body'],
      },
      this.options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS,
      true,
    );
    if (status >= 400) throw errorFrom(status, body, this.accessToken);
  }

  private async send(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    ambiguousOnTimeout: boolean,
  ): Promise<{ status: number; body: unknown; headers: Headers }> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        redirect: init.redirect ?? 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new YouTubeApiError(
        'TRANSIENT',
        null,
        null,
        timedOut ? 'YouTube did not respond in time' : 'YouTube could not be reached',
        ambiguousOnTimeout && timedOut,
      );
    }
    const text = await response.text().catch(() => '');
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    return { status: response.status, body: parsed, headers: response.headers };
  }
}
