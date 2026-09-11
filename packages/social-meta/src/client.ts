import { createHmac } from 'node:crypto';

/**
 * A narrow Graph API client.
 *
 * The access token travels as the `access_token` parameter, as Meta documents
 * it, with an `appsecret_proof` (HMAC-SHA256 of the token keyed by the app
 * secret) on every call when the app secret is available — Meta's recommended
 * protection for server-side calls. URLs carrying a token are never logged.
 * Redirects are refused and every call times out. Errors carry the HTTP
 * status, Meta's code and subcode and a trimmed message, with the token
 * scrubbed out.
 */

export interface MetaGraphOptions {
  /** `https://graph.facebook.com`, or a local mock in tests. */
  apiBaseUrl: string;
  /** `vNN.N`. */
  version: string;
  /** Enables appsecret_proof. */
  appSecret?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type MetaErrorKind =
  'AUTH' | 'PERMISSION' | 'VALIDATION' | 'NOT_FOUND' | 'RATE_LIMIT' | 'TRANSIENT' | 'UNKNOWN';

export class MetaApiError extends Error {
  constructor(
    public readonly kind: MetaErrorKind,
    public readonly httpStatus: number | null,
    public readonly code: number | null,
    public readonly subcode: number | null,
    message: string,
    /** The write may have been applied despite the error (a timeout after sending). */
    public readonly ambiguous = false,
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 60_000;
/** Subcodes that mean the token itself is no longer usable. */
const AUTH_SUBCODES = new Set([458, 459, 460, 463, 464, 467]);

/** Meta's error-handling guide, code by code. */
function kindFor(code: number | null, subcode: number | null, status: number): MetaErrorKind {
  if (subcode === 492) return 'PERMISSION'; // no appropriate role on the Page
  if (code === 190 || code === 102 || (subcode !== null && AUTH_SUBCODES.has(subcode)))
    return 'AUTH';
  if (code === 10 || code === 368 || (code !== null && code >= 200 && code <= 299))
    return 'PERMISSION';
  if (code === 4 || code === 17 || code === 32 || code === 341 || code === 613) return 'RATE_LIMIT';
  if (code === 1 || code === 2) return 'TRANSIENT';
  if (code === 100 || code === 506) return 'VALIDATION';
  if (code === 803 || status === 404) return 'NOT_FOUND';
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

function errorFrom(status: number, body: unknown, secret: string): MetaApiError {
  const error = (body as GraphErrorBody | null)?.error ?? {};
  const code = typeof error.code === 'number' ? error.code : null;
  const subcode = typeof error.error_subcode === 'number' ? error.error_subcode : null;
  const rawMessage =
    typeof error.error_user_msg === 'string' && error.error_user_msg
      ? error.error_user_msg
      : typeof error.message === 'string'
        ? error.message
        : '';
  const detail = rawMessage ? clean(rawMessage, secret) : '';
  return new MetaApiError(
    kindFor(code, subcode, status),
    status,
    code,
    subcode,
    `Meta responded ${status}${code !== null ? ` (code ${code}${subcode !== null ? `/${subcode}` : ''})` : ''}${detail ? `: ${detail}` : ''}`,
  );
}

export interface GraphFile {
  field: string;
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}

export class MetaGraphClient {
  private readonly base: string;

  constructor(
    private readonly accessToken: string,
    private readonly options: MetaGraphOptions,
  ) {
    this.base = `${options.apiBaseUrl.replace(/\/+$/, '')}/${options.version}`;
  }

  private auth(): Record<string, string> {
    return {
      access_token: this.accessToken,
      ...(this.options.appSecret
        ? {
            appsecret_proof: createHmac('sha256', this.options.appSecret)
              .update(this.accessToken)
              .digest('hex'),
          }
        : {}),
    };
  }

  private url(path: string): URL {
    return new URL(`${this.base}/${path.replace(/^\/+/, '')}`);
  }

  get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = this.url(path);
    for (const [key, value] of Object.entries({ ...params, ...this.auth() })) {
      url.searchParams.set(key, value);
    }
    return this.send<T>('GET', url.toString(), {}, undefined, DEFAULT_TIMEOUT_MS);
  }

  post<T>(path: string, params: Record<string, string>): Promise<T> {
    return this.send<T>(
      'POST',
      this.url(path).toString(),
      { 'content-type': 'application/x-www-form-urlencoded' },
      new URLSearchParams({ ...params, ...this.auth() }).toString(),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  }

  /** A multipart POST carrying one file (Page Photos `source`). */
  postFile<T>(path: string, params: Record<string, string>, file: GraphFile): Promise<T> {
    const form = new FormData();
    for (const [key, value] of Object.entries({ ...params, ...this.auth() }))
      form.append(key, value);
    form.append(
      file.field,
      new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }),
      file.filename,
    );
    return this.send<T>('POST', this.url(path).toString(), {}, form, UPLOAD_TIMEOUT_MS);
  }

  private async send<T>(
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    body: string | FormData | undefined,
    timeoutMs: number,
  ): Promise<T> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: { accept: 'application/json', ...headers },
        ...(body !== undefined ? { body } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new MetaApiError(
        'TRANSIENT',
        null,
        null,
        null,
        timedOut ? 'Meta did not respond in time' : 'Meta could not be reached',
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
