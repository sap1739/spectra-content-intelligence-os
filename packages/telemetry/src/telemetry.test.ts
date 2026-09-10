import { describe, expect, it } from 'vitest';

import { safeSpanAttributes } from './attributes';
import { METRICS, MetricsRegistry, createRegistry } from './metrics';
import { activeTraceId, initTracing, withSpan } from './tracing';

/** Telemetry (ADR-0033). */

describe('tracing when unconfigured', () => {
  it('stays off without an endpoint and explains why', async () => {
    const handle = await initTracing({ serviceName: 'test' });
    expect(handle.enabled).toBe(false);
    expect(handle.reason).toMatch(/OTEL_EXPORTER_OTLP_ENDPOINT is not set/);
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it('treats a blank endpoint as unconfigured, not as a bad endpoint', async () => {
    const handle = await initTracing({ serviceName: 'test', endpoint: '   ' });
    expect(handle.enabled).toBe(false);
  });

  it('withSpan still runs the work and returns its value', async () => {
    // Call sites never branch on whether tracing is on — the no-op tracer
    // makes the instrumented path identical.
    const result = await withSpan('op', { 'spectra.operation': 'test' }, async () => 42);
    expect(result).toBe(42);
  });

  it('withSpan rethrows so error handling is unchanged by tracing', async () => {
    await expect(
      withSpan('op', {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('reports no trace id when tracing is off', () => {
    expect(activeTraceId()).toBeUndefined();
  });
});

describe('span attribute allow-list', () => {
  it('keeps identifiers and outcomes', () => {
    const safe = safeSpanAttributes({
      'spectra.run.id': 'run-1',
      'spectra.provider': 'anthropic',
      'spectra.count': 3,
      'http.response.status_code': 200,
    });
    expect(safe).toEqual({
      'spectra.run.id': 'run-1',
      'spectra.provider': 'anthropic',
      'spectra.count': 3,
      'http.response.status_code': 200,
    });
  });

  it('drops anything not explicitly allowed', () => {
    // The allow-list is the point: unknown keys are dropped even when they
    // look harmless, because the next one might not be.
    const safe = safeSpanAttributes({
      apiKey: 'sk-secret',
      accessToken: 'token',
      password: 'hunter2',
      prompt: 'the full user prompt',
      documentContent: 'private text',
      'spectra.operation': 'draft',
    });
    expect(safe).toEqual({ 'spectra.operation': 'draft' });
  });

  it('drops objects and arrays entirely', () => {
    // The easiest route for an unexpected payload to reach a span.
    const safe = safeSpanAttributes({
      'spectra.operation': { nested: 'secret' },
      'spectra.count': [1, 2, 3],
    });
    expect(safe).toEqual({});
  });

  it('bounds long strings so a body cannot ride on an allowed key', () => {
    const safe = safeSpanAttributes({ 'spectra.operation': 'x'.repeat(5000) });
    expect(String(safe['spectra.operation']).length).toBeLessThanOrEqual(257);
  });

  it('drops null and undefined rather than recording them', () => {
    expect(safeSpanAttributes({ 'spectra.run.id': null, 'spectra.model': undefined })).toEqual({});
  });
});

describe('metrics registry', () => {
  it('counts and renders in Prometheus format', async () => {
    const registry = new MetricsRegistry();
    registry.counter('test_total', 'A test counter.');
    registry.increment('test_total', { kind: 'a' });
    registry.increment('test_total', { kind: 'a' });
    registry.increment('test_total', { kind: 'b' });

    const text = await registry.render();
    expect(text).toContain('# TYPE test_total counter');
    expect(text).toContain('test_total{kind="a"} 2');
    expect(text).toContain('test_total{kind="b"} 1');
  });

  it('records histogram buckets, sum and count', async () => {
    const registry = new MetricsRegistry();
    registry.histogram('dur_ms', 'Durations.', [10, 100]);
    registry.observe('dur_ms', 5);
    registry.observe('dur_ms', 50);
    registry.observe('dur_ms', 500);

    const text = await registry.render();
    expect(text).toContain('dur_ms_bucket{le="10"} 1');
    expect(text).toContain('dur_ms_bucket{le="100"} 2');
    expect(text).toContain('dur_ms_bucket{le="+Inf"} 3');
    expect(text).toContain('dur_ms_count 3');
    expect(text).toContain('dur_ms_sum 555');
  });

  it('times a call and labels its outcome, without swallowing errors', async () => {
    const registry = new MetricsRegistry();
    registry.histogram('op_ms', 'Ops.');

    await registry.time('op_ms', { kind: 'x' }, async () => 'ok');
    await expect(
      registry.time('op_ms', { kind: 'x' }, async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');

    const text = await registry.render();
    expect(text).toContain('outcome="success"');
    expect(text).toContain('outcome="error"');
  });

  it('omits a gauge whose source is unreachable rather than reporting zero', async () => {
    const registry = new MetricsRegistry();
    registry.gauge('depth', 'Queue depth.', () => {
      throw new Error('redis down');
    });
    const text = await registry.render();
    // Zero depth and an unreachable queue are different facts.
    expect(text).toContain('# TYPE depth gauge');
    expect(text).not.toMatch(/^depth 0$/m);
  });

  it('renders one labelled series per gauge sample', async () => {
    const registry = new MetricsRegistry();
    registry.gauge('depth', 'Queue depth.', () => [
      { labels: { state: 'waiting' }, value: 3 },
      { labels: { state: 'failed' }, value: 0 },
    ]);
    const text = await registry.render();
    expect(text).toContain('depth{state="waiting"} 3');
    // An explicit zero for a state we CAN read is real information — only an
    // unreadable gauge is omitted.
    expect(text).toContain('depth{state="failed"} 0');
  });

  it('omits every sample when a multi-series gauge cannot be read', async () => {
    const registry = new MetricsRegistry();
    registry.gauge('depth', 'Queue depth.', async () => {
      await Promise.resolve();
      throw new Error('redis down');
    });
    const text = await registry.render();
    expect(text).not.toMatch(/^depth\{/m);
  });

  it('caps series cardinality so one bad label cannot blow up the backend', async () => {
    const registry = new MetricsRegistry();
    registry.counter('wide_total', 'Wide.');
    for (let i = 0; i < 600; i += 1) registry.increment('wide_total', { id: `v${i}` });
    const series = (await registry.render()).split('\n').filter((l) => l.startsWith('wide_total{'));
    expect(series.length).toBeLessThanOrEqual(500);
  });

  it('ignores writes to unregistered metrics instead of throwing', () => {
    const registry = new MetricsRegistry();
    // Telemetry must never break the code it measures.
    expect(() => registry.increment('never_registered', {})).not.toThrow();
    expect(() => registry.observe('never_registered', 5)).not.toThrow();
  });

  it('escapes label values so they cannot break the exposition format', async () => {
    const registry = new MetricsRegistry();
    registry.counter('esc_total', 'Escaping.');
    registry.increment('esc_total', { reason: 'a "quoted" \\ value' });
    const text = await registry.render();
    expect(text).toContain('\\"quoted\\"');
  });

  it('registers every documented platform metric', () => {
    const registry = createRegistry();
    expect(() => {
      registry.increment(METRICS.budgetBlocked, { kind: 'AI_GENERATION' });
      registry.observe(METRICS.researchRunDuration, 1200, { outcome: 'success' });
      registry.observe(METRICS.providerLatency, 300, { provider: 'anthropic' });
    }).not.toThrow();
  });
});
