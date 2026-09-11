/**
 * In-process metrics with a Prometheus text exposition (ADR-0033).
 *
 * First-party rather than an OTel metrics pipeline, because a scrape endpoint
 * needs no collector to be useful: an operator can curl it in staging on day
 * one. The shape (counters, histograms, labels) is deliberately OTel-compatible
 * so an exporter can be added later without changing a single call site.
 *
 * Label values are bounded and allow-listed by the caller — an unbounded label
 * (a URL with ids in it, a provider error string) is the classic way to blow up
 * a metrics backend AND to leak data into one.
 */

export type MetricLabels = Record<string, string | number>;

/** One labelled reading of a gauge, so a gauge can report several series. */
export interface GaugeSample {
  labels?: MetricLabels;
  value: number;
}

type GaugeGetter = () => Promise<number | GaugeSample[]> | number | GaugeSample[];

interface CounterState {
  help: string;
  values: Map<string, { labels: MetricLabels; value: number }>;
}

interface HistogramState {
  help: string;
  buckets: readonly number[];
  values: Map<string, { labels: MetricLabels; counts: number[]; sum: number; count: number }>;
}

/** Latency buckets in milliseconds, spanning a fast cache hit to a slow LLM call. */
export const DEFAULT_DURATION_BUCKETS_MS = [
  5, 25, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000,
] as const;

const MAX_LABEL_VALUE_LENGTH = 64;
/** Guards against unbounded cardinality from an unexpected label value. */
const MAX_SERIES_PER_METRIC = 500;

function seriesKey(labels: MetricLabels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${normalizeLabelValue(labels[k])}`)
    .join(',');
}

function normalizeLabelValue(value: string | number | undefined): string {
  if (value === undefined) return '';
  const text = String(value);
  return text.length > MAX_LABEL_VALUE_LENGTH ? text.slice(0, MAX_LABEL_VALUE_LENGTH) : text;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, CounterState>();
  private readonly histograms = new Map<string, HistogramState>();
  private readonly gauges = new Map<string, { help: string; getter: GaugeGetter }>();

  counter(name: string, help: string): void {
    if (!this.counters.has(name)) this.counters.set(name, { help, values: new Map() });
  }

  histogram(
    name: string,
    help: string,
    buckets: readonly number[] = DEFAULT_DURATION_BUCKETS_MS,
  ): void {
    if (!this.histograms.has(name)) {
      this.histograms.set(name, {
        help,
        buckets: [...buckets].sort((a, b) => a - b),
        values: new Map(),
      });
    }
  }

  /**
   * Registers a value read at scrape time — for things the process does not
   * increment but can ask about, like queue depth.
   *
   * The getter may return several labelled samples (e.g. depth per queue
   * state). Throwing is the correct way to say "unknown": see `render`.
   */
  gauge(name: string, help: string, getter: GaugeGetter): void {
    this.gauges.set(name, { help, getter });
  }

  increment(name: string, labels: MetricLabels = {}, by = 1): void {
    const state = this.counters.get(name);
    if (!state) return; // unregistered metric: ignored, never thrown
    const key = seriesKey(labels);
    const existing = state.values.get(key);
    if (existing) {
      existing.value += by;
      return;
    }
    if (state.values.size >= MAX_SERIES_PER_METRIC) return;
    state.values.set(key, { labels, value: by });
  }

  observe(name: string, valueMs: number, labels: MetricLabels = {}): void {
    const state = this.histograms.get(name);
    if (!state) return;
    const key = seriesKey(labels);
    let entry = state.values.get(key);
    if (!entry) {
      if (state.values.size >= MAX_SERIES_PER_METRIC) return;
      entry = { labels, counts: new Array(state.buckets.length).fill(0), sum: 0, count: 0 };
      state.values.set(key, entry);
    }
    entry.sum += valueMs;
    entry.count += 1;
    for (let i = 0; i < state.buckets.length; i += 1) {
      if (valueMs <= (state.buckets[i] as number)) entry.counts[i] = (entry.counts[i] ?? 0) + 1;
    }
  }

  /** Times `fn`, recording its duration and outcome. Never swallows the error. */
  async time<T>(name: string, labels: MetricLabels, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      this.observe(name, Date.now() - start, { ...labels, outcome: 'success' });
      return result;
    } catch (error) {
      this.observe(name, Date.now() - start, { ...labels, outcome: 'error' });
      throw error;
    }
  }

  /** Prometheus text exposition (v0.0.4). */
  async render(): Promise<string> {
    const lines: string[] = [];

    for (const [name, state] of this.counters) {
      lines.push(`# HELP ${name} ${state.help}`, `# TYPE ${name} counter`);
      for (const { labels, value } of state.values.values()) {
        lines.push(`${name}${formatLabels(labels)} ${value}`);
      }
    }

    for (const [name, state] of this.histograms) {
      lines.push(`# HELP ${name} ${state.help}`, `# TYPE ${name} histogram`);
      for (const entry of state.values.values()) {
        state.buckets.forEach((bucket, i) => {
          lines.push(
            `${name}_bucket${formatLabels({ ...entry.labels, le: String(bucket) })} ${entry.counts[i] ?? 0}`,
          );
        });
        lines.push(`${name}_bucket${formatLabels({ ...entry.labels, le: '+Inf' })} ${entry.count}`);
        lines.push(`${name}_sum${formatLabels(entry.labels)} ${entry.sum}`);
        lines.push(`${name}_count${formatLabels(entry.labels)} ${entry.count}`);
      }
    }

    for (const [name, state] of this.gauges) {
      lines.push(`# HELP ${name} ${state.help}`, `# TYPE ${name} gauge`);
      try {
        const reading = await state.getter();
        if (typeof reading === 'number') {
          lines.push(`${name} ${reading}`);
        } else {
          for (const sample of reading.slice(0, MAX_SERIES_PER_METRIC)) {
            lines.push(`${name}${formatLabels(sample.labels ?? {})} ${sample.value}`);
          }
        }
      } catch {
        // A gauge whose source is unreachable is OMITTED, not reported as 0 —
        // zero queue depth and an unreachable queue are different facts.
        // Alert on the series being ABSENT, not only on its value.
      }
    }

    return `${lines.join('\n')}\n`;
  }

  /** Test seam. */
  reset(): void {
    for (const state of this.counters.values()) state.values.clear();
    for (const state of this.histograms.values()) state.values.clear();
  }
}

function formatLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return '';
  const rendered = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escapeLabel(normalizeLabelValue(v))}"`)
    .join(',');
  return `{${rendered}}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Metric names, centralised so dashboards and code cannot drift apart. */
export const METRICS = {
  apiRequestDuration: 'spectra_api_request_duration_ms',
  apiRequestErrors: 'spectra_api_request_errors_total',
  apiRateLimited: 'spectra_api_rate_limited_total',
  workerJobDuration: 'spectra_worker_job_duration_ms',
  workerJobFailures: 'spectra_worker_job_failures_total',
  queueDepth: 'spectra_queue_depth',
  queueDeadLettered: 'spectra_queue_dead_lettered_total',
  providerLatency: 'spectra_provider_latency_ms',
  researchRunDuration: 'spectra_research_run_duration_ms',
  publishAttemptDuration: 'spectra_publish_attempt_duration_ms',
  budgetBlocked: 'spectra_budget_blocked_total',
  opsJobRetries: 'spectra_ops_job_retries_total',
  oauthFlows: 'spectra_oauth_flows_total',
} as const;

/** Registers every metric the platform reports. */
export function createRegistry(): MetricsRegistry {
  const registry = new MetricsRegistry();
  registry.histogram(METRICS.apiRequestDuration, 'API request duration in milliseconds.');
  registry.counter(METRICS.apiRequestErrors, 'API responses with a 4xx or 5xx status.');
  registry.counter(METRICS.apiRateLimited, 'Requests rejected by the rate limiter.');
  registry.histogram(METRICS.workerJobDuration, 'Worker job execution duration in milliseconds.');
  registry.counter(METRICS.workerJobFailures, 'Worker jobs that ended in failure.');
  registry.counter(
    METRICS.queueDeadLettered,
    'Jobs that exhausted their retries and were dead-lettered.',
  );
  registry.histogram(METRICS.providerLatency, 'External provider call latency in milliseconds.');
  registry.histogram(METRICS.researchRunDuration, 'Research run duration in milliseconds.');
  registry.histogram(METRICS.publishAttemptDuration, 'Publish attempt duration in milliseconds.');
  registry.counter(METRICS.budgetBlocked, 'Operations refused by a budget pre-flight.');
  registry.counter(METRICS.opsJobRetries, 'Failed jobs re-run from the operations dashboard.');
  registry.counter(
    METRICS.oauthFlows,
    'OAuth start, callback, refresh and disconnect outcomes by platform.',
  );
  return registry;
}

/** Process-wide registry. */
export const metrics = createRegistry();
