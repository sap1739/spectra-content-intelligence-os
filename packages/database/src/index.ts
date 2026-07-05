export { PrismaClient, Prisma } from '@prisma/client';
export { createPrismaClient } from './client';
export type { CreatePrismaClientOptions, SpectraPrismaClient } from './client';
export {
  TENANT_SCOPED_MODELS,
  TenantScopeViolationError,
  assertTenantScopedArgs,
} from './tenant-guard';
