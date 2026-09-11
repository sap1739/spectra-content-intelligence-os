import type { PublishMediaInput } from '@spectra/social-core';
import { describe, expect, it, vi } from 'vitest';

import { LinkedInPublisher, type MediaUploadLedger } from './publisher';

const TOKEN = 'li-access-TOKENVALUE';
const MEMBER = 'urn:li:person:782bbtaQ';
const PAGE = 'urn:li:organization:5515715';
const IMAGE_URN = 'urn:li:image:C4E10AQFoyyAjHPMQuQ';

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const created = (postUrn: string | null) =>
  new Response(null, { status: 201, headers: postUrn ? { 'x-restli-id': postUrn } : {} });

function linkedIn(
  overrides: {
    post?: () => Response | Promise<Response>;
    uploadUrl?: string;
    imageStatus?: () => string;
  } = {},
) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof body === 'string' ? JSON.parse(body) : body,
    });
    if (url.pathname === '/rest/images' && url.searchParams.get('action') === 'initializeUpload') {
      return json(200, {
        value: {
          uploadUrl:
            overrides.uploadUrl ??
            'https://www.linkedin.com/dms-uploads/C4E10AQFoyy/uploaded-image/0',
          image: IMAGE_URN,
          uploadUrlExpiresAt: 1_800_000_000_000,
        },
      });
    }
    if (init?.method === 'PUT') return new Response(null, { status: 201 });
    if (url.pathname.startsWith('/rest/images/')) {
      return json(200, { id: IMAGE_URN, status: overrides.imageStatus?.() ?? 'AVAILABLE' });
    }
    if (url.pathname === '/rest/posts')
      return overrides.post ? overrides.post() : created('urn:li:share:7000');
    return json(404, {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function memoryLedger(initial?: {
  externalMediaId: string;
  status: 'UPLOADED';
  verified: boolean;
}) {
  const rows = new Map<
    string,
    {
      externalMediaId: string | null;
      status: 'REGISTERED' | 'UPLOADED' | 'FAILED';
      verified: boolean;
      lastPostId?: string;
    }
  >();
  if (initial) rows.set('asset-1', { ...initial });
  const ledger: MediaUploadLedger = {
    find: async (id) => rows.get(id) ?? null,
    registered: async (id, externalMediaId) => {
      rows.set(id, { externalMediaId, status: 'REGISTERED', verified: false });
    },
    uploaded: async (id, verified) => {
      const row = rows.get(id);
      if (row) Object.assign(row, { status: 'UPLOADED', verified });
    },
    failed: async (id) => {
      const row = rows.get(id);
      if (row) row.status = 'FAILED';
    },
    attached: async (id, postUrn) => {
      const row = rows.get(id);
      if (row) row.lastPostId = postUrn;
    },
  };
  return { ledger, rows };
}

const image = (overrides: Partial<PublishMediaInput> = {}): PublishMediaInput => ({
  assetId: 'asset-1',
  kind: 'IMAGE',
  mimeType: 'image/png',
  sizeBytes: 9,
  widthPx: 1200,
  heightPx: 627,
  altText: 'A chart of Q3 results',
  load: async () => Buffer.from('png-bytes'),
  ...overrides,
});

function publisher(
  fetchImpl: typeof fetch,
  options: Partial<ConstructorParameters<typeof LinkedInPublisher>[0]> = {},
) {
  return new LinkedInPublisher({
    apiBaseUrl: 'https://api.linkedin.com',
    version: '202608',
    fetchImpl,
    accessToken: TOKEN,
    authorUrn: MEMBER,
    grantedScopes: ['openid', 'profile', 'w_member_social'],
    now: () => new Date('2026-09-11T10:00:00.000Z'),
    sleep: async () => undefined,
    ...options,
  });
}

const input = (body: string, media?: PublishMediaInput[]) => ({
  idempotencyKey: 'idem-1',
  title: 'Q3 results',
  body,
  ...(media ? { media } : {}),
});

describe('LinkedInPublisher — text', () => {
  it('creates a post through the Posts API and returns its URN and URL', async () => {
    const { fetchImpl, calls } = linkedIn();
    const outcome = await publisher(fetchImpl).publish(input('Q3 is up (again) #results'));
    expect(outcome).toEqual({
      status: 'PUBLISHED',
      externalPostId: 'urn:li:share:7000',
      externalUrl: 'https://www.linkedin.com/feed/update/urn:li:share:7000/',
      publishedAt: '2026-09-11T10:00:00.000Z',
    });
    const [call] = calls;
    expect(call?.url.pathname).toBe('/rest/posts');
    expect(call?.headers['linkedin-version']).toBe('202608');
    expect(call?.body).toEqual({
      author: MEMBER,
      commentary: 'Q3 is up \\(again\\) #results',
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
  });

  it('declares image-only media support, so the executor refuses video as UNSUPPORTED', () => {
    expect(publisher(linkedIn().fetchImpl).supportedMedia.kinds).toEqual(['IMAGE']);
  });

  it('validates before sending anything', async () => {
    const { fetchImpl, calls } = linkedIn();
    const outcome = await publisher(fetchImpl).publish(input('a'.repeat(3001)));
    expect(outcome).toMatchObject({ status: 'FAILED', failureCode: 'VALIDATION' });
    expect(calls).toHaveLength(0);
  });

  it('refuses an author that is not a person or organization URN', () => {
    expect(() => publisher(linkedIn().fetchImpl, { authorUrn: 'acme' })).toThrow(
      /person or organization URN/,
    );
  });
});

describe('LinkedInPublisher — images', () => {
  it('registers, uploads and attaches an image through the Images API', async () => {
    const { fetchImpl, calls } = linkedIn();
    const { ledger, rows } = memoryLedger();
    const outcome = await publisher(fetchImpl, { ledger }).publish(
      input('Chart attached', [image()]),
    );
    expect(outcome.status).toBe('PUBLISHED');

    const [init, upload, post] = calls;
    expect(init?.url.search).toBe('?action=initializeUpload');
    expect(init?.body).toEqual({ initializeUploadRequest: { owner: MEMBER } });
    expect(upload?.method).toBe('PUT');
    expect(upload?.url.hostname).toBe('www.linkedin.com');
    expect(upload?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(Buffer.from(upload?.body as Uint8Array).toString()).toBe('png-bytes');
    expect(post?.body).toMatchObject({
      content: { media: { id: IMAGE_URN, altText: 'A chart of Q3 results' } },
    });
    // A member token cannot read image status, so nothing is polled — and the
    // ledger records the upload as unverified.
    expect(calls.some((c) => c.url.pathname.startsWith('/rest/images/'))).toBe(false);
    expect(rows.get('asset-1')).toMatchObject({
      status: 'UPLOADED',
      verified: false,
      lastPostId: 'urn:li:share:7000',
    });
  });

  it('reuses an image LinkedIn already has instead of uploading it again', async () => {
    const { fetchImpl, calls } = linkedIn();
    const { ledger } = memoryLedger({
      externalMediaId: 'urn:li:image:EARLIER',
      status: 'UPLOADED',
      verified: false,
    });
    const load = vi.fn(async () => Buffer.from('png-bytes'));
    const outcome = await publisher(fetchImpl, { ledger }).publish(
      input('Again', [image({ load })]),
    );
    expect(outcome.status).toBe('PUBLISHED');
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(['POST /rest/posts']);
    expect(calls[0]?.body).toMatchObject({ content: { media: { id: 'urn:li:image:EARLIER' } } });
    expect(load).not.toHaveBeenCalled();
  });

  it('waits for a page image to finish processing before posting', async () => {
    const statuses = ['PROCESSING', 'AVAILABLE'];
    const { fetchImpl, calls } = linkedIn({ imageStatus: () => statuses.shift() ?? 'AVAILABLE' });
    const { ledger, rows } = memoryLedger();
    const outcome = await publisher(fetchImpl, {
      ledger,
      authorUrn: PAGE,
      grantedScopes: ['w_organization_social', 'r_organization_admin'],
    }).publish(input('Page post', [image()]));
    expect(outcome.status).toBe('PUBLISHED');
    expect(calls.filter((c) => c.url.pathname.startsWith('/rest/images/'))).toHaveLength(2);
    expect(rows.get('asset-1')?.verified).toBe(true);
  });

  it('fails honestly when LinkedIn cannot process the image, and creates no post', async () => {
    const { fetchImpl, calls } = linkedIn({ imageStatus: () => 'PROCESSING_FAILED' });
    const { ledger, rows } = memoryLedger();
    const outcome = await publisher(fetchImpl, {
      ledger,
      authorUrn: PAGE,
      grantedScopes: ['w_organization_social'],
    }).publish(input('Page post', [image()]));
    expect(outcome).toMatchObject({ status: 'FAILED', failureCode: 'VALIDATION' });
    expect(calls.some((c) => c.url.pathname === '/rest/posts')).toBe(false);
    expect(rows.get('asset-1')?.status).toBe('FAILED');
  });

  it('keeps an upload that is still processing, and reuses it on the next attempt', async () => {
    let status = 'PROCESSING';
    const { fetchImpl, calls } = linkedIn({ imageStatus: () => status });
    const { ledger } = memoryLedger();
    const pagePublisher = publisher(fetchImpl, {
      ledger,
      authorUrn: PAGE,
      grantedScopes: ['w_organization_social'],
      imageStatusChecks: 2,
    });
    const first = await pagePublisher.publish(input('Page post', [image()]));
    expect(first).toMatchObject({ status: 'FAILED', failureCode: 'TRANSIENT' });
    expect(first.failureReason).toMatch(/still processing/);

    status = 'AVAILABLE';
    const second = await pagePublisher.publish(input('Page post', [image()]));
    expect(second.status).toBe('PUBLISHED');
    const initializations = calls.filter(
      (c) => c.url.searchParams.get('action') === 'initializeUpload',
    );
    expect(initializations).toHaveLength(1);
  });

  it('refuses an upload URL outside linkedin.com — the image and token go nowhere', async () => {
    const { fetchImpl, calls } = linkedIn({ uploadUrl: 'https://evil.example/upload' });
    const { ledger, rows } = memoryLedger();
    const outcome = await publisher(fetchImpl, { ledger }).publish(input('x', [image()]));
    expect(outcome).toMatchObject({ status: 'FAILED', failureCode: 'VALIDATION' });
    expect(calls.some((c) => c.url.hostname === 'evil.example')).toBe(false);
    expect(rows.get('asset-1')?.status).toBe('FAILED');
  });
});

describe('LinkedInPublisher — failures', () => {
  it('asks for a reconnect when LinkedIn rejects the token', async () => {
    const { fetchImpl } = linkedIn({ post: () => json(401, { code: 'EXPIRED_ACCESS_TOKEN' }) });
    const onAuthRejected = vi.fn(async () => undefined);
    const outcome = await publisher(fetchImpl, { onAuthRejected }).publish(input('Hi'));
    expect(outcome).toMatchObject({ status: 'FAILED', failureCode: 'AUTH' });
    expect(outcome.failureReason).toMatch(/reconnect LinkedIn/);
    expect(onAuthRejected).toHaveBeenCalledTimes(1);
  });

  it('explains a permission refusal without leaking the token', async () => {
    const { fetchImpl } = linkedIn({
      post: () => json(403, { code: 'ACCESS_DENIED', message: 'Not enough permissions' }),
    });
    const outcome = await publisher(fetchImpl).publish(input('Hi'));
    expect(outcome).toMatchObject({ status: 'FAILED', failureCode: 'PERMISSION' });
    expect(outcome.failureReason).toContain('ACCESS_DENIED');
    expect(outcome.failureReason).not.toContain(TOKEN);
  });

  it('reports rate limiting as retryable', async () => {
    const { fetchImpl } = linkedIn({ post: () => json(429, { code: 'TOO_MANY_REQUESTS' }) });
    expect(await publisher(fetchImpl).publish(input('Hi'))).toMatchObject({
      failureCode: 'RATE_LIMIT',
    });
  });

  it('never claims success, or plain failure, when the post may exist', async () => {
    const { fetchImpl } = linkedIn({
      post: () => {
        throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      },
    });
    const outcome = await publisher(fetchImpl).publish(input('Hi'));
    expect(outcome).toMatchObject({ status: 'FAILED', failureCode: 'AMBIGUOUS' });
    expect(outcome.failureReason).toMatch(/may have been created/);
  });

  it('treats a 201 without a post id as ambiguous', async () => {
    const { fetchImpl } = linkedIn({ post: () => created(null) });
    expect(await publisher(fetchImpl).publish(input('Hi'))).toMatchObject({
      failureCode: 'AMBIGUOUS',
    });
  });
});
