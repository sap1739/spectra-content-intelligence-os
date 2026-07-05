import { describe, expect, it } from 'vitest';

import { aggregateHealth, type HealthIndicator } from './health';

const up = (name: string): HealthIndicator => ({
  name,
  check: async () => ({ status: 'up' }),
});

const down = (name: string, optional = false): HealthIndicator => ({
  name,
  optional,
  check: async () => ({ status: 'down', detail: `${name} unreachable` }),
});

const throwing = (name: string): HealthIndicator => ({
  name,
  check: async () => {
    throw new Error('boom');
  },
});

describe('aggregateHealth', () => {
  it('reports up when all components are up', async () => {
    const result = await aggregateHealth([up('db'), up('redis')]);
    expect(result.status).toBe('up');
    expect(result.components).toHaveLength(2);
    expect(result.checkedAt).toMatch(/Z$/);
  });

  it('reports down when a required component is down', async () => {
    const result = await aggregateHealth([up('db'), down('redis')]);
    expect(result.status).toBe('down');
  });

  it('reports degraded when only an optional component is down', async () => {
    const result = await aggregateHealth([up('db'), down('worker-heartbeat', true)]);
    expect(result.status).toBe('degraded');
  });

  it('treats indicator exceptions as down instead of crashing', async () => {
    const result = await aggregateHealth([throwing('db')]);
    expect(result.status).toBe('down');
    expect(result.components[0]?.detail).toBe('boom');
  });
});
