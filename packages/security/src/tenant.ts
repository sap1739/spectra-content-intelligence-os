import { TenantIsolationError } from './errors';

/**
 * Tenant isolation guard used at every trust boundary (API handlers, worker
 * jobs, storage access). Looking up a record by a guessed id must fail with
 * the same generic error as a missing record — existence is never revealed.
 */

export interface TenantContext {
  organizationId: string;
  workspaceId?: string;
}

export interface TenantOwned {
  organizationId: string;
  workspaceId?: string | null;
}

/**
 * Asserts that `resource` belongs to the caller's tenant. Pass `null` for a
 * resource that was not found — the caller gets the same error either way.
 */
export function assertTenantOwnership(
  resource: TenantOwned | null | undefined,
  context: TenantContext,
): asserts resource is TenantOwned {
  if (!resource) {
    throw new TenantIsolationError();
  }
  if (resource.organizationId !== context.organizationId) {
    throw new TenantIsolationError();
  }
  if (
    context.workspaceId !== undefined &&
    resource.workspaceId != null &&
    resource.workspaceId !== context.workspaceId
  ) {
    throw new TenantIsolationError();
  }
}
