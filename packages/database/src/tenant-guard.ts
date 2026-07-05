/**
 * Defence-in-depth for tenant isolation at the data layer.
 *
 * Primary enforcement lives in services (assertTenantOwnership from
 * @spectra/security). This guard adds a second net: multi-row queries against
 * tenant-scoped models must carry an organizationId filter, or they throw.
 */

export class TenantScopeViolationError extends Error {
  constructor(model: string, operation: string) {
    super(`Query ${operation} on tenant-scoped model ${model} is missing an organizationId filter`);
    this.name = 'TenantScopeViolationError';
  }
}

/** Models that must always be queried with a tenant filter. */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set([
  'Membership',
  'Workspace',
  'Brand',
  'CustomVertical',
  'ResearchProject',
  'ResearchRun',
  'ResearchSource',
  'ResearchFinding',
  'TrendCandidate',
  'AuditLog',
]);

const GUARDED_OPERATIONS: ReadonlySet<string> = new Set([
  'findMany',
  'findFirst',
  'updateMany',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

interface WhereArgs {
  where?: Record<string, unknown>;
}

function whereHasTenantFilter(where: Record<string, unknown> | undefined): boolean {
  if (!where) return false;
  if ('organizationId' in where && where['organizationId'] != null) return true;
  // Accept tenant filters nested one level inside AND — common query shape.
  const and = where['AND'];
  if (Array.isArray(and)) {
    return and.some(
      (clause) =>
        clause &&
        typeof clause === 'object' &&
        (clause as Record<string, unknown>)['organizationId'] != null,
    );
  }
  return false;
}

/**
 * Pure check used by the Prisma client extension (and unit tests).
 * Throws when a guarded model + operation lacks a tenant filter.
 */
export function assertTenantScopedArgs(
  model: string | undefined,
  operation: string,
  args: unknown,
): void {
  if (!model || !TENANT_SCOPED_MODELS.has(model) || !GUARDED_OPERATIONS.has(operation)) {
    return;
  }
  const where = (args as WhereArgs | undefined)?.where;
  if (!whereHasTenantFilter(where)) {
    throw new TenantScopeViolationError(model, operation);
  }
}
