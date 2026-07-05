import { describe, expect, it } from 'vitest';

import { TenantScopeViolationError, assertTenantScopedArgs } from './tenant-guard';

describe('assertTenantScopedArgs', () => {
  it('allows tenant-scoped findMany with an organizationId filter', () => {
    expect(() =>
      assertTenantScopedArgs('ResearchProject', 'findMany', {
        where: { organizationId: 'org-1', status: 'ACTIVE' },
      }),
    ).not.toThrow();
  });

  it('allows tenant filters nested inside AND clauses', () => {
    expect(() =>
      assertTenantScopedArgs('ResearchFinding', 'findMany', {
        where: { AND: [{ organizationId: 'org-1' }, { status: 'VALIDATED' }] },
      }),
    ).not.toThrow();
  });

  it('rejects unscoped multi-row reads of tenant data', () => {
    expect(() => assertTenantScopedArgs('ResearchProject', 'findMany', { where: {} })).toThrow(
      TenantScopeViolationError,
    );
    expect(() => assertTenantScopedArgs('TrendCandidate', 'count', {})).toThrow(
      TenantScopeViolationError,
    );
  });

  it('rejects unscoped bulk mutations', () => {
    expect(() =>
      assertTenantScopedArgs('ResearchSource', 'deleteMany', { where: { category: 'WEB' } }),
    ).toThrow(TenantScopeViolationError);
  });

  it('ignores non-tenant models and single-record primary-key operations', () => {
    expect(() => assertTenantScopedArgs('User', 'findMany', { where: {} })).not.toThrow();
    expect(() =>
      assertTenantScopedArgs('ResearchProject', 'findUnique', { where: { id: 'x' } }),
    ).not.toThrow();
  });
});
