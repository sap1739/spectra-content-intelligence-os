import type { PublishInput, PublishMediaInput } from '@spectra/social-core';
import { describe, expect, it } from 'vitest';

import { YouTubeVideoPublisher, type ResumableUploadLedger } from './publisher';

/**
 * The upload, against a stand-in that behaves like Google's resumable
 * protocol: chunks with byte ranges, 308 with what it has so far, and 201 with
 * the video. What matters here is that an interrupted upload RESUMES, a
 * finished one is never sent twice, and everything YouTube did differently is
 * reported rather than smoothed over.
 */

const BASE = 'https://youtube.test';
const SESSION = `${BASE}/upload/session/abc`;
const CHUNK = 262_144;

interface Recorder {
  received: number;
  initiates: number;
  thumbnails: number;
  metadata: unknown;
}

interface FakeOptions {
  /** Total bytes this stand-in will ever accept, so an upload stalls part-way. */
  stopAfter?: number;
  video?: Record<string, unknown>;
  initiateError?: { status: number; reason: string };
  thumbnailError?: { status: number; reason: string };
  authErrorOnInitiate?: boolean;
}

function fakeYouTube(options: FakeOptions = {}) {
  const state: Recorder = { received: 0, initiates: 0, thumbnails: 0, metadata: null };
  const video = options.video ?? {
    id: 'vid_abcdefgh',
    status: { uploadStatus: 'processed', privacyStatus: 'public' },
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  const error = (status: number, reason: string) =>
    json(status, {
      error: { code: status, message: reason, errors: [{ reason, message: reason }] },
    });

  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/thumbnails/set')) {
      state.thumbnails += 1;
      if (options.thumbnailError) {
        return error(options.thumbnailError.status, options.thumbnailError.reason);
      }
      return json(200, { kind: 'youtube#thumbnailSetResponse' });
    }
    if (method === 'POST' && url.includes('uploadType=resumable')) {
      state.initiates += 1;
      if (options.authErrorOnInitiate) return error(401, 'authError');
      if (options.initiateError) {
        return error(options.initiateError.status, options.initiateError.reason);
      }
      state.metadata = JSON.parse(String(init?.body));
      return json(200, {}, { location: SESSION });
    }
    if (method === 'PUT') {
      const range = new Headers(init?.headers).get('content-range') ?? '';
      const probe = /^bytes \*\/(\d+)$/.exec(range);
      const total = Number(probe ? probe[1] : /\/(\d+)$/.exec(range)?.[1]);
      if (!probe) {
        const [, start, end] = /^bytes (\d+)-(\d+)\//.exec(range) as RegExpExecArray;
        const from = Number(start);
        const to = Number(end) + 1;
        const limit = options.stopAfter ?? Infinity;
        // An absolute ceiling: past it, YouTube stops accepting bytes.
        state.received = Math.max(state.received, Math.min(to, limit));
        void from;
      }
      if (state.received >= total) return json(201, video);
      return new Response(null, {
        status: 308,
        headers: { range: `bytes=0-${state.received - 1}` },
      });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { impl, state };
}

function memoryLedger() {
  const rows = new Map<
    string,
    {
      sessionUrl: string | null;
      uploadedBytes: number;
      videoId: string | null;
      status: 'REGISTERED' | 'UPLOADED' | 'FAILED';
    }
  >();
  const ledger: ResumableUploadLedger = {
    async find(assetId) {
      return rows.get(assetId) ?? null;
    },
    async started(assetId, sessionUrl) {
      rows.set(assetId, { sessionUrl, uploadedBytes: 0, videoId: null, status: 'REGISTERED' });
    },
    async progressed(assetId, uploadedBytes) {
      const row = rows.get(assetId);
      if (row) row.uploadedBytes = uploadedBytes;
    },
    async finished(assetId, videoId) {
      const row = rows.get(assetId);
      if (row) Object.assign(row, { videoId, status: 'UPLOADED', sessionUrl: null });
    },
    async failed(assetId) {
      const row = rows.get(assetId);
      if (row) Object.assign(row, { status: 'FAILED', sessionUrl: null });
    },
  };
  return { ledger, rows };
}

const media = (bytes: number): PublishMediaInput => ({
  assetId: 'asset-1',
  kind: 'VIDEO',
  mimeType: 'video/mp4',
  sizeBytes: bytes,
  widthPx: 1920,
  heightPx: 1080,
  altText: null,
  load: async () => Buffer.alloc(bytes, 7),
});

const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  idempotencyKey: 'entry-1',
  title: 'Quarterly roast report',
  body: 'What changed.',
  media: [media(CHUNK * 3)],
  metadata: {
    youtube: {
      title: 'Quarterly roast report',
      description: 'What changed.',
      tags: [],
      privacyStatus: 'public',
      madeForKids: false,
      notifySubscribers: false,
    },
  },
  ...over,
});

const publisher = (
  impl: typeof fetch,
  over: Partial<ConstructorParameters<typeof YouTubeVideoPublisher>[0]> = {},
) =>
  new YouTubeVideoPublisher({
    apiBaseUrl: BASE,
    fetchImpl: impl,
    accessToken: 'ya29.token',
    channelId: 'UC_x5XG1OV2P6uZZ5FSM9Ttw',
    grantedScopes: ['https://www.googleapis.com/auth/youtube.upload'],
    chunkBytes: CHUNK,
    projectAudited: true,
    now: () => new Date('2026-09-12T10:00:00.000Z'),
    ...over,
  });

