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
  /**
   * Semantic embeddings (Phase 5A). Optional — without a key the system falls
   * back to the first-party lexical embedder and SAYS SO (retrieval stays
   * lexical; nothing is silently degraded or fabricated).
   */
  VOYAGE_API_KEY: z.string().min(1).optional(),
  VOYAGE_EMBEDDING_MODEL: z.string().min(1).default('voyage-4'),
  /** Matryoshka output width. voyage-4 family supports 256/512/1024/2048. */
  VOYAGE_EMBEDDING_DIMENSIONS: z.coerce
    .number()
    .int()
    .refine((d) => [256, 512, 1024, 2048].includes(d), {
      message: 'VOYAGE_EMBEDDING_DIMENSIONS must be one of 256, 512, 1024, 2048',
    })
    .default(1024),
});

/**
 * Research discovery config (Phase 5B). Optional — without a key, live web/news
 * search is honestly unavailable and research runs fall back to the operator's
 * own RSS feeds. No result is ever invented.
 */
export const researchEnvSchema = z.object({
  BRAVE_SEARCH_API_KEY: z.string().min(1).optional(),
});

const BASE64_KEY = /^[A-Za-z0-9+/]+={0,2}$/;

/** True when `value` is a base64-encoded 32-byte (AES-256) key. */
function isAes256Key(value: string): boolean {
  return BASE64_KEY.test(value) && Buffer.from(value, 'base64').length === 32;
}

const encryptionKeyIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, {
  message: 'must be 1-32 characters of a-z, 0-9 and "-"',
});

/**
 * Publishing credentials (Phase 4) and their key rotation (Phase 6C, ADR-0034).
 * Optional — without the key, storing a social credential is honestly
 * unavailable (accounts can still be registered, just without a sealed token).
 * Base64-encoded 32-byte AES-256-GCM key (see @spectra/security).
 */
export const socialEnvSchema = z.object({
  SOCIAL_TOKEN_ENCRYPTION_KEY: z
    .string()
    .min(1)
    .refine(isAes256Key, { message: 'must be a base64-encoded 32-byte key' })
    .optional(),
  /** Stamped into every new ciphertext. Change it when you rotate the key. */
  SOCIAL_TOKEN_ENCRYPTION_KEY_ID: encryptionKeyIdSchema.default('social-v1'),
  /**
   * Decrypt-only keys from earlier rotations: "keyId:base64key,keyId:base64key".
   * Credentials sealed under them stay readable and move onto the active key
   * the next time they are written (refresh, reconnect).
   */
  SOCIAL_TOKEN_ENCRYPTION_RETIRED_KEYS: z.string().min(1).optional(),
});

/**
 * Parses SOCIAL_TOKEN_ENCRYPTION_RETIRED_KEYS. Problems name the entry
 * position, never a key value.
 */
export function parseRetiredEncryptionKeys(spec: string): {
  keys: Array<{ keyId: string; key: string }>;
  problems: string[];
} {
  const keys: Array<{ keyId: string; key: string }> = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  spec
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry, index) => {
      const separator = entry.indexOf(':');
      const keyId = separator > 0 ? entry.slice(0, separator) : '';
      const key = separator > 0 ? entry.slice(separator + 1) : '';
      if (!encryptionKeyIdSchema.safeParse(keyId).success || !isAes256Key(key)) {
        problems.push(`entry ${index + 1} must be "<keyId>:<base64 32-byte key>"`);
        return;
      }
      if (seen.has(keyId)) {
        problems.push(`key id "${keyId}" appears more than once`);
        return;
      }
      seen.add(keyId);
      keys.push({ keyId, key });
    });
  return { keys, problems };
}

interface SocialKeyRingEnv {
  SOCIAL_TOKEN_ENCRYPTION_KEY?: string | undefined;
  SOCIAL_TOKEN_ENCRYPTION_KEY_ID?: string | undefined;
  SOCIAL_TOKEN_ENCRYPTION_RETIRED_KEYS?: string | undefined;
}

/**
 * The social credential key ring, or undefined when no key is configured.
 * Structurally a `KeyRing` from @spectra/security. The API seals with it and
 * the worker opens with it, so both build it here rather than each hard-coding
 * a key id.
 */
