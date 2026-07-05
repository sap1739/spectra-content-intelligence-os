import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';

import { getApiEnv } from '../config/env';

/** Lazily connecting Redis client used for readiness and worker liveness. */
@Injectable()
export class RedisService implements OnModuleDestroy {
  public readonly client: Redis;

  constructor() {
    this.client = new IORedis(getApiEnv().REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      enableOfflineQueue: false,
    });
    // Prevent unhandled error events from crashing the process when Redis
    // is down; readiness reports the failure instead.
    this.client.on('error', () => undefined);
  }

  /** Lazily connects (idempotent) — callers race during concurrent checks. */
  async ensureConnected(): Promise<void> {
    if (this.client.status === 'wait' || this.client.status === 'end') {
      await this.client.connect();
    } else if (this.client.status !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Redis connect timeout')), 2000);
        this.client.once('ready', () => {
          clearTimeout(timer);
          resolve();
        });
        this.client.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    }
  }

  async ping(): Promise<void> {
    await this.ensureConnected();
    await this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }
}
