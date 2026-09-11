import { SOCIAL_OAUTH_PLATFORM_IDS } from '@spectra/config';
import { OAUTH_PLATFORMS, SOCIAL_PLATFORMS } from '@spectra/contracts';
import { describe, expect, it } from 'vitest';

import { allOAuthDefinitions, getOAuthDefinition } from './definitions';

const sorted = (values: readonly string[]) => [...values].sort();

describe('declared OAuth platform definitions', () => {
  it('cover exactly the OAuth platforms, and the env schema agrees', () => {
    expect(sorted(allOAuthDefinitions().map((d) => d.platform))).toEqual(sorted(OAUTH_PLATFORMS));
    expect(sorted(SOCIAL_OAUTH_PLATFORM_IDS)).toEqual(sorted(OAUTH_PLATFORMS));
  });

  it('never present WordPress or email as OAuth platforms', () => {
    for (const platform of OAUTH_PLATFORMS) expect(SOCIAL_PLATFORMS).toContain(platform);
    expect(OAUTH_PLATFORMS).not.toContain('WORDPRESS');
    expect(OAUTH_PLATFORMS).not.toContain('EMAIL');
  });

  it('declare only https endpoints', () => {
    for (const definition of allOAuthDefinitions()) {
      const urls = [
        definition.authorizationUrl,
        definition.tokenUrl,
        definition.docsUrl,
        ...(definition.revocationUrl ? [definition.revocationUrl] : []),
      ];
      for (const url of urls) expect(url.startsWith('https://'), url).toBe(true);
    }
  });

  it('explain every approval requirement', () => {
    for (const definition of allOAuthDefinitions()) {
      if (definition.approval.required) {
        expect(definition.approval.notes.length, definition.platform).toBeGreaterThan(0);
      }
    }
  });

  it('request by default the scopes their publish capability needs', () => {
    for (const definition of allOAuthDefinitions()) {
      for (const scope of definition.capabilityScopes.publish ?? []) {
        expect(definition.defaultScopes, definition.platform).toContain(scope);
      }
    }
  });

  it('require PKCE where the platform does', () => {
    expect(getOAuthDefinition('X').pkce).toBe('required');
    expect(getOAuthDefinition('X').defaultScopes).toContain('offline.access');
  });

  it('mark the Meta family as reconnect-only: no standard refresh grant', () => {
    const reconnectOnly = allOAuthDefinitions()
      .filter((d) => d.refresh === 'none')
      .map((d) => d.platform);
    expect(sorted(reconnectOnly)).toEqual(['FACEBOOK', 'INSTAGRAM', 'THREADS']);
  });

  it('describe Meta: GET token requests, a long-lived exchange, and reviewed products', () => {
    const meta = getOAuthDefinition('FACEBOOK');
    expect(meta.tokenRequestMethod).toBe('GET');
    expect(meta.longLivedExchange).toBe('fb_exchange_token');
    expect(meta.defaultScopes).toContain('instagram_content_publish');
    expect(meta.products?.every((p) => p.reviewRequired)).toBe(true);
    expect(meta.authorizationUrl).toContain('/v26.0/');
  });
});
