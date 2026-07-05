import {
  brandSchema,
  customVerticalSchema,
  membershipSchema,
  organizationSchema,
  researchFindingSchema,
  researchProjectSchema,
  researchSourceSchema,
  trendCandidateSchema,
  userSchema,
  workspaceSchema,
  type Brand,
  type CustomVertical,
  type Membership,
  type Organization,
  type ResearchFinding,
  type ResearchProject,
  type ResearchSource,
  type TrendCandidate,
  type User,
  type Workspace,
} from '@spectra/contracts';

/**
 * Deterministic factories: no randomness, no clock reads. Sequence-derived
 * UUIDs and a fixed timestamp make every test run reproducible. Outputs are
 * parsed through their Zod schemas so factories can never drift from the
 * contracts.
 */

export const FIXED_TEST_TIME = '2026-01-01T00:00:00.000Z';

let sequence = 0;

export function resetFactorySequence(): void {
  sequence = 0;
}

/** RFC-4122-shaped deterministic id derived from a counter. */
export function deterministicUuid(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

function nextId(): string {
  sequence += 1;
  return deterministicUuid(sequence);
}

const timestamps = { createdAt: FIXED_TEST_TIME, updatedAt: FIXED_TEST_TIME };

export interface TenantIds {
  organizationId: string;
  workspaceId: string;
}

export function buildTenant(): TenantIds {
  return { organizationId: nextId(), workspaceId: nextId() };
}

export function buildUser(overrides: Partial<User> = {}): User {
  const id = nextId();
  return userSchema.parse({
    id,
    email: `user-${id.slice(-4)}@example.test`,
    name: `Test User ${id.slice(-4)}`,
    timezone: 'UTC',
    locale: 'en',
    status: 'ACTIVE',
    ...timestamps,
    ...overrides,
  });
}

export function buildOrganization(overrides: Partial<Organization> = {}): Organization {
  const id = nextId();
  return organizationSchema.parse({
    id,
    slug: `org-${id.slice(-4)}`,
    name: `Test Organization ${id.slice(-4)}`,
    status: 'ACTIVE',
    settings: {},
    ...timestamps,
    ...overrides,
  });
}

export function buildMembership(
  organizationId: string,
  userId: string,
  overrides: Partial<Membership> = {},
): Membership {
  return membershipSchema.parse({
    id: nextId(),
    organizationId,
    userId,
    role: 'CREATOR',
    extraPermissions: [],
    workspaceIds: [],
    status: 'ACTIVE',
    ...timestamps,
    ...overrides,
  });
}

export function buildWorkspace(
  organizationId: string,
  overrides: Partial<Workspace> = {},
): Workspace {
  const id = nextId();
  return workspaceSchema.parse({
    id,
    organizationId,
    slug: `workspace-${id.slice(-4)}`,
    name: `Test Workspace ${id.slice(-4)}`,
    timezone: 'UTC',
    settings: {},
    status: 'ACTIVE',
    ...timestamps,
    ...overrides,
  });
}

export function buildBrand(tenant: TenantIds, overrides: Partial<Brand> = {}): Brand {
  const id = nextId();
  return brandSchema.parse({
    id,
    ...tenant,
    slug: `brand-${id.slice(-4)}`,
    name: `Test Brand ${id.slice(-4)}`,
    languages: ['en'],
    guidelines: {},
    status: 'ACTIVE',
    ...timestamps,
    ...overrides,
  });
}

export function buildVertical(
  tenant: TenantIds,
  overrides: Partial<CustomVertical> = {},
): CustomVertical {
  const id = nextId();
  return customVerticalSchema.parse({
    id,
    ...tenant,
    slug: `vertical-${id.slice(-4)}`,
    name: `Test Vertical ${id.slice(-4)}`,
    status: 'ACTIVE',
    ...timestamps,
    ...overrides,
  });
}

export function buildResearchProject(
  tenant: TenantIds,
  overrides: Partial<ResearchProject> = {},
): ResearchProject {
  const id = nextId();
  return researchProjectSchema.parse({
    id,
    ...tenant,
    name: `Test Research Project ${id.slice(-4)}`,
    status: 'DRAFT',
    ...timestamps,
    ...overrides,
  });
}

export function buildResearchSource(
  tenant: TenantIds,
  projectId: string,
  overrides: Partial<ResearchSource> = {},
): ResearchSource {
  const id = nextId();
  return researchSourceSchema.parse({
    id,
    ...tenant,
    projectId,
    url: `https://example.test/articles/${id.slice(-4)}`,
    retrievedAt: FIXED_TEST_TIME,
    category: 'WEB',
    provenance: {
      providerId: 'fixture-web-search',
      providerKind: 'web-search',
      retrievedAt: FIXED_TEST_TIME,
    },
    processingStatus: 'DISCOVERED',
    metadata: {},
    ...timestamps,
    ...overrides,
  });
}

export function buildResearchFinding(
  tenant: TenantIds,
  projectId: string,
  sourceId: string,
  overrides: Partial<ResearchFinding> = {},
): ResearchFinding {
  const id = nextId();
  return researchFindingSchema.parse({
    id,
    ...tenant,
    projectId,
    sourceId,
    summary: `Deterministic test finding ${id.slice(-4)}`,
    sourceCategory: 'WEB',
    status: 'PENDING_REVIEW',
    provenance: {
      providerId: 'fixture-web-search',
      providerKind: 'web-search',
      retrievedAt: FIXED_TEST_TIME,
    },
    ...timestamps,
    ...overrides,
  });
}

export function buildTrendCandidate(
  tenant: TenantIds,
  overrides: Partial<TrendCandidate> = {},
): TrendCandidate {
  const id = nextId();
  return trendCandidateSchema.parse({
    id,
    ...tenant,
    title: `Test Trend Candidate ${id.slice(-4)}`,
    state: 'UNVERIFIED',
    ...timestamps,
    ...overrides,
  });
}