export function socialKeyRingFromEnv(
  env: SocialKeyRingEnv,
): { keys: Record<string, string>; activeKeyId: string } | undefined {
  if (!env.SOCIAL_TOKEN_ENCRYPTION_KEY) return undefined;
  const activeKeyId = env.SOCIAL_TOKEN_ENCRYPTION_KEY_ID ?? 'social-v1';
  const keys: Record<string, string> = {};
  if (env.SOCIAL_TOKEN_ENCRYPTION_RETIRED_KEYS) {
    for (const retired of parseRetiredEncryptionKeys(env.SOCIAL_TOKEN_ENCRYPTION_RETIRED_KEYS)
      .keys) {
      keys[retired.keyId] = retired.key;
    }
  }
  keys[activeKeyId] = env.SOCIAL_TOKEN_ENCRYPTION_KEY;
  return { keys, activeKeyId };
}

function refineSocialKeyRing(env: SocialKeyRingEnv, ctx: z.RefinementCtx): void {
  const retired = env.SOCIAL_TOKEN_ENCRYPTION_RETIRED_KEYS;
  if (!retired) return;
  const path = ['SOCIAL_TOKEN_ENCRYPTION_RETIRED_KEYS'];
  if (!env.SOCIAL_TOKEN_ENCRYPTION_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: 'requires SOCIAL_TOKEN_ENCRYPTION_KEY (the active key)',
    });
  }
  const parsed = parseRetiredEncryptionKeys(retired);
  for (const problem of parsed.problems) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: problem });
  }
  if (parsed.keys.some((entry) => entry.keyId === env.SOCIAL_TOKEN_ENCRYPTION_KEY_ID)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: 'a retired key id cannot equal SOCIAL_TOKEN_ENCRYPTION_KEY_ID',
    });
  }
}

/**
 * OAuth platforms configurable per deployment (Phase 6C, ADR-0034). Mirrors
 * OAUTH_PLATFORMS in @spectra/contracts — a test in @spectra/social-oauth
 * asserts the lists match. Kept here so config has no domain dependency.
 */
export const SOCIAL_OAUTH_PLATFORM_IDS = [
  'LINKEDIN',
  'FACEBOOK',
  'INSTAGRAM',
  'THREADS',
  'YOUTUBE',
  'TIKTOK',
  'X',
  'PINTEREST',
] as const;
export type SocialOAuthPlatformId = (typeof SOCIAL_OAUTH_PLATFORM_IDS)[number];

export const SOCIAL_OAUTH_KEY_SUFFIXES = [
  'CLIENT_ID',
  'CLIENT_SECRET',
  'SCOPES',
  'AUTHORIZATION_URL',
  'TOKEN_URL',
  'REVOCATION_URL',
] as const;
export type SocialOAuthKeySuffix = (typeof SOCIAL_OAUTH_KEY_SUFFIXES)[number];
export type SocialOAuthEnvKey = `SOCIAL_OAUTH_${SocialOAuthPlatformId}_${SocialOAuthKeySuffix}`;

export function socialOAuthEnvKey(
  platform: SocialOAuthPlatformId,
  suffix: SocialOAuthKeySuffix,
): SocialOAuthEnvKey {
  return `SOCIAL_OAUTH_${platform}_${suffix}`;
}

const OAUTH_URL_SUFFIXES: ReadonlySet<SocialOAuthKeySuffix> = new Set([
  'AUTHORIZATION_URL',
  'TOKEN_URL',
  'REVOCATION_URL',
]);
const OAUTH_OVERRIDE_SUFFIXES: readonly SocialOAuthKeySuffix[] = [
  'SCOPES',
  'AUTHORIZATION_URL',
  'TOKEN_URL',
  'REVOCATION_URL',
];

const perPlatformOAuthShape = Object.fromEntries(
  SOCIAL_OAUTH_PLATFORM_IDS.flatMap((platform) =>
    SOCIAL_OAUTH_KEY_SUFFIXES.map((suffix) => [
      socialOAuthEnvKey(platform, suffix),
      OAUTH_URL_SUFFIXES.has(suffix) ? z.string().url().optional() : z.string().min(1).optional(),
    ]),
  ),
) as Record<SocialOAuthEnvKey, z.ZodOptional<z.ZodString>>;

