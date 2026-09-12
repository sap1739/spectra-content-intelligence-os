import { DEFAULT_X_API_BASE_URL, X_PATHS } from './constants';

/**
 * A narrow X API v2 client: create a post, and the chunked media upload
 * (initialize, append, finalize, status).
 *
 * The access token travels in the Authorization header and never in a URL;
 * redirects are refused; every call times out; error messages carry X's own
 * title/detail with the token scrubbed out.
 */

export interface XApiOptions {
  /** `https://api.x.com`, or a local mock in tests. */
  apiBaseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  uploadTimeoutMs?: number;
}

export type XErrorKind =
  | 'AUTH'
  | 'PERMISSION'
  /** The API plan does not cover this call (not enrolled, or out of credits). */
  | 'ACCESS'
  | 'RATE_LIMIT'
  | 'VALIDATION'
  | 'DUPLICATE'
  | 'NOT_FOUND'
  | 'TRANSIENT'
  | 'UNKNOWN';

export class XApiError extends Error {
  constructor(
    public readonly kind: XErrorKind,
    public readonly httpStatus: number | null,
    /** X's `title` or error code, where it gave one. */
    public readonly code: string | null,
    message: string,
    /** The write may have been applied despite the error (a timeout after sending). */
    public readonly ambiguous = false,
  ) {
    super(message);
    this.name = 'XApiError';
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 60_000;

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

interface XErrorBody {
  title?: unknown;
  detail?: unknown;
  type?: unknown;
  status?: unknown;
  errors?: Array<{ message?: unknown; code?: unknown }>;
}

/**
 * X answers errors either as a problem document (`title`/`detail`) or as an
 * `errors` array with a numeric code; both are read.
 */
function errorFrom(status: number, body: unknown, secret: string): XApiError {
  const problem = (body as XErrorBody | null) ?? {};
  const first = Array.isArray(problem.errors) ? problem.errors[0] : undefined;
  const title = typeof problem.title === 'string' ? problem.title : null;
  const numeric = typeof first?.code === 'number' ? first.code : null;
  const raw =
    typeof problem.detail === 'string' && problem.detail
      ? problem.detail
      : typeof first?.message === 'string'
        ? first.message
        : (title ?? '');
  const detail = raw ? clean(raw, secret) : '';
  const code = title ?? (numeric !== null ? String(numeric) : null);

  let kind: XErrorKind;
  const notEnrolled =
    (title ?? '').toLowerCase().includes('not enrolled') ||
    (title ?? '').toLowerCase().includes('client-not-enrolled') ||
    detail.toLowerCase().includes('not enrolled') ||
    detail.toLowerCase().includes('access level');
  if (numeric === 88 || status === 429) kind = 'RATE_LIMIT';
  else if (numeric === 187) kind = 'DUPLICATE';
  else if (status === 401 || numeric === 89 || numeric === 32) kind = 'AUTH';
  else if (status === 403 && notEnrolled) kind = 'ACCESS';
  else if (status === 402 || status === 453) kind = 'ACCESS';
  else if (status === 403) kind = 'PERMISSION';
  else if (status === 404) kind = 'NOT_FOUND';
  else if (status >= 500) kind = 'TRANSIENT';
  else if (status >= 400) kind = 'VALIDATION';
  else kind = 'UNKNOWN';

  return new XApiError(
    kind,
    status,
    code,
    `X responded ${status}${code ? ` (${code})` : ''}${detail ? `: ${detail}` : ''}`,
  );
}

export interface XMediaStatus {
  mediaId: string;
  /** `pending`, `in_progress`, `succeeded`, `failed`, or absent when done. */
  state: string | null;
  checkAfterSeconds: number | null;
  error: string | null;
}

export class XClient {
  constructor(
    private readonly accessToken: string,
    private readonly options: XApiOptions,
  ) {}

  private get base(): string {
    return (this.options.apiBaseUrl || DEFAULT_X_API_BASE_URL).replace(/\/+$/, '');
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.accessToken}`, accept: 'application/json', ...extra };
  }

  /** `GET /2/...` */
  get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return this.send<T>('GET', url.toString(), this.headers(), undefined, false);
  }

  /** A JSON write, e.g. creating a post. */
  postJson<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>(
      'POST',
      `${this.base}${path}`,
      this.headers({ 'content-type': 'application/json' }),
      JSON.stringify(body),
      true,
    );
  }

  /** Starts a chunked upload and returns the media id. */
  initializeMedia(input: {
    mediaType: string;
    totalBytes: number;
    mediaCategory: string;
  }): Promise<unknown> {
    return this.postJson(X_PATHS.mediaInitialize, {
      media_type: input.mediaType,
      total_bytes: input.totalBytes,
      media_category: input.mediaCategory,
    });
  }

  /** Uploads one segment (5 MB or less) as multipart form data. */
  appendMedia(
    mediaId: string,
    input: { segmentIndex: number; bytes: Uint8Array; contentType: string },
  ): Promise<unknown> {
    const form = new FormData();
    form.append('segment_index', String(input.segmentIndex));
    form.append(
      'media',
      new Blob([new Uint8Array(input.bytes)], { type: input.contentType }),
      `segment-${input.segmentIndex}`,
    );
    return this.send<unknown>(
      'POST',
      `${this.base}${X_PATHS.mediaUpload}/${encodeURIComponent(mediaId)}/append`,
      this.headers(),
      form,
      true,
      this.options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS,
    );
  }

  /** Completes the upload; X may still be processing the file afterwards. */
  finalizeMedia(mediaId: string): Promise<unknown> {
    return this.send<unknown>(
      'POST',
      `${this.base}${X_PATHS.mediaUpload}/${encodeURIComponent(mediaId)}/finalize`,
      this.headers(),
      undefined,
      true,
    );
  }

  /** Reads processing state for an uploaded file. */
  async mediaStatus(mediaId: string): Promise<XMediaStatus> {
    const body = await this.get<unknown>(X_PATHS.mediaUpload, {
      command: 'STATUS',
      media_id: mediaId,
    });
    const data = (body as { data?: Record<string, unknown> } | null)?.data ?? {};
    const info = (data.processing_info ?? {}) as Record<string, unknown>;
    return {
      mediaId: typeof data.id === 'string' ? data.id : mediaId,
      state: typeof info.state === 'string' ? info.state : null,
      checkAfterSeconds: typeof info.check_after_secs === 'number' ? info.check_after_secs : null,
      error:
        typeof (info.error as { message?: unknown } | undefined)?.message === 'string'
          ? (info.error as { message: string }).message
          : null,
    };
  }

  private async send<T>(
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    body: string | FormData | undefined,
    ambiguousOnTimeout: boolean,
    timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new XApiError(
        'TRANSIENT',
        null,
        null,
        timedOut ? 'X did not respond in time' : 'X could not be reached',
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
    if (!response.ok) throw errorFrom(response.status, parsed, this.accessToken);
    return parsed as T;
  }
}
