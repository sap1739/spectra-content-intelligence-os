/** Deterministic test environment. Values point at local dev services. */
process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] ??=
  'postgresql://spectra:spectra_local_dev@localhost:5432/spectra?schema=public';
process.env['REDIS_URL'] ??= 'redis://localhost:6379';
// Tests use fastify inject — no socket is opened; any valid port satisfies env.
process.env['API_PORT'] ??= '4100';
process.env['LOG_LEVEL'] ??= 'error';
// Object storage (media rendering) — local MinIO from docker-compose.
process.env['STORAGE_ENDPOINT'] ??= 'http://localhost:9000';
process.env['STORAGE_REGION'] ??= 'us-east-1';
process.env['STORAGE_ACCESS_KEY'] ??= 'spectra-local';
process.env['STORAGE_SECRET_KEY'] ??= 'spectra_local_dev';
process.env['STORAGE_BUCKET'] ??= 'spectra-dev';
process.env['STORAGE_FORCE_PATH_STYLE'] ??= 'true';

// Video rendering (Phase 7B). No ffmpeg binary is vendored by the product, so
// the tests point at the dev-only installer package — exactly as a deployment
// points at its own build. Without this, the suite would only ever be able to
// assert that the engine is unavailable.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- CJS-only installer packages
  process.env['FFMPEG_PATH'] ??= (require('@ffmpeg-installer/ffmpeg') as { path: string }).path;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- CJS-only installer packages
  process.env['FFPROBE_PATH'] ??= (require('@ffprobe-installer/ffprobe') as { path: string }).path;
} catch {
  // Left unset: the API then reports the engine as unavailable, which is the
  // honest state and what the capability tests assert against.
}

// Billing (Phase 8A). Set here rather than in a spec's beforeAll because
// `getApiEnv()` memoizes on first call, and vitest reuses a worker across
// spec files — a spec that mutated process.env later would get an
// unconfigured provider whenever another spec had already read the env.
// The base URL is overridden per-spec to point at the local Stripe stand-in.
process.env['STRIPE_SECRET_KEY'] ??= 'sk_test_integration';
process.env['STRIPE_WEBHOOK_SECRET'] ??= 'whsec_integration_secret';
process.env['BILLING_RETURN_ORIGIN'] ??= 'http://localhost:3000';
