import { SOCIAL_PLATFORMS } from '@spectra/contracts';
import { describe, expect, it } from 'vitest';

import {
  AccountDiscoveryRegistry,
  accountDiscoveryRegistry,
  sanitizeDiscoveryMetadata,
  type AccountDiscoveryPort,
} from './discovery';

describe('account discovery registry', () => {
  it('has no platform wired in Phase 6C', () => {
    for (const platform of SOCIAL_PLATFORMS) {
      expect(accountDiscoveryRegistry.isWired(platform)).toBe(false);
    }
  });

  it('registers and unregisters an adapter per platform', async () => {
    const registry = new AccountDiscoveryRegistry();
    const adapter: AccountDiscoveryPort = {
      platform: 'LINKEDIN',
      adapterVersion: 'test',
      discoverIdentity: async () => ({ externalId: 'u1', displayName: 'U', kind: 'PROFILE' }),
      discoverDestinations: async () => [],
      discoverCapabilities: async () => ({
        grantedScopes: null,
        capabilityVersion: 't',
        notes: [],
      }),
    };
    registry.register(adapter);
    expect(registry.isWired('LINKEDIN')).toBe(true);
    expect(registry.isWired('X')).toBe(false);
    expect(
      await registry
        .get('LINKEDIN')
        ?.discoverDestinations({ accessToken: 't', grantedScopes: null }),
    ).toEqual([]);
    registry.unregister('LINKEDIN');
    expect(registry.isWired('LINKEDIN')).toBe(false);
  });
});

describe('sanitizeDiscoveryMetadata', () => {
  it('keeps bounded primitives only', () => {
    const clean = sanitizeDiscoveryMetadata({
      followers: 1200,
      verified: true,
      handle: 'acme',
      avatar: null,
      nested: { accessToken: 'leak' },
      list: ['a'],
      'bad key': 'x',
      infinite: Number.POSITIVE_INFINITY,
    });
    expect(clean).toEqual({ followers: 1200, verified: true, handle: 'acme', avatar: null });
  });

  it('truncates long strings and caps the key count', () => {
    const many = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`k${i}`, 'v'.repeat(400)]),
    );
    const clean = sanitizeDiscoveryMetadata(many);
    expect(Object.keys(clean)).toHaveLength(20);
    expect((clean['k0'] as string).length).toBe(256);
  });

  it('returns an empty object for non-objects', () => {
    expect(sanitizeDiscoveryMetadata('x')).toEqual({});
    expect(sanitizeDiscoveryMetadata(null)).toEqual({});
    expect(sanitizeDiscoveryMetadata([1, 2])).toEqual({});
  });
});