/**
 * Social OAuth (Phase 6C). Entirely optional: a platform is connectable only
 * when BOTH its client id and secret are set, and the callback needs a public
 * base URL. Anything half-configured is a boot error, not a silent no-op.
 */
export const socialOAuthEnvSchema = z.object({
  /**
   * Public base URL of THIS API as platforms reach it. The redirect URI
   * registered with each platform is <base>/v1/social/oauth/<platform>/callback.
   */
  SOCIAL_OAUTH_REDIRECT_BASE_URL: z.string().url().optional(),
  /**
   * Web app origin the callback returns the browser to. Must be one of
   * API_CORS_ORIGIN, which doubles as the redirect allow-list. Defaults to the
   * first API_CORS_ORIGIN entry.
   */
  WEB_APP_URL: z.string().url().optional(),
  /** How long a started OAuth flow may take before its state is rejected. */
  SOCIAL_OAUTH_STATE_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(600),
  ...perPlatformOAuthShape,
});

type SocialOAuthEnvShape = z.infer<typeof socialOAuthEnvSchema> & {
  NODE_ENV: z.infer<typeof nodeEnvSchema>;
  /** API only: the worker never redirects a browser. */
  API_CORS_ORIGIN?: string[];
};

function refineSocialOAuth(env: SocialOAuthEnvShape, ctx: z.RefinementCtx): void {
  const issue = (key: string, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message });
  const production = env.NODE_ENV === 'production';
  let anyConfigured = false;

  for (const platform of SOCIAL_OAUTH_PLATFORM_IDS) {
    const idKey = socialOAuthEnvKey(platform, 'CLIENT_ID');
    const secretKey = socialOAuthEnvKey(platform, 'CLIENT_SECRET');
    const hasId = Boolean(env[idKey]);
    const hasSecret = Boolean(env[secretKey]);
    if (hasId && !hasSecret) issue(secretKey, `required when ${idKey} is set`);
    if (hasSecret && !hasId) issue(idKey, `required when ${secretKey} is set`);
    if (hasId && hasSecret) {
      anyConfigured = true;
    } else {
      for (const suffix of OAUTH_OVERRIDE_SUFFIXES) {
        const key = socialOAuthEnvKey(platform, suffix);
        if (env[key]) issue(key, `has no effect unless ${idKey} and ${secretKey} are set`);
      }
    }
    if (production) {
      for (const suffix of OAUTH_URL_SUFFIXES) {
        const key = socialOAuthEnvKey(platform, suffix);
        const value = env[key];
        if (value && !value.startsWith('https://')) issue(key, 'must use https in production');
      }
    }
  }

  const base = env.SOCIAL_OAUTH_REDIRECT_BASE_URL;
  if (anyConfigured && !base) {
    issue(
      'SOCIAL_OAUTH_REDIRECT_BASE_URL',
      'required when any SOCIAL_OAUTH_<PLATFORM>_CLIENT_ID is set',
    );
  }
  if (base && production && !base.startsWith('https://')) {
    issue('SOCIAL_OAUTH_REDIRECT_BASE_URL', 'must use https in production');
  }

  if (env.WEB_APP_URL && env.API_CORS_ORIGIN) {
    const url = new URL(env.WEB_APP_URL);
    if (url.pathname !== '/' || url.search || url.hash) {
      issue('WEB_APP_URL', 'must be an origin (scheme://host[:port]) with no path');
    } else if (!env.API_CORS_ORIGIN.includes(url.origin)) {
      issue('WEB_APP_URL', 'must be one of API_CORS_ORIGIN (the OAuth return allow-list)');
    }
  }
}

/**
 * OpenTelemetry (Phase 6B). Entirely optional: with no endpoint the services
 * run without tracing and say so at boot rather than failing.
 */
