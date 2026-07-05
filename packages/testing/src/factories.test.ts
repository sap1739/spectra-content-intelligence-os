import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildBrand,
  buildMembership,
  buildOrganization,
  buildResearchFinding,
  buildResearchProject,
  buildResearchSource,
  buildTenant,
  buildTrendCandidate,
  buildUser,
  buildVertical,
  buildWorkspace,
  resetFactorySequence,
} from './factories';

describe('deterministic factories', () => {
  beforeEach(() => {
    resetFactorySequence();
  });

  it('produces identical objects across runs (determinism)', () => {
    const first = buildUser();
    resetFactorySequence();
    const second = buildUser();
    expect(first).toEqual(second);
  });

  it('builds a full schema-valid tenant graph', () => {
    const user = buildUser();
    const org = buildOrganization();
    const membership = buildMembership(org.id, user.id, { role: 'ORG_OWNER' });
    const workspace = buildWorkspace(org.id);
    const tenant = { organizationId: org.id, workspaceId: workspace.id };

    const brand = buildBrand(tenant);
    const vertical = buildVertical(tenant);
    const project = buildResearchProject(tenant, { verticalId: vertical.id, brandId: brand.id });
    const source = buildResearchSource(tenant, project.id);
    const finding = buildResearchFinding(tenant, project.id, source.id);
    const trend = buildTrendCandidate(tenant, { projectId: project.id });

    expect(membership.organizationId).toBe(org.id);
    expect(finding.sourceId).toBe(source.id);
    expect(trend.projectId).toBe(project.id);
    expect(finding.provenance.providerId).toBe('fixture-web-search');
  });

  it('supports overrides while staying schema-valid', () => {
    const tenant = buildTenant();
    const vertical = buildVertical(tenant, {
      name: 'Hyderabad real estate',
      industry: 'Real estate',
      geographies: ['Hyderabad, India'],
      languages: ['en', 'te'],
    });
    expect(vertical.industry).toBe('Real estate');
    expect(vertical.geographies).toContain('Hyderabad, India');
  });

  it('rejects overrides that violate the contract', () => {
    const tenant = buildTenant();
    expect(() => buildVertical(tenant, { slug: 'NOT A SLUG' })).toThrow();
  });
});
