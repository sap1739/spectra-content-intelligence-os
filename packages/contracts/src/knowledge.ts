import { z } from 'zod';

import {
  auditTimestampsSchema,
  isoDateTimeSchema,
  languageCodeSchema,
  scoreSchema,
  tenantScopeSchema,
  uuidSchema,
} from './common';

/**
 * Knowledge & evidence contracts backing retrieval-augmented generation.
 * Uploaded internal documents must never be exposed across tenants — every
 * retrieval request carries a mandatory tenant scope. See docs/KNOWLEDGE_AND_RAG.md.
 */

export const documentOriginSchema = z.enum(['RESEARCH_SOURCE', 'UPLOAD', 'INTERNAL']);

export const documentAccessScopeSchema = z.enum(['WORKSPACE', 'ORGANIZATION', 'RESTRICTED']);

export const sourceDocumentSchema = z
  .object({
    id: uuidSchema,
    origin: documentOriginSchema,
    /** Present when the document came from the research pipeline. */
    researchSourceId: uuidSchema.nullish(),
    uploadedById: uuidSchema.nullish(),
    title: z.string().min(1).max(500),
    mimeType: z.string().min(1),
    /** Tenant-scoped object storage key of the canonical bytes. */
    storageKey: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    checksum: z.string().min(1),
    language: languageCodeSchema.nullish(),
    /** Monotonic version; re-uploads create a new version, never mutate. */
    version: z.number().int().positive().default(1),
    previousVersionId: uuidSchema.nullish(),
    accessScope: documentAccessScopeSchema.default('WORKSPACE'),
    /** Freshness horizon — content older than this should be re-validated. */
    freshUntil: isoDateTimeSchema.nullish(),
    indexingStatus: z.enum(['PENDING', 'CHUNKED', 'EMBEDDED', 'INDEXED', 'FAILED']),
  })
  .merge(tenantScopeSchema)
  .merge(auditTimestampsSchema);
export type SourceDocument = z.infer<typeof sourceDocumentSchema>;

export const embeddingRefSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  dimensions: z.number().int().positive(),
  /** Identifier of the vector inside the vector store. */
  vectorId: z.string().min(1),
});
export type EmbeddingRef = z.infer<typeof embeddingRefSchema>;

export const documentChunkSchema = z
  .object({
    id: uuidSchema,
    documentId: uuidSchema,
    index: z.number().int().nonnegative(),
    text: z.string().max(50000),
    tokenCount: z.number().int().nonnegative().nullish(),
    headingPath: z.array(z.string().max(300)).default([]),
    page: z.number().int().positive().nullish(),
    embedding: embeddingRefSchema.nullish(),
    metadata: z.record(z.unknown()).default({}),
  })
  .merge(tenantScopeSchema);
export type DocumentChunk = z.infer<typeof documentChunkSchema>;

export const knowledgeEntityTypeSchema = z.enum([
  'PERSON',
  'ORGANIZATION',
  'PRODUCT',
  'TECHNOLOGY',
  'LOCATION',
  'EVENT',
  'TOPIC',
  'OTHER',
]);

export const knowledgeEntitySchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1).max(300),
    entityType: knowledgeEntityTypeSchema,
    aliases: z.array(z.string().max(300)).default([]),
    externalIds: z.record(z.string()).default({}),
  })
  .merge(tenantScopeSchema);
export type KnowledgeEntity = z.infer<typeof knowledgeEntitySchema>;

/** Links generated content to the exact evidence it consumed. */
export const generatedContentReferenceSchema = z
  .object({
    id: uuidSchema,
    contentItemId: uuidSchema,
    claimIds: z.array(uuidSchema).default([]),
    citationIds: z.array(uuidSchema).default([]),
    evidencePackIds: z.array(uuidSchema).default([]),
    documentChunkIds: z.array(uuidSchema).default([]),
    usedAt: isoDateTimeSchema,
  })
  .merge(tenantScopeSchema);
export type GeneratedContentReference = z.infer<typeof generatedContentReferenceSchema>;

/** Hybrid keyword + semantic retrieval request. Tenant scope is mandatory. */
export const vectorSearchRequestSchema = z
  .object({
    collection: z.string().min(1),
    queryText: z.string().max(5000).optional(),
    queryVector: z.array(z.number()).optional(),
    keywordWeight: scoreSchema.default(0.3),
    semanticWeight: scoreSchema.default(0.7),
    filters: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
    topK: z.number().int().min(1).max(100).default(10),
    minScore: scoreSchema.optional(),
  })
  .merge(tenantScopeSchema);
export type VectorSearchRequest = z.infer<typeof vectorSearchRequestSchema>;

export const vectorSearchHitSchema = z.object({
  chunkId: z.string().min(1),
  documentId: z.string().min(1),
  score: scoreSchema,
  text: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type VectorSearchHit = z.infer<typeof vectorSearchHitSchema>;

// ---------------------------------------------------------------------------
// Prompt-injection risk — untrusted external/uploaded content is never mixed
// with application instructions. See docs/PROMPT_INJECTION_DEFENCE.md.
// ---------------------------------------------------------------------------

export const promptInjectionRiskLevelSchema = z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type PromptInjectionRiskLevel = z.infer<typeof promptInjectionRiskLevelSchema>;

export const promptInjectionDispositionSchema = z.enum([
  'ALLOW',
  'SANITIZE',
  'QUARANTINE',
  'BLOCK',
]);

export const promptInjectionSignalSchema = z.object({
  patternId: z.string().min(1),
  description: z.string().max(500),
  /** Short excerpt around the match; truncated so logs stay safe. */
  excerpt: z.string().max(300).optional(),
  weight: z.number().min(0),
});
export type PromptInjectionSignal = z.infer<typeof promptInjectionSignalSchema>;

export const promptInjectionRiskSchema = z.object({
  contentRef: z.object({
    kind: z.enum(['RESEARCH_SOURCE', 'UPLOADED_DOCUMENT', 'WEB_PAGE', 'COMMENT', 'OTHER']),
    refId: z.string().optional(),
  }),
  riskLevel: promptInjectionRiskLevelSchema,
  signals: z.array(promptInjectionSignalSchema).default([]),
  disposition: promptInjectionDispositionSchema,
  assessorVersion: z.string().min(1),
  assessedAt: isoDateTimeSchema,
});
export type PromptInjectionRisk = z.infer<typeof promptInjectionRiskSchema>;
