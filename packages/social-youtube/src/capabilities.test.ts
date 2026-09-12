import { describe, expect, it } from 'vitest';

import { youTubeChannelCapabilities } from './capabilities';
import { YOUTUBE_SCOPES } from './constants';

/**
 * A channel's capability snapshot: what YouTube's API can publish, what it
 * cannot publish at all, and the two facts an operator must know before
 * trusting an upload — the audit restriction and the long-uploads status.
 */

const checkedAt = new Date('2026-09-12T10:00:00.000Z');
const snapshot = (over: Partial<Parameters<typeof youTubeChannelCapabilities>[0]> = {}) =>
  youTubeChannelCapabilities({
    grantedScopes: [YOUTUBE_SCOPES.upload, YOUTUBE_SCOPES.readonly],
    longUploadsStatus: 'allowed',
    projectAudited: true,
    checkedAt,
    ...over,
  });

describe('youTubeChannelCapabilities', () => {
  it('publishes video, and says the rest is not something YouTube offers', () => {
    const caps = snapshot();
    expect(caps.postTypes.VIDEO.status).toBe('AVAILABLE');
    expect(caps.postTypes.TEXT.status).toBe('NOT_SUPPORTED');
    expect(caps.postTypes.IMAGE.status).toBe('NOT_SUPPORTED');
    expect(caps.postTypes.DOCUMENT.status).toBe('NOT_SUPPORTED');
    expect(caps.postTypes.IMAGE.reason).toContain('custom thumbnail');
    expect(caps.checkedAt).toBe(checkedAt.toISOString());
  });

  it('names the missing scope rather than failing silently', () => {
    const caps = snapshot({ grantedScopes: [YOUTUBE_SCOPES.readonly] });
    expect(caps.postTypes.VIDEO.status).toBe('MISSING_PERMISSION');
    expect(caps.postTypes.VIDEO.reason).toContain('youtube.upload');
  });

  it('does not guess when YouTube reported no scopes', () => {
    expect(snapshot({ grantedScopes: null }).postTypes.VIDEO.status).toBe('UNKNOWN');
  });

  it("warns while the API project is unaudited, quoting Google's own rule", () => {
    const notes = snapshot({ projectAudited: false }).notes;
    expect(notes.some((note) => note.includes('restricted to private viewing mode'))).toBe(true);
    // Audited projects are not warned about something that does not apply.
    expect(snapshot().notes.some((note) => note.includes('private viewing mode'))).toBe(false);
  });

  it('passes on the long-uploads status YouTube reported', () => {
    const notes = snapshot({ longUploadsStatus: 'disallowed' }).notes;
    expect(notes.some((note) => note.includes('longer than 15 minutes'))).toBe(true);
    expect(snapshot().notes.some((note) => note.includes('longer than 15 minutes'))).toBe(false);
  });

  it('always states that the API has a daily quota', () => {
    expect(snapshot().notes.some((note) => note.includes('daily quota'))).toBe(true);
  });

  it('offers thumbnail formats as the image limits, since that is the only image', () => {
    expect(snapshot().limits.imageMimeTypes).toEqual(['image/jpeg', 'image/png']);
    expect(snapshot().limits.maxImages).toBe(1);
  });
});
