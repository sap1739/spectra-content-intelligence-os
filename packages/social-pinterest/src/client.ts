import { DEFAULT_PINTEREST_API_BASE_URL, PINTEREST_API_VERSION } from './constants';

/**
 * A narrow Pinterest API v5 client.
 *
 * The access token travels in the Authorization header and never in a URL;
 * redirects are refused; every call times out; error messages carry
 * Pinterest's own `message` with the token scrubbed out.
 */

export interface PinterestApiOptions {
  /** `https://api.pinterest.com`, or a local mock in tests. */
  apiBaseUrl: string;
  version?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type PinterestErrorKind =
  | 'AUTH'
  | 'PERMISSION'
  /** Pinterest refused the image itself: too small, too large or broken. */
  | 'IMAGE_REFUSED'
  | 'RATE_LIMIT'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'TRANSIENT'
  | 'UNKNOWN';

export class PinterestApiError extends Error {
  constructor(
    public readonly kind: PinterestErrorKind,
    public readonly httpStatus: number | null,
    /** Pinterest's numeric `code`, where it gave one. */
    public readonly code: number | null,
    message: string,
    /** The write may have been applied despite the error (a timeout after sending). */
    public readonly ambiguous = false,
  ) {
    super(message);
    this.name = 'PinterestApiError';
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;

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

interface PinterestErrorBody {
  message?: unknown;
  code?: unknown;
}

/**
 * Pinterest documents these statuses for creating a pin: 400 invalid
 * parameters, 403 "The Pin's image is too small, too large or is broken",
 * 404 board or section not found, 429 rate limited.
 */
function errorFrom(
  status: number,
  body: unknown,
  secret: string,
  writing: boolean,
): PinterestApiError {
  const problem = (body as PinterestErrorBody | null) ?? {};
  const code = typeof problem.code === 'number' ? problem.code : null;
  const raw = typeof problem.message === 'string' ? problem.message : '';
  const detail = raw ? clean(raw, secret) : '';

  let kind: PinterestErrorKind;
  if (status === 401) kind = 'AUTH';
  else if (status === 403) kind = writing ? 'IMAGE_REFUSED' : 'PERMISSION';
  else if (status === 404) kind = 'NOT_FOUND';
  else if (status === 429) kind = 'RATE_LIMIT';
  else if (status >= 500) kind = 'TRANSIENT';
  else if (status >= 400) kind = 'VALIDATION';
  else kind = 'UNKNOWN';

  return new PinterestApiError(
    kind,
    status,
    code,
    `Pinterest responded ${status}${code !== null ? ` (code ${code})` : ''}${detail ? `: ${detail}` : ''}`,
  );
}

export class PinterestClient {
  private readonly base: string;

  constructor(
    private readonly accessToken: string,
    private readonly options: PinterestApiOptions,
  ) {
    const host = (options.apiBaseUrl || DEFAULT_PINTEREST_API_BASE_URL).replace(/\/+$/, '');
    this.base = `${host}/${options.version ?? PINTEREST_API_VERSION}`;
  }

  get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return this.send<T>('GET', url.toString(), undefined, false);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>('POST', `${this.base}${path}`, JSON.stringify(body), true);
  }

  private async send<T>(
    method: 'GET' | 'POST',
    url: string,
    body: string | undefined,
    writing: boolean,
  ): Promise<T> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new PinterestApiError(
        'TRANSIENT',
        null,
        null,
        timedOut ? 'Pinterest did not respond in time' : 'Pinterest could not be reached',
        writing && timedOut,
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
    if (!response.ok) throw errorFrom(response.status, parsed, this.accessToken, writing);
    return parsed as T;
  }
}
