import { PERMISSIONS, ROLES } from '@spectra/contracts';
import { describe, expect, it } from 'vitest';

import { ForbiddenError } from './errors';
import { ROLE_PERMISSIONS, assertPermission, hasPermission } from './permissions';

describe('role permission bundles', () => {
  it('covers every role', () => {
    for (const role of ROLES) {
      expect(ROLE_PERMISSIONS[role]).toBeDefined();
    }
  });

  it('grants org owners everything and read-only nothing writable', () => {
    expect(ROLE_PERMISSIONS.ORG_OWNER).toHaveLength(PERMISSIONS.length);
    for (const permission of ROLE_PERMISSIONS.READ_ONLY) {
      expect(permission.endsWith(':read')).toBe(true);
    }
  });

  it('keeps billing exclusive to org owners among built-in bundles', () => {
    const rolesWithBilling = ROLES.filter((role) =>
      ROLE_PERMISSIONS[role].includes('org:billing:manage'),
    );
    expect(rolesWithBilling).toEqual(['ORG_OWNER']);
  });
});

describe('hasPermission', () => {
  it('checks the role bundle', () => {
    expect(hasPermission({ role: 'RESEARCHER' }, 'research:run')).toBe(true);
    expect(hasPermission({ role: 'RESEARCHER' }, 'social:publish')).toBe(false);
  });

  it('honours explicit extra grants beyond the role', () => {
    expect(
      hasPermission(
        { role: 'CLIENT_REVIEWER', extraPermissions: ['analytics:read'] },
        'analytics:read',
      ),
    ).toBe(true);
  });

  it('assertPermission throws ForbiddenError with the missing permission', () => {
    try {
      assertPermission({ role: 'READ_ONLY' }, 'content:approve');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).permission).toBe('content:approve');
    }
  });
});
