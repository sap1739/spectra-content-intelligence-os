/** Provider-neutral health primitives used by API readiness and worker checks. */

export type HealthStatus = 'up' | 'down' | 'degraded';

export interface ComponentHealth {
  name: string;
  status: HealthStatus;
  /** Optional human-readable detail. Must never contain secrets. */
  detail?: string;
  latencyMs?: number;
}

export interface HealthIndicator {
  name: string;
  /** Marked optional=true when failure should degrade, not fail, readiness. */
  optional?: boolean;
  check(): Promise<Omit<ComponentHealth, 'name'>>;
}

export interface AggregatedHealth {
  status: HealthStatus;
  components: ComponentHealth[];
  checkedAt: string;
}

/**
 * Runs all indicators concurrently. Overall status:
 * - `down` if any required component is down;
 * - `degraded` if any optional component is down or any component degraded;
 * - `up` otherwise.
 */
export async function aggregateHealth(
  indicators: readonly HealthIndicator[],
  now: () => Date = () => new Date(),
): Promise<AggregatedHealth> {
  const components = await Promise.all(
    indicators.map(async (indicator): Promise<ComponentHealth & { optional: boolean }> => {
      const startedAt = Date.now();
      try {
        const result = await indicator.check();
        return {
          name: indicator.name,
          optional: indicator.optional ?? false,
          latencyMs: Date.now() - startedAt,
          ...result,
        };
      } catch (error) {
        return {
          name: indicator.name,
          optional: indicator.optional ?? false,
          status: 'down',
          detail: error instanceof Error ? error.message : 'check failed',
          latencyMs: Date.now() - startedAt,
        };
      }
    }),
  );

  const requiredDown = components.some((c) => !c.optional && c.status === 'down');
  const anyDegradedOrOptionalDown = components.some(
    (c) => c.status === 'degraded' || (c.optional && c.status === 'down'),
  );

  const status: HealthStatus = requiredDown
    ? 'down'
    : anyDegradedOrOptionalDown
      ? 'degraded'
      : 'up';

  return {
    status,
    components: components.map(({ optional: _optional, ...rest }) => rest),
    checkedAt: now().toISOString(),
  };
}
