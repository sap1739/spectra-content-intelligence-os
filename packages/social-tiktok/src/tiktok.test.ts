import type { PublishInput, PublishMediaInput } from '@spectra/social-core';
import { describe, expect, it } from 'vitest';

import { tikTokCreatorCapabilities } from './capabilities';
import { isAllowedUploadUrl } from './client';
import {
  TIKTOK_MAX_CHUNK_BYTES,
  TIKTOK_MIN_CHUNK_BYTES,
  TIKTOK_SCOPES,
  chunkPlan,
  chunkRange,
} from './constants';
import { TikTokVideoPublisher, type TikTokPublishLedger } from './publisher';
import { postInfo, resolveTikTokMetadata, validateTikTokVideo } from './text';

/**
 * The TikTok adapter against a stand-in that behaves like the Content Posting
 * API: creator info first, then init, chunked PUTs, and a status poll. What
 * matters is that the creator's own settings win, an unaudited client is told
 * why a public post is refused, and a finished publish is never sent twice.
 */

const BASE = 'https://tiktok.test';
const UPLOAD = `${BASE}/upload/abc`;

interface Recorder {
  creatorInfo: number;
  inits: number;
  chunks: Array<{ range: string; bytes: number }>;
  statusCalls: number;
  postInfo: unknown;
}

interface FakeOptions {
  privacyOptions?: string[];
  commentDisabled?: boolean;
  statuses?: string[];
  failReason?: string;
  postId?: string | null;
  initError?: { code: string; status?: number };
  uploadStatus?: number;
}

