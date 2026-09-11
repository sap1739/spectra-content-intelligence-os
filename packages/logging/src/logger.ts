import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

/**
 * Paths that are ALWAYS redacted from structured logs, regardless of caller
 * configuration. See docs/SECURITY.md — passwords, tokens, keys, payment data
 * and private document content must never reach a log sink.
 */
export const MANDATORY_REDACT_PATHS: readonly string[] = [
  'password',
  '*.password',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'token',
  '*.token',
  'apiKey',
  '*.apiKey',
  'secret',
  '*.secret',
  'secretKey',
  '*.secretKey',
  'encryptionKey',
  '*.encryptionKey',
  'authorization',
  '*.authorization',
  'cookie',
  '*.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'cardNumber',
  '*.cardNumber',
  'documentContent',
  '*.documentContent',
  // --- Phase 6B additions (ADR-0033) -------------------------------------
  // Header casing varies by client and framework; pino paths are
  // case-sensitive, so each real-world spelling needs its own entry.
  'req.headers.Authorization',
  'req.headers["x-api-key"]',
  'req.headers["X-Api-Key"]',
  'headers.authorization',
  'headers.cookie',
  '*.headers.authorization',
  '*.headers.cookie',
  'set-cookie',
  '*.setCookie',
  // Credentials by other names used across the codebase.
  'credential',
  '*.credential',
  'applicationPassword',
  '*.applicationPassword',
  'encryptedToken',
  '*.encryptedToken',
  'sessionToken',
  '*.sessionToken',
  'passwordHash',
  '*.passwordHash',
  'privateKey',
  '*.privateKey',
  'clientSecret',
  '*.clientSecret',
  // Model input/output. A prompt carries the operator's private research and
  // an untrusted source's text; a completion can echo both back.
  'prompt',
  '*.prompt',
  'prompts',
  '*.prompts',
  'completion',
  '*.completion',
  'messages',
  '*.messages',
  'instructions',
  '*.instructions',
  // Extracted external/document content.
  'extractedText',
  '*.extractedText',
  'rawHtml',
  '*.rawHtml',
  'body.content',
  // --- Phase 6C additions (ADR-0034) -------------------------------------
  // OAuth wire names. A token-endpoint response or request logged whole would
  // otherwise carry every one of these in snake_case.
  'access_token',
  '*.access_token',
  'refresh_token',
  '*.refresh_token',
  'id_token',
  '*.id_token',
  'client_secret',
  '*.client_secret',
  'code_verifier',
  '*.code_verifier',
  'codeVerifier',
  '*.codeVerifier',
  'encryptedCredential',
  '*.encryptedCredential',
  'encryptedCodeVerifier',
  '*.encryptedCodeVerifier',
  'authorizationCode',
  '*.authorizationCode',
  // The callback query string carries a single-use code and the flow's state.
  'query.code',
  'query.state',
  '*.query.code',
  '*.query.state',
  // Payment data beyond the card number itself.
  'cvv',
  '*.cvv',
  'cardCvc',
  '*.cardCvc',
  'iban',
  '*.iban',
];

export interface CreateLoggerOptions {
  /** Service name stamped onto every line, e.g. `api`, `worker`. */
  name: string;
  level?: LoggerOptions['level'];
  /** Additional redaction paths merged with the mandatory set. */
  redactPaths?: readonly string[];
  /** Static bindings merged into every log line (e.g. version, env). */
  base?: Record<string, unknown>;
  /** Override destination — used by tests to capture output. */
  destination?: DestinationStream;
}

export type { Logger };

export function createLogger(options: CreateLoggerOptions): Logger {
  const { name, level = 'info', redactPaths = [], base = {}, destination } = options;

  const loggerOptions: LoggerOptions = {
    name,
    level,
    base: { service: name, ...base },
    redact: {
      paths: [...new Set([...MANDATORY_REDACT_PATHS, ...redactPaths])],
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  return destination ? pino(loggerOptions, destination) : pino(loggerOptions);
}

/** Child logger carrying the request/job correlation id. */
export function withCorrelation(logger: Logger, correlationId: string): Logger {
  return logger.child({ correlationId });
}

/** Child logger carrying tenant scope for tenant-aware audit trails. */
export function withTenant(
  logger: Logger,
  tenant: { organizationId: string; workspaceId?: string | undefined },
): Logger {
  return logger.child({
    organizationId: tenant.organizationId,
    ...(tenant.workspaceId ? { workspaceId: tenant.workspaceId } : {}),
  });
}
