import type { PublishInput, PublishMediaInput } from '@spectra/social-core';
import { describe, expect, it } from 'vitest';

import { threadsProfileCapabilities } from './capabilities';
import { THREADS_SCOPES } from './constants';
import { ThreadsAccountDiscovery } from './discovery';
import { ThreadsPublisher, type ThreadsContainerLedger } from './publisher';
import { validateThreadsPost } from './text';

/**
 * The Threads adapter against a stand-in that behaves like the Threads API:
 * a media container, then a publish. What matters is that a container an
 * earlier attempt made is published rather than remade, and that an image
 * Threads cannot fetch is refused before anything is posted.
 */

const BASE = 'https://threads.test';
const USER = '17841400000000001';

interface Recorder {
  containers: number;
  publishes: number;
  params: URLSearchParams | null;
}

function fakeThreads(options: { publishError?: { code: number; status?: number } } = {}) {
  const state: Recorder = { containers: 0, publishes: 0, params: null };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/me')) return json({ id: USER, username: 'acmecoffee', name: 'Acme' });
    if (url.endsWith('/threads')) {
      state.containers += 1;
      state.params = new URLSearchParams(String(init?.body));
      return json({ id: 'container-1' });
    }
    if (url.endsWith('/threads_publish')) {
      state.publishes += 1;
      if (options.publishError) {
        return json(
          { error: { message: 'nope', code: options.publishError.code } },
          options.publishError.status ?? 400,
        );
      }
      return json({ id: '7700000000000000001' });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { impl, state };
}

function memoryLedger(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  const ledger: ThreadsContainerLedger = {
    async find(key) {
      return rows.get(key) ?? null;
    },
    async staged(key, containerId) {
      rows.set(key, containerId);
      return true;
    },
    async cleared(key) {
      rows.delete(key);
    },
  };
  return { ledger, rows };
}

const image = (over: Partial<PublishMediaInput> = {}): PublishMediaInput => ({
  assetId: 'asset-1',
  kind: 'IMAGE',
  mimeType: 'image/jpeg',
  sizeBytes: 400_000,
  widthPx: 1080,
  heightPx: 1350,
  altText: 'A cup of coffee',
  load: async () => Buffer.alloc(8),
  url: async () => 'https://storage.test/signed/photo.jpg',
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
  over: Partial<ConstructorParameters<typeof ThreadsPublisher>[0]> = {},
) =>
  new ThreadsPublisher({
    apiBaseUrl: BASE,
    fetchImpl: impl,
    accessToken: 'THREADS-TOKEN',
    threadsUserId: USER,
    grantedScopes: [THREADS_SCOPES.basic, THREADS_SCOPES.publish],
    username: 'acmecoffee',
    publishDelayMs: 0,
    sleep: async () => undefined,
    now: () => new Date('2026-09-12T10:00:00.000Z'),
    ...over,
  });

describe('validation', () => {
  it('accepts text, and text with one image', () => {
    expect(validateThreadsPost(input())).toEqual([]);
    expect(validateThreadsPost(input({ media: [image()] }))).toEqual([]);
  });

  it('enforces the limits Meta documents', () => {
    const codes = (value: PublishInput) => validateThreadsPost(value).map((i) => i.code);
    expect(codes(input({ body: 'x'.repeat(501) }))).toContain('MAX_CHARACTERS');
    expect(codes(input({ body: '', title: '' }))).toContain('EMPTY_POST');
    expect(codes(input({ media: [image({ mimeType: 'image/webp' })] }))).toContain(
      'UNSUPPORTED_IMAGE_FORMAT',
    );
    expect(codes(input({ media: [image({ sizeBytes: 9 * 1024 * 1024 })] }))).toContain(
      'IMAGE_FILE_TOO_LARGE',
    );
    expect(codes(input({ media: [image({ widthPx: 200 })] }))).toContain('IMAGE_TOO_NARROW');
    expect(codes(input({ media: [image({ widthPx: 2000 })] }))).toContain('IMAGE_TOO_WIDE');
    expect(codes(input({ media: [image({ widthPx: 1400, heightPx: 100 })] }))).toContain(
      'ASPECT_RATIO',
    );
    expect(codes(input({ media: [image(), image({ assetId: 'b' })] }))).toContain('TOO_MANY_MEDIA');
  });
});

describe('capabilities', () => {
  const caps = (over = {}) =>
    threadsProfileCapabilities({
      grantedScopes: [THREADS_SCOPES.basic, THREADS_SCOPES.publish],
      checkedAt: new Date('2026-09-12T10:00:00.000Z'),
      ...over,
    });

  it('publishes text and images, not video yet', () => {
    expect(caps().postTypes.TEXT.status).toBe('AVAILABLE');
    expect(caps().postTypes.IMAGE.status).toBe('AVAILABLE');
    expect(caps().postTypes.VIDEO.status).toBe('NOT_IMPLEMENTED');
    expect(caps().postTypes.DOCUMENT.status).toBe('NOT_SUPPORTED');
  });

  it('names missing permissions', () => {
    const snapshot = caps({ grantedScopes: [THREADS_SCOPES.basic] });
    expect(snapshot.postTypes.TEXT.status).toBe('MISSING_PERMISSION');
    expect(snapshot.postTypes.TEXT.reason).toContain('threads_content_publish');
  });

  it('keeps text available when only the image link is impossible', () => {
    const snapshot = caps({ mediaProblem: 'Storage is not reachable from the internet.' });
    expect(snapshot.postTypes.TEXT.status).toBe('AVAILABLE');
    expect(snapshot.postTypes.IMAGE.status).toBe('MISSING_PERMISSION');
  });

  it("quotes Meta's tester-accounts-only rule and the daily cap", () => {
    expect(caps().notes.some((n) => n.includes("your app's tester accounts"))).toBe(true);
    expect(caps().notes.some((n) => n.includes('250 API-published posts'))).toBe(true);
  });
});

describe('publishing', () => {
  it('creates a container and publishes it', async () => {
    const { impl, state } = fakeThreads();
    const outcome = await publisher(impl).publish(input({ media: [image()] }));
    expect(outcome).toMatchObject({
      status: 'PUBLISHED',
      externalPostId: '7700000000000000001',
      externalUrl: 'https://www.threads.net/@acmecoffee/post/7700000000000000001',
    });
    expect(state.containers).toBe(1);
    expect(state.publishes).toBe(1);
    expect(state.params?.get('media_type')).toBe('IMAGE');
    expect(state.params?.get('image_url')).toBe('https://storage.test/signed/photo.jpg');
    expect(state.params?.get('alt_text')).toBe('A cup of coffee');
  });

  it('sends a text post as TEXT, with no image url', async () => {
    const { impl, state } = fakeThreads();
    await publisher(impl).publish(input());
    expect(state.params?.get('media_type')).toBe('TEXT');
    expect(state.params?.get('image_url')).toBeNull();
  });

  it('publishes the container an earlier attempt prepared, rather than making another', async () => {
    const { ledger } = memoryLedger({ 'entry-1': 'container-earlier' });
    const { impl, state } = fakeThreads();
    const outcome = await publisher(impl, { ledger }).publish(input());
    expect(outcome.status).toBe('PUBLISHED');
    expect(state.containers).toBe(0);
    expect(outcome.note).toContain('prepared by an earlier attempt');
  });

  it('calls a refused reused container ambiguous rather than posting again', async () => {
    const { ledger } = memoryLedger({ 'entry-1': 'container-earlier' });
    const { impl } = fakeThreads({ publishError: { code: 100 } });
    const outcome = await publisher(impl, { ledger }).publish(input());
    expect(outcome.failureCode).toBe('AMBIGUOUS');
    expect(outcome.failureReason).toContain('already published it');
  });

  it('refuses an image it cannot give Threads a link to', async () => {
    const { impl, state } = fakeThreads();
    const outcome = await publisher(impl).publish(input({ media: [image({ url: undefined })] }));
    expect(outcome.failureCode).toBe('UNSUPPORTED_MEDIA');
    expect(outcome.failureReason).toContain('not reachable from the internet');
    expect(state.containers).toBe(0);
  });

  it('marks the connection for reconnect when Threads rejects the token', async () => {
    let reconnect = false;
    const { impl } = fakeThreads({ publishError: { code: 190, status: 401 } });
    const outcome = await publisher(impl, {
      onAuthRejected: async () => {
        reconnect = true;
      },
    }).publish(input());
    expect(outcome.failureCode).toBe('AUTH');
    expect(reconnect).toBe(true);
  });
});

describe('discovery', () => {
  it('names the profile from /me and lists no other destination', async () => {
    const { impl } = fakeThreads();
    const discovery = new ThreadsAccountDiscovery(
      { apiBaseUrl: BASE, fetchImpl: impl },
      () => new Date('2026-09-12T10:00:00.000Z'),
    );
    const identity = await discovery.discoverIdentity({
      accessToken: 'THREADS-TOKEN',
      grantedScopes: [THREADS_SCOPES.basic, THREADS_SCOPES.publish],
    });
    expect(identity).toMatchObject({
      externalId: USER,
      displayName: '@acmecoffee',
      kind: 'PROFILE',
    });
    expect(await discovery.discoverDestinations()).toEqual([]);
  });
});
