import type { PublishInput, PublishMediaInput } from '@spectra/social-core';
import { describe, expect, it } from 'vitest';

import { pinterestBoardCapabilities } from './capabilities';
import { PINTEREST_SCOPES } from './constants';
import { PinterestAccountDiscovery } from './discovery';
import { PinterestPublisher } from './publisher';
import { pinCreateBody, validatePinterestPin, type PinDetails } from './text';

/**
 * The Pinterest adapter against a stand-in that behaves like API v5: paged
 * board listing, and pin creation from an image link. What matters is that no
 * limit Pinterest has not documented is invented, and that its own refusals —
 * notably the 403 for an image it will not take — are reported as they came.
 */

const BASE = 'https://pinterest.test';
const BOARD = 'board-1';

interface Recorder {
  boardPages: number;
  pins: number;
  body: unknown;
}

interface FakeOptions {
  pinError?: { status: number; message?: string };
  pages?: number;
}

function fakePinterest(options: FakeOptions = {}) {
  const state: Recorder = { boardPages: 0, pins: 0, body: null };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const pages = options.pages ?? 1;

  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/user_account')) {
      return json({ username: 'acmecoffee', account_type: 'BUSINESS' });
    }
    if (url.pathname.endsWith('/boards')) {
      const page = state.boardPages;
      state.boardPages += 1;
      const last = page + 1 >= pages;
      return json({
        items: [
          {
            id: `${BOARD}-${page}`,
            name: `Board ${page}`,
            privacy: 'PUBLIC',
            pin_count: 12,
          },
        ],
        ...(last ? { bookmark: null } : { bookmark: `page-${page + 1}` }),
      });
    }
    if (url.pathname.endsWith('/pins')) {
      state.pins += 1;
      if (options.pinError) {
        return json(
          { message: options.pinError.message ?? 'refused', code: 7 },
          options.pinError.status,
        );
      }
      state.body = JSON.parse(String(init?.body));
      return json({ id: 'pin-1' }, 201);
    }
    throw new Error(`unexpected ${url.pathname}`);
  };
  return { impl, state };
}

const image = (over: Partial<PublishMediaInput> = {}): PublishMediaInput => ({
  assetId: 'asset-1',
  kind: 'IMAGE',
  mimeType: 'image/jpeg',
  sizeBytes: 500_000,
  widthPx: 1000,
  heightPx: 1500,
  altText: 'A cup of coffee',
  load: async () => Buffer.alloc(8),
  url: async () => 'https://storage.test/signed/photo.jpg',
  ...over,
});

const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  idempotencyKey: 'entry-1',
  title: 'Fresh roast',
  body: 'What changed this quarter',
  media: [image()],
  ...over,
});

const publisher = (
  impl: typeof fetch,
  over: Partial<ConstructorParameters<typeof PinterestPublisher>[0]> = {},
) =>
  new PinterestPublisher({
    apiBaseUrl: BASE,
    fetchImpl: impl,
    accessToken: 'PIN-TOKEN',
    boardId: BOARD,
    grantedScopes: [PINTEREST_SCOPES.pinsWrite, PINTEREST_SCOPES.boardsRead],
    now: () => new Date('2026-09-12T10:00:00.000Z'),
    ...over,
  });

describe('validation', () => {
  it('accepts an image pin on a board', () => {
    expect(validatePinterestPin(input(), { boardId: BOARD })).toEqual([]);
  });

  it('needs a board and an image', () => {
    const codes = (value: PublishInput, details: PinDetails = { boardId: BOARD }) =>
      validatePinterestPin(value, details).map((i) => i.code);
    expect(codes(input(), { boardId: null })).toContain('BOARD_REQUIRED');
    expect(codes(input({ media: [] }))).toContain('IMAGE_REQUIRED');
    expect(codes(input({ media: [image(), image({ assetId: 'b' })] }))).toContain('TOO_MANY_MEDIA');
  });

  it('checks a destination link is a URL', () => {
    const issues = validatePinterestPin(input(), { boardId: BOARD, link: 'not a url' });
    expect(issues.map((i) => i.code)).toContain('INVALID_LINK');
  });

  it('builds the PinCreate body Pinterest documents', () => {
    expect(
      pinCreateBody({
        boardId: BOARD,
        imageUrl: 'https://storage.test/photo.jpg',
        title: 'Fresh roast',
        description: 'What changed',
        altText: 'A cup',
        link: 'https://example.test/post',
      }),
    ).toEqual({
      board_id: BOARD,
      media_source: { source_type: 'image_url', url: 'https://storage.test/photo.jpg' },
      title: 'Fresh roast',
      description: 'What changed',
      alt_text: 'A cup',
      link: 'https://example.test/post',
    });
  });
});

