import { z } from 'zod';

import {
  auditTimestampsSchema,
  isoDateTimeSchema,
  languageCodeSchema,
  tenantScopeSchema,
  urlSchema,
  uuidSchema,
} from './common';
import { contentLifecycleStateSchema } from './lifecycle';
import { socialPlatformSchema } from './social';

/**
 * Content strategy contracts. Every generated content item can be traced back
 * to the research, trends, citations, brand, vertical, campaign, generation
 * job, prompt version, model version, human edits and approvals behind it.
 */

export const funnelStageSchema = z.enum([
  'AWARENESS',
  'CONSIDERATION',
  'CONVERSION',
  'RETENTION',
  'ADVOCACY',
]);
export type FunnelStage = z.infer<typeof funnelStageSchema>;

export const contentObjectiveSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1).max(300),
    description: z.string().max(2000).nullish(),
    kpi: z.string().max(300).nullish(),
    targetValue: z.number().nullish(),
  })
  .merge(tenantScopeSchema);
export type ContentObjective = z.infer<typeof contentObjectiveSchema>;

export const audiencePersonaSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1).max(300),
    description: z.string().max(5000).nullish(),
    roles: z.array(z.string().max(200)).default([]),
    seniority: z.string().max(200).nullish(),
    industries: z.array(z.string().max(200)).default([]),
    painPoints: z.array(z.string().max(500)).default([]),
    goals: z.array(z.string().max(500)).default([]),
    preferredPlatforms: z.array(socialPlatformSchema).default([]),
    languages: z.array(languageCodeSchema).default([]),
  })
  .merge(tenantScopeSchema);
export type AudiencePersona = z.infer<typeof audiencePersonaSchema>;

export const contentPillarSchema = z
  .object({
    id: uuidSchema,
    brandId: uuidSchema.nullish(),
    name: z.string().min(1).max(300),
    description: z.string().max(2000).nullish(),
    keywords: z.array(z.string().max(200)).default([]),
  })
  .merge(tenantScopeSchema);
export type ContentPillar = z.infer<typeof contentPillarSchema>;

/** References from strategy artifacts back into the research domain. */
export const researchReferenceSchema = z.object({
  researchProjectId: uuidSchema.nullish(),
  findingIds: z.array(uuidSchema).default([]),
  trendCandidateIds: z.array(uuidSchema).default([]),
  citationIds: z.array(uuidSchema).default([]),
  evidencePackIds: z.array(uuidSchema).default([]),
});
export type ResearchReference = z.infer<typeof researchReferenceSchema>;

export const topicIdeaSchema = z
  .object({
    id: uuidSchema,
    title: z.string().min(1).max(500),
    description: z.string().max(5000).nullish(),
    pillarId: uuidSchema.nullish(),
    verticalId: uuidSchema.nullish(),
    researchReference: researchReferenceSchema.nullish(),
    status: z.enum(['PROPOSED', 'SHORTLISTED', 'IN_USE', 'DISCARDED']),
  })
  .merge(tenantScopeSchema)
  .merge(auditTimestampsSchema);
export type TopicIdea = z.infer<typeof topicIdeaSchema>;

export const contentAngleSchema = z.object({
  id: uuidSchema,
  topicIdeaId: uuidSchema,
  angle: z.string().min(1).max(1000),
  rationale: z.string().max(2000).nullish(),
  personaIds: z.array(uuidSchema).default([]),
  funnelStage: funnelStageSchema,
});
export type ContentAngle = z.infer<typeof contentAngleSchema>;

export const channelStrategySchema = z.object({
  platform: socialPlatformSchema,
  cadencePerWeek: z.number().int().min(0).max(100).nullish(),
  formats: z.array(z.string().max(200)).default([]),
  notes: z.string().max(2000).nullish(),
});
export type ChannelStrategy = z.infer<typeof channelStrategySchema>;

export const campaignStrategySchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1).max(300),
    summary: z.string().max(10000).nullish(),
    objectiveIds: z.array(uuidSchema).default([]),
    personaIds: z.array(uuidSchema).default([]),
    pillarIds: z.array(uuidSchema).default([]),
    channels: z.array(channelStrategySchema).default([]),
    researchReference: researchReferenceSchema.nullish(),
    startDate: isoDateTimeSchema.nullish(),
    endDate: isoDateTimeSchema.nullish(),
  })
  .merge(tenantScopeSchema)
  .merge(auditTimestampsSchema);
export type CampaignStrategy = z.infer<typeof campaignStrategySchema>;

export const campaignStatusSchema = z.enum([
  'DRAFT',
  'PLANNED',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'ARCHIVED',
]);
export type CampaignStatus = z.infer<typeof campaignStatusSchema>;

