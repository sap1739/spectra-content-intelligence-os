import { z } from 'zod';

import { languageCodeSchema, slugSchema, uuidSchema } from './common';
import { roleSchema } from './tenancy';
import { customVerticalSchema } from './vertical';
import { brandSchema } from './vertical';
import { researchProjectSchema } from './research';

/**
 * API request/response contracts shared by the API (validation pipes) and the
 * web app (form resolvers). Kept beside the domain contracts so client and
 * server can never drift.
 */

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200);

export const registerRequestSchema = z.object({
  email: z.string().email().max(320),
  password: passwordSchema,
  name: z.string().min(1).max(200),
  /** Optional; defaults to "<name>'s organization". */
  organizationName: z.string().min(1).max(200).optional(),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const membershipSummarySchema = z.object({
  organizationId: uuidSchema,
  organizationName: z.string(),
  organizationSlug: slugSchema,
  role: z.string(),
  extraPermissions: z.array(z.string()),
  /** Empty = all workspaces in the organization. */
  workspaceIds: z.array(uuidSchema),
});

export const workspaceSummarySchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  slug: slugSchema,
  name: z.string(),
  timezone: z.string(),
});

export const authMeResponseSchema = z.object({
  user: z.object({
    id: uuidSchema,
    email: z.string().email(),
    name: z.string(),
    timezone: z.string(),
    locale: z.string(),
  }),
  memberships: z.array(membershipSummarySchema),
  workspaces: z.array(workspaceSummarySchema),
});
export type AuthMeResponse = z.infer<typeof authMeResponseSchema>;

// ---------------------------------------------------------------------------
// Workspace management
// ---------------------------------------------------------------------------

export const createWorkspaceInputSchema = z.object({
  name: z.string().min(1).max(200),
  slug: slugSchema.optional(),
  description: z.string().max(2000).optional(),
  timezone: z.string().min(1).max(64).default('UTC'),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;

// ---------------------------------------------------------------------------
// Custom verticals
// ---------------------------------------------------------------------------

/** Client-supplied fields only — ids, tenancy and audit fields are server-set. */
export const createVerticalInputSchema = customVerticalSchema
  .pick({
    name: true,
    description: true,
    industry: true,
    subIndustry: true,
    businessModel: true,
    products: true,
    services: true,
    targetAudiences: true,
    customerPainPoints: true,
    geographies: true,
    languages: true,
    competitors: true,
    keywords: true,
    excludedKeywords: true,
    trustedDomains: true,
    blockedDomains: true,
    preferredPublications: true,
    regulatoryConsiderations: true,
    seasonalEvents: true,
    commercialObjectives: true,
    contentObjectives: true,
    preferredPlatforms: true,
    relevanceCriteria: true,
  })
  .partial()
  .extend({
    name: z.string().min(1).max(200),
    slug: slugSchema.optional(),
  });
export type CreateVerticalInput = z.infer<typeof createVerticalInputSchema>;

export const updateVerticalInputSchema = createVerticalInputSchema.partial().extend({
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
});
export type UpdateVerticalInput = z.infer<typeof updateVerticalInputSchema>;

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

export const createBrandInputSchema = brandSchema
  .pick({
    name: true,
    description: true,
    websiteUrl: true,
    voice: true,
    guidelines: true,
  })
  .partial()
  .extend({
    name: z.string().min(1).max(200),
    slug: slugSchema.optional(),
    languages: z.array(languageCodeSchema).optional(),
  });
export type CreateBrandInput = z.infer<typeof createBrandInputSchema>;

export const updateBrandInputSchema = createBrandInputSchema.partial().extend({
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
});
export type UpdateBrandInput = z.infer<typeof updateBrandInputSchema>;

// ---------------------------------------------------------------------------
// Research projects
// ---------------------------------------------------------------------------

export const createResearchProjectInputSchema = researchProjectSchema
  .pick({
    name: true,
    description: true,
    objective: true,
  })
  .partial()
  .extend({
    name: z.string().min(1).max(300),
    verticalId: uuidSchema.optional(),
    brandId: uuidSchema.optional(),
  });
export type CreateResearchProjectInput = z.infer<typeof createResearchProjectInputSchema>;

export const updateResearchProjectInputSchema = createResearchProjectInputSchema.partial().extend({
  status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED']).optional(),
});
export type UpdateResearchProjectInput = z.infer<typeof updateResearchProjectInputSchema>;

// ---------------------------------------------------------------------------
// Research runs & review
// ---------------------------------------------------------------------------

/**
 * Phase 2 research runs monitor RSS/Atom feeds (first-party provider).
 * Feed URLs are user-supplied; the UI pre-fills URL-shaped entries from the
 * vertical's preferred publications.
 */
export const startResearchRunInputSchema = z.object({
  feedUrls: z.array(z.string().url()).min(1).max(25),
});
export type StartResearchRunInput = z.infer<typeof startResearchRunInputSchema>;

export const reviewFindingInputSchema = z.object({
  status: z.enum(['VALIDATED', 'REJECTED']),
});
export type ReviewFindingInput = z.infer<typeof reviewFindingInputSchema>;

/** Recurring research: every N minutes over a fixed feed set. */
export const scheduleResearchInputSchema = z.object({
  everyMinutes: z.number().int().min(15).max(10080),
  feedUrls: z.array(z.string().url()).min(1).max(25),
});
export type ScheduleResearchInput = z.infer<typeof scheduleResearchInputSchema>;

// ---------------------------------------------------------------------------
// Trend watchlists
// ---------------------------------------------------------------------------

export const createWatchlistInputSchema = z.object({
  name: z.string().min(1).max(200),
  keywords: z.array(z.string().min(1).max(200)).min(1).max(20),
  threshold: z.number().min(0.1).max(1).default(0.7),
});
export type CreateWatchlistInput = z.infer<typeof createWatchlistInputSchema>;

// ---------------------------------------------------------------------------
// Team invitations
// ---------------------------------------------------------------------------

export const createInvitationInputSchema = z.object({
  email: z.string().email().max(320),
  role: roleSchema.default('READ_ONLY'),
});
export type CreateInvitationInput = z.infer<typeof createInvitationInputSchema>;
