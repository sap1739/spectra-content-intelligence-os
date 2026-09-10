import { SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api';
import type { Logger } from '@spectra/logging';

import { safeSpanAttributes } from './attributes';

/**
 * Env-gated OpenTelemetry tracing (ADR-0033).
 *
 * Without `OTEL_EXPORTER_OTLP_ENDPOINT` nothing is initialised and no SDK is
 * loaded. The instrumentation helpers below still work — they just record to
 * the API's default no-op tracer — so call sites never need to branch on
 * whether tracing is on. "Unconfigured" is a supported, silent state, not a
 * degraded one.
 */

export interface TracingConfig {
  /** OTLP/HTTP collector endpoint. Absent => tracing stays off. */
  endpoint?: string | undefined;
  serviceName: string;
  serviceVersion?: string | undefined;
  /** Deployment environment tag, e.g. `staging`. */
  environment?: string | undefined;
  /** Optional collector headers, e.g. an auth token. NEVER logged. */
  headers?: Record<string, string> | undefined;
}

export interface TracingHandle {
  enabled: boolean;
  /** Operator-facing explanation; always populated. */
  reason: string;
  shutdown: () => Promise<void>;
}

let started = false;

/**
 * Starts tracing when an endpoint is configured. Idempotent and non-throwing:
 * a telemetry failure must never take down the service it observes.
 */
export async function initTracing(config: TracingConfig, logger?: Logger): Promise<TracingHandle> {
  const endpoint = config.endpoint?.trim();
  if (!endpoint) {
    return {
      enabled: false,
      reason:
        'OTEL_EXPORTER_OTLP_ENDPOINT is not set — tracing is off and no telemetry SDK is loaded.',
      shutdown: async () => undefined,
    };
  }
  if (started) {
    return {
      enabled: true,
      reason: 'Tracing already initialised.',
      shutdown: async () => undefined,
    };
  }

  try {
    // Imported lazily so an unconfigured deployment never pays the SDK's
    // startup cost or its dependency surface.
    const [{ NodeSDK }, { OTLPTraceExporter }, { resourceFromAttributes }, semconv] =
      await Promise.all([
        import('@opentelemetry/sdk-node'),
        import('@opentelemetry/exporter-trace-otlp-http'),
        import('@opentelemetry/resources'),
        import('@opentelemetry/semantic-conventions'),
      ]);

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [semconv.ATTR_SERVICE_NAME]: config.serviceName,
        ...(config.serviceVersion ? { [semconv.ATTR_SERVICE_VERSION]: config.serviceVersion } : {}),
        ...(config.environment ? { 'deployment.environment.name': config.environment } : {}),
      }),
      traceExporter: new OTLPTraceExporter({
        url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
        ...(config.headers ? { headers: config.headers } : {}),
      }),
    });

    sdk.start();
    started = true;
    // The endpoint is logged; the headers (which may carry a token) are not.
    logger?.info({ endpoint, serviceName: config.serviceName }, 'OpenTelemetry tracing enabled');

    return {
      enabled: true,
      reason: `Exporting traces to ${endpoint}.`,
      shutdown: async () => {
        await sdk.shutdown().catch(() => undefined);
        started = false;
      },
    };
  } catch (error) {
    // Never fatal. An observability failure that takes down the API would be a
    // worse outcome than running without traces.
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn({ err: message }, 'Tracing failed to initialise — continuing without it');
    return {
      enabled: false,
      reason: `Tracing could not start (${message}); the service is running without it.`,
      shutdown: async () => undefined,
    };
  }
}

export function getTracer(name = 'spectra'): Tracer {
  // With no SDK registered this returns the API's no-op tracer, so callers
  // below are safe either way.
  return trace.getTracer(name);
}

/**
 * Runs `fn` inside a span, recording only allow-listed attributes.
 *
 * Errors are recorded as a span status and message, then rethrown — the caller's
 * error handling is unchanged by being traced.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, unknown>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, async (span) => {
    span.setAttributes(safeSpanAttributes(attributes));
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The message, not the exception object: a thrown error can carry a
      // request payload on its properties.
      span.setStatus({ code: SpanStatusCode.ERROR, message: message.slice(0, 256) });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** The active trace id, for correlating a support request to a trace. */
export function activeTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  const context = span?.spanContext();
  return context && context.traceId !== '00000000000000000000000000000000'
    ? context.traceId
    : undefined;
}
