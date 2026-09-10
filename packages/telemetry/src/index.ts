export { ALLOWED_SPAN_ATTRIBUTES, safeSpanAttributes } from './attributes';
export type { SpanAttributeValue } from './attributes';
export { activeTraceId, getTracer, initTracing, withSpan } from './tracing';
export type { TracingConfig, TracingHandle } from './tracing';
export {
  DEFAULT_DURATION_BUCKETS_MS,
  METRICS,
  MetricsRegistry,
  createRegistry,
  metrics,
} from './metrics';
export type { GaugeSample, MetricLabels } from './metrics';
