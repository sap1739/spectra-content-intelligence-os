import { describe, expect, it } from 'vitest';

import {
  EnvValidationError,
  apiEnvSchema,
  loadEnv,
  socialKeyRingFromEnv,
  workerEnvSchema,
} from './env';

const validApiEnv = {
  DATABASE_URL: 'postgresql://spectra:secret@localhost:5432/spectra',
  REDIS_URL: 'redis://localhost:6379',
  // Object storage is required on the API since Phase 3F (media rendering).
  STORAGE_ENDPOINT: 'http://localhost:9000',
  STORAGE_ACCESS_KEY: 'spectra-local',
  STORAGE_SECRET_KEY: 'spectra_local_dev',
  STORAGE_BUCKET: 'spectra-dev',
};

describe('loadEnv', () => {
  it('parses a valid API environment and applies defaults', () => {
    const env = loadEnv(apiEnvSchema, validApiEnv as NodeJS.ProcessEnv);
    expect(env.API_PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('coerces numeric values from strings', () => {
    const env = loadEnv(apiEnvSchema, {
      ...validApiEnv,
      API_PORT: '8080',
    } as NodeJS.ProcessEnv);
    expect(env.API_PORT).toBe(8080);
  });

  it('rejects a non-postgres DATABASE_URL and never echoes the value', () => {
    const source = { ...validApiEnv, DATABASE_URL: 'mysql://nope' } as NodeJS.ProcessEnv;
    try {
      loadEnv(apiEnvSchema, source);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).not.toContain('mysql://nope');
    }
  });

  it('rejects out-of-range worker configuration', () => {
    expect(() =>
      loadEnv(workerEnvSchema, {
        REDIS_URL: 'redis://localhost:6379',
        WORKER_HEARTBEAT_INTERVAL_MS: '10',
      } as NodeJS.ProcessEnv),
    ).toThrow(EnvValidationError);
  });
});

/** Asserts a validation failure that names `key` and never echoes `secret`. */
function expectEnvError(source: Record<string, string>, key: string, secret?: string): void {
  try {
    loadEnv(apiEnvSchema, source as NodeJS.ProcessEnv);
    expect.unreachable('should have thrown');
  } catch (error) {
    expect(error).toBeInstanceOf(EnvValidationError);
    const message = (error as Error).message;
    expect(message).toContain(key);
    if (secret) expect(message).not.toContain(secret);
  }
}

describe('social credential key rotation (ADR-0034)', () => {
  const activeKey = Buffer.alloc(32, 1).toString('base64');
  const retiredKey = Buffer.alloc(32, 2).toString('base64');

  it('rejects an encryption key that is not 32 bytes, without echoing it', () => {
    const shortKey = Buffer.alloc(16, 3).toString('base64');
    expectEnvError(
      { ...validApiEnv, SOCIAL_TOKEN_ENCRYPTION_KEY: shortKey },
      'SOCIAL_TOKEN_ENCRYPTION_KEY',
      shortKey,
    );
  });

  it('defaults the key id, so existing ciphertexts stay readable', () => {
    const env = loadEnv(apiEnvSchema, {
      ...validApiEnv,
      SOCIAL_TOKEN_ENCRYPTION_KEY: activeKey,
    } as NodeJS.ProcessEnv);
    expect(socialKeyRingFromEnv(env)).toEqual({
      activeKeyId: 'social-v1',
      keys: { 'social-v1': activeKey },
    });
  });

  it('builds a ring with the active key plus decrypt-only retired keys', () => {
    const env = loadEnv(apiEnvSchema, {
      ...validApiEnv,
      SOCIAL_TOKEN_ENCRYPTION_KEY: activeKey,
      SOCIAL_TOKEN_ENCRYPTION_KEY_ID: 'social-v2',
      SOCIAL_TOKEN_ENCRYPTION_RETIRED_KEYS: `social-v1:${retiredKey}`,
    } as NodeJS.ProcessEnv);
    expect(socialKeyRingFromEnv(env)).toEqual({
      activeKeyId: 'social-v2',
      keys: { 'social-v1': retiredKey, 'social-v2': activeKey },
    });
  });

  it('returns no ring when no key is configured', () => {
    const env = loadEnv(apiEnvSchema, validApiEnv as NodeJS.ProcessEnv);
    expect(socialKeyRingFromEnv(env)).toBeUndefined();
  });

  it('rejects a malformed retired key without echoing it', () => {
    const badValue = 'c2hvcnQtc2VjcmV0';
    expectEnvError(
      {
        ...validApiEnv,
        SOCIAL_TOKEN_ENCRYPTION_KEY: activeKey,
        SOCIAL_TOKEN_ENCRYPTION_RETIRED_KEYS: `social-v0:${badValue}`,
      },
      'SOCIAL_TOKEN_ENCRYPTION_RETIRED_KEYS',
      badValue,
    );
  });

  it('rejects a retired key id equal to the active one', () => {
    expectEnvError(
      {
        ...validApiEnv,
        SOCIAL_TOKEN_ENCRYPTION_KEY: activeKey,
        SOCIAL_TOKEN_ENCRYPTION_RETIRED_KEYS: `social-v1:${retiredKey}`,
      },
      'SOCIAL_TOKEN_ENCRYPTION_RETIRED_KEYS',
      retiredKey,
    );
  });

  it('validates retired keys in the worker too', () => {
    expect(() =>
      loadEnv(workerEnvSchema, {
        REDIS_URL: 'redis://localhost:6379',
        DATABASE_URL: 'postgresql://spectra:secret@localhost:5432/spectra',
        STORAGE_ENDPOINT: 'http://localhost:9000',
        STORAGE_ACCESS_KEY: 'a',
        STORAGE_SECRET_KEY: 'b',
        STORAGE_BUCKET: 'c',
        SOCIAL_TOKEN_ENCRYPTION_RETIRED_KEYS: `social-v0:${retiredKey}`,
      } as NodeJS.ProcessEnv),
    ).toThrow(/SOCIAL_TOKEN_ENCRYPTION_RETIRED_KEYS/);
  });
});

describe('social OAuth configuration (ADR-0034)', () => {
  const linkedIn = {
    SOCIAL_OAUTH_LINKEDIN_CLIENT_ID: 'li-id-VALUE',
    SOCIAL_OAUTH_LINKEDIN_CLIENT_SECRET: 'li-secret-VALUE',
  };

  it('accepts a deployment with no OAuth configured', () => {
    const env = loadEnv(apiEnvSchema, validApiEnv as NodeJS.ProcessEnv);
    expect(env.SOCIAL_OAUTH_STATE_TTL_SECONDS).toBe(600);
    expect(env.SOCIAL_OAUTH_REDIRECT_BASE_URL).toBeUndefined();
  });

  it('parses a complete platform configuration', () => {
    const env = loadEnv(apiEnvSchema, {
      ...validApiEnv,
      ...linkedIn,
      SOCIAL_OAUTH_REDIRECT_BASE_URL: 'http://localhost:4000',
    } as NodeJS.ProcessEnv);
    expect(env.SOCIAL_OAUTH_LINKEDIN_CLIENT_ID).toBe('li-id-VALUE');
  });

  it('requires a client secret alongside a client id, naming keys not values', () => {
    expectEnvError(
      {
        ...validApiEnv,
        SOCIAL_OAUTH_REDIRECT_BASE_URL: 'http://localhost:4000',
        SOCIAL_OAUTH_LINKEDIN_CLIENT_ID: 'li-id-VALUE',
      },
      'SOCIAL_OAUTH_LINKEDIN_CLIENT_SECRET',
      'li-id-VALUE',
    );
  });

  it('requires the redirect base URL once any platform is configured', () => {
    expectEnvError(
      { ...validApiEnv, ...linkedIn },
      'SOCIAL_OAUTH_REDIRECT_BASE_URL',
      'li-secret-VALUE',
    );
  });

  it('rejects endpoint overrides for a platform with no credentials', () => {
    expectEnvError(
      { ...validApiEnv, SOCIAL_OAUTH_X_TOKEN_URL: 'https://example.com/token' },
      'SOCIAL_OAUTH_X_TOKEN_URL',
    );
  });

  it('requires https for the callback in production', () => {
    expectEnvError(
      {
        ...validApiEnv,
        ...linkedIn,
        NODE_ENV: 'production',
        SOCIAL_OAUTH_REDIRECT_BASE_URL: 'http://api.example.com',
      },
      'SOCIAL_OAUTH_REDIRECT_BASE_URL',
      'li-secret-VALUE',
    );
  });

  it('allows http endpoints outside production, for local mock providers', () => {
    const env = loadEnv(apiEnvSchema, {
      ...validApiEnv,
      ...linkedIn,
      SOCIAL_OAUTH_REDIRECT_BASE_URL: 'http://localhost:4000',
      SOCIAL_OAUTH_LINKEDIN_TOKEN_URL: 'http://127.0.0.1:9999/token',
    } as NodeJS.ProcessEnv);
    expect(env.SOCIAL_OAUTH_LINKEDIN_TOKEN_URL).toBe('http://127.0.0.1:9999/token');
  });

  it('returns the browser only to an allow-listed web origin', () => {
    expectEnvError({ ...validApiEnv, WEB_APP_URL: 'https://evil.example.com' }, 'WEB_APP_URL');
    expectEnvError(
      { ...validApiEnv, WEB_APP_URL: 'http://localhost:3000/somewhere' },
      'WEB_APP_URL',
    );
    const env = loadEnv(apiEnvSchema, {
      ...validApiEnv,
      WEB_APP_URL: 'http://localhost:3000',
    } as NodeJS.ProcessEnv);
    expect(env.WEB_APP_URL).toBe('http://localhost:3000');
  });
});

describe('LinkedIn API configuration (ADR-0035)', () => {
  it('defaults to LinkedIn itself and a pinned version', () => {
    const env = loadEnv(apiEnvSchema, validApiEnv as NodeJS.ProcessEnv);
    expect(env.LINKEDIN_API_BASE_URL).toBe('https://api.linkedin.com');
    expect(env.LINKEDIN_API_VERSION).toMatch(/^\d{6}$/);
  });

  it('rejects a version that is not YYYYMM', () => {
    expectEnvError({ ...validApiEnv, LINKEDIN_API_VERSION: '2026-08' }, 'LINKEDIN_API_VERSION');
  });

  it('requires https for the LinkedIn API in production', () => {
    expectEnvError(
      { ...validApiEnv, NODE_ENV: 'production', LINKEDIN_API_BASE_URL: 'http://mock.local' },
      'LINKEDIN_API_BASE_URL',
    );
  });

  it('gives the worker the OAuth settings it needs to refresh a token', () => {
    const env = loadEnv(workerEnvSchema, {
      REDIS_URL: 'redis://localhost:6379',
      DATABASE_URL: 'postgresql://spectra:secret@localhost:5432/spectra',
      STORAGE_ENDPOINT: 'http://localhost:9000',
      STORAGE_ACCESS_KEY: 'a',
      STORAGE_SECRET_KEY: 'b',
      STORAGE_BUCKET: 'c',
      SOCIAL_OAUTH_REDIRECT_BASE_URL: 'http://localhost:4000',
      SOCIAL_OAUTH_LINKEDIN_CLIENT_ID: 'li-id',
      SOCIAL_OAUTH_LINKEDIN_CLIENT_SECRET: 'li-secret',
    } as NodeJS.ProcessEnv);
    expect(env.SOCIAL_OAUTH_LINKEDIN_CLIENT_ID).toBe('li-id');
    expect(env.LINKEDIN_API_VERSION).toMatch(/^\d{6}$/);
  });
});

describe('Meta Graph API configuration (ADR-0036)', () => {
  it('defaults to Meta itself and a pinned Graph version', () => {
    const env = loadEnv(apiEnvSchema, validApiEnv as NodeJS.ProcessEnv);
    expect(env.META_GRAPH_API_BASE_URL).toBe('https://graph.facebook.com');
    expect(env.META_GRAPH_API_VERSION).toBe('v26.0');
  });

  it('rejects a version that is not vNN.N', () => {
    expectEnvError({ ...validApiEnv, META_GRAPH_API_VERSION: '26' }, 'META_GRAPH_API_VERSION');
  });

  it('requires https for the Graph API in production', () => {
    expectEnvError(
      { ...validApiEnv, NODE_ENV: 'production', META_GRAPH_API_BASE_URL: 'http://graph.mock' },
      'META_GRAPH_API_BASE_URL',
    );
  });
});
