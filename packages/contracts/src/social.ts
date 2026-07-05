import { z } from 'zod';

import { isoDateTimeSchema, tenantScopeSchema, urlSchema, uuidSchema } from './common';

/**
 * Provider-neutral social publishing contracts. Platform differences are
 * expressed through a versioned PlatformCapability record — never assumed.
 * See docs/SOCIAL_PLATFORM_CAPABILITY_MATRIX.md. No platform is integrated
 * in Phase 1.
 */

export const SOCIAL_PLATFORMS = [
  'LINKEDIN',
  'INSTAGRAM',
  'FACEBOOK',
  'YOUTUBE',
  'TIKTOK',
  'THREADS',
  'X',
  'PINTEREST',
  'WORDPRESS',
  'EMAIL',
] as const;

export const socialPlatformSchema = z.enum(SOCIAL_PLATFORMS);
export type SocialPlatform = z.infer<typeof socialPlatformSchema>;

export const platformMediaFormatSchema = z.object({
  kind: z.enum(['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT']),
  mimeTypes: z.array(z.string().min(1)),
  maxSizeBytes: z.number().int().positive().nullish(),
  maxDurationSeconds: z.number().int().positive().nullish(),
  aspectRatios: z.array(z.string().max(20)).default([]),
});

/**
 * Versioned capability snapshot per platform. Capabilities change as platform
 * APIs evolve; variants record which capability version they were validated
 * against. `null` means "unknown", not "unsupported".
 */
export const platformCapabilitySchema = z.object({
  platform: socialPlatformSchema,
  capabilityVersion: z.string().min(1),
  recordedAt: isoDateTimeSchema,
  mediaFormats: z.array(platformMediaFormatSchema).default([]),
  limits: z.object({
    maxCharacters: z.number().int().positive().nullish(),
    maxHashtags: z.number().int().nonnegative().nullish(),
    maxMediaPerPost: z.number().int().nonnegative().nullish(),
  }),
  supports: z.object({
    nativeScheduling: z.boolean().nullable(),
    editAfterPublish: z.boolean().nullable(),
    deletion: z.boolean().nullable(),
    analytics: z.boolean().nullable(),
    comments: z.boolean().nullable(),
    webhooks: z.boolean().nullable(),
    stories: z.boolean().nullable(),
    drafts: z.boolean().nullable(),
  }),
  oauth: z.object({
    scopes: z.array(z.string().min(1)).default([]),
    refreshSupported: z.boolean().nullable(),
    tokenLifetimeSeconds: z.number().int().positive().nullish(),
  }),
  notes: z.string().max(5000).nullish(),
});
export type PlatformCapability = z.infer<typeof platformCapabilitySchema>;

export const socialAccountStatusSchema = z.enum(['CONNECTED', 'EXPIRED', 'REVOKED', 'ERROR']);

export const socialAccountSchema = z
  .object({
    id: uuidSchema,
    platform: socialPlatformSchema,
    externalAccountId: z.string().min(1),
    displayName: z.string().min(1).max(300),
    kind: z.enum(['PROFILE', 'PAGE', 'CHANNEL', 'BUSINESS_ACCOUNT', 'SITE']),
    status: socialAccountStatusSchema,
    scopes: z.array(z.string()).default([]),
    connectedById: uuidSchema,
    connectedAt: isoDateTimeSchema,
    lastRefreshedAt: isoDateTimeSchema.nullish(),
    /** Opaque reference into the encrypted token vault — never a raw token. */
    tokenRef: z.string().min(1),
  })
  .merge(tenantScopeSchema);
export type SocialAccount = z.infer<typeof socialAccountSchema>;

export const oauthInitiationRequestSchema = z
  .object({
    platform: socialPlatformSchema,
    redirectUri: urlSchema,
    requestedScopes: z.array(z.string()).default([]),
    /** CSRF-binding state token generated server-side. */
    state: z.string().min(16),
  })
  .merge(tenantScopeSchema);
export type OAuthInitiationRequest = z.infer<typeof oauthInitiationRequestSchema>;

export const oauthInitiationResultSchema = z.object({
  authorizationUrl: urlSchema,
  state: z.string().min(16),
  /** PKCE verifier reference when the platform supports PKCE. */
  pkceVerifierRef: z.string().nullish(),
});
export type OAuthInitiationResult = z.infer<typeof oauthInitiationResultSchema>;

