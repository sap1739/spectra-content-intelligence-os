import { z } from 'zod';

/**
 * Environment validation for every Spectra process.
 *
 * Rules:
 * - every app validates its environment at boot and crashes loudly on failure;
 * - validation errors never echo values (only key names), so secrets cannot leak;
 * - all URLs/credentials come from the environment — never hard-code keys.
 */

export const nodeEnvSchema = z.enum(['development', 'test', 'production']).default('development');

const postgresUrl = z
  .string()
  .min(1)
  .refine((v) => v.startsWith('postgresql://') || v.startsWith('postgres://'), {
    message: 'must be a postgresql:// connection string',
  });

const redisUrl = z
  .string()
  .min(1)
  .refine((v) => v.startsWith('redis://') || v.startsWith('rediss://'), {
    message: 'must be a redis:// connection string',
  });

export const logLevelSchema = z
  .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
  .default('info');

export const databaseEnvSchema = z.object({
  DATABASE_URL: postgresUrl,
});

export const redisEnvSchema = z.object({
  REDIS_URL: redisUrl,
});

export const storageEnvSchema = z.object({
  STORAGE_ENDPOINT: z.string().url(),
  STORAGE_REGION: z.string().min(1).default('us-east-1'),
  STORAGE_ACCESS_KEY: z.string().min(1),
  STORAGE_SECRET_KEY: z.string().min(1),
  STORAGE_BUCKET: z.string().min(1),
  STORAGE_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
});

/**
 * AI provider config. Every field is OPTIONAL — the platform runs without a
 * key and reports generation as honestly unavailable (no fabricated output).
 * The key is a secret: `loadEnv` never echoes values, only key names.
 */
export const aiEnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-opus-4-8'),
  ANTHROPIC_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(64000).default(4096),
});

export const apiEnvSchema = z
  .object({
    NODE_ENV: nodeEnvSchema,
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    /** Comma-separated allow-list of browser origins (CORS + CSRF origin check). */
    API_CORS_ORIGIN: z
      .string()
      .default('http://localhost:3000,http://localhost:3001')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().url()).min(1)),
    LOG_LEVEL: logLevelSchema,
  })
  .merge(databaseEnvSchema)
  .merge(redisEnvSchema)
  .merge(aiEnvSchema);

export const workerEnvSchema = z
  .object({
    NODE_ENV: nodeEnvSchema,
    WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1000).default(30000),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
    LOG_LEVEL: logLevelSchema,
  })
  .merge(redisEnvSchema)
  // Research pipeline: persistence + snapshot storage.
  .merge(databaseEnvSchema)
  .merge(storageEnvSchema);

export const webEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  NEXT_PUBLIC_API_BASE_URL: z.string().url().default('http://localhost:4000'),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
export type WebEnv = z.infer<typeof webEnvSchema>;
export type StorageEnv = z.infer<typeof storageEnvSchema>;

export class EnvValidationError extends Error {
  public readonly issues: ReadonlyArray<{ key: string; message: string }>;

  constructor(issues: ReadonlyArray<{ key: string; message: string }>) {
    // Intentionally lists key names and rule failures only — never values.
    super(
      `Environment validation failed: ${issues.map((i) => `${i.key} (${i.message})`).join('; ')}`,
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

export function loadEnv<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<TSchema> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => ({
        key: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  return result.data;
}
