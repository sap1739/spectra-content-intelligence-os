import { z } from 'zod';

import { languageCodeSchema, slugSchema, uuidSchema } from './common';
import { imageOperationSchema } from './media';
import { oauthReturnPathSchema, socialPlatformSchema } from './social';
import { contentTypeSchema, funnelStageSchema } from './strategy';
import { permissionSchema, roleSchema } from './tenancy';
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
  /**
   * The permissions this membership actually grants (role bundle + extras),
   * resolved server-side. The client checks THESE, never role names — role is
   * a label, permissions are the authority (CLAUDE.md).
   */
  effectivePermissions: z.array(permissionSchema),
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

/**
 * Editable workspace settings (Phase 6A). Deliberately narrow: only fields the
 * backend genuinely persists appear here — the Settings UI shows nothing it
 * cannot actually save.
 */
export const updateWorkspaceInputSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullish(),
    /** IANA timezone for DISPLAY only; storage stays UTC. */
    timezone: z.string().min(1).max(64).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceInputSchema>;

/**
 * Editable organization settings.
 *
 * Only `name`: the Organization table has no timezone column, so offering an
 * organization timezone would be a setting the backend silently drops. Timezone
 * is a workspace and user concern (CLAUDE.md: no fake settings).
 */
export const updateOrganizationInputSchema = z.object({
  name: z.string().min(1).max(200),
});
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationInputSchema>;

/** User preferences that are genuinely persisted on the User row. */
export const updateUserPreferencesInputSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    /** IANA timezone for DISPLAY only; storage stays UTC. */
    timezone: z.string().min(1).max(64).optional(),
    locale: z.string().min(2).max(20).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
export type UpdateUserPreferencesInput = z.infer<typeof updateUserPreferencesInputSchema>;

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
 * Research runs draw on two discovery paths (ADR-0025): RSS/Atom feeds the
 * operator names, and free-text queries run against registered search providers
 * (live only when one is configured — ADR-0024). At least one of the two must
 * be supplied; a search-only plan on a deployment without a search provider
 * fails loudly rather than reporting an empty success.
 */
export const startResearchRunInputSchema = z
  .object({
    feedUrls: z.array(z.string().url()).max(25).default([]),
    searchQueries: z.array(z.string().min(2).max(300)).max(10).default([]),
  })
  .refine((v) => v.feedUrls.length > 0 || v.searchQueries.length > 0, {
    message: 'Provide at least one feed URL or search query',
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

/** Schedule a content item onto the calendar for a platform at a UTC instant. */
/**
 * YouTube's own limits on a video resource, enforced here so an upload is
 * refused before the bytes are sent rather than after: a title of at most 100
 * characters, a description of at most 5,000 BYTES, and a combined tags value
 * of at most 500 characters. Titles and descriptions may contain any valid
 * UTF-8 except `<` and `>`. Thumbnails are capped at 2 MB by thumbnails.set.
 */
export const YOUTUBE_LIMITS = {
  titleChars: 100,
  descriptionBytes: 5000,
  tagsChars: 500,
  thumbnailBytes: 2 * 1024 * 1024,
} as const;

/** YouTube rejects these characters in a title or description. */
export const YOUTUBE_FORBIDDEN_TEXT = /[<>]/;

/** UTF-8 byte length, which is how YouTube measures a description. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export const YOUTUBE_PRIVACY_STATUSES = ['private', 'unlisted', 'public'] as const;
export const youtubePrivacyStatusSchema = z.enum(YOUTUBE_PRIVACY_STATUSES);
export type YouTubePrivacyStatus = z.infer<typeof youtubePrivacyStatusSchema>;

/** What a YouTube upload needs beyond the content item itself (Phase 6F). */
export const youtubeVideoMetadataSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(YOUTUBE_LIMITS.titleChars)
      .refine((value) => !YOUTUBE_FORBIDDEN_TEXT.test(value), {
        message: 'YouTube does not allow < or > in a title',
      }),
    description: z
      .string()
      .optional()
      .refine((value) => value === undefined || !YOUTUBE_FORBIDDEN_TEXT.test(value), {
        message: 'YouTube does not allow < or > in a description',
      })
      .refine(
        (value) => value === undefined || utf8ByteLength(value) <= YOUTUBE_LIMITS.descriptionBytes,
        { message: `YouTube allows ${YOUTUBE_LIMITS.descriptionBytes} bytes of description` },
      ),
    tags: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
    /** A YouTube category id for the channel's region (videoCategories.list). */
    categoryId: z
      .string()
      .regex(/^\d{1,3}$/, { message: 'must be a YouTube category id, such as 22' })
      .optional(),
    /** Defaults to private: never publish more widely than asked. */
    privacyStatus: youtubePrivacyStatusSchema.default('private'),
    /** Declared by the uploader; YouTube requires an answer. */
    madeForKids: z.boolean().default(false),
    notifySubscribers: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    const total = value.tags.join('').length;
    if (total > YOUTUBE_LIMITS.tagsChars) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tags'],
        message: `YouTube allows ${YOUTUBE_LIMITS.tagsChars} characters of tags in total; these use ${total}.`,
      });
    }
  });
