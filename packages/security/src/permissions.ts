import { PERMISSIONS, type Permission, type Role } from '@spectra/contracts';

import { ForbiddenError } from './errors';

/**
 * Role → permission bundles. Roles are convenience labels; every check in the
 * codebase tests a permission, never a role name, so custom roles and
 * per-membership grants remain possible.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  ORG_OWNER: [...PERMISSIONS],
  ORG_ADMIN: PERMISSIONS.filter((p) => p !== 'org:billing:manage'),
  WORKSPACE_ADMIN: [
    'workspace:manage',
    'workspace:members:manage',
    'brand:read',
    'brand:write',
    'vertical:read',
    'vertical:write',
    'research:read',
    'research:run',
    'research:review',
    'trend:read',
    'trend:review',
    'knowledge:read',
    'knowledge:write',
    'strategy:read',
    'strategy:write',
    'content:read',
    'content:write',
    'content:review',
    'content:approve',
    'campaign:read',
    'campaign:write',
    'media:read',
    'media:write',
    'social:connect',
    'social:publish',
    'analytics:read',
    'audit:read',
  ],
  RESEARCHER: [
    'vertical:read',
    'brand:read',
    'research:read',
    'research:run',
    'research:review',
    'trend:read',
    'knowledge:read',
    'knowledge:write',
    'analytics:read',
  ],
  CONTENT_STRATEGIST: [
    'brand:read',
    'vertical:read',
    'research:read',
    'trend:read',
    'trend:review',
    'knowledge:read',
    'strategy:read',
    'strategy:write',
    'campaign:read',
    'campaign:write',
    'content:read',
    'analytics:read',
  ],
  CREATOR: [
    'brand:read',
    'vertical:read',
    'research:read',
    'trend:read',
    'knowledge:read',
    'strategy:read',
    'content:read',
    'content:write',
    'campaign:read',
    'media:read',
    'media:write',
  ],
  DESIGNER: ['brand:read', 'content:read', 'campaign:read', 'media:read', 'media:write'],
  EDITOR: [
    'brand:read',
    'research:read',
    'content:read',
    'content:write',
    'content:review',
    'campaign:read',
    'media:read',
  ],
  APPROVER: [
    'brand:read',
    'research:read',
    'content:read',
    'content:review',
    'content:approve',
    'campaign:read',
  ],
  PUBLISHER: [
    'content:read',
    'campaign:read',
    'social:connect',
    'social:publish',
    'analytics:read',
  ],
  ANALYST: ['content:read', 'campaign:read', 'trend:read', 'research:read', 'analytics:read'],
  CLIENT_REVIEWER: ['content:read', 'content:review', 'campaign:read'],
  READ_ONLY: [
    'brand:read',
    'vertical:read',
    'research:read',
    'trend:read',
    'strategy:read',
    'content:read',
    'campaign:read',
    'media:read',
    'analytics:read',
  ],
};

export interface PermissionSubject {
  role: Role;
  /** Explicit grants beyond the role bundle (from Membership.extraPermissions). */
  extraPermissions?: readonly Permission[];
}

export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function hasPermission(subject: PermissionSubject, permission: Permission): boolean {
  return (
    ROLE_PERMISSIONS[subject.role].includes(permission) ||
    (subject.extraPermissions?.includes(permission) ?? false)
  );
}

export function assertPermission(subject: PermissionSubject, permission: Permission): void {
  if (!hasPermission(subject, permission)) {
    throw new ForbiddenError(permission);
  }
}
