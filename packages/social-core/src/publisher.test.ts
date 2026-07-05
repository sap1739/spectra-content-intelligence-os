import type { PlatformCapability } from '@spectra/contracts';
import { describe, expect, it } from 'vitest';

import { UnsupportedCapabilityError, assertCapability } from './publisher';

function capability(overrides: Partial<PlatformCapability['supports']>): PlatformCapability {
  return {
    platform: 'LINKEDIN',
    capabilityVersion: '2026-07-01',
    recordedAt: '2026-07-01T00:00:00.000Z',
    mediaFormats: [],
    limits: { maxCharacters: null, maxHashtags: null, maxMediaPerPost: null },
    supports: {
      nativeScheduling: null,
      editAfterPublish: null,
      deletion: null,
      analytics: null,
      comments: null,
      webhooks: null,
      stories: null,
      drafts: null,
      ...overrides,
    },
    oauth: { scopes: [], refreshSupported: null, tokenLifetimeSeconds: null },
    notes: null,
  };
}

describe('assertCapability', () => {
  it('allows positively recorded capabilities', () => {
    expect(() => assertCapability(capability({ analytics: true }), 'analytics')).not.toThrow();
  });

  it('rejects explicitly unsupported capabilities', () => {
    expect(() => assertCapability(capability({ deletion: false }), 'deletion')).toThrow(
      UnsupportedCapabilityError,
    );
  });

  it('fails closed on unknown (null) capabilities', () => {
    expect(() => assertCapability(capability({}), 'comments')).toThrow(UnsupportedCapabilityError);
  });
});
