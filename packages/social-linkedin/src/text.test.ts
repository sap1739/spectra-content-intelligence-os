import type { PublishMediaInput } from '@spectra/social-core';
import { describe, expect, it } from 'vitest';

import { linkedInPostText, toLittleText, toPlainText, validateLinkedInPost } from './text';

const image = (overrides: Partial<PublishMediaInput> = {}): PublishMediaInput => ({
  assetId: 'asset-1',
  kind: 'IMAGE',
  mimeType: 'image/png',
  sizeBytes: 1_000,
  widthPx: 1200,
  heightPx: 627,
  altText: null,
  load: async () => Buffer.from(''),
  ...overrides,
});

const post = (body: string, media?: PublishMediaInput[]) => ({
  idempotencyKey: 'k',
  title: 'Title',
  body,
  ...(media ? { media } : {}),
});

describe('little text (LinkedIn commentary format)', () => {
  it('escapes every reserved character LinkedIn lists', () => {
    expect(toLittleText('a|b{c}d@e[f]g(h)i<j>k\\l*m_n~o')).toBe(
      'a\\|b\\{c\\}d\\@e\\[f\\]g\\(h\\)i\\<j\\>k\\\\l\\*m\\_n\\~o',
    );
  });

  it('keeps hashtags as native hashtag elements', () => {
    expect(toLittleText('Launch day #launch #AI2026')).toBe('Launch day #launch #AI2026');
    expect(toLittleText('#café 🚀')).toBe('#café 🚀');
  });

  it('escapes a # that does not start a hashtag', () => {
    expect(toLittleText('C# and # alone and #')).toBe('C\\# and \\# alone and \\#');
  });

  it('only letters and digits form the hashtag; the rest is escaped text', () => {
    expect(toLittleText('#my_tag')).toBe('#my\\_tag');
  });

  it('escapes realistic copy and normalises line endings', () => {
    expect(toLittleText('Save 20% (today only)\r\nEmail me@acme.com')).toBe(
      'Save 20% \\(today only\\)\nEmail me\\@acme.com',
    );
  });
});

describe('plain text for LinkedIn', () => {
  it('passes plain text through', () => {
    expect(toPlainText('  Hello world  ')).toBe('Hello world');
  });

  it('flattens HTML written for other channels', () => {
    expect(toPlainText('<p>Hello <strong>world</strong></p><p>Second &amp; last</p>')).toBe(
      'Hello world\nSecond & last',
    );
    expect(toPlainText('<ul><li>One</li><li>Two</li></ul>')).toBe('• One\n• Two');
  });

  it('falls back to the title when there is no body', () => {
    expect(linkedInPostText({ title: 'Title only', body: '' })).toBe('Title only');
  });
});

describe('validateLinkedInPost', () => {
  it('needs text', () => {
    const issues = validateLinkedInPost({ idempotencyKey: 'k', title: '', body: '' });
    expect(issues.map((i) => i.code)).toEqual(['EMPTY_TEXT']);
  });

  it('allows exactly 3,000 characters and refuses 3,001', () => {
    expect(validateLinkedInPost(post('a'.repeat(3000)))).toEqual([]);
    const [issue] = validateLinkedInPost(post('a'.repeat(3001)));
    expect(issue?.code).toBe('MAX_CHARACTERS');
    expect(issue?.message).toContain('3,000');
    expect(issue?.message).toContain('3,001');
  });

  it('counts characters, not UTF-16 code units', () => {
    expect(validateLinkedInPost(post('🚀'.repeat(3000)))).toEqual([]);
  });

  it('allows one image and refuses more', () => {
    expect(validateLinkedInPost(post('Hi', [image()]))).toEqual([]);
    const codes = validateLinkedInPost(post('Hi', [image(), image({ assetId: 'b' })])).map(
      (i) => i.code,
    );
    expect(codes).toContain('TOO_MANY_MEDIA');
  });

  it('refuses formats LinkedIn does not accept', () => {
    const [issue] = validateLinkedInPost(post('Hi', [image({ mimeType: 'image/webp' })]));
    expect(issue?.code).toBe('UNSUPPORTED_IMAGE_FORMAT');
    expect(issue?.message).toContain('image/webp');
  });

  it('refuses images at or over the documented pixel limit', () => {
    const [issue] = validateLinkedInPost(post('Hi', [image({ widthPx: 7000, heightPx: 6000 })]));
    expect(issue?.code).toBe('IMAGE_TOO_LARGE');
  });

  it("says when a limit is Spectra's rather than LinkedIn's", () => {
    const [issue] = validateLinkedInPost(post('Hi', [image({ sizeBytes: 21 * 1024 * 1024 })]));
    expect(issue?.code).toBe('IMAGE_FILE_TOO_LARGE');
    expect(issue?.message).toMatch(/Spectra limit/);
  });

  it('leaves unsupported media KINDS to the executor, which reports UNSUPPORTED', () => {
    expect(
      validateLinkedInPost(post('Hi', [image({ kind: 'VIDEO', mimeType: 'video/mp4' })])),
    ).toEqual([]);
  });
});