export type YouTubeVideoMetadata = z.infer<typeof youtubeVideoMetadataSchema>;

/** TikTok's documented privacy levels; which are allowed comes from the creator. */
export const TIKTOK_PRIVACY_LEVELS = [
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
] as const;
export const tiktokPrivacyLevelSchema = z.enum(TIKTOK_PRIVACY_LEVELS);

/**
 * What a TikTok Direct Post needs beyond the video (Phase 6G). The caption is
 * capped at 2,200 UTF-16 runes, which is what `String#length` counts.
 */
export const tiktokVideoMetadataSchema = z.object({
  title: z.string().trim().max(2200),
  /** Defaults to private: never post more widely than asked, and an unaudited client may not. */
  privacyLevel: tiktokPrivacyLevelSchema.default('SELF_ONLY'),
  disableComment: z.boolean().default(false),
  disableDuet: z.boolean().default(false),
  disableStitch: z.boolean().default(false),
  coverTimestampMs: z.number().int().nonnegative().max(600_000).optional(),
  /** TikTok's branded-content disclosures, which the creator is responsible for. */
  brandContentToggle: z.boolean().default(false),
  brandOrganicToggle: z.boolean().default(false),
  isAigc: z.boolean().default(false),
});
export type TikTokVideoMetadata = z.infer<typeof tiktokVideoMetadataSchema>;

/**
 * What a Pinterest pin needs beyond the image (Phase 6G): the page the pin
 * should send people to. Pinterest documents no text limits for a pin, so none
 * are imposed here.
 */
export const pinterestPinMetadataSchema = z.object({
  link: z.string().url().max(2000).optional(),
});
export type PinterestPinMetadata = z.infer<typeof pinterestPinMetadataSchema>;

/** Platform-specific publishing fields, keyed by platform. */
export const publishMetadataSchema = z.object({
  youtube: youtubeVideoMetadataSchema.optional(),
  tiktok: tiktokVideoMetadataSchema.optional(),
  pinterest: pinterestPinMetadataSchema.optional(),
});
export type PublishMetadata = z.infer<typeof publishMetadataSchema>;

export const scheduleEntryInputSchema = z.object({
  contentItemId: uuidSchema,
  platform: socialPlatformSchema,
  scheduledAt: z.string().datetime(),
  note: z.string().max(2000).optional(),
  /** Optional publishing target; when set, the dispatcher attempts to publish. */
  socialAccountId: uuidSchema.optional(),
  /** One image to publish with the post (Phase 6D). Checked against the target's capabilities. */
  mediaAssetId: uuidSchema.optional(),
  /** Alternative text for that image — read by screen readers on the platform. */
  mediaAltText: z.string().trim().min(1).max(1000).optional(),
  /** A cover image for platforms that take one separately (YouTube; Phase 6F). */
  thumbnailAssetId: uuidSchema.optional(),
  /** Platform-specific publishing fields, by platform (Phase 6F). */
  publishMetadata: publishMetadataSchema.optional(),
});
export type ScheduleEntryInput = z.infer<typeof scheduleEntryInputSchema>;

// ---------------------------------------------------------------------------
// Media rendering (Phase 3F)
// ---------------------------------------------------------------------------

/**
 * Registering a file Spectra did not render — a video to publish to YouTube,
 * or a photo for a social post (Phase 6F). The API issues a short-lived signed
 * URL, the client PUTs the bytes straight to object storage, and the asset row
 * is created only once storage confirms the object, with the size storage
 * reports rather than the size the client claimed.
 */
export const mediaUploadTicketInputSchema = z.object({
  filename: z.string().trim().min(1).max(200).optional(),
  mimeType: z.string().trim().min(3).max(120),
  sizeBytes: z.number().int().positive(),
});
export type MediaUploadTicketInput = z.infer<typeof mediaUploadTicketInputSchema>;

export const mediaUploadCompleteInputSchema = z.object({ uploadId: uuidSchema });
export type MediaUploadCompleteInput = z.infer<typeof mediaUploadCompleteInputSchema>;

