import { apiEnvSchema, loadEnv, type ApiEnv } from '@spectra/config';

let cached: ApiEnv | null = null;

/** Validated at boot; the process refuses to start with a bad environment. */
export function getApiEnv(): ApiEnv {
  if (!cached) {
    cached = loadEnv(apiEnvSchema);
  }
  return cached;
}

/** Test hook: reset cache so tests can inject their own environment. */
export function resetApiEnvCache(): void {
  cached = null;
}
