import type { PublishMediaInput } from '@spectra/social-core';
import { describe, expect, it, vi } from 'vitest';

import { FacebookPagePublisher, InstagramPublisher, type ContainerLedger } from './publisher';

const TOKEN = 'EAAB-page-TOKENVALUE';
const PAGE = '1111';
const IG = '17841400000000001';
const CONTAINER = '90010000000001';
const OLD_CONTAINER = '90010000000000';
const MEDIA = '17900000000000001';
const SIGNED = 'https://storage.example.com/org/1/ws/1/media/a/photo.jpg?X-Amz-Signature=abc';
const BASE = { apiBaseUrl: 'https://graph.facebook.com', version: 'v26.0' };

interface Call {
  path: string;
  method: string;
  body: unknown;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const timeout = (): never => {
  const error = new Error('timed out');
  error.name = 'TimeoutError';
  throw error;
};

function graph(
  overrides: {
    feed?: () => Response;
    containerStatus?: () => string;
    publish?: () => Response;
    quota?: unknown;
  } = {},
) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/v26.0/', '');
    calls.push({ path, method, body: init?.body });
    if (method === 'POST' && path === `${PAGE}/feed`) {
      return overrides.feed ? overrides.feed() : json(200, { id: `${PAGE}_555` });
    }
    if (method === 'POST' && path === `${PAGE}/photos`)
      return json(200, { id: '777', post_id: `${PAGE}_778` });
    if (method === 'GET' && (path === `${PAGE}_555` || path === `${PAGE}_778`)) {
      return json(200, {
        id: path,
        permalink_url: `https://www.facebook.com/${PAGE}/posts/${path.split('_')[1]}`,
      });
    }
    if (path === `${IG}/content_publishing_limit`) {
      return json(
        200,
        overrides.quota ?? {
          data: [{ quota_usage: 3, config: { quota_total: 100, quota_duration: 86400 } }],
        },
      );
    }
    if (method === 'POST' && path === `${IG}/media`) return json(200, { id: CONTAINER });
    if (method === 'GET' && (path === CONTAINER || path === OLD_CONTAINER)) {
      return json(200, { id: path, status_code: overrides.containerStatus?.() ?? 'FINISHED' });
    }
    if (method === 'POST' && path === `${IG}/media_publish`) {
      return overrides.publish ? overrides.publish() : json(200, { id: MEDIA });
    }
    if (method === 'GET' && path === MEDIA)
      return json(200, { id: MEDIA, permalink: 'https://www.instagram.com/p/ABC123/' });
    return json(404, { error: { code: 803, message: 'Unknown path' } });
  }) as typeof fetch;
  const count = (method: string, path: string) =>
    calls.filter((c) => c.method === method && c.path === path).length;
  return { fetchImpl, calls, count };
}

function memoryLedger(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  const ledger: ContainerLedger = {
    find: async (key) => rows.get(key) ?? null,
    staged: async (key, id) => {
      rows.set(key, id);
      return true;
    },
    cleared: async (key) => {
      rows.delete(key);
    },
  };
  return { ledger, rows };
}

const image = (overrides: Partial<PublishMediaInput> = {}): PublishMediaInput => ({
  assetId: 'asset-1',
  kind: 'IMAGE',
  mimeType: 'image/jpeg',
  sizeBytes: 12,
  widthPx: 1080,
  heightPx: 1350,
  altText: 'A chart of Q3 results',
  load: async () => Buffer.from('jpeg-bytes!!'),
  url: async () => SIGNED,
  ...overrides,
});
const input = (media?: PublishMediaInput[]) => ({
  idempotencyKey: 'entry-key-1',
  title: 'Q3 results',
  body: 'Q3 is up #results',
  ...(media ? { media } : {}),
});

describe('FacebookPagePublisher', () => {
  const publisher = (fetchImpl: typeof fetch, onAuthRejected?: () => Promise<void>) =>
    new FacebookPagePublisher({
      ...BASE,
      fetchImpl,
      accessToken: TOKEN,
      pageId: PAGE,
      ...(onAuthRejected ? { onAuthRejected } : {}),
    });

  it('publishes text to the Page feed with the Page token, and links the post', async () => {
    const { fetchImpl, calls } = graph();
    const outcome = await publisher(fetchImpl).publish(input());
    expect(outcome).toMatchObject({
      status: 'PUBLISHED',
      externalPostId: `${PAGE}_555`,
      externalUrl: `https://www.facebook.com/${PAGE}/posts/555`,
    });
    const form = new URLSearchParams(String(calls[0]?.body));
    expect(form.get('message')).toBe('Q3 is up #results');
    expect(form.get('access_token')).toBe(TOKEN);
  });

  it('uploads one photo as multipart source with the caption', async () => {
    const { fetchImpl, calls } = graph();
    const outcome = await publisher(fetchImpl).publish(input([image({ mimeType: 'image/png' })]));
    expect(outcome).toMatchObject({ status: 'PUBLISHED', externalPostId: `${PAGE}_778` });
    const form = calls.find((c) => c.path === `${PAGE}/photos`)?.body as FormData;
    expect(form.get('caption')).toBe('Q3 is up #results');
    expect((form.get('source') as Blob).size).toBe('jpeg-bytes!!'.length);
  });

  it('asks for a reconnect when Meta rejects the token', async () => {
    const onAuthRejected = vi.fn(async () => undefined);
    const { fetchImpl } = graph({
      feed: () =>
        json(400, { error: { code: 190, error_subcode: 460, message: 'Password changed' } }),
    });
    const outcome = await publisher(fetchImpl, onAuthRejected).publish(input());
    expect(outcome).toMatchObject({ status: 'FAILED', failureCode: 'AUTH' });
    expect(outcome.failureReason).toMatch(/reconnect Meta/);
    expect(onAuthRejected).toHaveBeenCalledOnce();
  });

  it('reports an unanswered publish as ambiguous — it may have been posted', async () => {
    const { fetchImpl } = graph({ feed: timeout });
    const outcome = await publisher(fetchImpl).publish(input());
    expect(outcome).toMatchObject({ status: 'FAILED', failureCode: 'AMBIGUOUS' });
    expect(outcome.failureReason).toMatch(/may appear twice/);
  });
});

