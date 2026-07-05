import { z } from 'zod';

/** Shared primitives used by every domain contract. */

export const uuidSchema = z.string().uuid();

/** ISO-8601 timestamp. All timestamps are stored and transmitted in UTC. */
export const isoDateTimeSchema = z.string().datetime({ offset: true });

/** BCP-47 language tag, e.g. `en`, `bn`, `hi-IN`. */
export const languageCodeSchema = z.string().min(2).max(35);

/** Geographic scope — free text or ISO country code; verticals define their own. */
export const geographySchema = z.string().min(1).max(120);

export const urlSchema = z.string().url();

export const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase kebab-case slug');

/** Normalized score in [0, 1]. */
export const scoreSchema = z.number().min(0).max(1);

/** Confidence in [0, 1]. */
export const confidenceSchema = scoreSchema;

/**
 * Tenant scope carried by every tenant-owned record.
 * Workspace is the primary isolation boundary; organization the billing boundary.
 */
export const tenantScopeSchema = z.object({
  organizationId: uuidSchema,
  workspaceId: uuidSchema,
});
export type TenantScope = z.infer<typeof tenantScopeSchema>;

/** Organization-level scope for records that exist above workspaces. */
export const organizationScopeSchema = z.object({
  organizationId: uuidSchema,
});
export type OrganizationScope = z.infer<typeof organizationScopeSchema>;

export const auditTimestampsSchema = z.object({
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  deletedAt: isoDateTimeSchema.nullish(),
});
export type AuditTimestamps = z.infer<typeof auditTimestampsSchema>;

export const paginationRequestSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export type PaginationRequest = z.infer<typeof paginationRequestSchema>;

export const paginatedResponseSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullish(),
    total: z.number().int().nonnegative().optional(),
  });

/**
 * Provenance recorded on every ingested artifact: which provider produced it,
 * when, and under which request — the audit trail behind every citation.
 */
export const provenanceSchema = z.object({
  providerId: z.string().min(1),
  providerKind: z.string().min(1),
  requestRef: z.string().optional(),
  retrievedAt: isoDateTimeSchema,
  pipelineVersion: z.string().optional(),
});
export type Provenance = z.infer<typeof provenanceSchema>;

/** Copyright / licensing metadata retained for every external source. */
export const copyrightMetadataSchema = z.object({
  license: z.string().optional(),
  rightsHolder: z.string().optional(),
  attributionRequired: z.boolean().optional(),
  usageNotes: z.string().optional(),
});
export type CopyrightMetadata = z.infer<typeof copyrightMetadataSchema>;
