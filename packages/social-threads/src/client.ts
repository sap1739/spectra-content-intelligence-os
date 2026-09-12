import { DEFAULT_THREADS_API_BASE_URL, THREADS_API_VERSION } from './constants';

/**
 * A narrow Threads API client.
 *
 * The token travels as the documented `access_token` parameter; request URLs
 * are never logged, redirects are refused, every call times out, and error
 * messages carry Meta's code and subcode with the token scrubbed out.
 */

export interface ThreadsApiOptions {
  /** `https://graph.threads.net`, or a local mock in tests. */
  apiBaseUrl: string;
  version?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type ThreadsErrorKind =
  'AUTH' | 'PERMISSION' | 'RATE_LIMIT' | 'VALIDATION' | 'NOT_FOUND' | 'TRANSIENT' | 'UNKNOWN';

export class ThreadsApiError extends Error {
  constructor(
    public readonly kind: ThreadsErrorKind,
    public readonly httpStatus: number | null,
    public readonly code: number | null,
    public readonly subcode: number | null,
    message: string,
    /** The write may have been applied despite the error (a timeout after sending). */
    public readonly ambiguous = false,
  ) {
    super(message);
    this.name = 'ThreadsApiError';
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** Subcodes that mean the token itself is no longer usable (Graph conventions). */
const AUTH_SUBCODES = new Set([458, 459, 460, 463, 464, 467]);

function kindFor(code: number | null, subcode: number | null, status: number): ThreadsErrorKind {
  if (code === 190 || code === 102 || (subcode !== null && AUTH_SUBCODES.has(subcode))) {
    return 'AUTH';
  }
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) return 'PERMISSION';
  if (code === 4 || code === 17 || code === 32 || code === 341 || code === 613) return 'RATE_LIMIT';
  if (code === 1 || code === 2) return 'TRANSIENT';
  if (code === 100) return 'VALIDATION';
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

interface GraphErrorBody {
  error?: {
    message?: unknown;
    code?: unknown;
    error_subcode?: unknown;
    error_user_msg?: unknown;
  };
}

function errorFrom(status: number, body: unknown, secret: string): ThreadsApiError {
  const error = (body as GraphErrorBody | null)?.error ?? {};
  const code = typeof error.code === 'number' ? error.code : null;
  const subcode = typeof error.error_subcode === 'number' ? error.error_subcode : null;
  const raw =
    typeof error.error_user_msg === 'string' && error.error_user_msg
      ? error.error_user_msg
      : typeof error.message === 'string'
        ? error.message
        : '';
  const detail = raw ? clean(raw, secret) : '';
  return new ThreadsApiError(
    kindFor(code, subcode, status),
    status,
    code,
    subcode,
    `Threads responded ${status}${code !== null ? ` (code ${code}${subcode !== null ? `/${subcode}` : ''})` : ''}${detail ? `: ${detail}` : ''}`,
  );
}

export class ThreadsClient {
  private readonly base: string;

  constructor(
    private readonly accessToken: string,
    private readonly options: ThreadsApiOptions,
  ) {
    const host = (options.apiBaseUrl || DEFAULT_THREADS_API_BASE_URL).replace(/\/+$/, '');
    this.base = `${host}/${options.version ?? THREADS_API_VERSION}`;
  }

  get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.base}/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries({ ...params, access_token: this.accessToken })) {
      url.searchParams.set(key, value);
    }
    return this.send<T>('GET', url.toString(), undefined);
  }

  post<T>(path: string, params: Record<string, string>): Promise<T> {
    return this.send<T>(
      'POST',
      new URL(`${this.base}/${path.replace(/^\/+/, '')}`).toString(),
      new URLSearchParams({ ...params, access_token: this.accessToken }).toString(),
    );
  }

  private async send<T>(method: 'GET' | 'POST', url: string, body: string | undefined): Promise<T> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(body !== undefined ? { body } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new ThreadsApiError(
        'TRANSIENT',
        null,
        null,
        null,
        timedOut ? 'Threads did not respond in time' : 'Threads could not be reached',
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
    if (!response.ok || (parsed as GraphErrorBody | null)?.error) {
      throw errorFrom(response.status, parsed, this.accessToken);
    }
    return parsed as T;
  }
}
