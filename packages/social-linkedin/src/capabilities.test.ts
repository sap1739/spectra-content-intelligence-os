import { describe, expect, it } from 'vitest';

import { linkedInAccountCapabilities } from './capabilities';

const checkedAt = new Date('2026-09-11T10:00:00.000Z');

describe('LinkedIn account capabilities', () => {
  it('lets a member with w_member_social post text and one image — and says video and documents are not implemented', () => {
    const caps = linkedInAccountCapabilities({
      kind: 'PROFILE',
      grantedScopes: ['openid', 'profile', 'w_member_social'],
      checkedAt,
    });
    expect(caps.postTypes.TEXT.status).toBe('AVAILABLE');
    expect(caps.postTypes.IMAGE.status).toBe('AVAILABLE');
    expect(caps.postTypes.VIDEO.status).toBe('NOT_IMPLEMENTED');
    expect(caps.postTypes.DOCUMENT.status).toBe('NOT_IMPLEMENTED');
    expect(caps.postTypes.VIDEO.reason).toMatch(/LinkedIn supports video/);
    expect(caps.limits).toEqual({
      maxCharacters: 3000,
      maxImages: 1,
      imageMimeTypes: ['image/jpeg', 'image/png', 'image/gif'],
    });
    expect(caps.checkedAt).toBe('2026-09-11T10:00:00.000Z');
    // Member tokens cannot check image processing; the snapshot says so.
    expect(caps.notes.join(' ')).toMatch(/member-only token/);
  });

  it('names the missing scope and product for a member', () => {
    const caps = linkedInAccountCapabilities({
      kind: 'PROFILE',
      grantedScopes: ['openid', 'profile'],
      checkedAt,
    });
    expect(caps.postTypes.TEXT.status).toBe('MISSING_PERMISSION');
    expect(caps.postTypes.TEXT.reason).toContain('w_member_social');
    expect(caps.postTypes.TEXT.reason).toContain('Share on LinkedIn');
  });

  it('requires the reviewed Community Management product for a page', () => {
    const caps = linkedInAccountCapabilities({
      kind: 'PAGE',
      grantedScopes: ['openid', 'profile', 'w_member_social', 'r_organization_admin'],
      checkedAt,
    });
    expect(caps.postTypes.IMAGE.status).toBe('MISSING_PERMISSION');
    expect(caps.postTypes.IMAGE.reason).toContain('w_organization_social');
    expect(caps.postTypes.IMAGE.reason).toContain('Community Management');
    expect(caps.notes).toEqual([]);
  });

  it('does not guess when LinkedIn did not report scopes', () => {
    const caps = linkedInAccountCapabilities({ kind: 'PAGE', grantedScopes: null, checkedAt });
    expect(caps.postTypes.TEXT.status).toBe('UNKNOWN');
  });
});
