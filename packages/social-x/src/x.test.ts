import type { PublishInput, PublishMediaInput } from '@spectra/social-core';
import { describe, expect, it } from 'vitest';

import { xAccountCapabilities } from './capabilities';
import { SPECTRA_MAX_POST_CHARS, X_SCOPES } from './constants';
import { XAccountDiscovery } from './discovery';
import { XPublisher, type XMediaLedger } from './publisher';
import { validateXPost } from './text';

/**
 * The X adapter against a stand-in that behaves like the v2 API: chunked
 * media upload (initialize, append, finalize, status) and then a post. What
 * matters is that an image is only attached once X says it is processed, and
 * that a plan or access refusal is reported as exactly that.
 */

const BASE = 'https://x.test';

interface Recorder {
  initializes: number;
  appends: Array<number>;
  finalizes: number;
  statuses: number;
  post: unknown;
}

interface FakeOptions {
  states?: Array<string | null>;
  postError?: { status: number; body: unknown };
  processingError?: string;
}

function fakeX(options: FakeOptions = {}) {
  const state: Recorder = { initializes: 0, appends: [], finalizes: 0, statuses: 0, post: null };
  const states = options.states ?? [null];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/2/users/me')) {
      return json({ data: { id: '1200', username: 'acmecoffee', name: 'Acme' } });
    }
    if (url.endsWith('/2/media/upload/initialize')) {
      state.initializes += 1;
      return json({ data: { id: 'media-1' } });
    }
    if (url.includes('/append')) {
      const form = init?.body as FormData;
      state.appends.push(Number(form.get('segment_index')));
      return json({ data: { id: 'media-1' } });
    }
    if (url.includes('/finalize')) {
      state.finalizes += 1;
      return json({ data: { id: 'media-1', processing_info: { state: 'in_progress' } } });
    }
    if (url.includes('command=STATUS')) {
      const current = states[Math.min(state.statuses, states.length - 1)];
      state.statuses += 1;
      return json({
        data: {
          id: 'media-1',
          ...(current === null
            ? {}
            : {
                processing_info: {
                  state: current,
                  check_after_secs: 0,
                  ...(options.processingError
                    ? { error: { message: options.processingError } }
                    : {}),
                },
              }),
        },
      });
    }
    if (url.endsWith('/2/tweets')) {
      if (options.postError) return json(options.postError.body, options.postError.status);
      state.post = JSON.parse(String(init?.body));
      return json({ data: { id: '1899000000000000001', text: 'ok' } });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { impl, state };
}

function memoryLedger() {
  const rows = new Map<string, { mediaId: string | null; verified: boolean }>();
  const ledger: XMediaLedger = {
    async find(assetId) {
      return rows.get(assetId) ?? null;
    },
    async registered(assetId, mediaId) {
      rows.set(assetId, { mediaId, verified: false });
    },
    async uploaded(assetId, verified) {
      const row = rows.get(assetId);
      if (row) row.verified = verified;
    },
    async failed() {},
    async attached() {},
  };
  return { ledger, rows };
}

const image = (over: Partial<PublishMediaInput> = {}): PublishMediaInput => ({
  assetId: 'asset-1',
  kind: 'IMAGE',
  mimeType: 'image/jpeg',
  sizeBytes: 2048,
  widthPx: 1200,
  heightPx: 800,
  altText: null,
  load: async () => Buffer.alloc(2048, 5),
  ...over,
});

const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  idempotencyKey: 'entry-1',
  title: 'Fresh roast',
  body: 'Fresh roast Friday',
  ...over,
});

const publisher = (
  impl: typeof fetch,
  over: Partial<ConstructorParameters<typeof XPublisher>[0]> = {},
) =>
  new XPublisher({
    apiBaseUrl: BASE,
    fetchImpl: impl,
    accessToken: 'X-TOKEN',
    grantedScopes: [X_SCOPES.write, X_SCOPES.read, X_SCOPES.users, X_SCOPES.media],
    username: 'acmecoffee',
    pollIntervalMs: 0,
    sleep: async () => undefined,
    now: () => new Date('2026-09-12T10:00:00.000Z'),
    ...over,
  });

describe('validation', () => {
  it('accepts text and up to four images', () => {
    expect(validateXPost(input())).toEqual([]);
    expect(validateXPost(input({ media: [image(), image({ assetId: 'b' })] }))).toEqual([]);
  });

  it('attributes the character cap to Spectra, since X documents none', () => {
    const issues = validateXPost(input({ body: 'x'.repeat(SPECTRA_MAX_POST_CHARS + 1) }));
    expect(issues[0]?.code).toBe('MAX_CHARACTERS');
    expect(issues[0]?.message).toContain('Spectra caps');
    expect(issues[0]?.message).toContain('not stated in its API reference');
  });

  it('refuses five images, an empty post and an oversized upload', () => {
    const codes = (value: PublishInput) => validateXPost(value).map((i) => i.code);
    const five = Array.from({ length: 5 }, (_, i) => image({ assetId: `a${i}` }));
    expect(codes(input({ media: five }))).toContain('TOO_MANY_MEDIA');
    expect(codes(input({ title: '', body: '' }))).toContain('EMPTY_POST');
    expect(codes(input({ media: [image({ sizeBytes: 6 * 1024 * 1024 })] }))).toContain(
      'IMAGE_FILE_TOO_LARGE',
    );
  });
});