export const campaignSchema = z
  .object({
    id: uuidSchema,
    strategyId: uuidSchema.nullish(),
    brandId: uuidSchema.nullish(),
    verticalId: uuidSchema.nullish(),
    name: z.string().min(1).max(300),
    description: z.string().max(5000).nullish(),
    status: campaignStatusSchema,
    startAt: isoDateTimeSchema.nullish(),
    endAt: isoDateTimeSchema.nullish(),
    /** Display timezone for planning; storage remains UTC. */
    timezone: z.string().min(1).default('UTC'),
  })
  .merge(tenantScopeSchema)
  .merge(auditTimestampsSchema);
export type Campaign = z.infer<typeof campaignSchema>;

export const campaignBriefSchema = z
  .object({
    id: uuidSchema,
    campaignId: uuidSchema,
    background: z.string().max(20000).nullish(),
    objectives: z.array(z.string().max(1000)).default([]),
    keyMessages: z.array(z.string().max(1000)).default([]),
    mandatories: z.array(z.string().max(1000)).default([]),
    doNots: z.array(z.string().max(1000)).default([]),
    tone: z.string().max(1000).nullish(),
    researchReference: researchReferenceSchema.nullish(),
  })
  .merge(tenantScopeSchema)
  .merge(auditTimestampsSchema);
export type CampaignBrief = z.infer<typeof campaignBriefSchema>;

export const callToActionSchema = z.object({
  id: uuidSchema,
  label: z.string().min(1).max(300),
  url: urlSchema.nullish(),
  kind: z.enum(['LINK', 'SIGNUP', 'DOWNLOAD', 'CONTACT', 'FOLLOW', 'CUSTOM']),
});
export type CallToAction = z.infer<typeof callToActionSchema>;

export const contentTypeSchema = z.enum([
  'POST',
  'ARTICLE',
  'THREAD',
  'VIDEO_SCRIPT',
  'IMAGE',
  'CAROUSEL',
  'SHORT_VIDEO',
  'LONG_VIDEO',
  'AUDIO',
  'EMAIL',
  'OTHER',
]);
export type ContentType = z.infer<typeof contentTypeSchema>;

export const generationRecordSchema = z.object({
  jobId: z.string().nullish(),
  promptVersion: z.string().nullish(),
  modelProvider: z.string().nullish(),
  modelVersion: z.string().nullish(),
  generatedAt: isoDateTimeSchema.nullish(),
});
export type GenerationRecord = z.infer<typeof generationRecordSchema>;

export const humanEditRecordSchema = z.object({
  editedById: uuidSchema,
  editedAt: isoDateTimeSchema,
  note: z.string().max(2000).nullish(),
});

export const approvalRecordSchema = z.object({
  approverId: uuidSchema,
  decision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REJECTED']),
  decidedAt: isoDateTimeSchema,
  note: z.string().max(2000).nullish(),
});
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;

export const channelVariantSchema = z.object({
  id: uuidSchema,
  contentItemId: uuidSchema,
  platform: socialPlatformSchema,
  body: z.string().max(100000).nullish(),
  mediaAssetIds: z.array(uuidSchema).default([]),
  callToAction: callToActionSchema.nullish(),
  characterCount: z.number().int().nonnegative().nullish(),
  /** PlatformCapability version the variant was validated against. */
  platformCapabilityVersion: z.string().nullish(),
  status: z.enum(['DRAFT', 'READY', 'PUBLISHED', 'FAILED']),
});
export type ChannelVariant = z.infer<typeof channelVariantSchema>;

export const contentItemSchema = z
  .object({
    id: uuidSchema,
    campaignId: uuidSchema.nullish(),
    briefId: uuidSchema.nullish(),
    brandId: uuidSchema.nullish(),
    verticalId: uuidSchema.nullish(),
    title: z.string().min(1).max(500),
    contentType: contentTypeSchema,
    lifecycleState: contentLifecycleStateSchema,
    body: z.string().max(200000).nullish(),
    funnelStage: funnelStageSchema.nullish(),
    researchReference: researchReferenceSchema.nullish(),
    generation: generationRecordSchema.nullish(),
    humanEdits: z.array(humanEditRecordSchema).default([]),
    approvals: z.array(approvalRecordSchema).default([]),
    variants: z.array(channelVariantSchema).default([]),
  })
  .merge(tenantScopeSchema)
  .merge(auditTimestampsSchema);
export type ContentItem = z.infer<typeof contentItemSchema>;

export const contentCalendarEntrySchema = z.object({
  contentItemId: uuidSchema,
  channelVariantId: uuidSchema.nullish(),
  platform: socialPlatformSchema,
  /** UTC instant; rendered in the calendar's display timezone. */
  scheduledAt: isoDateTimeSchema,
});

export const contentCalendarSchema = z
  .object({
    id: uuidSchema,
    campaignId: uuidSchema.nullish(),
    name: z.string().min(1).max(300),
    timezone: z.string().min(1).default('UTC'),
    entries: z.array(contentCalendarEntrySchema).default([]),
  })
  .merge(tenantScopeSchema)
  .merge(auditTimestampsSchema);
export type ContentCalendar = z.infer<typeof contentCalendarSchema>;
