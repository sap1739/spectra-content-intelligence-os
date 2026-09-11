import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { MetaApiError, MetaGraphClient } from './client';

const TOKEN = 'EAAB-page-TOKENVALUE';
const SECRET = 'app-secret';
const BASE = { apiBaseUrl: 'https://graph.facebook.com', version: 'v26.0' };

interface Call {
  url: URL;
  method: string;
  body: unknown;
  redirect: string | undefined;
}

function fake(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      body: init?.body,
      redirect: init?.redirect,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const graphError = (status: number, code: number, subcode?: number, message = 'Error') =>
  json(status, {
    error: {
      message,
      type: 'OAuthException',
      code,
      ...(subcode !== undefined ? { error_subcode: subcode } : {}),
      fbtrace_id: 'AbCdEf',
    },
  });
const timeout = () => {
  const error = new Error('timed out');
  error.name = 'TimeoutError';
  throw error;
};

describe('MetaGraphClient', () => {
  it('sends the token as access_token with an appsecret_proof, on a versioned path, refusing redirects', async () => {
    const { fetchImpl, calls } = fake(() => json(200, { id: '1' }));
    await new MetaGraphClient(TOKEN, { ...BASE, appSecret: SECRET, fetchImpl }).get('me', {
      fields: 'id,name',
    });
    const call = calls[0];
    expect(call?.url.pathname).toBe('/v26.0/me');
    expect(call?.url.searchParams.get('fields')).toBe('id,name');
    expect(call?.url.searchParams.get('access_token')).toBe(TOKEN);
    expect(call?.url.searchParams.get('appsecret_proof')).toBe(
      createHmac('sha256', SECRET).update(TOKEN).digest('hex'),
    );
    expect(call?.redirect).toBe('error');
  });

  it('posts form fields in the body, never in the URL', async () => {
    const { fetchImpl, calls } = fake(() => json(200, { id: '1' }));
    await new MetaGraphClient(TOKEN, { ...BASE, appSecret: SECRET, fetchImpl }).post('123/feed', {
      message: 'hi',
    });
    const call = calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url.search).toBe('');
    const form = new URLSearchParams(String(call?.body));
    expect(form.get('message')).toBe('hi');
    expect(form.get('access_token')).toBe(TOKEN);
    expect(form.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('omits appsecret_proof when no app secret is configured', async () => {
    const { fetchImpl, calls } = fake(() => json(200, { id: '1' }));
    await new MetaGraphClient(TOKEN, { ...BASE, fetchImpl }).get('me');
    expect(calls[0]?.url.searchParams.has('appsecret_proof')).toBe(false);
  });

  it.each([
    [400, 190, undefined, 'AUTH'],
    [400, 190, 463, 'AUTH'],
    [400, 102, undefined, 'AUTH'],
    [403, 200, undefined, 'PERMISSION'],
    [403, 10, undefined, 'PERMISSION'],
    [400, 100, 492, 'PERMISSION'],
    [400, 368, undefined, 'PERMISSION'],
    [400, 4, undefined, 'RATE_LIMIT'],
    [400, 17, undefined, 'RATE_LIMIT'],
    [400, 32, undefined, 'RATE_LIMIT'],
    [400, 613, undefined, 'RATE_LIMIT'],
    [500, 1, undefined, 'TRANSIENT'],
    [503, 2, undefined, 'TRANSIENT'],
    [400, 100, undefined, 'VALIDATION'],
    [400, 506, undefined, 'VALIDATION'],
  ] as const)('maps HTTP %i, code %i/%s to %s', async (status, code, subcode, kind) => {
    const { fetchImpl } = fake(() => graphError(status, code, subcode));
    const error = await new MetaGraphClient(TOKEN, { ...BASE, fetchImpl })
      .get('me')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error).toMatchObject({ kind, code, subcode: subcode ?? null, httpStatus: status });
  });

  it('treats an error body as an error even on a 200', async () => {
    const { fetchImpl } = fake(() => json(200, { error: { code: 190, message: 'expired' } }));
    const error = await new MetaGraphClient(TOKEN, { ...BASE, fetchImpl })
      .get('me')
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'AUTH' });
  });

  it('never echoes the token in an error message', async () => {
    const { fetchImpl } = fake(() => graphError(400, 190, undefined, `Bad token ${TOKEN}`));
    const error = (await new MetaGraphClient(TOKEN, { ...BASE, fetchImpl })
      .get('me')
      .catch((e: unknown) => e)) as MetaApiError;
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain('[redacted]');
  });

  it('marks an unanswered POST as ambiguous, and an unanswered GET as not', async () => {
    const { fetchImpl } = fake(timeout);
    const client = new MetaGraphClient(TOKEN, { ...BASE, fetchImpl });
    expect(await client.post('1/feed', { message: 'x' }).catch((e: unknown) => e)).toMatchObject({
      kind: 'TRANSIENT',
      ambiguous: true,
    });
    expect(await client.get('me').catch((e: unknown) => e)).toMatchObject({
      kind: 'TRANSIENT',
      ambiguous: false,
    });
  });

  it('sends a file as multipart form data with the token alongside', async () => {
    const { fetchImpl, calls } = fake(() => json(200, { id: '1' }));
    await new MetaGraphClient(TOKEN, { ...BASE, fetchImpl }).postFile(
      '123/photos',
      { caption: 'Q3' },
      {
        field: 'source',
        bytes: Buffer.from('jpeg-bytes'),
        mimeType: 'image/jpeg',
        filename: 'image.jpg',
      },
    );
    const form = calls[0]?.body as FormData;
    expect(form.get('caption')).toBe('Q3');
    expect(form.get('access_token')).toBe(TOKEN);
    expect((form.get('source') as Blob).size).toBe('jpeg-bytes'.length);
  });
});