export const telemetryEnvSchema = z.object({
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  /** Comma-separated `key=value` pairs, e.g. an auth header. NEVER logged. */
  OTEL_EXPORTER_OTLP_HEADERS: z.string().optional(),
});

/**
 * LinkedIn API (Phase 6D, ADR-0035). Defaults target LinkedIn itself; the base
 * URL is overridable only so tests can point at a local mock (https in
 * production). Every versioned call sends LINKEDIN_API_VERSION.
 */
export const linkedInEnvSchema = z.object({
  LINKEDIN_API_BASE_URL: z.string().url().default('https://api.linkedin.com'),
  LINKEDIN_API_VERSION: z
    .string()
    .regex(/^\d{6}$/, { message: 'must be a LinkedIn API version in YYYYMM form' })
    .default('202608'),
});

function refineLinkedIn(
  env: { NODE_ENV: z.infer<typeof nodeEnvSchema>; LINKEDIN_API_BASE_URL: string },
  ctx: z.RefinementCtx,
): void {
  if (env.NODE_ENV === 'production' && !env.LINKEDIN_API_BASE_URL.startsWith('https://')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['LINKEDIN_API_BASE_URL'],
      message: 'must use https in production',
    });
  }
}

/**
 * Meta Graph API (Phase 6E, ADR-0036). Defaults target Meta itself; the base
 * URL is overridable only so tests can point at a local mock (https in
 * production). The version is the path segment every Graph call uses.
 */
export const metaEnvSchema = z.object({
  META_GRAPH_API_BASE_URL: z.string().url().default('https://graph.facebook.com'),
  META_GRAPH_API_VERSION: z
    .string()
    .regex(/^v\d{1,3}\.\d{1,2}$/, { message: 'must be a Graph API version such as v26.0' })
    .default('v26.0'),
});

function refineMeta(
  env: { NODE_ENV: z.infer<typeof nodeEnvSchema>; META_GRAPH_API_BASE_URL: string },
  ctx: z.RefinementCtx,
): void {
  if (env.NODE_ENV === 'production' && !env.META_GRAPH_API_BASE_URL.startsWith('https://')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['META_GRAPH_API_BASE_URL'],
      message: 'must use https in production',
    });
  }
}

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
  .merge(aiEnvSchema)
  // Media rendering (Phase 3F) reads/writes tenant-rooted object storage.
  .merge(storageEnvSchema)
  // Publishing (Phase 4): optional token-encryption key for social credentials.
  .merge(socialEnvSchema)
  // Research discovery (Phase 5B): optional live web/news search.
  .merge(researchEnvSchema)
  // Observability (Phase 6B): optional OTLP tracing.
  .merge(telemetryEnvSchema)
  // Social OAuth (Phase 6C): optional per-platform client credentials.
  .merge(socialOAuthEnvSchema)
  // LinkedIn adapter (Phase 6D).
  .merge(linkedInEnvSchema)
  // Meta adapters (Phase 6E).
  .merge(metaEnvSchema)
  .superRefine((env, ctx) => {
    refineSocialKeyRing(env, ctx);
    refineSocialOAuth(env, ctx);
    refineLinkedIn(env, ctx);
    refineMeta(env, ctx);
  });

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
  .merge(storageEnvSchema)
  // Content generation (Phase 3): optional AI provider for the draft worker.
  .merge(aiEnvSchema)
  // Publishing (Phase 4): the worker decrypts sealed social credentials to
  // publish. Without the key, publishing resolves to UNSUPPORTED (honest).
  .merge(socialEnvSchema)
  // Research discovery (Phase 5B): optional live web/news search.
  .merge(researchEnvSchema)
  // Observability (Phase 6B): optional OTLP tracing.
  .merge(telemetryEnvSchema)
  // Social OAuth (Phase 6D): the worker refreshes a LinkedIn token before
  // publishing when the platform issued a refresh token.
  .merge(socialOAuthEnvSchema)
  .merge(linkedInEnvSchema)
  .merge(metaEnvSchema)
  .superRefine((env, ctx) => {
    refineSocialKeyRing(env, ctx);
    refineSocialOAuth(env, ctx);
    refineLinkedIn(env, ctx);
    refineMeta(env, ctx);
  });

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
