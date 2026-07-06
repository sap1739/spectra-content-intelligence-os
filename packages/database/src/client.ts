import { PrismaClient } from '@prisma/client';

import { assertTenantScopedArgs } from './tenant-guard';

export interface CreatePrismaClientOptions {
  datasourceUrl?: string;
  /** Enable the tenant-scope query guard (recommended everywhere). */
  tenantGuard?: boolean;
  log?: Array<'query' | 'info' | 'warn' | 'error'>;
}

/**
 * Creates the shared Prisma client. With `tenantGuard` enabled (default),
 * multi-row queries on tenant-scoped models throw unless they filter by
 * organizationId — a safety net beneath service-level authorization.
 */
export function createPrismaClient(options: CreatePrismaClientOptions = {}) {
  const { datasourceUrl, tenantGuard = true, log = ['warn', 'error'] } = options;

  const client = new PrismaClient({
    ...(datasourceUrl ? { datasources: { db: { url: datasourceUrl } } } : {}),
    log,
  });

  // Always return the extended shape (single type) — the guard flag only
  // toggles enforcement, keeping $transaction overloads intact for callers.
  return client.$extends({
    name: 'tenant-guard',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (tenantGuard) {
            assertTenantScopedArgs(model, operation, args);
          }
          return query(args);
        },
      },
    },
  });
}

export type SpectraPrismaClient = ReturnType<typeof createPrismaClient>;
