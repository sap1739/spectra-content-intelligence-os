export { PrismaClient, Prisma } from '@prisma/client';
export type {
  AuditLog,
  Brand,
  Credential,
  CustomVertical,
  Membership,
  Organization,
  ResearchFinding,
  ResearchProject,
  ResearchRun,
  ResearchSource,
  TrendCandidate,
  User,
  Workspace,
} from '@prisma/client';
export { createPrismaClient } from './client';
export type { CreatePrismaClientOptions, SpectraPrismaClient } from './client';
export {
  TENANT_SCOPED_MODELS,
  TenantScopeViolationError,
  assertTenantScopedArgs,
} from './tenant-guard';
export { PgVectorStore } from './vector-store';
