import { describe, expect, it } from 'vitest';

import { YouTubeApiError, YouTubeClient, isAllowedSessionUrl } from './client';

/**
 * The client against Google's documented protocol: bearer tokens that never
 * reach a URL, the resumable session dance, and errors mapped from Google's
 * own `reason` — with the token scrubbed out of anything it says.
 */

const BASE = 'https://youtube.test';
const TOKEN = 'ya29.SECRETTOKEN';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  redirect: RequestInit['redirect'];
}

function fakeFetch(responses: Array<() => Response>) {
  const calls: Call[] = [];
  const queue = [...responses];
  const impl: typeof fetch = async (input, init) => {
    const body = init?.body;
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof body === 'string' ? body : null,
      redirect: init?.redirect,
    });
    const next = queue.shift();
    if (!next) throw new Error('unexpected request');
    return next();
  };
  return { impl, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const googleError = (status: number, reason: string, message = 'nope') =>
  json(status, {
    error: { code: status, message, errors: [{ domain: 'youtube.api', reason, message }] },
  });

const client = (impl: typeof fetch) =>
  new YouTubeClient(TOKEN, { apiBaseUrl: BASE, fetchImpl: impl });

/** The error a call threw, typed — `promise.catch()` would widen it to a union. */
async function failure(promise: Promise<unknown>): Promise<YouTubeApiError> {
  try {
    await promise;
  } catch (error) {
    return error as YouTubeApiError;
  }
  throw new Error('expected the call to fail');
}

describe('reads', () => {
  it('sends the token as a bearer header and never in the URL', async () => {
    const { impl, calls } = fakeFetch([() => json(200, { items: [] })]);
    await client(impl).get('channels', { part: 'snippet,status', mine: 'true' });
    const call = calls[0] as Call;
    expect(call.url).toBe(`${BASE}/youtube/v3/channels?part=snippet%2Cstatus&mine=true`);
    expect(call.url).not.toContain(TOKEN);
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe('resumable uploads', () => {
  it('initiates a session with the size and type headers Google documents', async () => {
    const { impl, calls } = fakeFetch([
      () => json(200, {}, { location: `${BASE}/upload/session/abc` }),
    ]);
    const session = await client(impl).initiateUpload({
      part: 'snippet,status',
      params: { notifySubscribers: 'false' },
      metadata: { snippet: { title: 'A' } },
      contentLength: 2048,
      contentType: 'video/mp4',
    });
    expect(session).toBe(`${BASE}/upload/session/abc`);
    const call = calls[0] as Call;
    const url = new URL(call.url);
    expect(url.pathname).toBe('/upload/youtube/v3/videos');
    expect(url.searchParams.get('uploadType')).toBe('resumable');
    expect(url.searchParams.get('part')).toBe('snippet,status');
    expect(url.searchParams.get('notifySubscribers')).toBe('false');
    expect(call.headers['x-upload-content-length']).toBe('2048');
    expect(call.headers['x-upload-content-type']).toBe('video/mp4');
    expect(JSON.parse(call.body as string)).toEqual({ snippet: { title: 'A' } });
  });

  it('refuses an upload location that is not YouTube', async () => {
    const { impl } = fakeFetch([
      () => json(200, {}, { location: 'https://attacker.example/upload' }),
    ]);
    await expect(
      client(impl).initiateUpload({
        part: 'snippet,status',
        metadata: {},
        contentLength: 1,
        contentType: 'video/mp4',
      }),
    ).rejects.toThrow(/will not upload to/);
  });

  it('sends each chunk with its byte range and reports what YouTube has', async () => {
    const { impl, calls } = fakeFetch([
      () => new Response(null, { status: 308, headers: { range: 'bytes=0-262143' } }),
    ]);
    const progress = await client(impl).uploadChunk(`${BASE}/upload/session/abc`, {
      bytes: new Uint8Array(262_144),
      start: 0,
      total: 524_288,
      contentType: 'video/mp4',
    });
    expect(progress).toEqual({ done: false, nextByte: 262_144, video: null });
    expect((calls[0] as Call).headers['content-range']).toBe('bytes 0-262143/524288');
  });

  it('returns the video resource when the last chunk completes it', async () => {
    const { impl } = fakeFetch([
      () => json(201, { id: 'vid_12345', status: { uploadStatus: 'uploaded' } }),
    ]);
    const progress = await client(impl).uploadChunk(`${BASE}/upload/session/abc`, {
      bytes: new Uint8Array(16),
      start: 0,
      total: 16,
      contentType: 'video/mp4',
    });
    expect(progress.done).toBe(true);
    expect((progress.video as { id: string }).id).toBe('vid_12345');
  });

  it('reads 308 itself rather than letting fetch call it a redirect', async () => {
    // 308 is a redirect status, so redirect:'error' would turn every incomplete
    // chunk into a network error. 'manual' still never follows a redirect.
    const { impl, calls } = fakeFetch([
      () => new Response(null, { status: 308, headers: { range: 'bytes=0-9' } }),
      () => json(200, { items: [] }),
    ]);
    await client(impl).probeUpload(`${BASE}/upload/session/abc`, 100);
    expect((calls[0] as Call).redirect).toBe('manual');
    await client(impl).get('channels', {});
    expect((calls[1] as Call).redirect).not.toBe('manual');
  });

  it('asks how much of an interrupted upload survived', async () => {
    const { impl, calls } = fakeFetch([
      () => new Response(null, { status: 308, headers: { range: 'bytes=0-999999' } }),
    ]);
    const progress = await client(impl).probeUpload(`${BASE}/upload/session/abc`, 5_000_000);
    expect(progress.nextByte).toBe(1_000_000);
    expect((calls[0] as Call).headers['content-range']).toBe('bytes */5000000');
  });

  it('treats a 308 with no range as "nothing received yet"', async () => {
    const { impl } = fakeFetch([() => new Response(null, { status: 308 })]);
    expect((await client(impl).probeUpload(`${BASE}/s`, 100)).nextByte).toBe(0);
  });

  it('reports an expired session so a retry starts a fresh upload', async () => {
    const { impl } = fakeFetch([() => new Response(null, { status: 404 })]);
    await expect(client(impl).probeUpload(`${BASE}/upload/session/abc`, 10)).rejects.toMatchObject({
      sessionExpired: true,
    });
  });

  it('will not send bytes to a stored session outside the API', async () => {
    const { impl, calls } = fakeFetch([]);
    await expect(
      client(impl).probeUpload('https://attacker.example/session', 10),
    ).rejects.toMatchObject({ sessionExpired: true });
    expect(calls).toHaveLength(0);
  });
});

describe('thumbnails', () => {
  it('posts the image to thumbnails.set for one video', async () => {
    const { impl, calls } = fakeFetch([() => json(200, { items: [] })]);
    await client(impl).setThumbnail('vid_12345', new Uint8Array([1, 2, 3]), 'image/png');
    const url = new URL((calls[0] as Call).url);
    expect(url.pathname).toBe('/upload/youtube/v3/thumbnails/set');
    expect(url.searchParams.get('videoId')).toBe('vid_12345');
    expect((calls[0] as Call).headers['content-type']).toBe('image/png');
  });
});

describe('errors', () => {
  const cases: Array<[number, string, string]> = [
    [403, 'quotaExceeded', 'QUOTA'],
    [403, 'dailyLimitExceeded', 'QUOTA'],
    [429, 'rateLimitExceeded', 'RATE_LIMIT'],
    [400, 'uploadLimitExceeded', 'RATE_LIMIT'],
    [401, 'authError', 'AUTH'],
    [403, 'forbidden', 'PERMISSION'],
    [400, 'invalidTitle', 'VALIDATION'],
    [404, 'videoNotFound', 'NOT_FOUND'],
    [500, 'backendError', 'TRANSIENT'],
  ];
  for (const [status, reason, kind] of cases) {
    it(`maps ${reason} to ${kind}`, async () => {
      const { impl } = fakeFetch([() => googleError(status, reason)]);
      await expect(client(impl).get('videos', { part: 'status' })).rejects.toMatchObject({
        kind,
        reason,
      });
    });
  }

  it('never repeats the access token in an error message', async () => {
    const { impl } = fakeFetch([
      () => googleError(400, 'badRequest', `token ${TOKEN} is bad\nsecond line`),
    ]);
    const error = await failure(client(impl).get('videos', { part: 'status' }));
    expect(error).toBeInstanceOf(YouTubeApiError);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain('[redacted]');
    expect(error.message).not.toContain('\n');
  });

  it('calls a timed-out upload ambiguous, and a timed-out read not', async () => {
    const timeout = () => {
      const error = new Error('timeout');
      error.name = 'TimeoutError';
      throw error;
    };
    const upload = await failure(
      new YouTubeClient(TOKEN, {
        apiBaseUrl: BASE,
        fetchImpl: timeout as unknown as typeof fetch,
      }).uploadChunk(`${BASE}/s`, {
        bytes: new Uint8Array(1),
        start: 0,
        total: 1,
        contentType: 'video/mp4',
      }),
    );
    expect(upload.ambiguous).toBe(true);
    expect(upload.kind).toBe('TRANSIENT');

    const read = await failure(
      new YouTubeClient(TOKEN, {
        apiBaseUrl: BASE,
        fetchImpl: timeout as unknown as typeof fetch,
      }).get('channels', {}),
    );
    expect(read.ambiguous).toBe(false);
  });
});

describe('isAllowedSessionUrl', () => {
  it('allows the API origin and googleapis.com, nothing else', () => {
    expect(isAllowedSessionUrl(`${BASE}/upload/x`, BASE)).toBe(true);
    expect(isAllowedSessionUrl('https://www.googleapis.com/upload/x', BASE)).toBe(true);
    expect(isAllowedSessionUrl('http://www.googleapis.com/upload/x', BASE)).toBe(false);
    expect(isAllowedSessionUrl('https://googleapis.com.attacker.example/x', BASE)).toBe(false);
    expect(isAllowedSessionUrl('not a url', BASE)).toBe(false);
  });
});
