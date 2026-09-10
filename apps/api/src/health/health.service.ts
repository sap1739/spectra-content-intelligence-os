import { Injectable } from '@nestjs/common';
import {
  aggregateHealth,
  type AggregatedHealth,
  type HealthIndicator,
} from '@spectra/observability';

import { PrismaService } from '../prisma/prisma.service';
import { OpsService } from '../ops/ops.service';
import { RedisService } from '../redis/redis.service';
import { StorageHealthService } from '../infra/storage-health.service';

export const WORKER_HEARTBEAT_KEY = 'spectra:worker:heartbeat';
/** Heartbeats older than this are considered stale. */
export const WORKER_HEARTBEAT_STALE_MS = 90_000;

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly ops: OpsService,
    private readonly storage: StorageHealthService,
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
      {
        // Queue reachability is distinct from Redis reachability: Redis can be
        // up while the queue is unusable. Optional, because the API can still
        // serve reads when background work is stalled.
        name: 'job-queue',
        optional: true,
        check: async () => {
          const status = await this.ops.queueStatus();
          if (!status.reachable || !status.counts) {
            return { status: 'down' as const, detail: 'queue unreachable — depth unknown' };
          }
          const { waiting, active, failed, deadLettered } = status.counts;
          const detail = `waiting=${waiting} active=${active} failed=${failed} dead=${deadLettered}`;
          // A growing dead-letter queue is a real operational problem, so it
          // degrades readiness rather than passing silently.
          return deadLettered > 0
            ? { status: 'degraded' as const, detail: `${detail} — dead-lettered jobs need review` }
            : { status: 'up' as const, detail };
        },
      },
      {
        // Object storage holds source snapshots and rendered media. Optional:
        // reads and most writes still work without it.
        name: 'object-storage',
        optional: true,
        check: async () => {
          const reachable = await this.storage.isReachable();
          return reachable
            ? { status: 'up' as const }
            : { status: 'down' as const, detail: 'bucket unreachable' };
        },
      },
    ];
    return aggregateHealth(indicators);
  }
}
