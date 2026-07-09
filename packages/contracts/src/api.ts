import { z } from 'zod';

import { languageCodeSchema, slugSchema, uuidSchema } from './common';
import { contentTypeSchema, funnelStageSchema } from './strategy';
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

// ---------------------------------------------------------------------------
// Content items & evidence-grounded drafts (Phase 3)
// ---------------------------------------------------------------------------

export const createContentItemInputSchema = z.object({
  title: z.string().min(1).max(500),
  contentType: contentTypeSchema.default('POST'),
  objective: z.string().max(2000).optional(),
  funnelStage: funnelStageSchema.optional(),
  campaignId: uuidSchema.optional(),
  brandId: uuidSchema.optional(),
  verticalId: uuidSchema.optional(),
  /** Optional evidence pack to ground drafts on (must be in the same tenant). */
  evidencePackId: uuidSchema.optional(),
});
export type CreateContentItemInput = z.infer<typeof createContentItemInputSchema>;

export const generateDraftInputSchema = z.object({
  /** Extra trusted guidance appended to the prompt instructions. */
  additionalGuidance: z.string().max(2000).optional(),
  targetPlatform: z.string().max(100).optional(),
  maxOutputTokens: z.number().int().min(256).max(8000).optional(),
});
export type GenerateDraftInput = z.infer<typeof generateDraftInputSchema>;

/** Human edit — replaces the content item body and records the edit. */
export const updateContentBodyInputSchema = z.object({
  body: z.string().min(1).max(200000),
  note: z.string().max(2000).optional(),
});
export type UpdateContentBodyInput = z.infer<typeof updateContentBodyInputSchema>;

/** A review decision note (approve / request-changes / reject). */
export const reviewNoteInputSchema = z.object({
  note: z.string().max(2000).optional(),
});
export type ReviewNoteInput = z.infer<typeof reviewNoteInputSchema>;

// ---------------------------------------------------------------------------
// Strategy entities (Phase 3C)
// ---------------------------------------------------------------------------

const strList = (max = 500) => z.array(z.string().min(1).max(max)).max(50).default([]);

export const createPersonaInputSchema = z.object({
  name: z.string().min(1).max(300),
  description: z.string().max(5000).optional(),
  roles: strList(200),
  seniority: z.string().max(200).optional(),
  industries: strList(200),
  painPoints: strList(500),
  goals: strList(500),
  preferredPlatforms: strList(100),
  languages: z.array(languageCodeSchema).max(50).default([]),
});
export type CreatePersonaInput = z.infer<typeof createPersonaInputSchema>;

export const createPillarInputSchema = z.object({
  name: z.string().min(1).max(300),
  description: z.string().max(2000).optional(),
  keywords: strList(200),
  brandId: uuidSchema.optional(),
});
export type CreatePillarInput = z.infer<typeof createPillarInputSchema>;

export const createTopicIdeaInputSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  pillarId: uuidSchema.optional(),
  verticalId: uuidSchema.optional(),
  evidencePackId: uuidSchema.optional(),
  findingIds: z.array(uuidSchema).max(100).default([]),
  trendCandidateIds: z.array(uuidSchema).max(100).default([]),
  citationIds: z.array(uuidSchema).max(100).default([]),
});
export type CreateTopicIdeaInput = z.infer<typeof createTopicIdeaInputSchema>;

export const updateTopicIdeaStatusInputSchema = z.object({
  status: z.enum(['PROPOSED', 'SHORTLISTED', 'IN_USE', 'DISCARDED']),
});
export type UpdateTopicIdeaStatusInput = z.infer<typeof updateTopicIdeaStatusInputSchema>;

export const createCampaignInputSchema = z.object({
  name: z.string().min(1).max(300),
  description: z.string().max(5000).optional(),
  brandId: uuidSchema.optional(),
  verticalId: uuidSchema.optional(),
  status: z
    .enum(['DRAFT', 'PLANNED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'])
    .default('DRAFT'),
  timezone: z.string().min(1).max(100).default('UTC'),
  startAt: z.string().datetime().optional(),
  endAt: z.string().datetime().optional(),
});
export type CreateCampaignInput = z.infer<typeof createCampaignInputSchema>;

export const upsertCampaignBriefInputSchema = z.object({
  background: z.string().max(20000).optional(),
  objectives: strList(1000),
  keyMessages: strList(1000),
  mandatories: strList(1000),
  doNots: strList(1000),
  tone: z.string().max(1000).optional(),
});
export type UpsertCampaignBriefInput = z.infer<typeof upsertCampaignBriefInputSchema>;
