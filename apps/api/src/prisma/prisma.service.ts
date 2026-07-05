import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createPrismaClient, type SpectraPrismaClient } from '@spectra/database';

import { getApiEnv } from '../config/env';

/**
 * Prisma access with the tenant-guard extension enabled. Connects lazily on
 * first query so liveness endpoints work even when the database is down.
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  public readonly client: SpectraPrismaClient;

  constructor() {
    this.client = createPrismaClient({ datasourceUrl: getApiEnv().DATABASE_URL });
  }

  async ping(): Promise<void> {
    await this.client.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
