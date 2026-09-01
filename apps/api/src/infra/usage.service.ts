import { Injectable } from '@nestjs/common';
import type { TenantScope } from '@spectra/contracts';
import { PrismaUsageRecorder, type UsageRecord, type UsageRecorder } from '@spectra/metering';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Nest-injectable usage ledger. Thin wrapper over PrismaUsageRecorder so API
 * request paths (knowledge search, generation) meter the same way the worker
 * does — one ledger, one set of rates.
 */
@Injectable()
export class UsageService implements UsageRecorder {
  private readonly recorder: UsageRecorder;

  constructor(prisma: PrismaService) {
    this.recorder = new PrismaUsageRecorder(prisma.client);
  }

  record(tenant: TenantScope, usage: UsageRecord): Promise<void> {
    return this.recorder.record(tenant, usage);
  }
}
