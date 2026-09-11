import { describe, expect, it } from 'vitest';

import {
  facebookPageCapabilities,
  facebookProfileCapabilities,
  instagramCapabilities,
} from './capabilities';

const NOW = new Date('2026-09-11T12:00:00Z');
const PAGE_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'];
const ALL = [...PAGE_SCOPES, 'instagram_basic', 'instagram_content_publish'];
const CREATOR = ['ANALYZE', 'ADVERTISE', 'MODERATE', 'CREATE_CONTENT', 'MANAGE'];

describe('facebookPageCapabilities', () => {
  it('offers text and photo posts to a Page you can create content on', () => {
    const caps = facebookPageCapabilities({
      grantedScopes: ALL,
      tasks: CREATOR,
      hasToken: true,
      checkedAt: NOW,
    });
    expect(caps.postTypes.TEXT.status).toBe('AVAILABLE');
    expect(caps.postTypes.IMAGE.status).toBe('AVAILABLE');
    expect(caps.postTypes.VIDEO.status).toBe('NOT_IMPLEMENTED');
    expect(caps.postTypes.DOCUMENT.status).toBe('NOT_SUPPORTED');
    expect(caps.limits.imageMimeTypes).toContain('image/png');
  });

  it('names a missing permission', () => {
    const caps = facebookPageCapabilities({
      grantedScopes: ['pages_show_list', 'pages_read_engagement'],
      tasks: CREATOR,
      hasToken: true,
      checkedAt: NOW,
    });
    expect(caps.postTypes.TEXT).toMatchObject({ status: 'MISSING_PERMISSION' });
    expect(caps.postTypes.TEXT.reason).toContain('pages_manage_posts');
  });

  it('says so when your Page role cannot create content, or no Page token was issued', () => {
    const analyst = facebookPageCapabilities({
      grantedScopes: ALL,
      tasks: ['ANALYZE'],
      hasToken: true,
      checkedAt: NOW,
    });
    expect(analyst.postTypes.TEXT.status).toBe('MISSING_PERMISSION');
    expect(analyst.postTypes.TEXT.reason).toContain('Create content');
    const noToken = facebookPageCapabilities({
      grantedScopes: ALL,
      tasks: null,
      hasToken: false,
      checkedAt: NOW,
    });
    expect(noToken.postTypes.IMAGE.status).toBe('MISSING_PERMISSION');
  });

  it('does not guess when Meta reported no permissions', () => {
    const caps = facebookPageCapabilities({
      grantedScopes: null,
      tasks: CREATOR,
      hasToken: true,
      checkedAt: NOW,
    });
    expect(caps.postTypes.TEXT.status).toBe('UNKNOWN');
  });
});

describe('instagramCapabilities', () => {
  it('offers single-image posts to an eligible professional account, never text-only', () => {
    const caps = instagramCapabilities({
      grantedScopes: ALL,
      eligible: true,
      hasToken: true,
      checkedAt: NOW,
    });
    expect(caps.postTypes.IMAGE.status).toBe('AVAILABLE');
    expect(caps.postTypes.TEXT.status).toBe('NOT_SUPPORTED');
    expect(caps.postTypes.VIDEO.status).toBe('NOT_IMPLEMENTED');
    expect(caps.limits.imageMimeTypes).toEqual(['image/jpeg']);
  });

  it('marks an account Facebook does not report as professional as unsupported, with the reason', () => {
    const caps = instagramCapabilities({
      grantedScopes: ALL,
      eligible: false,
      hasToken: true,
      checkedAt: NOW,
    });
    for (const support of Object.values(caps.postTypes)) {
      expect(support.status).toBe('NOT_SUPPORTED');
      expect(support.reason).toMatch(/professional \(Business or Creator\)/);
    }
  });

  it('names a missing Instagram permission', () => {
    const caps = instagramCapabilities({
      grantedScopes: [...PAGE_SCOPES, 'instagram_basic'],
      eligible: true,
      hasToken: true,
      checkedAt: NOW,
    });
    expect(caps.postTypes.IMAGE.status).toBe('MISSING_PERMISSION');
    expect(caps.postTypes.IMAGE.reason).toContain('instagram_content_publish');
  });
});

describe('facebookProfileCapabilities', () => {
  it('records that Facebook does not let apps post to personal profiles', () => {
    const caps = facebookProfileCapabilities(NOW);
    for (const support of Object.values(caps.postTypes)) {
      expect(support.status).toBe('NOT_SUPPORTED');
      expect(support.reason).toContain('personal profiles');
    }
  });
});