/** Process an uploaded image through a sharp operation pipeline. */
export const processImageInputSchema = z.object({
  /** Base64-encoded source image (no data: prefix). Max ~10MB decoded. */
  imageBase64: z.string().min(1).max(15_000_000),
  operations: z.array(imageOperationSchema).min(1).max(10),
  outputFormat: z.enum(['jpeg', 'png', 'webp', 'avif']).default('webp'),
});
export type ProcessImageInput = z.infer<typeof processImageInputSchema>;

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

// ---------------------------------------------------------------------------
// Publishing — social accounts & variant validation (Phase 4)
// ---------------------------------------------------------------------------

export const registerSocialAccountInputSchema = z.object({
  platform: socialPlatformSchema,
  displayName: z.string().min(1).max(300),
  externalAccountId: z.string().min(1).max(500),
  kind: z.enum(['PROFILE', 'PAGE', 'CHANNEL', 'BUSINESS_ACCOUNT', 'SITE']).default('PROFILE'),
  scopes: z.array(z.string().max(200)).default([]),
  /**
   * Optional credential to seal (AES-256-GCM). Requires
   * SOCIAL_TOKEN_ENCRYPTION_KEY; the raw value is never stored or returned.
   */
  accessToken: z.string().min(1).max(8000).optional(),
});
export type RegisterSocialAccountInput = z.infer<typeof registerSocialAccountInputSchema>;

export const validateVariantInputSchema = z.object({
  platform: socialPlatformSchema,
  text: z.string().max(100000).optional(),
  hashtagCount: z.number().int().nonnegative().max(1000).optional(),
  mediaCount: z.number().int().nonnegative().max(100).optional(),
  mediaKinds: z
    .array(z.enum(['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT']))
    .max(50)
    .optional(),
});
export type ValidateVariantInput = z.infer<typeof validateVariantInputSchema>;

// ---------------------------------------------------------------------------
// Publishing — OAuth connections (Phase 6C, ADR-0034)
// ---------------------------------------------------------------------------

export const startOAuthInputSchema = z.object({
  /** Operator-facing name for the connection, e.g. "Acme LinkedIn". */
  label: z.string().trim().min(1).max(120).optional(),
  /** Allow-listed return path on the web app — never a URL. */
  returnPath: oauthReturnPathSchema.default('/social-accounts'),
});
export type StartOAuthInput = z.infer<typeof startOAuthInputSchema>;

export const reconnectOAuthInputSchema = startOAuthInputSchema.pick({ returnPath: true });
export type ReconnectOAuthInput = z.infer<typeof reconnectOAuthInputSchema>;

// ---------------------------------------------------------------------------
// Workspace budgets (Phase 5E)
// ---------------------------------------------------------------------------

/**
 * Per-workspace monthly spend ceiling. Enforced against ESTIMATED cost from the
 * versioned rate table (ADR-0026), so it is approximate by construction — the
 * budget decision always reports how many events could not be priced.
 */
export const budgetEnforcementSchema = z.enum(['OFF', 'WARN', 'ENFORCE']);
export type BudgetEnforcementMode = z.infer<typeof budgetEnforcementSchema>;

export const updateWorkspaceBudgetInputSchema = z.object({
  /** Monthly ceiling in micros (millionths of a currency unit). Null clears it. */
  monthlyLimitMicros: z.number().int().min(0).max(2_000_000_000).nullable(),
  enforcement: budgetEnforcementSchema,
  warnAtPercent: z.number().int().min(1).max(100).default(80),
});
export type UpdateWorkspaceBudgetInput = z.infer<typeof updateWorkspaceBudgetInputSchema>;

// ---------------------------------------------------------------------------
// Budget hardening (Phase 5E.1) — ADR-0028
// ---------------------------------------------------------------------------

export const usageKindSchema = z.enum([
  'AI_GENERATION',
  'AI_EMBEDDING',
  'WEB_SEARCH',
  'NEWS_SEARCH',
  'PAGE_FETCH',
  'RESEARCH_RUN',
  'CONTENT_DRAFT',
  'DOCUMENT_EXTRACTION',
  'MEDIA_RENDER',
  'PUBLISH_ATTEMPT',
]);
export type UsageKindName = z.infer<typeof usageKindSchema>;

/** Why an operation carries no cost estimate. Never absent on an unpriced row. */
export const unpricedReasonSchema = z.enum([
  'NO_RATE_FOR_MODEL',
  'FREE_LOCAL',
  'NOT_VENDOR_BILLED',
  'NO_MEASURED_QUANTITY',
  'COUNTER_ONLY',
]);
export type UnpricedReasonName = z.infer<typeof unpricedReasonSchema>;

