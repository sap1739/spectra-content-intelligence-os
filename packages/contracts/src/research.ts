import { z } from 'zod';

import {
  auditTimestampsSchema,
  confidenceSchema,
  copyrightMetadataSchema,
  geographySchema,
  isoDateTimeSchema,
  languageCodeSchema,
  provenanceSchema,
  scoreSchema,
  tenantScopeSchema,
  urlSchema,
  uuidSchema,
} from './common';

/**
 * Research contracts. Every finding retains full provenance so the platform
 * can always answer: which source supported this statement, when was it
 * published/retrieved, is it stale, was it duplicated, was it verified, and
 * which generated content used it. See docs/RESEARCH_ARCHITECTURE.md and
 * docs/CITATION_AND_PROVENANCE.md.
 */

export const RESEARCH_PIPELINE_STAGES = [
  'REQUEST_CREATED',
  'QUERY_PLANNING',
  'QUERY_EXPANSION',
  'SOURCE_DISCOVERY',
  'SOURCE_RETRIEVAL',
  'CONTENT_EXTRACTION',
  'METADATA_EXTRACTION',
  'LANGUAGE_DETECTION',
  'GEOGRAPHIC_CLASSIFICATION',
  'PUBLICATION_DATE_DETECTION',
  'DUPLICATE_DETECTION',
  'NEAR_DUPLICATE_DETECTION',
  'TOPIC_CLUSTERING',
  'ENTITY_EXTRACTION',
  'CLAIM_EXTRACTION',
  'CITATION_CAPTURE',
  'CREDIBILITY_ASSESSMENT',
  'FRESHNESS_ASSESSMENT',
  'TREND_SCORING',
  'HUMAN_REVIEW',
  'EVIDENCE_PACK_GENERATION',
  'KNOWLEDGE_BASE_STORAGE',
] as const;

export const researchPipelineStageSchema = z.enum(RESEARCH_PIPELINE_STAGES);
export type ResearchPipelineStage = z.infer<typeof researchPipelineStageSchema>;

export const researchProjectStatusSchema = z.enum([
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'ARCHIVED',
]);

export const researchProjectSchema = z
  .object({
    id: uuidSchema,
    verticalId: uuidSchema.nullish(),
    brandId: uuidSchema.nullish(),
    name: z.string().min(1).max(300),
    description: z.string().max(5000).nullish(),
    /** The user's research objective in their own words. */
    objective: z.string().max(5000).nullish(),
    status: researchProjectStatusSchema,
    createdById: uuidSchema.nullish(),
  })
  .merge(tenantScopeSchema)
  .merge(auditTimestampsSchema);
export type ResearchProject = z.infer<typeof researchProjectSchema>;

export const researchQuestionSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  question: z.string().min(1).max(2000),
  rationale: z.string().max(2000).nullish(),
  priority: z.number().int().min(1).max(5).default(3),
  status: z.enum(['OPEN', 'ANSWERED', 'PARTIALLY_ANSWERED', 'DISCARDED']),
});
export type ResearchQuestion = z.infer<typeof researchQuestionSchema>;

export const researchQuerySchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  questionId: uuidSchema.nullish(),
  /** Which provider kind this query targets, e.g. `web-search`, `news-search`. */
  providerKind: z.string().min(1),
  queryText: z.string().min(1).max(2000),
  language: languageCodeSchema.nullish(),
  geography: geographySchema.nullish(),
  /** Set when this query was produced by expanding another query. */
  expansionOfQueryId: uuidSchema.nullish(),
  status: z.enum(['PLANNED', 'EXECUTED', 'FAILED', 'SKIPPED']),
});
export type ResearchQuery = z.infer<typeof researchQuerySchema>;

