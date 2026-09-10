import { describe, expect, it } from 'vitest';

import { formatMicros } from '../usage';

/**
 * Cost display (Phase 6A).
 *
 * These figures are ESTIMATES (ADR-0026). The formatter must never turn an
 * unknown cost into "$0.00", because that asserts the operation was free.
 */
describe('formatMicros', () => {
  it('renders null as a dash, not as zero', () => {
    // The distinction the whole metering layer exists to preserve.
    expect(formatMicros(null)).toBe('—');
  });

  it('renders a genuine zero as zero', () => {
    expect(formatMicros(0)).toBe('$0.00');
  });

  it('keeps sub-cent amounts visible instead of rounding them away', () => {
    // 5000 micros = $0.005. Rounding to $0.01 or $0.00 would misreport it.
    expect(formatMicros(5_000)).toBe('$0.0050');
  });

  it('renders ordinary amounts to two decimals', () => {
    expect(formatMicros(1_500_000)).toBe('$1.50');
    expect(formatMicros(12_340_000)).toBe('$12.34');
  });
});