function fakeTikTok(options: FakeOptions = {}) {
  const state: Recorder = { creatorInfo: 0, inits: 0, chunks: [], statusCalls: 0, postInfo: null };
  const statuses = options.statuses ?? ['PUBLISH_COMPLETE'];
  const ok = (data: unknown) =>
    new Response(JSON.stringify({ data, error: { code: 'ok', message: '', log_id: 'log' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const fail = (code: string, status = 200) =>
    new Response(JSON.stringify({ error: { code, message: code, log_id: 'log' } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/creator_info/query/')) {
      state.creatorInfo += 1;
      return ok({
        creator_username: 'acmecoffee',
        creator_nickname: 'Acme Coffee',
        privacy_level_options: options.privacyOptions ?? ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
        comment_disabled: options.commentDisabled ?? false,
        duet_disabled: false,
        stitch_disabled: false,
        max_video_post_duration_sec: 600,
      });
    }
    if (url.includes('/video/init/')) {
      state.inits += 1;
      if (options.initError) return fail(options.initError.code, options.initError.status ?? 200);
      state.postInfo = (JSON.parse(String(init?.body)) as { post_info: unknown }).post_info;
      return ok({ publish_id: 'publish-1', upload_url: UPLOAD });
    }
    if (url === UPLOAD) {
      const range = new Headers(init?.headers).get('content-range') ?? '';
      state.chunks.push({ range, bytes: Number((init?.body as Uint8Array).byteLength) });
      return new Response(null, { status: options.uploadStatus ?? 201 });
    }
    if (url.includes('/status/fetch/')) {
      const status = statuses[Math.min(state.statusCalls, statuses.length - 1)];
      state.statusCalls += 1;
      return ok({
        status,
        ...(options.failReason ? { fail_reason: options.failReason } : {}),
        ...(options.postId === null
          ? {}
          : { publicaly_available_post_id: [options.postId ?? '7300000000000000000'] }),
      });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { impl, state };
}

function memoryLedger() {
  const rows = new Map<
    string,
    {
      publishId: string | null;
      uploadUrl: string | null;
      uploadedBytes: number;
      postId: string | null;
      status: 'REGISTERED' | 'UPLOADED' | 'FAILED';
    }
  >();
  const ledger: TikTokPublishLedger = {
    async find(assetId) {
      return rows.get(assetId) ?? null;
    },
    async started(assetId, publishId, uploadUrl) {
      rows.set(assetId, {
        publishId,
        uploadUrl,
        uploadedBytes: 0,
        postId: null,
        status: 'REGISTERED',
      });
    },
    async progressed(assetId, uploadedBytes) {
      const row = rows.get(assetId);
      if (row) row.uploadedBytes = uploadedBytes;
    },
    async finished(assetId, postId) {
      const row = rows.get(assetId);
      if (row) Object.assign(row, { postId, status: 'UPLOADED' });
    },
    async failed(assetId) {
      const row = rows.get(assetId);
      if (row) Object.assign(row, { status: 'FAILED' });
    },
  };
  return { ledger, rows };
}

const video = (bytes = 1024): PublishMediaInput => ({
  assetId: 'asset-1',
  kind: 'VIDEO',
  mimeType: 'video/mp4',
  sizeBytes: bytes,
  widthPx: 1080,
  heightPx: 1920,
  altText: null,
  load: async () => Buffer.alloc(bytes, 3),
});

const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  idempotencyKey: 'entry-1',
  title: 'Fresh roast',
  body: 'Fresh roast Friday',
  media: [video()],
  metadata: {
    tiktok: {
      title: 'Fresh roast Friday',
      privacyLevel: 'PUBLIC_TO_EVERYONE',
      disableComment: false,
      disableDuet: false,
      disableStitch: false,
      brandContentToggle: false,
      brandOrganicToggle: false,
      isAigc: false,
    },
  },
  ...over,
});

const publisher = (
  impl: typeof fetch,
  over: Partial<ConstructorParameters<typeof TikTokVideoPublisher>[0]> = {},
) =>
  new TikTokVideoPublisher({
    apiBaseUrl: BASE,
    fetchImpl: impl,
    accessToken: 'act.TOKEN',
    openId: 'open-id-1',
    grantedScopes: [TIKTOK_SCOPES.publish, TIKTOK_SCOPES.profile],
    clientAudited: true,
    pollIntervalMs: 0,
    sleep: async () => undefined,
    now: () => new Date('2026-09-12T10:00:00.000Z'),
    ...over,
  });

describe('chunk planning', () => {
  it('sends a small file whole, as TikTok requires', () => {
    expect(chunkPlan(1024, 10 * 1024 * 1024)).toEqual({ chunkSize: 1024, totalChunkCount: 1 });
  });

  it('rounds the chunk count DOWN so the last chunk carries the remainder', () => {
    const size = 25 * 1024 * 1024;
    const plan = chunkPlan(size, TIKTOK_MIN_CHUNK_BYTES);
    expect(plan).toEqual({ chunkSize: TIKTOK_MIN_CHUNK_BYTES, totalChunkCount: 5 });
    const last = chunkRange(size, plan, 4);
    expect(last.end).toBe(size - 1);
  });

  it('keeps the chunk size inside TikTok bounds', () => {
    expect(chunkPlan(200 * 1024 * 1024, 1024).chunkSize).toBe(TIKTOK_MIN_CHUNK_BYTES);
    expect(chunkPlan(500 * 1024 * 1024, 999 * 1024 * 1024).chunkSize).toBe(TIKTOK_MAX_CHUNK_BYTES);
  });
});

describe('validation', () => {
  it('accepts a video with the details an operator set', () => {
    expect(validateTikTokVideo(input())).toEqual([]);
  });

  it('needs a video, and only a video', () => {
    expect(validateTikTokVideo(input({ media: [] })).map((i) => i.code)).toContain(
      'VIDEO_REQUIRED',
    );
    const image = { ...video(), kind: 'IMAGE' as const, mimeType: 'image/png' };
    expect(validateTikTokVideo(input({ media: [image] })).map((i) => i.code)).toContain(
      'NOT_A_VIDEO',
    );
  });

  it('refuses a format TikTok does not take', () => {
    const wrong = { ...video(), mimeType: 'video/x-msvideo' };
    expect(validateTikTokVideo(input({ media: [wrong] })).map((i) => i.code)).toContain(
      'UNSUPPORTED_VIDEO_FORMAT',
    );
  });

  it('defaults to the narrowest privacy when no details were set', () => {
    const { metadata } = resolveTikTokMetadata(input({ metadata: undefined }));
    expect(metadata.privacyLevel).toBe('SELF_ONLY');
    expect(metadata.title).toBe('Fresh roast Friday');
  });

  it('keeps an interaction the creator turned off turned off', () => {
    const built = postInfo(resolveTikTokMetadata(input()).metadata, {
      commentDisabled: true,
      duetDisabled: false,
      stitchDisabled: true,
    });
    expect(built).toMatchObject({
      disable_comment: true,
      disable_stitch: true,
      disable_duet: false,
    });
  });
});

describe('capabilities', () => {
  const caps = (over = {}) =>
    tikTokCreatorCapabilities({
      grantedScopes: [TIKTOK_SCOPES.publish],
      privacyLevelOptions: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
      clientAudited: true,
      checkedAt: new Date('2026-09-12T10:00:00.000Z'),
      ...over,
    });

  it('publishes video, and says what TikTok has no concept of', () => {
    expect(caps().postTypes.VIDEO.status).toBe('AVAILABLE');
    expect(caps().postTypes.TEXT.status).toBe('NOT_SUPPORTED');
    // Photo posts exist on TikTok; this adapter has not built them.
    expect(caps().postTypes.IMAGE.status).toBe('NOT_IMPLEMENTED');
  });

  it('names the missing scope instead of failing later', () => {
    const snapshot = caps({ grantedScopes: ['user.info.basic'] });
    expect(snapshot.postTypes.VIDEO.status).toBe('MISSING_PERMISSION');
    expect(snapshot.postTypes.VIDEO.reason).toContain('video.publish');
  });

  it("quotes TikTok's audit rule while the client is unaudited", () => {
    expect(
      caps({ clientAudited: false }).notes.some((n) => n.includes('restricted to private viewing')),
    ).toBe(true);
    expect(caps().notes.some((n) => n.includes('restricted to private viewing'))).toBe(false);
  });

  it('reports the privacy levels TikTok said this creator may use', () => {
    expect(caps().notes.some((n) => n.includes('PUBLIC_TO_EVERYONE, SELF_ONLY'))).toBe(true);
    expect(
      caps({ privacyLevelOptions: ['SELF_ONLY'] }).notes.some((n) =>
        n.includes('Only private (SELF_ONLY) posting'),
      ),
    ).toBe(true);
  });
});

describe('publishing', () => {
  it('asks the creator first, uploads the file, then reports the post', async () => {
    const { impl, state } = fakeTikTok();
    const outcome = await publisher(impl).publish(input());
    expect(outcome).toMatchObject({
      status: 'PUBLISHED',
      externalPostId: '7300000000000000000',
      externalUrl: 'https://www.tiktok.com/@acmecoffee/video/7300000000000000000',
    });
    expect(state.creatorInfo).toBeGreaterThan(0);
    expect(state.inits).toBe(1);
    expect(state.chunks).toEqual([{ range: 'bytes 0-1023/1024', bytes: 1024 }]);
    expect(state.postInfo).toMatchObject({ privacy_level: 'PUBLIC_TO_EVERYONE' });
  });

  it('refuses a privacy level TikTok does not offer, and says why', async () => {
    const { impl, state } = fakeTikTok({ privacyOptions: ['SELF_ONLY'] });
    const outcome = await publisher(impl, { clientAudited: false }).publish(input());
    expect(outcome.status).toBe('FAILED');
    expect(outcome.failureCode).toBe('PERMISSION');
    expect(outcome.failureReason).toContain('SELF_ONLY');
    expect(outcome.failureReason).toContain('restricted to private viewing mode');
    expect(state.inits).toBe(0);
  });

  it('never publishes the same video twice', async () => {
    const { ledger, rows } = memoryLedger();
    rows.set('asset-1', {
      publishId: 'publish-1',
      uploadUrl: null,
      uploadedBytes: 1024,
      postId: '7300000000000000000',
      status: 'UPLOADED',
    });
    const { impl, state } = fakeTikTok();
    const outcome = await publisher(impl, { ledger }).publish(input());
    expect(outcome.status).toBe('PUBLISHED');
    expect(outcome.note).toContain('did not upload it again');
    expect(state.inits).toBe(0);
  });

  it('checks an unfinished publish rather than starting another', async () => {
    const { ledger, rows } = memoryLedger();
    rows.set('asset-1', {
      publishId: 'publish-1',
      uploadUrl: UPLOAD,
      uploadedBytes: 1024,
      postId: null,
      status: 'REGISTERED',
    });
    const { impl, state } = fakeTikTok();
    const outcome = await publisher(impl, { ledger }).publish(input());
    expect(outcome.status).toBe('PUBLISHED');
    expect(state.inits).toBe(0);
    expect(state.creatorInfo).toBe(0);
  });

  it('reports what TikTok said when it could not publish', async () => {
    const { impl } = fakeTikTok({ statuses: ['FAILED'], failReason: 'file_format_check_failed' });
    const outcome = await publisher(impl).publish(input());
    expect(outcome.status).toBe('FAILED');
    expect(outcome.failureReason).toContain('file_format_check_failed');
  });

  it("says a video sent to the creator's inbox is not published", async () => {
    const { impl } = fakeTikTok({ statuses: ['SEND_TO_USER_INBOX'] });
    const outcome = await publisher(impl).publish(input());
    expect(outcome.status).toBe('FAILED');
    expect(outcome.failureReason).toContain('inbox');
  });

  it('keeps the publish when TikTok is still processing, and says a retry is safe', async () => {
    const { impl } = fakeTikTok({ statuses: ['PROCESSING_UPLOAD'] });
    const outcome = await publisher(impl, { statusChecks: 2 }).publish(input());
    expect(outcome.failureCode).toBe('TRANSIENT');
    expect(outcome.failureReason).toContain('rather than uploading it twice');
  });

  it('maps an unaudited refusal at init to a permission problem with the quote', async () => {
    const { impl } = fakeTikTok({
      initError: { code: 'unaudited_client_can_only_post_to_private_accounts' },
    });
    const outcome = await publisher(impl).publish(input());
    expect(outcome.failureCode).toBe('PERMISSION');
    expect(outcome.failureReason).toContain('restricted to private viewing mode');
  });

  it('marks the connection for reconnect when TikTok rejects the token', async () => {
    let reconnect = false;
    const { impl } = fakeTikTok({ initError: { code: 'access_token_invalid', status: 401 } });
    const outcome = await publisher(impl, {
      onAuthRejected: async () => {
        reconnect = true;
      },
    }).publish(input());
    expect(outcome.failureCode).toBe('AUTH');
    expect(reconnect).toBe(true);
  });
});

describe('isAllowedUploadUrl', () => {
  it('only ever uploads to TikTok, or the configured API origin in tests', () => {
    expect(isAllowedUploadUrl(UPLOAD, BASE)).toBe(true);
    expect(isAllowedUploadUrl('https://upload.tiktokcdn.com/x', BASE)).toBe(true);
    expect(isAllowedUploadUrl('http://upload.tiktokcdn.com/x', BASE)).toBe(false);
    expect(isAllowedUploadUrl('https://tiktokcdn.com.attacker.example/x', BASE)).toBe(false);
    expect(isAllowedUploadUrl('nonsense', BASE)).toBe(false);
  });
});
