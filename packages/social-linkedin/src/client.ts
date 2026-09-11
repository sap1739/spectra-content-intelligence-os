/**
 * A narrow client for LinkedIn's REST APIs.
 *
 * Versioned `/rest` calls always carry `Linkedin-Version` and
 * `X-Restli-Protocol-Version: 2.0.0` (LinkedIn rejects unversioned calls).
 * Redirects are refused — the request carries a bearer token — and every call
 * times out. Errors carry the HTTP status, LinkedIn's own error code and a
 * trimmed message; never the token or the request body.
 */

export interface LinkedInApiOptions {
  /** `https://api.linkedin.com`, or a local mock in tests. */
  apiBaseUrl: string;
  /** `YYYYMM`. */
  version: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type LinkedInErrorKind =
  | 'AUTH'
  | 'PERMISSION'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'RATE_LIMIT'
  | 'CONFLICT'
  | 'TRANSIENT'
  | 'UNKNOWN';

export class LinkedInApiError extends Error {
  constructor(
    public readonly kind: LinkedInErrorKind,
    public readonly httpStatus: number | null,
    /** LinkedIn's own error code (e.g. ACCESS_DENIED) when it sent one. */
    public readonly code: string | null,
    message: string,
    /**
     * The request may have reached LinkedIn and succeeded anyway — a timeout
     * after a POST was sent. Retrying could create a duplicate.
     */
    public readonly ambiguous = false,
  ) {
    super(message);
    this.name = 'LinkedInApiError';
  }

  get retryable(): boolean {
    return this.kind === 'RATE_LIMIT' || this.kind === 'TRANSIENT' || this.kind === 'CONFLICT';
  }
}

export interface LinkedInResponse<T> {
  status: number;
  headers: Headers;
  body: T | null;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

function kindForStatus(status: number): LinkedInErrorKind {
  if (status === 401) return 'AUTH';
  if (status === 403) return 'PERMISSION';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'TRANSIENT';
  if (status >= 400) return 'VALIDATION';
  return 'UNKNOWN';
}

/** Printable, single-line, bounded. */
function clean(text: string, max = 200): string {
  const printable = [...text]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : char;
    })
    .join('');
  const flat = printable.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function errorFrom(status: number, body: unknown): LinkedInApiError {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const code =
    typeof record['code'] === 'string' && ERROR_CODE.test(record['code']) ? record['code'] : null;
  const detail = typeof record['message'] === 'string' ? clean(record['message']) : '';
  return new LinkedInApiError(
    kindForStatus(status),
    status,
    code,
    `LinkedIn responded ${status}${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}`,
  );
}

/**
 * An upload URL must really be LinkedIn's: the image AND the bearer token go
 * there. `*.linkedin.com` over https, or the configured API origin itself
 * (which is how a local mock is reached in tests).
 */
export function isAllowedUploadUrl(uploadUrl: string, apiBaseUrl: string): boolean {
  let url: URL;
  let base: URL;
  try {
    url = new URL(uploadUrl);
    base = new URL(apiBaseUrl);
  } catch {
    return false;
  }
  if (url.origin === base.origin) return true;
  return (
    url.protocol === 'https:' &&
    (url.hostname === 'linkedin.com' || url.hostname.endsWith('.linkedin.com'))
  );
}

export class LinkedInClient {
  private readonly base: string;

  constructor(
    private readonly accessToken: string,
    private readonly options: LinkedInApiOptions,
  ) {
    this.base = options.apiBaseUrl.replace(/\/+$/, '');
  }

  /** A versioned `/rest` call. `query` is appended verbatim (Rest.li `List(...)` syntax). */
  rest<T>(
    method: 'GET' | 'POST',
    path: string,
    init: { query?: string; body?: unknown } = {},
  ): Promise<LinkedInResponse<T>> {
    return this.send<T>(
      method,
      `${this.base}${path}${init.query ? `?${init.query}` : ''}`,
      {
        'Linkedin-Version': this.options.version,
        'X-Restli-Protocol-Version': '2.0.0',
      },
      init.body,
    );
  }

  /** An unversioned `/v2` call — only OpenID Connect userinfo uses one. */
  v2<T>(path: string): Promise<LinkedInResponse<T>> {
    return this.send<T>('GET', `${this.base}${path}`, {}, undefined);
  }

  /** PUTs image bytes to the upload URL LinkedIn issued, with the bearer token LinkedIn requires. */
  async upload(uploadUrl: string, bytes: Uint8Array): Promise<void> {
    if (!isAllowedUploadUrl(uploadUrl, this.base)) {
      throw new LinkedInApiError(
        'VALIDATION',
        null,
        null,
        'LinkedIn returned an upload URL outside linkedin.com; the image and token were not sent there',
      );
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          'content-type': 'application/octet-stream',
        },
        body: new Uint8Array(bytes),
        redirect: 'error',
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new LinkedInApiError(
        'TRANSIENT',
        null,
        null,
        timedOut
          ? 'The image upload to LinkedIn timed out'
          : 'LinkedIn could not be reached for the upload',
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      throw errorFrom(response.status, parsed);
    }
  }

  private async send<T>(
    method: 'GET' | 'POST',
    url: string,
    extraHeaders: Record<string, string>,
    body: unknown,
  ): Promise<LinkedInResponse<T>> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...extraHeaders,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new LinkedInApiError(
        'TRANSIENT',
        null,
        null,
        timedOut ? 'LinkedIn did not respond in time' : 'LinkedIn could not be reached',
        // A POST that timed out may still have been applied.
        method === 'POST' && timedOut,
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
    if (!response.ok) throw errorFrom(response.status, parsed);
    return { status: response.status, headers: response.headers, body: parsed as T | null };
  }
}
