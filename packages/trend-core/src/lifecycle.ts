import type { TrendState } from '@spectra/contracts';

/** Allowed trend state transitions. Everything starts UNVERIFIED. */
export const TREND_STATE_TRANSITIONS: Record<TrendState, readonly TrendState[]> = {
  UNVERIFIED: ['EMERGING', 'SEASONAL', 'EVERGREEN', 'REJECTED'],
  EMERGING: ['ACCELERATING', 'STABLE', 'DECLINING', 'REJECTED'],
  ACCELERATING: ['PEAKING', 'STABLE', 'DECLINING'],
  PEAKING: ['STABLE', 'DECLINING'],
  STABLE: ['ACCELERATING', 'DECLINING', 'EVERGREEN'],
  DECLINING: ['STABLE', 'REJECTED', 'SEASONAL'],
  SEASONAL: ['EMERGING', 'ACCELERATING', 'DECLINING'],
  EVERGREEN: ['STABLE', 'DECLINING'],
  REJECTED: [],
};

export function canTransitionTrend(from: TrendState, to: TrendState): boolean {
  return TREND_STATE_TRANSITIONS[from].includes(to);
}