export const rateSourceSchema = z.enum(['EXACT', 'FAMILY_FALLBACK_CONSERVATIVE']);
export type RateSourceName = z.infer<typeof rateSourceSchema>;

/** Pre-flight outcomes. UNKNOWN_COST_ALLOW_WITH_NOTICE exists so an operation we
 *  cannot price is never silently treated as free. */
export const preflightOutcomeSchema = z.enum([
  'ALLOW',
  'ALLOW_WITH_WARNING',
  'BLOCK',
  'REQUIRES_APPROVAL',
  'UNKNOWN_COST_ALLOW_WITH_NOTICE',
]);
export type PreflightOutcomeName = z.infer<typeof preflightOutcomeSchema>;

export const budgetLimitExceededReasonSchema = z.enum([
  'WORKSPACE_COST_CEILING',
  'ORGANIZATION_COST_CEILING',
  'WORKSPACE_OPERATION_LIMIT',
  'ORGANIZATION_OPERATION_LIMIT',
]);
export type BudgetLimitExceededReasonName = z.infer<typeof budgetLimitExceededReasonSchema>;

/** Shared shape for a workspace or organization spend ceiling. */
export const budgetPolicyInputSchema = z.object({
  monthlyLimitMicros: z.number().int().min(0).max(2_000_000_000).nullable(),
  enforcement: budgetEnforcementSchema,
  warnAtPercent: z.number().int().min(1).max(100).default(80),
});
export type BudgetPolicyInput = z.infer<typeof budgetPolicyInputSchema>;

export const organizationBudgetPolicyInputSchema = budgetPolicyInputSchema;
export type OrganizationBudgetPolicyInput = z.infer<typeof organizationBudgetPolicyInputSchema>;
export const workspaceBudgetPolicyInputSchema = budgetPolicyInputSchema;
export type WorkspaceBudgetPolicyInput = z.infer<typeof workspaceBudgetPolicyInputSchema>;

/** One per-operation monthly cap. Null limits mean uncapped. */
export const budgetOperationLimitInputSchema = z.object({
  kind: usageKindSchema,
  maxRequests: z.number().int().min(0).max(10_000_000).nullable(),
  maxTokens: z.number().int().min(0).max(2_000_000_000).nullable(),
});
export type BudgetOperationLimitInput = z.infer<typeof budgetOperationLimitInputSchema>;

export const updateBudgetOperationLimitsInputSchema = z.object({
  limits: z.array(budgetOperationLimitInputSchema).max(20),
});
export type UpdateBudgetOperationLimitsInput = z.infer<
  typeof updateBudgetOperationLimitsInputSchema
>;

/** Ask what WOULD happen for an operation, without performing it. */
export const budgetPreflightRequestSchema = z.object({
  kind: usageKindSchema,
  provider: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(128).optional(),
  requests: z.number().int().min(1).max(1000).default(1),
  estimatedInputTokens: z.number().int().min(0).max(10_000_000).optional(),
  estimatedOutputTokens: z.number().int().min(0).max(10_000_000).optional(),
});
export type BudgetPreflightRequest = z.infer<typeof budgetPreflightRequestSchema>;

// ---------------------------------------------------------------------------
// Claim verification & review (Phase 5H) — ADR-0032
// ---------------------------------------------------------------------------

export const claimReviewActionSchema = z.enum(['APPROVE', 'REJECT', 'REQUEST_MORE_RESEARCH']);
export type ClaimReviewActionName = z.infer<typeof claimReviewActionSchema>;

/**
 * A reviewer decision. REJECT and REQUEST_MORE_RESEARCH require a note: a
 * decision nobody can understand later is not reviewable.
 */
export const reviewClaimInputSchema = z
  .object({
    action: claimReviewActionSchema,
    note: z.string().min(1).max(2000).optional(),
  })
  .refine((v) => v.action === 'APPROVE' || (v.note !== undefined && v.note.trim().length > 0), {
    message: 'A note is required when rejecting a claim or requesting more research',
    path: ['note'],
  });
export type ReviewClaimInput = z.infer<typeof reviewClaimInputSchema>;

export const resolveContradictionInputSchema = z.object({
  status: z.enum(['RESOLVED', 'DISMISSED']),
  note: z.string().max(2000).optional(),
});
export type ResolveContradictionInput = z.infer<typeof resolveContradictionInputSchema>;
