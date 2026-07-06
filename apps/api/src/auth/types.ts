import type { Permission, Role } from '@spectra/contracts';

/** The authenticated caller, resolved fresh per request from the database. */
export interface Principal {
  userId: string;
  email: string;
  name: string;
  memberships: PrincipalMembership[];
}

export interface PrincipalMembership {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: Role;
  extraPermissions: Permission[];
  /** Empty = access to all workspaces in the organization. */
  workspaceIds: string[];
}

/** Tenant scope resolved from route params + the caller's memberships. */
export interface TenantContext {
  organizationId: string;
  workspaceId?: string;
  membership: PrincipalMembership;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    tenant?: TenantContext;
  }
}