describe('publishing a video', () => {
  it('uploads it in chunks and links to the watch page', async () => {
    const { impl, state } = fakeYouTube();
    const outcome = await publisher(impl).publish(input());
    expect(outcome).toMatchObject({
      status: 'PUBLISHED',
      externalPostId: 'vid_abcdefgh',
      externalUrl: 'https://www.youtube.com/watch?v=vid_abcdefgh',
    });
    expect(outcome.note).toBeUndefined();
    expect(state.initiates).toBe(1);
    expect(state.metadata).toMatchObject({
      snippet: { title: 'Quarterly roast report' },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
    });
  });

  it('records progress, and resumes an interrupted upload instead of starting again', async () => {
    const { ledger, rows } = memoryLedger();
    // The server stops accepting after one chunk, so the first attempt cannot finish.
    const first = fakeYouTube({ stopAfter: CHUNK });
    const stalled = await publisher(first.impl, { ledger }).publish(input());
    expect(stalled.status).toBe('FAILED');
    expect(stalled.failureCode).toBe('TRANSIENT');
    expect(rows.get('asset-1')?.uploadedBytes).toBe(CHUNK);
    expect(rows.get('asset-1')?.sessionUrl).toBe(SESSION);

    // A second attempt probes, finds one chunk already there, and finishes.
    const second = fakeYouTube();
    second.state.received = CHUNK;
    const outcome = await publisher(second.impl, { ledger }).publish(input());
    expect(outcome.status).toBe('PUBLISHED');
    expect(second.state.initiates).toBe(0);
    expect(rows.get('asset-1')).toMatchObject({ videoId: 'vid_abcdefgh', status: 'UPLOADED' });
  });

  it('never uploads a video the ledger already finished', async () => {
    const { ledger, rows } = memoryLedger();
    rows.set('asset-1', {
      sessionUrl: null,
      uploadedBytes: CHUNK * 3,
      videoId: 'vid_abcdefgh',
      status: 'UPLOADED',
    });
    const { impl, state } = fakeYouTube();
    const outcome = await publisher(impl, { ledger }).publish(input());
    expect(outcome.status).toBe('PUBLISHED');
    expect(outcome.note).toContain('did not upload it again');
    expect(state.initiates).toBe(0);
    expect(state.received).toBe(0);
  });
});

describe('what YouTube did differently', () => {
  it('says so when the upload came back private rather than public', async () => {
    const { impl } = fakeYouTube({
      video: {
        id: 'vid_abcdefgh',
        status: { uploadStatus: 'processed', privacyStatus: 'private' },
      },
    });
    const outcome = await publisher(impl, { projectAudited: false }).publish(input());
    expect(outcome.status).toBe('PUBLISHED');
    expect(outcome.note).toContain('You asked for public');
    expect(outcome.note).toContain('restricted to private viewing mode');
  });

  it('says when YouTube has not finished processing the video', async () => {
    const { impl } = fakeYouTube({
      video: { id: 'vid_abcdefgh', status: { uploadStatus: 'uploaded', privacyStatus: 'public' } },
    });
    expect((await publisher(impl).publish(input())).note).toContain('still processing');
  });

  it('fails honestly when YouTube rejected the video', async () => {
    const { impl } = fakeYouTube({
      video: {
        id: 'vid_abcdefgh',
        status: { uploadStatus: 'rejected', rejectionReason: 'duplicate' },
      },
    });
    const outcome = await publisher(impl).publish(input());
    expect(outcome.status).toBe('FAILED');
    expect(outcome.failureCode).toBe('VALIDATION');
    expect(outcome.failureReason).toContain('duplicate');
  });
});

describe('thumbnails and failures', () => {
  const thumbnail: PublishMediaInput = {
    assetId: 'thumb-1',
    kind: 'IMAGE',
    mimeType: 'image/jpeg',
    sizeBytes: 2048,
    widthPx: 1280,
    heightPx: 720,
    altText: null,
    load: async () => Buffer.alloc(2048, 1),
  };

  it('sets a custom thumbnail after the upload', async () => {
    const { impl, state } = fakeYouTube();
    const outcome = await publisher(impl).publish(input({ thumbnail }));
    expect(outcome.status).toBe('PUBLISHED');
    expect(state.thumbnails).toBe(1);
    expect(outcome.note).toBeUndefined();
  });

  it('keeps the published video when only the thumbnail was refused', async () => {
    const { impl } = fakeYouTube({ thumbnailError: { status: 403, reason: 'forbidden' } });
    const outcome = await publisher(impl).publish(input({ thumbnail }));
    expect(outcome.status).toBe('PUBLISHED');
    expect(outcome.note).toContain('did not set the custom thumbnail');
  });

  it('reports an exhausted quota as a quota problem, with what to do', async () => {
    const { impl } = fakeYouTube({ initiateError: { status: 403, reason: 'quotaExceeded' } });
    const outcome = await publisher(impl).publish(input());
    expect(outcome.failureCode).toBe('QUOTA');
    expect(outcome.failureReason).toContain('midnight Pacific Time');
  });

  it('marks the connection for reconnect when Google rejects the token', async () => {
    let reconnect = false;
    const { impl } = fakeYouTube({ authErrorOnInitiate: true });
    const outcome = await publisher(impl, {
      onAuthRejected: async () => {
        reconnect = true;
      },
    }).publish(input());
    expect(outcome.failureCode).toBe('AUTH');
    expect(reconnect).toBe(true);
  });

  it('refuses an entry with no video before contacting YouTube', async () => {
    const { impl, state } = fakeYouTube();
    const outcome = await publisher(impl).publish(input({ media: [] }));
    expect(outcome.status).toBe('FAILED');
    expect(outcome.failureCode).toBe('VALIDATION');
    expect(state.initiates).toBe(0);
  });
});
