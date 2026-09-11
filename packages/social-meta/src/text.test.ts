import type { PublishMediaInput } from '@spectra/social-core';
import { describe, expect, it } from 'vitest';

import { metaPostText, validateFacebookPost, validateInstagramPost } from './text';

const image = (overrides: Partial<PublishMediaInput> = {}): PublishMediaInput => ({
  assetId: 'asset-1',
  kind: 'IMAGE',
  mimeType: 'image/jpeg',
  sizeBytes: 200_000,
  widthPx: 1080,
  heightPx: 1080,
  altText: null,
  load: async () => Buffer.alloc(0),
  ...overrides,
});
const post = (body: string, media?: PublishMediaInput[]) => ({
  idempotencyKey: 'k',
  title: 'Q3 results',
  body,
  ...(media ? { media } : {}),
});
const codes = (issues: Array<{ code: string }>) => issues.map((issue) => issue.code);

describe('metaPostText', () => {
  it('flattens HTML and falls back to the title', () => {
    expect(metaPostText({ title: 'T', body: '<p>One</p><p>Two &amp; three</p>' })).toBe(
      'One\nTwo & three',
    );
    expect(metaPostText({ title: 'Only the title', body: '' })).toBe('Only the title');
  });
});

describe('validateFacebookPost', () => {
  it('accepts a text post and a supported photo', () => {
    expect(validateFacebookPost(post('Hello'))).toEqual([]);
    expect(validateFacebookPost(post('', [image({ mimeType: 'image/png' })]))).toEqual([]);
  });

  it('refuses an empty post and one over the character limit', () => {
    expect(codes(validateFacebookPost({ idempotencyKey: 'k', title: '', body: '' }))).toEqual([
      'EMPTY_POST',
    ]);
    expect(codes(validateFacebookPost(post('x'.repeat(63_207))))).toEqual(['MAX_CHARACTERS']);
  });

  it('refuses formats Page Photos do not accept, files over 10 MB, and more than one photo', () => {
    expect(codes(validateFacebookPost(post('x', [image({ mimeType: 'image/webp' })])))).toEqual([
      'UNSUPPORTED_IMAGE_FORMAT',
    ]);
    expect(
      codes(validateFacebookPost(post('x', [image({ sizeBytes: 11 * 1024 * 1024 })]))),
    ).toEqual(['IMAGE_FILE_TOO_LARGE']);
    expect(codes(validateFacebookPost(post('x', [image(), image()])))).toEqual(['TOO_MANY_MEDIA']);
  });
});

describe('validateInstagramPost', () => {
  it('requires an image — Instagram has no text-only posts', () => {
    expect(codes(validateInstagramPost(post('Just words')))).toEqual(['MEDIA_REQUIRED']);
  });

  it('accepts JPEG only', () => {
    expect(codes(validateInstagramPost(post('x', [image({ mimeType: 'image/png' })])))).toEqual([
      'UNSUPPORTED_IMAGE_FORMAT',
    ]);
  });

  it.each([
    [1080, 1080],
    [1080, 1350],
    [1910, 1000],
  ])('accepts a %i×%i image', (widthPx, heightPx) => {
    expect(validateInstagramPost(post('x', [image({ widthPx, heightPx })]))).toEqual([]);
  });

  it.each([
    [1080, 1400],
    [1920, 1000],
  ])('refuses a %i×%i image — outside 4:5 to 1.91:1', (widthPx, heightPx) => {
    expect(codes(validateInstagramPost(post('x', [image({ widthPx, heightPx })])))).toEqual([
      'ASPECT_RATIO',
    ]);
  });

  it('refuses an image whose dimensions are unknown, rather than guessing', () => {
    expect(
      codes(validateInstagramPost(post('x', [image({ widthPx: null, heightPx: null })]))),
    ).toEqual(['ASPECT_RATIO_UNKNOWN']);
  });

  it('enforces the size, caption, hashtag, mention and alt-text limits', () => {
    expect(
      codes(validateInstagramPost(post('x', [image({ sizeBytes: 9 * 1024 * 1024 })]))),
    ).toEqual(['IMAGE_FILE_TOO_LARGE']);
    expect(codes(validateInstagramPost(post('x'.repeat(2201), [image()])))).toEqual([
      'MAX_CHARACTERS',
    ]);
    const tags = (n: number) => Array.from({ length: n }, (_, i) => `#tag${i}`).join(' ');
    expect(validateInstagramPost(post(tags(30), [image()]))).toEqual([]);
    expect(codes(validateInstagramPost(post(tags(31), [image()])))).toEqual(['TOO_MANY_HASHTAGS']);
    const mentions = Array.from({ length: 21 }, (_, i) => `@user${i}`).join(' ');
    expect(codes(validateInstagramPost(post(mentions, [image()])))).toEqual(['TOO_MANY_MENTIONS']);
    expect(codes(validateInstagramPost(post('x', [image({ altText: 'a'.repeat(1001) })])))).toEqual(
      ['ALT_TEXT_TOO_LONG'],
    );
  });
});
