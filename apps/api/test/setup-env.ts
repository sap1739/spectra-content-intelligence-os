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
