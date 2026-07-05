import { z } from 'zod';

import {
  auditTimestampsSchema,
  geographySchema,
  languageCodeSchema,
  scoreSchema,
  slugSchema,
  tenantScopeSchema,
  urlSchema,
  uuidSchema,
} from './common';
import { socialPlatformSchema } from './social';

/**
 * Custom verticals are first-class and fully user-defined.
 * Industries are free text on purpose — the platform never hard-codes a
 * supported-industry list. See docs/CUSTOM_VERTICALS.md.
 */

export const verticalAudienceSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  roles: z.array(z.string().max(120)).default([]),
  seniority: z.string().max(120).optional(),
});
export type VerticalAudience = z.infer<typeof verticalAudienceSchema>;

export const verticalCompetitorSchema = z.object({
  name: z.string().min(1).max(200),
  websiteUrl: urlSchema.optional(),
  notes: z.string().max(2000).optional(),
});
export type VerticalCompetitor = z.infer<typeof verticalCompetitorSchema>;

export const seasonalEventSchema = z.object({
  name: z.string().min(1).max(200),
  /** 1–12; recurring events may span a range. */
  startMonth: z.number().int().min(1).max(12).optional(),
  endMonth: z.number().int().min(1).max(12).optional(),
  notes: z.string().max(1000).optional(),
});
export type SeasonalEvent = z.infer<typeof seasonalEventSchema>;

export const relevanceCriterionSchema = z.object({
  criterion: z.string().min(1).max(500),
  weight: scoreSchema.default(1),
});
export type RelevanceCriterion = z.infer<typeof relevanceCriterionSchema>;

export const verticalStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']);

export const customVerticalSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1).max(200),
    slug: slugSchema,
    description: z.string().max(5000).nullish(),
    /** Free text — arbitrary user-defined niches are supported. */
    industry: z.string().max(200).nullish(),
    subIndustry: z.string().max(200).nullish(),
    businessModel: z.string().max(200).nullish(),
    products: z.array(z.string().max(300)).default([]),
    services: z.array(z.string().max(300)).default([]),
    targetAudiences: z.array(verticalAudienceSchema).default([]),
    customerPainPoints: z.array(z.string().max(500)).default([]),
    geographies: z.array(geographySchema).default([]),
    languages: z.array(languageCodeSchema).default([]),
    competitors: z.array(verticalCompetitorSchema).default([]),
    keywords: z.array(z.string().max(200)).default([]),
    excludedKeywords: z.array(z.string().max(200)).default([]),
    trustedDomains: z.array(z.string().max(300)).default([]),
    blockedDomains: z.array(z.string().max(300)).default([]),
    preferredPublications: z.array(z.string().max(300)).default([]),
    regulatoryConsiderations: z.array(z.string().max(1000)).default([]),
    seasonalEvents: z.array(seasonalEventSchema).default([]),
    commercialObjectives: z.array(z.string().max(500)).default([]),
    contentObjectives: z.array(z.string().max(500)).default([]),
    preferredPlatforms: z.array(socialPlatformSchema).default([]),
    /** Brand-specific relevance criteria used by trend scoring. */
    relevanceCriteria: z.array(relevanceCriterionSchema).default([]),
    status: verticalStatusSchema,
  })
  .merge(tenantScopeSchema)
  .merge(auditTimestampsSchema);
export type CustomVertical = z.infer<typeof customVerticalSchema>;

export const brandStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']);

export const brandVoiceSchema = z.object({
  tone: z.array(z.string().max(120)).default([]),
  personality: z.string().max(2000).optional(),
  doNots: z.array(z.string().max(500)).default([]),
  examplePhrases: z.array(z.string().max(500)).default([]),
});
export type BrandVoice = z.infer<typeof brandVoiceSchema>;

export const brandSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1).max(200),
    slug: slugSchema,
    description: z.string().max(5000).nullish(),
    websiteUrl: urlSchema.nullish(),
    voice: brandVoiceSchema.nullish(),
    guidelines: z.record(z.unknown()).default({}),
    languages: z.array(languageCodeSchema).default([]),
    status: brandStatusSchema,
  })
  .merge(tenantScopeSchema)
  .merge(auditTimestampsSchema);
export type Brand = z.infer<typeof brandSchema>;
