import { describe, expect, it } from 'vitest';

import { EnvValidationError, apiEnvSchema, loadEnv, workerEnvSchema } from './env';

const validApiEnv = {
  DATABASE_URL: 'postgresql://spectra:secret@localhost:5432/spectra',
  REDIS_URL: 'redis://localhost:6379',
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
