import type { PublishInput, PublishMediaInput } from '@spectra/social-core';
import { describe, expect, it } from 'vitest';

import { resolveYouTubeMetadata, validateYouTubeVideo, videoResource } from './text';

/**
 * What YouTube would refuse, refused here first — and the defaults when an
 * operator supplied no video details at all.
 */

const video = (over: Partial<PublishMediaInput> = {}): PublishMediaInput => ({
  assetId: 'asset-1',
  kind: 'VIDEO',
  mimeType: 'video/mp4',
  sizeBytes: 4 * 1024 * 1024,
  widthPx: 1920,
  heightPx: 1080,
  altText: null,
  load: async () => Buffer.alloc(0),
  ...over,
});

const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  idempotencyKey: 'entry-1',
  title: 'Quarterly roast report',
  body: 'What changed this quarter.',
  media: [video()],
  ...over,
});

const details = (over: Record<string, unknown> = {}) => ({
  youtube: {
    title: 'Quarterly roast report',
    description: 'What changed this quarter.',
    tags: ['coffee'],
    privacyStatus: 'public',
    madeForKids: false,
    notifySubscribers: true,
    ...over,
  },
});

const codes = (value: PublishInput) => validateYouTubeVideo(value).map((issue) => issue.code);

describe('validateYouTubeVideo', () => {
  it('accepts a video with the details an operator set', () => {
    expect(validateYouTubeVideo(input({ metadata: details() }))).toEqual([]);
  });

  it('needs a video: YouTube has nothing else to publish', () => {
    expect(codes(input({ media: [] }))).toContain('VIDEO_REQUIRED');
    expect(codes(input({ media: [video({ kind: 'IMAGE', mimeType: 'image/png' })] }))).toContain(
      'NOT_A_VIDEO',
    );
    expect(codes(input({ media: [video(), video({ assetId: 'asset-2' })] }))).toContain(
      'TOO_MANY_MEDIA',
    );
  });

  it('refuses a file that is not video, or larger than Spectra uploads', () => {
    expect(codes(input({ media: [video({ mimeType: 'application/zip' })] }))).toContain(
      'UNSUPPORTED_VIDEO_FORMAT',
    );
    expect(codes(input({ media: [video({ sizeBytes: 600 * 1024 * 1024 })] }))).toContain(
      'VIDEO_TOO_LARGE',
    );
  });

  it('enforces the title limits YouTube documents', () => {
    expect(codes(input({ title: 'x'.repeat(101), media: [video()] }))).toContain('TITLE_TOO_LONG');
    // `<this>` reads as markup and is flattened away; `<3` is real text.
    expect(codes(input({ title: 'Coffee <3 roasting' }))).toContain('TITLE_CHARACTERS');
    expect(codes(input({ title: '   ' }))).toContain('TITLE_REQUIRED');
  });

  it('measures the description in BYTES, as YouTube does', () => {
    // 2,000 euro signs are 2,000 characters but 6,000 UTF-8 bytes.
    const long = '€'.repeat(2000);
    expect([...long].length).toBeLessThan(5000);
    expect(codes(input({ body: long }))).toContain('DESCRIPTION_TOO_LONG');
    expect(codes(input({ body: 'a < b' }))).toContain('DESCRIPTION_CHARACTERS');
  });

  it("reports the operator's own video details as theirs when they are wrong", () => {
    const issues = validateYouTubeVideo(input({ metadata: details({ title: 'x'.repeat(101) }) }));
    expect(issues.some((issue) => issue.code.startsWith('METADATA_'))).toBe(true);
    expect(issues[0]?.message).toContain('Video details:');
  });

  it('counts the combined tags against YouTube 500-character limit', () => {
    const issues = validateYouTubeVideo(
      input({ metadata: details({ tags: Array.from({ length: 20 }, () => 'a'.repeat(30)) }) }),
    );
    expect(issues.some((issue) => issue.message.includes('500 characters of tags'))).toBe(true);
  });

  it('checks a custom thumbnail against thumbnails.set', () => {
    const thumbnail = (over: Partial<PublishMediaInput> = {}) =>
      video({ assetId: 'thumb', kind: 'IMAGE', mimeType: 'image/jpeg', sizeBytes: 1024, ...over });
    expect(validateYouTubeVideo(input({ thumbnail: thumbnail() }))).toEqual([]);
    expect(codes(input({ thumbnail: thumbnail({ mimeType: 'image/webp' }) }))).toContain(
      'UNSUPPORTED_THUMBNAIL_FORMAT',
    );
    expect(codes(input({ thumbnail: thumbnail({ sizeBytes: 3 * 1024 * 1024 }) }))).toContain(
      'THUMBNAIL_TOO_LARGE',
    );
  });
});

describe('resolveYouTubeMetadata', () => {
  it('falls back to the content item, and never to a wider privacy than asked', () => {
    const { metadata, issues } = resolveYouTubeMetadata(input());
    expect(issues).toEqual([]);
    expect(metadata.title).toBe('Quarterly roast report');
    expect(metadata.description).toBe('What changed this quarter.');
    expect(metadata.privacyStatus).toBe('private');
    expect(metadata.madeForKids).toBe(false);
  });

  it('flattens an HTML body into a plain description', () => {
    const { metadata } = resolveYouTubeMetadata(input({ body: '<p>One</p><p>Two</p>' }));
    expect(metadata.description).toBe('One\nTwo');
  });

  it("keeps the operator's details when they parse", () => {
    const { metadata } = resolveYouTubeMetadata(
      input({ metadata: details({ privacyStatus: 'unlisted', categoryId: '22' }) }),
    );
    expect(metadata.privacyStatus).toBe('unlisted');
    expect(metadata.categoryId).toBe('22');
  });
});

describe('videoResource', () => {
  it('builds the snippet and status videos.insert documents', () => {
    const { metadata } = resolveYouTubeMetadata(
      input({ metadata: details({ categoryId: '22', madeForKids: true }) }),
    );
    expect(videoResource(metadata)).toEqual({
      snippet: {
        title: 'Quarterly roast report',
        description: 'What changed this quarter.',
        tags: ['coffee'],
        categoryId: '22',
      },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: true },
    });
  });

  it('omits what was not set rather than sending empty values', () => {
    const { metadata } = resolveYouTubeMetadata(input({ title: 'Bare', body: '' }));
    const resource = videoResource(metadata) as { snippet: Record<string, unknown> };
    expect(resource.snippet).toEqual({ title: 'Bare' });
  });
});