export const oauthCallbackPayloadSchema = z.object({
  platform: socialPlatformSchema,
  code: z.string().min(1),
  state: z.string().min(16),
  error: z.string().nullish(),
});
export type OAuthCallbackPayload = z.infer<typeof oauthCallbackPayloadSchema>;

export const tokenRefreshResultSchema = z.object({
  accountId: uuidSchema,
  status: z.enum(['REFRESHED', 'NOT_SUPPORTED', 'REAUTH_REQUIRED', 'FAILED']),
  expiresAt: isoDateTimeSchema.nullish(),
});
export type TokenRefreshResult = z.infer<typeof tokenRefreshResultSchema>;

export const mediaUploadRequestSchema = z
  .object({
    accountId: uuidSchema,
    mediaAssetId: uuidSchema,
    mimeType: z.string().min(1),
    sizeBytes: z.number().int().positive(),
  })
  .merge(tenantScopeSchema);
export type MediaUploadRequest = z.infer<typeof mediaUploadRequestSchema>;

export const mediaUploadResultSchema = z.object({
  /** Platform-side media handle used in subsequent post creation. */
  externalMediaId: z.string().min(1),
  expiresAt: isoDateTimeSchema.nullish(),
});
export type MediaUploadResult = z.infer<typeof mediaUploadResultSchema>;

export const publishRequestSchema = z
  .object({
    /** Idempotency key — publishing the same request twice must be safe. */
    idempotencyKey: z.string().min(8),
    accountId: uuidSchema,
    channelVariantId: uuidSchema.nullish(),
    text: z.string().max(100000).nullish(),
    externalMediaIds: z.array(z.string()).default([]),
    link: urlSchema.nullish(),
    /** UTC instant for scheduled publishing (platform- or Spectra-side). */
    scheduledFor: isoDateTimeSchema.nullish(),
    /** AI-generated content disclosure where the platform supports/requires it. */
    aiContentDisclosure: z.boolean().default(false),
  })
  .merge(tenantScopeSchema);
export type PublishRequest = z.infer<typeof publishRequestSchema>;

export const publishStatusSchema = z.enum([
  'QUEUED',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED',
  'UNSUPPORTED',
  'CANCELLED',
]);

export const publishResultSchema = z.object({
  idempotencyKey: z.string().min(8),
  status: publishStatusSchema,
  externalPostId: z.string().nullish(),
  externalUrl: urlSchema.nullish(),
  failureReason: z.string().max(4000).nullish(),
  publishedAt: isoDateTimeSchema.nullish(),
});
export type PublishResult = z.infer<typeof publishResultSchema>;

export const analyticsMetricSchema = z.object({
  key: z.string().min(1).max(120),
  value: z.number(),
  capturedAt: isoDateTimeSchema,
});

export const analyticsRequestSchema = z
  .object({
    accountId: uuidSchema,
    externalPostId: z.string().nullish(),
    metricKeys: z.array(z.string()).default([]),
    from: isoDateTimeSchema.nullish(),
    to: isoDateTimeSchema.nullish(),
  })
  .merge(tenantScopeSchema);
export type AnalyticsRequest = z.infer<typeof analyticsRequestSchema>;

export const analyticsResultSchema = z.object({
  accountId: uuidSchema,
  externalPostId: z.string().nullish(),
  metrics: z.array(analyticsMetricSchema).default([]),
});
export type AnalyticsResult = z.infer<typeof analyticsResultSchema>;

export const socialCommentSchema = z.object({
  externalCommentId: z.string().min(1),
  externalPostId: z.string().min(1),
  authorDisplayName: z.string().max(300).nullish(),
  text: z.string().max(10000),
  postedAt: isoDateTimeSchema.nullish(),
});
export type SocialComment = z.infer<typeof socialCommentSchema>;

export const webhookEnvelopeSchema = z.object({
  platform: socialPlatformSchema,
  eventType: z.string().min(1).max(200),
  /** Result of signature verification — unverified payloads are quarantined. */
  signatureValid: z.boolean(),
  /** Dedupe key: webhooks must be idempotent. */
  idempotencyKey: z.string().min(1),
  receivedAt: isoDateTimeSchema,
  /** Raw payload persisted to tenant-scoped object storage, not inline. */
  payloadStorageKey: z.string().nullish(),
});
export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;
