import { describe, expect, it, vi } from 'vitest';

import {
  parseWordPressCredential,
  WordPressCredentialError,
  WordPressPublisher,
} from './index';

const CREDS = {
  siteUrl: 'https://blog.example.com/',
  username: 'editor',
  applicationPassword: 'abcd efgh ijkl mnop qrst uvwx',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('parseWordPressCredential', () => {
  it('splits on the first colon so passwords may contain colons', () => {
    const parsed = parseWordPressCredential('https://x.test', 'editor:a b:c d');
    expect(parsed.username).toBe('editor');
    expect(parsed.applicationPassword).toBe('a b:c d');
  });

  it('rejects a credential with no colon', () => {
    expect(() => parseWordPressCredential('https://x.test', 'nopassword')).toThrow(
      WordPressCredentialError,
    );
  });

  it('rejects an empty username or password', () => {
    expect(() => parseWordPressCredential('https://x.test', ':secret')).toThrow(
      WordPressCredentialError,
    );
    expect(() => parseWordPressCredential('https://x.test', 'user:')).toThrow(
      WordPressCredentialError,
    );
  });
});

describe('WordPressPublisher', () => {
  it('posts to the REST endpoint with Basic auth and maps a 201 to PUBLISHED', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(201, {
        id: 42,
        link: 'https://blog.example.com/?p=42',
        date_gmt: '2026-07-14T12:00:00',
      }),
    );
    const publisher = new WordPressPublisher(CREDS, { fetch: fetchMock as unknown as typeof fetch });

    const outcome = await publisher.publish({
      idempotencyKey: 'idem-1',
      title: 'Hello',
      body: '<p>World</p>',
    });

    expect(outcome.status).toBe('PUBLISHED');
    expect(outcome.externalPostId).toBe('42');
    expect(outcome.externalUrl).toBe('https://blog.example.com/?p=42');
    expect(outcome.publishedAt).toBe('2026-07-14T12:00:00Z');

    // Trailing slash normalized; correct REST path.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://blog.example.com/wp-json/wp/v2/posts');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from('editor:abcd efgh ijkl mnop qrst uvwx').toString('base64')}`,
    );
    expect(JSON.parse(init.body as string)).toEqual({
      title: 'Hello',
      content: '<p>World</p>',
      status: 'publish',
    });
  });

  it('maps a non-2xx response to FAILED with the status and trimmed body', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{"code":"rest_cannot_create","message":"Sorry"}', {
        status: 401,
        statusText: 'Unauthorized',
      }),
    );
    const publisher = new WordPressPublisher(CREDS, { fetch: fetchMock as unknown as typeof fetch });

    const outcome = await publisher.publish({ idempotencyKey: 'x', title: 't', body: 'b' });
    expect(outcome.status).toBe('FAILED');
    expect(outcome.failureReason).toContain('401');
    expect(outcome.failureReason).toContain('rest_cannot_create');
  });

  it('maps a network error to FAILED without throwing', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const publisher = new WordPressPublisher(CREDS, { fetch: fetchMock as unknown as typeof fetch });

    const outcome = await publisher.publish({ idempotencyKey: 'x', title: 't', body: 'b' });
    expect(outcome.status).toBe('FAILED');
    expect(outcome.failureReason).toContain('ECONNREFUSED');
  });

  it('rejects a non-http(s) site URL at construction', () => {
    expect(
      () => new WordPressPublisher({ ...CREDS, siteUrl: 'ftp://blog.example.com' }),
    ).toThrow(WordPressCredentialError);
  });
});
