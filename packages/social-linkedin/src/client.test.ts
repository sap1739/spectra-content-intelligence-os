import { describe, expect, it } from 'vitest';

import { LinkedInApiError, LinkedInClient, isAllowedUploadUrl } from './client';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: string | undefined;
}

function fakeFetch(respond: (url: string) => Response) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body,
      redirect: init?.redirect,
    });
    return respond(String(input));
  }) as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const TOKEN = 'li-access-TOKENVALUE';
const OPTIONS = { apiBaseUrl: 'https://api.linkedin.com', version: '202608' };

function client(respond: (url: string) => Response) {
  const fake = fakeFetch(respond);
  return {
    client: new LinkedInClient(TOKEN, { ...OPTIONS, fetchImpl: fake.impl }),
    calls: fake.calls,
  };
}

async function errorOf(promise: Promise<unknown>): Promise<LinkedInApiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof LinkedInApiError)) throw new Error('expected a LinkedInApiError');
  return error;
}

describe('LinkedInClient', () => {
  it('sends the version and Rest.li headers on versioned calls, and refuses redirects', async () => {
    const { client: li, calls } = client(() => json(200, { elements: [] }));
    await li.rest('GET', '/rest/organizationAcls', { query: 'q=roleAssignee' });
    const [call] = calls;
    expect(call?.url).toBe('https://api.linkedin.com/rest/organizationAcls?q=roleAssignee');
    expect(call?.headers['linkedin-version']).toBe('202608');
    expect(call?.headers['x-restli-protocol-version']).toBe('2.0.0');
    expect(call?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(call?.redirect).toBe('error');
  });

  it('sends no version header on the unversioned userinfo call', async () => {
    const { client: li, calls } = client(() => json(200, { sub: 'x' }));
    await li.v2('/v2/userinfo');
    expect(calls[0]?.headers['linkedin-version']).toBeUndefined();
  });

  it("keeps LinkedIn's error code and message, never the token", async () => {
    const { client: li } = client(() =>
      json(403, {
        status: 403,
        code: 'ACCESS_DENIED',
        message: 'Not enough permissions to access: posts.CREATE',
      }),
    );
    const error = await errorOf(li.rest('POST', '/rest/posts', { body: {} }));
    expect(error.kind).toBe('PERMISSION');
    expect(error.code).toBe('ACCESS_DENIED');
    expect(error.httpStatus).toBe(403);
    expect(error.message).toContain('ACCESS_DENIED');
    expect(error.message).not.toContain(TOKEN);
  });

  it.each([
    [401, 'AUTH', false],
    [404, 'NOT_FOUND', false],
    [409, 'CONFLICT', true],
    [422, 'VALIDATION', false],
    [426, 'VALIDATION', false],
    [429, 'RATE_LIMIT', true],
    [503, 'TRANSIENT', true],
  ] as const)('maps HTTP %i to %s', async (status, kind, retryable) => {
    const { client: li } = client(() => json(status, {}));
    const error = await errorOf(li.rest('GET', '/rest/x'));
    expect(error.kind).toBe(kind);
    expect(error.retryable).toBe(retryable);
  });

  it('drops an error code that is not a plain token', async () => {
    const { client: li } = client(() => json(400, { code: '<b>x</b>' }));
    expect((await errorOf(li.rest('GET', '/rest/x'))).code).toBeNull();
  });

  it('marks a timed-out POST as ambiguous — it may have been applied — but not a GET', async () => {
    const slow = (async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });
    }) as typeof fetch;
    const li = new LinkedInClient(TOKEN, { ...OPTIONS, fetchImpl: slow });
    expect((await errorOf(li.rest('POST', '/rest/posts', { body: {} }))).ambiguous).toBe(true);
    expect((await errorOf(li.rest('GET', '/rest/x'))).ambiguous).toBe(false);
  });
});

describe('image upload', () => {
  it('only sends bytes and the token to LinkedIn', () => {
    expect(isAllowedUploadUrl('https://www.linkedin.com/dms-uploads/abc', OPTIONS.apiBaseUrl)).toBe(
      true,
    );
    expect(isAllowedUploadUrl('https://api.linkedin.com/mediaUpload/abc', OPTIONS.apiBaseUrl)).toBe(
      true,
    );
    expect(isAllowedUploadUrl('http://www.linkedin.com/dms-uploads/abc', OPTIONS.apiBaseUrl)).toBe(
      false,
    );
    expect(isAllowedUploadUrl('https://evil.example/upload', OPTIONS.apiBaseUrl)).toBe(false);
    expect(isAllowedUploadUrl('https://linkedin.com.evil.example/upload', OPTIONS.apiBaseUrl)).toBe(
      false,
    );
    expect(isAllowedUploadUrl('not a url', OPTIONS.apiBaseUrl)).toBe(false);
    // The configured API origin (a local mock in tests) is allowed.
    expect(isAllowedUploadUrl('http://127.0.0.1:9000/dms-uploads/1', 'http://127.0.0.1:9000')).toBe(
      true,
    );
  });

  it('refuses a foreign upload URL without sending anything', async () => {
    const { client: li, calls } = client(() => json(201, {}));
    const error = await errorOf(li.upload('https://evil.example/upload', Buffer.from('png')));
    expect(error.kind).toBe('VALIDATION');
    expect(calls).toHaveLength(0);
  });

  it('PUTs the bytes with the bearer token LinkedIn requires for images', async () => {
    const { client: li, calls } = client(() => new Response(null, { status: 201 }));
    await li.upload('https://www.linkedin.com/dms-uploads/abc', Buffer.from('png-bytes'));
    const [call] = calls;
    expect(call?.method).toBe('PUT');
    expect(call?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(call?.headers['content-type']).toBe('application/octet-stream');
    expect(Buffer.from(call?.body as Uint8Array).toString()).toBe('png-bytes');
  });
});
