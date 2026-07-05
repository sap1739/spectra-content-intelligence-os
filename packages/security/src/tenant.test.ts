import { describe, expect, it } from 'vitest';

import { TenantIsolationError } from './errors';
import { assertTenantOwnership } from './tenant';

const ctx = { organizationId: 'org-a', workspaceId: 'ws-1' };

describe('assertTenantOwnership', () => {
  it('accepts resources in the caller tenant', () => {
    expect(() =>
      assertTenantOwnership({ organizationId: 'org-a', workspaceId: 'ws-1' }, ctx),
    ).not.toThrow();
  });

  it('accepts org-level resources without workspace when context has one', () => {
    expect(() => assertTenantOwnership({ organizationId: 'org-a' }, ctx)).not.toThrow();
  });

  it('rejects cross-organization access', () => {
    expect(() =>
      assertTenantOwnership({ organizationId: 'org-b', workspaceId: 'ws-1' }, ctx),
    ).toThrow(TenantIsolationError);
  });

  it('rejects cross-workspace access within the same organization', () => {
    expect(() =>
      assertTenantOwnership({ organizationId: 'org-a', workspaceId: 'ws-2' }, ctx),
    ).toThrow(TenantIsolationError);
  });

  it('treats missing resources identically to foreign ones (no existence leak)', () => {
    let notFoundMessage = '';
    let foreignMessage = '';
    try {
      assertTenantOwnership(null, ctx);
    } catch (error) {
      notFoundMessage = (error as Error).message;
    }
    try {
      assertTenantOwnership({ organizationId: 'org-b' }, ctx);
    } catch (error) {
      foreignMessage = (error as Error).message;
    }
    expect(notFoundMessage).toBe(foreignMessage);
  });
});
