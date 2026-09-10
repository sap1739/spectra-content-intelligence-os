import type { AuthMeResponse } from '@spectra/contracts';
import { renderHook } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { WorkspaceProvider, usePermissions } from '../auth';

/**
 * Permission gating (Phase 6A).
 *
 * The UI previously branched on role NAMES, which contradicts the project's own
 * rule ("Permissions, not roles"). These lock in the corrected behaviour: the
 * hook reads server-resolved effective permissions and never inspects the role.
 */

function makeMe(overrides: {
  permissions?: string[];
  role?: string;
  organizationId?: string;
}): AuthMeResponse {
  const organizationId = overrides.organizationId ?? 'org-1';
  return {
    user: {
      id: 'u1',
      email: 'a@b.test',
      name: 'Tester',
      timezone: 'UTC',
      locale: 'en',
    },
    memberships: [
      {
        organizationId,
        organizationName: 'Org',
        organizationSlug: 'org',
        role: overrides.role ?? 'VIEWER',
        extraPermissions: [],
        effectivePermissions: (overrides.permissions ?? []) as never,
        workspaceIds: [],
      },
    ],
    workspaces: [
      {
        id: 'ws-1',
        organizationId,
        name: 'Workspace',
        slug: 'ws',
        timezone: 'UTC',
        status: 'ACTIVE',
      },
    ],
  } as unknown as AuthMeResponse;
}

function wrapperFor(me: AuthMeResponse) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <WorkspaceProvider me={me}>{children}</WorkspaceProvider>;
  };
}

describe('usePermissions', () => {
  it('grants a permission the membership actually has', () => {
    const { result } = renderHook(() => usePermissions(), {
      wrapper: wrapperFor(makeMe({ permissions: ['brand:read', 'brand:write'] })),
    });
    expect(result.current.can('brand:write')).toBe(true);
    expect(result.current.permissions).toContain('brand:read');
  });

  it('denies a permission the membership lacks', () => {
    const { result } = renderHook(() => usePermissions(), {
      wrapper: wrapperFor(makeMe({ permissions: ['brand:read'] })),
    });
    expect(result.current.can('brand:write')).toBe(false);
  });

  it('ignores the role name entirely', () => {
    // An imposing role with no permissions grants nothing — the label is not
    // the authority, the permission list is.
    const { result } = renderHook(() => usePermissions(), {
      wrapper: wrapperFor(makeMe({ role: 'ORG_OWNER', permissions: [] })),
    });
    expect(result.current.can('org:manage')).toBe(false);
  });

  it('returns no permissions when the active workspace has no matching membership', () => {
    const me = makeMe({ permissions: ['brand:write'], organizationId: 'org-1' });
    // Workspace points at an organization the user has no membership in.
    const detached = {
      ...me,
      workspaces: [{ ...me.workspaces[0], organizationId: 'org-other' }],
    } as AuthMeResponse;
    const { result } = renderHook(() => usePermissions(), { wrapper: wrapperFor(detached) });
    // Fails CLOSED: no membership means no permissions, never a default grant.
    expect(result.current.permissions).toHaveLength(0);
    expect(result.current.can('brand:write')).toBe(false);
  });
});
