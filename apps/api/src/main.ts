import { createLogger } from '@spectra/logging';

import { createApp } from './bootstrap';
import { getApiEnv } from './config/env';

async function main(): Promise<void> {
  const env = getApiEnv();
  const logger = createLogger({ name: 'api', level: env.LOG_LEVEL });

  const app = await createApp(env);
  await app.listen({ port: env.API_PORT, host: env.API_HOST });

  logger.info(
    { port: env.API_PORT, host: env.API_HOST, docs: `http://localhost:${env.API_PORT}/docs` },
    'API started',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down API');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  // Logger may not exist yet if env validation failed — write to stderr.
  console.error('API failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
