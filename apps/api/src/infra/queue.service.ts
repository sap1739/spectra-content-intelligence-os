import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  BullMqJobQueue,
  SYSTEM_QUEUE,
  createRedisConnection,
  type EnqueueOptions,
  type ScheduleOptions,
} from '@spectra/workflow-core';

import { getApiEnv } from '../config/env';

/** Job producer for the shared system queue (worker consumes). */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly connection = createRedisConnection(getApiEnv().REDIS_URL);
  private readonly queue = new BullMqJobQueue(SYSTEM_QUEUE, this.connection);

  enqueue<TPayload>(name: string, payload: TPayload, options?: EnqueueOptions): Promise<string> {
    return this.queue.enqueue(name, payload, options);
  }

  schedule<TPayload>(name: string, payload: TPayload, options: ScheduleOptions): Promise<string> {
    return this.queue.schedule(name, payload, options);
  }

  unschedule(schedulerId: string): Promise<boolean> {
    return this.queue.unschedule(schedulerId);
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    this.connection.disconnect();
  }
}
