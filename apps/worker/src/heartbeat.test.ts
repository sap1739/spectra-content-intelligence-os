import { describe, expect, it } from 'vitest';

import { buildHeartbeat } from './heartbeat';

describe('buildHeartbeat', () => {
  const startedAt = new Date('2026-07-01T10:00:00.000Z');

  it('produces a UTC heartbeat with uptime', () => {
    const beat = buildHeartbeat({
      pid: 4242,
      hostname: 'test-host',
      startedAt,
      now: new Date('2026-07-01T10:05:30.000Z'),
    });
    expect(beat).toEqual({
      service: 'worker',
      pid: 4242,
      hostname: 'test-host',
      startedAt: '2026-07-01T10:00:00.000Z',
      at: '2026-07-01T10:05:30.000Z',
      uptimeSeconds: 330,
    });
  });

  it('never reports negative uptime (clock skew safety)', () => {
    const beat = buildHeartbeat({
      pid: 1,
      hostname: 'h',
      startedAt,
      now: new Date('2026-07-01T09:59:59.000Z'),
    });
    expect(beat.uptimeSeconds).toBe(0);
  });
});
