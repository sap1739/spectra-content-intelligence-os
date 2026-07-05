import type { Permission, Role } from '@spectra/contracts';

/**
 * Authentication DIRECTION only — Phase 1 ships no login flow.
 * ADR-0007: session-based auth (Auth.js on the web + first-party session
 * verification in the API) is the selected direction; these ports keep the
 * rest of the codebase independent of that choice.
 */

export type PrincipalKind = 'USER' | 'SERVICE' | 'SYSTEM';

export interface PrincipalMembership {
  organizationId: string;
  role: Role;
  extraPermissions: readonly Permission[];
  /** Empty array = access to all workspaces in the organization. */
  workspaceIds: readonly string[];
}

/** The authenticated caller attached to every request/job. */
export interface Principal {
  kind: PrincipalKind;
  userId?: string;
  email?: string;
  memberships: readonly PrincipalMembership[];
  activeOrganizationId?: string;
  activeWorkspaceId?: string;
}

export interface SessionContract {
  sessionId: string;
  principal: Principal;
  issuedAt: string;
  expiresAt: string;
}

/** Port implemented by the real authentication mechanism in Phase 2. */
export interface AuthProviderPort {
  readonly providerId: string;
  authenticate(input: {
    headers: Record<string, string | string[] | undefined>;
  }): Promise<Principal | null>;
}

/**
 * Encrypted token vault port for OAuth/social credentials. Implementations
 * use @spectra/security encryptSecret/decryptSecret with a managed key ring;
 * raw tokens never appear in the database, logs or API responses.
 */
export interface TokenVaultPort {
  store(tenantOrganizationId: string, plaintextToken: string): Promise<{ tokenRef: string }>;
  retrieve(tenantOrganizationId: string, tokenRef: string): Promise<string>;
  revoke(tenantOrganizationId: string, tokenRef: string): Promise<void>;
}

/** System principal used by workers and seeds; carries no user identity. */
export const SYSTEM_PRINCIPAL: Principal = {
  kind: 'SYSTEM',
  memberships: [],
};
