/** Deterministic test environment. Values point at local dev services. */
process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] ??=
  'postgresql://spectra:spectra_local_dev@localhost:5432/spectra?schema=public';
process.env['REDIS_URL'] ??= 'redis://localhost:6379';
// Tests use fastify inject — no socket is opened; any valid port satisfies env.
process.env['API_PORT'] ??= '4100';
process.env['LOG_LEVEL'] ??= 'error';