describe('InstagramPublisher', () => {
  const publisher = (
    fetchImpl: typeof fetch,
    extra: { ledger?: ContainerLedger; statusChecks?: number } = {},
  ) =>
    new InstagramPublisher({
      ...BASE,
      fetchImpl,
      accessToken: TOKEN,
      instagramAccountId: IG,
      sleep: async () => undefined,
      ...extra,
    });

  it('creates a container from a signed link, waits for FINISHED, publishes, and links the post', async () => {
    const { fetchImpl, calls, count } = graph();
    const { ledger, rows } = memoryLedger();
    const outcome = await publisher(fetchImpl, { ledger }).publish(input([image()]));
    expect(outcome).toMatchObject({
      status: 'PUBLISHED',
      externalPostId: MEDIA,
      externalUrl: 'https://www.instagram.com/p/ABC123/',
    });
    const created = new URLSearchParams(String(calls.find((c) => c.path === `${IG}/media`)?.body));
    expect(created.get('image_url')).toBe(SIGNED);
    expect(created.get('caption')).toBe('Q3 is up #results');
    expect(created.get('alt_text')).toBe('A chart of Q3 results');
    const published = new URLSearchParams(
      String(calls.find((c) => c.path === `${IG}/media_publish`)?.body),
    );
    expect(published.get('creation_id')).toBe(CONTAINER);
    expect(rows.get('entry-key-1')).toBe(CONTAINER);
    expect(count('GET', `${IG}/content_publishing_limit`)).toBe(1);
  });

  it('refuses honestly when no link to the image can be made', async () => {
    const { fetchImpl, calls } = graph();
    const media = image();
    delete media.url;
    const outcome = await publisher(fetchImpl).publish(input([media]));
    expect(outcome).toMatchObject({ status: 'FAILED', failureCode: 'UNSUPPORTED_MEDIA' });
    expect(calls).toHaveLength(0);
  });

  it('reuses a FINISHED container from an earlier attempt instead of creating another', async () => {
    const { fetchImpl, count } = graph();
    const { ledger } = memoryLedger({ 'entry-key-1': OLD_CONTAINER });
    const outcome = await publisher(fetchImpl, { ledger }).publish(input([image()]));
    expect(outcome.status).toBe('PUBLISHED');
    expect(count('POST', `${IG}/media`)).toBe(0);
  });

  it('never publishes a container Instagram reports as already PUBLISHED', async () => {
    const { fetchImpl, count } = graph({ containerStatus: () => 'PUBLISHED' });
    const { ledger } = memoryLedger({ 'entry-key-1': OLD_CONTAINER });
    const outcome = await publisher(fetchImpl, { ledger }).publish(input([image()]));
    expect(outcome).toMatchObject({ status: 'FAILED', failureCode: 'AMBIGUOUS' });
    expect(outcome.failureReason).toMatch(/will not publish it again/);
    expect(count('POST', `${IG}/media_publish`)).toBe(0);
  });

  it('clears a container Instagram could not process, and says why', async () => {
    const { fetchImpl } = graph({ containerStatus: () => 'ERROR' });
    const { ledger, rows } = memoryLedger();
    const outcome = await publisher(fetchImpl, { ledger }).publish(input([image()]));
    expect(outcome).toMatchObject({ status: 'FAILED', failureCode: 'VALIDATION' });
    expect(outcome.failureReason).toMatch(/could not process the image/);
    expect(rows.size).toBe(0);
  });

  it('keeps a container still processing, for the next attempt to reuse', async () => {
    const { fetchImpl } = graph({ containerStatus: () => 'IN_PROGRESS' });
    const { ledger, rows } = memoryLedger();
    const outcome = await publisher(fetchImpl, { ledger, statusChecks: 2 }).publish(
      input([image()]),
    );
    expect(outcome).toMatchObject({ status: 'FAILED', failureCode: 'TRANSIENT' });
    expect(rows.get('entry-key-1')).toBe(CONTAINER);
  });

  it('stops before creating anything when the 24-hour publishing allowance is used up', async () => {
    const { fetchImpl, count } = graph({
      quota: { data: [{ quota_usage: 100, config: { quota_total: 100, quota_duration: 86400 } }] },
    });
    const outcome = await publisher(fetchImpl).publish(input([image()]));
    expect(outcome).toMatchObject({ status: 'FAILED', failureCode: 'RATE_LIMIT' });
    expect(outcome.failureReason).toContain('100 of its 100');
    expect(count('POST', `${IG}/media`)).toBe(0);
  });

  it('calls an unanswered publish safe to retry when the container is recorded — ambiguous when not', async () => {
    const recorded = await publisher(graph({ publish: timeout }).fetchImpl, {
      ledger: memoryLedger().ledger,
    }).publish(input([image()]));
    expect(recorded).toMatchObject({ status: 'FAILED', failureCode: 'TRANSIENT' });
    expect(recorded.failureReason).toMatch(/Retrying is safe/);

    const unrecorded = await publisher(graph({ publish: timeout }).fetchImpl).publish(
      input([image()]),
    );
    expect(unrecorded).toMatchObject({ status: 'FAILED', failureCode: 'AMBIGUOUS' });
  });
});