describe('capabilities', () => {
  const caps = (over = {}) =>
    xAccountCapabilities({
      grantedScopes: [X_SCOPES.write, X_SCOPES.read, X_SCOPES.users, X_SCOPES.media],
      checkedAt: new Date('2026-09-12T10:00:00.000Z'),
      ...over,
    });

  it('posts text and images, not video', () => {
    expect(caps().postTypes.TEXT.status).toBe('AVAILABLE');
    expect(caps().postTypes.IMAGE.status).toBe('AVAILABLE');
    expect(caps().postTypes.VIDEO.status).toBe('NOT_IMPLEMENTED');
  });

  it('separates a missing media scope from a missing post scope', () => {
    const noMedia = caps({ grantedScopes: [X_SCOPES.write, X_SCOPES.read, X_SCOPES.users] });
    expect(noMedia.postTypes.TEXT.status).toBe('AVAILABLE');
    expect(noMedia.postTypes.IMAGE.status).toBe('MISSING_PERMISSION');
    expect(noMedia.postTypes.IMAGE.reason).toContain('media.write');
  });

  it('says publishing costs money and what the rate limits are', () => {
    expect(caps().notes.some((n) => n.includes('pay-per-usage'))).toBe(true);
    expect(caps().notes.some((n) => n.includes('100 posts per user per 15 minutes'))).toBe(true);
  });
});

describe('publishing', () => {
  it('posts text', async () => {
    const { impl, state } = fakeX();
    const outcome = await publisher(impl).publish(input());
    expect(outcome).toMatchObject({
      status: 'PUBLISHED',
      externalPostId: '1899000000000000001',
      externalUrl: 'https://x.com/acmecoffee/status/1899000000000000001',
    });
    expect(state.post).toEqual({ text: 'Fresh roast Friday' });
    expect(state.initializes).toBe(0);
  });

  it('uploads an image through the chunked endpoints and attaches its id', async () => {
    const { impl, state } = fakeX({ states: ['succeeded'] });
    const outcome = await publisher(impl).publish(input({ media: [image()] }));
    expect(outcome.status).toBe('PUBLISHED');
    expect(state.initializes).toBe(1);
    expect(state.appends).toEqual([0]);
    expect(state.finalizes).toBe(1);
    expect(state.post).toMatchObject({ media: { media_ids: ['media-1'] } });
  });

  it('reuses an image an earlier attempt already uploaded', async () => {
    const { ledger, rows } = memoryLedger();
    rows.set('asset-1', { mediaId: 'media-earlier', verified: true });
    const { impl, state } = fakeX();
    const outcome = await publisher(impl, { ledger }).publish(input({ media: [image()] }));
    expect(outcome.status).toBe('PUBLISHED');
    expect(state.initializes).toBe(0);
    expect(state.post).toMatchObject({ media: { media_ids: ['media-earlier'] } });
  });

  it('does not attach an image X failed to process', async () => {
    const { impl, state } = fakeX({ states: ['failed'], processingError: 'InvalidMedia' });
    const outcome = await publisher(impl).publish(input({ media: [image()] }));
    expect(outcome.status).toBe('FAILED');
    expect(outcome.failureReason).toContain('InvalidMedia');
    expect(state.post).toBeNull();
  });

  it('keeps the upload and asks for a retry while X is still processing', async () => {
    const { impl } = fakeX({ states: ['in_progress'] });
    const outcome = await publisher(impl, { statusChecks: 2 }).publish(input({ media: [image()] }));
    expect(outcome.failureCode).toBe('TRANSIENT');
    expect(outcome.failureReason).toContain('still processing');
  });

  it('refuses an image without the media scope, before contacting X', async () => {
    const { impl, state } = fakeX();
    const outcome = await publisher(impl, {
      grantedScopes: [X_SCOPES.write, X_SCOPES.read, X_SCOPES.users],
    }).publish(input({ media: [image()] }));
    expect(outcome.failureCode).toBe('PERMISSION');
    expect(outcome.failureReason).toContain('media.write');
    expect(state.initializes).toBe(0);
  });

  it('reports an API-plan refusal as what it is', async () => {
    const { impl } = fakeX({
      postError: {
        status: 403,
        body: { title: 'Client Forbidden', detail: 'Your client is not enrolled in a plan' },
      },
    });
    const outcome = await publisher(impl).publish(input());
    expect(outcome.failureCode).toBe('PERMISSION');
    expect(outcome.failureReason).toContain('credits or a plan');
  });

  it('reports a duplicate post and a rate limit distinctly', async () => {
    const duplicate = await publisher(
      fakeX({ postError: { status: 403, body: { errors: [{ code: 187, message: 'duplicate' }] } } })
        .impl,
    ).publish(input());
    expect(duplicate.failureCode).toBe('VALIDATION');
    expect(duplicate.failureReason).toContain('identical post');

    const limited = await publisher(
      fakeX({ postError: { status: 429, body: { errors: [{ code: 88, message: 'rate' }] } } }).impl,
    ).publish(input());
    expect(limited.failureCode).toBe('RATE_LIMIT');
  });
});

describe('discovery', () => {
  it('names the account from /2/users/me and lists no other destination', async () => {
    const { impl } = fakeX();
    const discovery = new XAccountDiscovery(
      { apiBaseUrl: BASE, fetchImpl: impl },
      () => new Date('2026-09-12T10:00:00.000Z'),
    );
    const identity = await discovery.discoverIdentity({
      accessToken: 'X-TOKEN',
      grantedScopes: [X_SCOPES.write, X_SCOPES.read, X_SCOPES.users],
    });
    expect(identity).toMatchObject({ externalId: '1200', displayName: '@acmecoffee' });
    expect(await discovery.discoverDestinations()).toEqual([]);
  });
});