describe('capabilities', () => {
  const caps = (over = {}) =>
    pinterestBoardCapabilities({
      grantedScopes: [PINTEREST_SCOPES.pinsWrite, PINTEREST_SCOPES.boardsRead],
      checkedAt: new Date('2026-09-12T10:00:00.000Z'),
      ...over,
    });

  it('pins images only, and says a text-only pin does not exist', () => {
    expect(caps().postTypes.IMAGE.status).toBe('AVAILABLE');
    expect(caps().postTypes.TEXT.status).toBe('NOT_SUPPORTED');
    expect(caps().postTypes.VIDEO.status).toBe('NOT_IMPLEMENTED');
  });

  it('claims no limit Pinterest has not documented', () => {
    expect(caps().limits.maxCharacters).toBeNull();
    expect(caps().limits.imageMimeTypes).toEqual([]);
    expect(caps().notes.some((n) => n.includes('does not document image formats'))).toBe(true);
  });

  it('states the Trial access gate and the missing scope case', () => {
    expect(caps().notes.some((n) => n.includes('Trial access'))).toBe(true);
    const snapshot = caps({ grantedScopes: [PINTEREST_SCOPES.boardsRead] });
    expect(snapshot.postTypes.IMAGE.status).toBe('MISSING_PERMISSION');
    expect(snapshot.postTypes.IMAGE.reason).toContain('pins:write');
  });
});

describe('publishing', () => {
  it('creates the pin and links to it', async () => {
    const { impl, state } = fakePinterest();
    const outcome = await publisher(impl, { link: 'https://example.test/post' }).publish(input());
    expect(outcome).toMatchObject({
      status: 'PUBLISHED',
      externalPostId: 'pin-1',
      externalUrl: 'https://www.pinterest.com/pin/pin-1/',
    });
    expect(state.body).toMatchObject({
      board_id: BOARD,
      media_source: { source_type: 'image_url', url: 'https://storage.test/signed/photo.jpg' },
      alt_text: 'A cup of coffee',
      link: 'https://example.test/post',
    });
  });

  it("passes Pinterest's image refusal through in its own words", async () => {
    const { impl } = fakePinterest({
      pinError: { status: 403, message: "The Pin's image is too small" },
    });
    const outcome = await publisher(impl).publish(input());
    expect(outcome.status).toBe('FAILED');
    expect(outcome.failureCode).toBe('VALIDATION');
    expect(outcome.failureReason).toContain('too small');
    expect(outcome.failureReason).toContain('too small, too large or broken');
  });

  it('says a missing board is a board problem', async () => {
    const { impl } = fakePinterest({ pinError: { status: 404 } });
    const outcome = await publisher(impl).publish(input());
    expect(outcome.failureReason).toContain('could not find that board');
  });

  it('refuses an image it cannot give Pinterest a link to', async () => {
    const { impl, state } = fakePinterest();
    const outcome = await publisher(impl).publish(input({ media: [image({ url: undefined })] }));
    expect(outcome.failureCode).toBe('UNSUPPORTED_MEDIA');
    expect(state.pins).toBe(0);
  });
});

describe('discovery', () => {
  const discovery = (impl: typeof fetch) =>
    new PinterestAccountDiscovery(
      { apiBaseUrl: BASE, fetchImpl: impl },
      () => new Date('2026-09-12T10:00:00.000Z'),
    );
  const context = {
    accessToken: 'PIN-TOKEN',
    grantedScopes: [
      PINTEREST_SCOPES.profile,
      PINTEREST_SCOPES.boardsRead,
      PINTEREST_SCOPES.pinsWrite,
    ],
  };

  it('lists every board, following the bookmark', async () => {
    const { impl, state } = fakePinterest({ pages: 3 });
    const boards = await discovery(impl).discoverDestinations(context);
    expect(boards).toHaveLength(3);
    expect(state.boardPages).toBe(3);
    expect(boards[0]).toMatchObject({ kind: 'CHANNEL', displayName: 'Board 0' });
    expect(boards[0]?.capabilities?.postTypes.IMAGE.status).toBe('AVAILABLE');
  });

  it('looks up nothing without board access', async () => {
    const { impl, state } = fakePinterest();
    const boards = await discovery(impl).discoverDestinations({
      ...context,
      grantedScopes: [PINTEREST_SCOPES.pinsWrite],
    });
    expect(boards).toEqual([]);
    expect(state.boardPages).toBe(0);
  });

  it('records the account itself as somewhere you cannot pin', async () => {
    const { impl } = fakePinterest();
    const identity = await discovery(impl).discoverIdentity(context);
    expect(identity.displayName).toBe('@acmecoffee');
    expect(identity.capabilities?.postTypes.IMAGE.status).toBe('NOT_SUPPORTED');
    expect(identity.capabilities?.postTypes.IMAGE.reason).toContain('pick a board');
  });
});
