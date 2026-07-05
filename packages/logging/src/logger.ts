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
