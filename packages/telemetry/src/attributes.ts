/**
 * Span-attribute policy (ADR-0033).
 *
 * Traces leave the process and land in a third-party backend that is not
 * covered by our log redaction, is often retained longer than logs, and is
 * frequently readable by more people. So spans use an **allow-list**, not a
 * deny-list: an attribute is dropped unless it is explicitly known to be safe.
 *
 * A deny-list would be the wrong shape here — it fails open on every new field
 * anyone adds, and the cost of one mistake is a credential in a vendor's UI.
 */

/** Attribute keys that may be recorded on a span. */
export const ALLOWED_SPAN_ATTRIBUTES = new Set([
  // Identity of the work, never its content.
  'spectra.operation',
  'spectra.job.name',
  'spectra.job.id',
  'spectra.job.attempt',
  'spectra.run.id',
  'spectra.draft.id',
  'spectra.entry.id',
  'spectra.correlation_id',
  // Tenancy — opaque UUIDs, needed to trace a customer issue.
  'spectra.organization_id',
  'spectra.workspace_id',
  // Provider identity and outcome, never prompts or responses.
  'spectra.provider',
  'spectra.model',
  'spectra.platform',
  'spectra.outcome',
  'spectra.failure_code',
  // Counts and sizes are safe; the things they count are not.
  'spectra.count',
  'spectra.duration_ms',
  'spectra.status_code',
  // Standard HTTP/RPC conventions.
  'http.request.method',
  'http.route',
  'http.response.status_code',
  'url.path',
  'server.address',
]);

export type SpanAttributeValue = string | number | boolean;

/**
 * Filters an attribute bag down to the allow-list.
 *
 * Values are additionally bounded and coerced: an unbounded string could carry
 * a whole document body under an otherwise-safe key.
 */
export function safeSpanAttributes(
  attributes: Record<string, unknown>,
): Record<string, SpanAttributeValue> {
  const safe: Record<string, SpanAttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!ALLOWED_SPAN_ATTRIBUTES.has(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = value;
      continue;
    }
    if (typeof value === 'string') {
      // 256 chars is ample for an id, a model name or a route, and far too
      // little to smuggle a prompt or a document through.
      safe[key] = value.length > 256 ? `${value.slice(0, 256)}…` : value;
    }
    // Objects and arrays are dropped entirely: they are the easiest way for
    // an unexpected payload to reach a span.
  }
  return safe;
}
