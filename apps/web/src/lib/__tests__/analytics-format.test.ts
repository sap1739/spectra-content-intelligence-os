import { describe, expect, it } from 'vitest';

import { availabilityVariant, formatMetricValue, freshnessLabel } from '../analytics';

/**
 * Analytics display (Phase 6H, ADR-0039). The formatter is where "unavailable"
 * and "zero" would be confused if anywhere — so it is pinned here.
 */
describe('formatMetricValue', () => {
  it('renders a missing metric as Unavailable with its reason — never 0', () => {
    const text = formatMetricValue({
      value: null,
      unit: 'COUNT',
      completeness: 'UNAVAILABLE',
      unavailableReason: 'MISSING_SCOPE',
    });
    expect(text).toBe('Unavailable · Missing permission');
    expect(text).not.toMatch(/\b0\b/);
    expect(formatMetricValue({ value: null, unit: 'COUNT', completeness: 'UNAVAILABLE' })).toBe(
      'Unavailable',
    );
  });

  it('renders a reported zero as 0', () => {
    expect(formatMetricValue({ value: 0, unit: 'COUNT', completeness: 'EXACT' })).toBe('0');
  });

  it('marks approximate values and formats units', () => {
    expect(formatMetricValue({ value: 12300, unit: 'COUNT', completeness: 'APPROXIMATE' })).toBe(
      '≈ 12,300',
    );
    expect(formatMetricValue({ value: 0.0541, unit: 'RATIO', completeness: 'DERIVED' })).toBe(
      '5.41%',
    );
    expect(formatMetricValue({ value: 1250.4, unit: 'MINUTES', completeness: 'EXACT' })).toBe(
      '1,250 min',
    );
  });
});

describe('freshnessLabel', () => {
  const now = new Date('2026-09-14T12:00:00Z');
  it('distinguishes never synced, fresh and stale', () => {
    expect(
      freshnessLabel(
        { state: 'NEVER_SYNCED', retrievedAt: null, staleAfter: null, dataAsOf: null, note: null },
        now,
      ),
    ).toBe('Never synced');
    expect(
      freshnessLabel(
        {
          state: 'FRESH',
          retrievedAt: '2026-09-14T11:30:00Z',
          staleAfter: null,
          dataAsOf: null,
          note: null,
        },
        now,
      ),
    ).toBe('Fresh · retrieved 30 min ago');
    expect(
      freshnessLabel(
        {
          state: 'STALE',
          retrievedAt: '2026-09-11T12:00:00Z',
          staleAfter: null,
          dataAsOf: null,
          note: null,
        },
        now,
      ),
    ).toBe('Stale · retrieved 3 d ago');
  });
});

describe('availabilityVariant', () => {
  it('never shows an unavailable provider as healthy', () => {
    expect(availabilityVariant('AVAILABLE')).toBe('success');
    for (const state of [
      'NOT_IMPLEMENTED',
      'UNSUPPORTED',
      'UNCONFIGURED',
      'NOT_CONNECTED',
    ] as const) {
      expect(availabilityVariant(state)).toBe('muted');
    }
    expect(availabilityVariant('MISSING_SCOPE')).toBe('warning');
  });
});
