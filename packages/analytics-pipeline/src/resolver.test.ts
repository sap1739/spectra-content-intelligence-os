import {
  SOCIAL_PLATFORMS,
  analyticsProviderCapabilitySchema,
  type SocialPlatform,
} from '@spectra/contracts';
import type { SpectraPrismaClient } from '@spectra/database';
import { describe, expect, it } from 'vitest';

import {
  ANALYTICS_ADAPTER_PLATFORMS,
  createAnalyticsProviderResolver,
  describeAnalyticsCapability,
  isAnalyticsUnavailable,
  type AnalyticsTargetAccount,
} from './resolver';

/**
 * Resolution paths that need no database: platforms without an adapter,
 * missing configuration and missing credentials all end in an honest
 * AnalyticsUnavailable — never a provider that pretends.
 */

const noDatabase = new Proxy({} as SpectraPrismaClient, {
  get() {
    throw new Error('the database must not be touched on these paths');
  },
});

const account = (
  platform: SocialPlatform,
  overrides: Partial<AnalyticsTargetAccount> = {},
): AnalyticsTargetAccount => ({
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  platform,
  kind: 'PROFILE',
  externalAccountId: 'external',
  displayName: 'Account',
  encryptedToken: null,
  connectionId: null,
  ...overrides,
});

describe('analytics provider resolution', () => {
  const resolve = createAnalyticsProviderResolver({ prisma: noDatabase, ring: undefined });

  it('platforms without an adapter are unavailable with the catalog reason', async () => {
    for (const platform of ['TIKTOK', 'X', 'THREADS', 'PINTEREST', 'EMAIL'] as const) {
      const resolved = await resolve(account(platform));
      expect(isAnalyticsUnavailable(resolved), platform).toBe(true);
      if (isAnalyticsUnavailable(resolved)) {
        expect(resolved.errorCode).toBe('UNSUPPORTED');
        expect(resolved.reason).toContain('No analytics were fetched');
      }
    }
  });

  it('an adapter the worker was not configured with is UNCONFIGURED', async () => {
    for (const platform of ['YOUTUBE', 'LINKEDIN', 'FACEBOOK', 'INSTAGRAM'] as const) {
      const resolved = await resolve(account(platform));
      expect(isAnalyticsUnavailable(resolved) && resolved.availability, platform).toBe(
        'UNCONFIGURED',
      );
    }
  });

  it('a WordPress site with no stored application password is NOT_CONNECTED', async () => {
    const resolved = await resolve(account('WORDPRESS', { kind: 'SITE' }));
    expect(isAnalyticsUnavailable(resolved) && resolved.availability).toBe('NOT_CONNECTED');
  });

  it('describes every platform with a schema-valid capability', () => {
    for (const platform of SOCIAL_PLATFORMS) {
      const capability = describeAnalyticsCapability({
        platform,
        grantedScopes: null,
        configured: true,
      });
      expect(analyticsProviderCapabilitySchema.parse(capability), platform).toBeTruthy();
      expect(capability.implemented).toBe(ANALYTICS_ADAPTER_PLATFORMS.has(platform));
    }
  });
});