export const researchRunStatusSchema = z.enum([
  'PENDING',
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'PARTIALLY_SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);

export const researchRunTriggerSchema = z.enum(['MANUAL', 'SCHEDULED', 'API']);

export const researchRunStatsSchema = z.object({
  queriesPlanned: z.number().int().nonnegative().default(0),
  queriesExecuted: z.number().int().nonnegative().default(0),
  sourcesDiscovered: z.number().int().nonnegative().default(0),
  sourcesFetched: z.number().int().nonnegative().default(0),
  findingsExtracted: z.number().int().nonnegative().default(0),
  duplicatesRemoved: z.number().int().nonnegative().default(0),
  claimsExtracted: z.number().int().nonnegative().default(0),
});
export type ResearchRunStats = z.infer<typeof researchRunStatsSchema>;

export const researchRunSchema = z
  .object({
    id: uuidSchema,
    projectId: uuidSchema,
    status: researchRunStatusSchema,
    trigger: researchRunTriggerSchema,
    currentStage: researchPipelineStageSchema.nullish(),
    queryPlan: z.array(researchQuerySchema).default([]),
    startedAt: isoDateTimeSchema.nullish(),
    completedAt: isoDateTimeSchema.nullish(),
    failureReason: z.string().max(4000).nullish(),
    stats: researchRunStatsSchema.default({}),
    createdById: uuidSchema.nullish(),
  })
  .merge(tenantScopeSchema)
  .merge(auditTimestampsSchema);
export type ResearchRun = z.infer<typeof researchRunSchema>;

export const sourceCategorySchema = z.enum([
  'WEB',
  'NEWS',
  'BLOG',
  'ACADEMIC',
  'SOCIAL',
  'VIDEO',
  'PODCAST',
  'COMMUNITY',
  'DOCUMENT',
  'INTERNAL',
  'OTHER',
]);
export type SourceCategory = z.infer<typeof sourceCategorySchema>;

export const sourceProcessingStatusSchema = z.enum([
  'DISCOVERED',
  'FETCHED',
  'EXTRACTED',
  'NORMALIZED',
  'DEDUPLICATED',
  'ANALYZED',
  'FAILED',
  'SKIPPED',
]);

export const researchSourceSchema = z
  .object({
    id: uuidSchema,
    projectId: uuidSchema,
    runId: uuidSchema.nullish(),
    url: urlSchema,
    canonicalUrl: urlSchema.nullish(),
    title: z.string().max(1000).nullish(),
    publisher: z.string().max(500).nullish(),
    author: z.string().max(500).nullish(),
    publishedAt: isoDateTimeSchema.nullish(),
    retrievedAt: isoDateTimeSchema,
    language: languageCodeSchema.nullish(),
    geography: geographySchema.nullish(),
    category: sourceCategorySchema,
    credibilityScore: scoreSchema.nullish(),
    freshnessScore: scoreSchema.nullish(),
    /** Exact-duplicate pointer; near-duplicates share a duplicateClusterKey. */
    duplicateOfSourceId: uuidSchema.nullish(),
    duplicateClusterKey: z.string().max(200).nullish(),
    copyright: copyrightMetadataSchema.nullish(),
    provenance: provenanceSchema,
    processingStatus: sourceProcessingStatusSchema,
    metadata: z.record(z.unknown()).default({}),
  })
  .merge(tenantScopeSchema)
  .merge(auditTimestampsSchema);
export type ResearchSource = z.infer<typeof researchSourceSchema>;

/** Immutable capture of a source at retrieval time; raw content in object storage. */
export const sourceSnapshotSchema = z.object({
  id: uuidSchema,
  sourceId: uuidSchema,
  retrievedAt: isoDateTimeSchema,
  contentHash: z.string().min(1),
  /** Tenant-scoped object storage key of the raw capture. */
  storageKey: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  extractionStatus: z.enum(['PENDING', 'EXTRACTED', 'FAILED']),
});
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;

/** Location of an excerpt inside an extracted snapshot. */
export const excerptLocationSchema = z.object({
  startOffset: z.number().int().nonnegative().optional(),
  endOffset: z.number().int().nonnegative().optional(),
  selector: z.string().max(1000).optional(),
  page: z.number().int().positive().optional(),
});
export type ExcerptLocation = z.infer<typeof excerptLocationSchema>;

export const findingStatusSchema = z.enum(['PENDING_REVIEW', 'VALIDATED', 'REJECTED', 'STALE']);

export const researchFindingSchema = z
  .object({
    id: uuidSchema,
    projectId: uuidSchema,
    runId: uuidSchema.nullish(),
    sourceId: uuidSchema,
    snapshotId: uuidSchema.nullish(),
    summary: z.string().min(1).max(5000),
    /** The claim this finding supports, if extracted. */
    claimId: uuidSchema.nullish(),
    excerpt: z.string().max(10000).nullish(),
    excerptLocation: excerptLocationSchema.nullish(),
    confidence: confidenceSchema.nullish(),
    credibilityScore: scoreSchema.nullish(),
    freshnessScore: scoreSchema.nullish(),
    language: languageCodeSchema.nullish(),
    geography: geographySchema.nullish(),
    duplicateClusterKey: z.string().max(200).nullish(),
    sourceCategory: sourceCategorySchema,
    topics: z.array(z.string().max(200)).default([]),
    entities: z.array(z.string().max(200)).default([]),
    /** Findings from other sources that corroborate this one. */
    corroboratedByFindingIds: z.array(uuidSchema).default([]),
    copyright: copyrightMetadataSchema.nullish(),
    provenance: provenanceSchema,
    status: findingStatusSchema,
    processingStage: researchPipelineStageSchema.nullish(),
  })
  .merge(tenantScopeSchema)
  .merge(auditTimestampsSchema);
export type ResearchFinding = z.infer<typeof researchFindingSchema>;

export const claimTypeSchema = z.enum(['FACTUAL', 'STATISTIC', 'PREDICTION', 'OPINION', 'QUOTE']);

export const claimVerificationStatusSchema = z.enum([
  'UNVERIFIED',
  'CORROBORATED',
  'DISPUTED',
  'VERIFIED',
  'REJECTED',
]);

export const extractedClaimSchema = z
  .object({
    id: uuidSchema,
    projectId: uuidSchema,
    text: z.string().min(1).max(5000),
    normalizedText: z.string().max(5000).nullish(),
    claimType: claimTypeSchema,
    subjectEntities: z.array(z.string().max(200)).default([]),
    verificationStatus: claimVerificationStatusSchema,
    supportingFindingIds: z.array(uuidSchema).default([]),
    contradictingFindingIds: z.array(uuidSchema).default([]),
    confidence: confidenceSchema.nullish(),
  })
  .merge(tenantScopeSchema)
  .merge(auditTimestampsSchema);
export type ExtractedClaim = z.infer<typeof extractedClaimSchema>;

export const citationSchema = z
  .object({
    id: uuidSchema,
    claimId: uuidSchema.nullish(),
    findingId: uuidSchema,
    sourceId: uuidSchema,
    snapshotId: uuidSchema.nullish(),
    url: urlSchema,
    title: z.string().max(1000).nullish(),
    publisher: z.string().max(500).nullish(),
    author: z.string().max(500).nullish(),
    publishedAt: isoDateTimeSchema.nullish(),
    retrievedAt: isoDateTimeSchema,
    excerpt: z.string().max(10000).nullish(),
    locator: excerptLocationSchema.nullish(),
  })
  .merge(tenantScopeSchema);
export type Citation = z.infer<typeof citationSchema>;

export const evidencePackStatusSchema = z.enum(['DRAFT', 'READY', 'STALE', 'ARCHIVED']);

export const evidencePackSchema = z
  .object({
    id: uuidSchema,
    projectId: uuidSchema,
    title: z.string().min(1).max(300),
    summary: z.string().max(10000).nullish(),
    claimIds: z.array(uuidSchema).default([]),
    citationIds: z.array(uuidSchema).default([]),
    findingIds: z.array(uuidSchema).default([]),
    trendCandidateIds: z.array(uuidSchema).default([]),
    /** Content items that consumed this pack — citation lineage. */
    usedByContentItemIds: z.array(uuidSchema).default([]),
    status: evidencePackStatusSchema,
  })
  .merge(tenantScopeSchema)
  .merge(auditTimestampsSchema);
export type EvidencePack = z.infer<typeof evidencePackSchema>;

export const topicClusterSchema = z
  .object({
    id: uuidSchema,
    projectId: uuidSchema,
    runId: uuidSchema.nullish(),
    label: z.string().min(1).max(300),
    description: z.string().max(2000).nullish(),
    keywords: z.array(z.string().max(200)).default([]),
    findingIds: z.array(uuidSchema).default([]),
    sourceIds: z.array(uuidSchema).default([]),
    cohesionScore: scoreSchema.nullish(),
  })
  .merge(tenantScopeSchema);
export type TopicCluster = z.infer<typeof topicClusterSchema>;

export const competitorFindingSchema = z
  .object({
    id: uuidSchema,
    projectId: uuidSchema,
    competitorName: z.string().min(1).max(300),
    category: z.enum(['LAUNCH', 'CAMPAIGN', 'PRICING', 'HIRING', 'CONTENT', 'FUNDING', 'OTHER']),
    summary: z.string().min(1).max(5000),
    sourceId: uuidSchema.nullish(),
    findingId: uuidSchema.nullish(),
    observedAt: isoDateTimeSchema,
  })
  .merge(tenantScopeSchema);
export type CompetitorFinding = z.infer<typeof competitorFindingSchema>;

export const researchReportSectionSchema = z.object({
  heading: z.string().min(1).max(300),
  body: z.string().max(50000),
  citationIds: z.array(uuidSchema).default([]),
});

export const researchReportSchema = z
  .object({
    id: uuidSchema,
    projectId: uuidSchema,
    runId: uuidSchema.nullish(),
    title: z.string().min(1).max(300),
    summary: z.string().max(10000).nullish(),
    sections: z.array(researchReportSectionSchema).default([]),
    evidencePackIds: z.array(uuidSchema).default([]),
    status: z.enum(['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'ARCHIVED']),
    generatedAt: isoDateTimeSchema.nullish(),
  })
  .merge(tenantScopeSchema)
  .merge(auditTimestampsSchema);
export type ResearchReport = z.infer<typeof researchReportSchema>;
