import { Injectable } from '@nestjs/common';
import {
  aggregateHealth,
  type AggregatedHealth,
  type HealthIndicator,
} from '@spectra/observability';

import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

export const WORKER_HEARTBEAT_KEY = 'spectra:worker:heartbeat';
/** Heartbeats older than this are considered stale. */
export const WORKER_HEARTBEAT_STALE_MS = 90_000;

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  liveness(): { status: 'ok'; uptimeSeconds: number; timestamp: string } {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  async readiness(): Promise<AggregatedHealth> {
    const indicators: HealthIndicator[] = [
      {
        name: 'postgres',
        check: async () => {
          await this.prisma.ping();
          return { status: 'up' as const };
        },
      },
      {
        name: 'redis',
        check: async () => {
          await this.redis.ping();
          return { status: 'up' as const };
        },
      },
      {
        // Informational: the API can serve traffic without the worker,
        // so a missing heartbeat degrades readiness instead of failing it.
        name: 'worker-heartbeat',
        optional: true,
        check: async () => {
          await this.redis.ensureConnected();
          const raw = await this.redis.client.get(WORKER_HEARTBEAT_KEY);
          if (!raw) {
            return { status: 'down' as const, detail: 'no heartbeat recorded' };
          }
          const heartbeat = JSON.parse(raw) as { at?: string };
          const at = heartbeat.at ? Date.parse(heartbeat.at) : NaN;
          if (Number.isNaN(at) || Date.now() - at > WORKER_HEARTBEAT_STALE_MS) {
            return { status: 'degraded' as const, detail: `stale heartbeat: ${heartbeat.at}` };
          }
          return { status: 'up' as const, detail: `last heartbeat ${heartbeat.at}` };
        },
      },
    ];
    return aggregateHealth(indicators);
  }
}
