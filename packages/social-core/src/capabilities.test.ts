import { describe, expect, it } from 'vitest';

import {
  DECLARED_CAPABILITY_VERSION,
  allPlatformCapabilities,
  getPlatformCapability,
} from './capabilities';
import { SocialPublisherRegistry } from './registry';
import { validateVariant } from './validation';

describe('platform capabilities', () => {
  it('declares a versioned capability for every platform, honestly labelled', () => {
    const all = allPlatformCapabilities();
    expect(all.length).toBe(10);
    for (const cap of all) {
      expect(cap.capabilityVersion).toBe(DECLARED_CAPABILITY_VERSION);
      expect(cap.notes).toContain('Declared reference (not live-verified)');
    }
  });

  it('exposes known reference limits (X = 280 chars, 4 media)', () => {
    const x = getPlatformCapability('X');
    expect(x.limits.maxCharacters).toBe(280);
    expect(x.limits.maxMediaPerPost).toBe(4);
  });

  it('leaves unknown support flags as null (fail-closed)', () => {
    // X drafts support is not asserted → null, not false.
    expect(getPlatformCapability('X').supports.drafts).toBeNull();
  });
});

describe('validateVariant', () => {
  const x = getPlatformCapability('X');

  it('passes a within-limits post', () => {
    const result = validateVariant(x, { text: 'short post', mediaCount: 2, mediaKinds: ['IMAGE'] });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.capabilityVersion).toBe(DECLARED_CAPABILITY_VERSION);
  });

  it('flags text over the character limit', () => {
    const result = validateVariant(x, { text: 'a'.repeat(300) });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe('MAX_CHARACTERS');
  });

  it('flags too many media and unsupported kinds', () => {
    const result = validateVariant(x, { mediaCount: 5, mediaKinds: ['AUDIO'] });
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain('MAX_MEDIA');
    expect(codes).toContain('UNSUPPORTED_MEDIA_KIND');
  });

  it('enforces Instagram hashtag cap', () => {
    const ig = getPlatformCapability('INSTAGRAM');
    const result = validateVariant(ig, { hashtagCount: 31 });
    expect(result.issues.map((i) => i.code)).toContain('MAX_HASHTAGS');
  });
});

describe('SocialPublisherRegistry', () => {
  it('is empty in this phase — no platform is wired', () => {
    const registry = new SocialPublisherRegistry();
    expect(registry.wiredPlatforms()).toEqual([]);
    expect(registry.isWired('X')).toBe(false);
    expect(registry.getPublisher('X')).toBeUndefined();
  });
});
