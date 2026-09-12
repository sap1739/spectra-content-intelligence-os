import { DEFAULT_TIKTOK_API_BASE_URL } from './constants';

/**
 * A narrow Content Posting API client.
 *
 * TikTok answers HTTP 200 with an `error.code` of `ok` on success, so every
 * response is inspected rather than trusted by status alone. The access token
 * travels in the Authorization header and never in a URL; redirects are
 * refused; calls time out; messages carry TikTok's own error code with the
 * token scrubbed out.
 *
 * The upload URL TikTok returns is a signed, short-lived capability. Bytes go
 * only to a TikTok host, and the access token is NOT sent with them — the
 * upload is authorized by the URL itself.
 */

export interface TikTokApiOptions {
  /** `https://open.tiktokapis.com`, or a local mock in tests. */
  apiBaseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  uploadTimeoutMs?: number;
}

export type TikTokErrorKind =
  | 'AUTH'
  | 'PERMISSION'
  /** The client has not passed TikTok's audit, so this post is not allowed. */
  | 'AUDIT'
  | 'RATE_LIMIT'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'TRANSIENT'
  | 'UNKNOWN';

export class TikTokApiError extends Error {
  constructor(
    public readonly kind: TikTokErrorKind,
    public readonly httpStatus: number | null,
    /** TikTok's own `error.code`, e.g. `spam_risk_too_many_posts`. */
    public readonly code: string | null,
    message: string,
    /** The write may have been applied despite the error (a timeout after sending). */
    public readonly ambiguous = false,
    /** The upload URL is gone; a retry must start a new publish. */
    public readonly uploadExpired = false,
  ) {
    super(message);
    this.name = 'TikTokApiError';
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;

const AUTH = new Set([
  'access_token_invalid',
  'token_not_authorized_for_specified_publish_id',
  'invalid_access_token',
]);
const PERMISSION = new Set([
  'scope_not_authorized',
  'scope_permission_missed',
  'permission_denied',
  'user_has_not_authorized_scope',
]);
const RATE = new Set([
  'rate_limit_exceeded',
  'spam_risk_too_many_posts',
  'spam_risk_user_banned_from_posting',
  'spam_risk',
  'reached_active_user_cap',
]);
const VALIDATION = new Set([
  'invalid_param',
  'invalid_publish_id',
  'invalid_file_upload',
  'privacy_level_option_mismatch',
  'url_ownership_unverified',
  'file_format_check_failed',
  'duration_check_failed',
  'frame_rate_check_failed',
  'picture_size_check_failed',
  'video_pull_failed',
]);

/** The audit restriction gets its own kind: it is not a permission the user can grant. */
const AUDIT = new Set([
  'unaudited_client_can_only_post_to_private_accounts',
  'unaudited_client_can_only_post_to_private_account',
]);

function kindFor(code: string | null, status: number): TikTokErrorKind {
  if (code) {
    if (AUDIT.has(code)) return 'AUDIT';
    if (AUTH.has(code)) return 'AUTH';
    if (PERMISSION.has(code)) return 'PERMISSION';
    if (RATE.has(code)) return 'RATE_LIMIT';
    if (VALIDATION.has(code)) return 'VALIDATION';
    if (code === 'internal_error') return 'TRANSIENT';
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

interface TikTokEnvelope {
  error?: { code?: unknown; message?: unknown; log_id?: unknown };
}

/** TikTok signs its upload URLs; bytes only ever go to a TikTok host. */
export function isAllowedUploadUrl(value: string, apiBaseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  try {
    if (url.origin === new URL(apiBaseUrl).origin) return true;
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return ['.tiktokapis.com', '.tiktokcdn.com', '.tiktokcdn-us.com', '.tiktokv.com'].some((suffix) =>
    url.hostname.endsWith(suffix),
  );
}

export class TikTokClient {
  constructor(
    private readonly accessToken: string,
    private readonly options: TikTokApiOptions,
  ) {}

  private get base(): string {
    return (this.options.apiBaseUrl || DEFAULT_TIKTOK_API_BASE_URL).replace(/\/+$/, '');
  }

  /** A Content Posting API call. Throws on any non-`ok` error code. */
  async post<T>(path: string, body: unknown): Promise<T> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(`${this.base}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          'content-type': 'application/json; charset=UTF-8',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new TikTokApiError(
        'TRANSIENT',
        null,
        null,
        timedOut ? 'TikTok did not respond in time' : 'TikTok could not be reached',
        // A publish that was sent but unanswered may have been accepted.
        timedOut && path !== '/v2/post/publish/status/fetch/',
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
    const envelope = (parsed as TikTokEnvelope | null)?.error ?? {};
    const code = typeof envelope.code === 'string' ? envelope.code : null;
    if (!response.ok || (code !== null && code !== 'ok')) {
      const raw = typeof envelope.message === 'string' ? envelope.message : '';
      const detail = raw ? clean(raw, this.accessToken) : '';
      throw new TikTokApiError(
        kindFor(code, response.status),
        response.status,
        code,
        `TikTok responded ${response.status}${code ? ` (${code})` : ''}${detail ? `: ${detail}` : ''}`,
      );
    }
    return parsed as T;
  }

  /**
   * Uploads one chunk to the signed URL. No access token is sent: the URL is
   * the authorization, and TikTok expects only the range headers.
   */
  async uploadChunk(
    uploadUrl: string,
    input: { bytes: Uint8Array; start: number; end: number; total: number; contentType: string },
  ): Promise<void> {
    if (!isAllowedUploadUrl(uploadUrl, this.base)) {
      throw new TikTokApiError(
        'VALIDATION',
        null,
        null,
        'The upload URL TikTok returned is not a TikTok address',
        false,
        true,
      );
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: {
          'content-type': input.contentType,
          'content-length': String(input.bytes.byteLength),
          'content-range': `bytes ${input.start}-${input.end}/${input.total}`,
        },
        body: input.bytes as unknown as RequestInit['body'],
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new TikTokApiError(
        'TRANSIENT',
        null,
        null,
        timedOut
          ? 'TikTok did not respond in time while the video was uploading'
          : 'TikTok could not be reached',
      );
    }
    if (response.status === 403 || response.status === 404) {
      throw new TikTokApiError(
        'VALIDATION',
        response.status,
        null,
        'The TikTok upload URL has expired',
        false,
        true,
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new TikTokApiError(
        kindFor(null, response.status),
        response.status,
        null,
        `TikTok refused the video chunk (${response.status})${text ? `: ${clean(text, this.accessToken, 120)}` : ''}`,
      );
    }
  }
}
