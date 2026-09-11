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

export const socialAccountStatusSchema = z.enum([
  // Registered as a publishing target but not yet OAuth-verified against the
  // platform. Honest initial state while no live adapter is wired.
  'PENDING',
  'CONNECTED',
  'EXPIRED',
  'REVOKED',
  'ERROR',
]);
export type SocialAccountStatus = z.infer<typeof socialAccountStatusSchema>;

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

// ---------------------------------------------------------------------------
// OAuth token brokering (Phase 6C, ADR-0034)
// ---------------------------------------------------------------------------

/**
 * Platforms whose connection is an OAuth 2.0 authorization-code grant.
 * WordPress (application passwords) and EMAIL (ESP API keys) are deliberately
 * absent: they are not OAuth platforms, and pretending otherwise would put a
 * "Connect" button in front of a flow that does not exist.
 */
export const OAUTH_PLATFORMS = [
  'LINKEDIN',
  'FACEBOOK',
  'INSTAGRAM',
  'THREADS',
  'YOUTUBE',
  'TIKTOK',
  'X',
  'PINTEREST',
] as const satisfies readonly SocialPlatform[];

export const oauthPlatformSchema = z.enum(OAUTH_PLATFORMS);
export type OAuthPlatform = z.infer<typeof oauthPlatformSchema>;

export const socialConnectionStatusSchema = z.enum([
  'CONNECTED',
  // The access token has expired. Refreshable connections recover via refresh.
  'EXPIRED',
  // The platform rejected a refresh: only a new authorization will fix it.
  'REAUTH_REQUIRED',
  'REVOKED',
  'ERROR',
]);
export type SocialConnectionStatus = z.infer<typeof socialConnectionStatusSchema>;

/**
 * Whether account discovery ran for a connection. NOT_AVAILABLE means no
 * discovery adapter is wired for the platform, so nothing was looked up —
 * which is different from "looked up and found nothing".
 */
export const accountDiscoveryStatusSchema = z.enum(['NOT_AVAILABLE', 'COMPLETE', 'FAILED']);
export type AccountDiscoveryStatus = z.infer<typeof accountDiscoveryStatusSchema>;

/**
 * Where the OAuth callback may return the browser. An allow-list of paths on
 * the configured web origin — never a caller-supplied URL (open redirect).
 */
export const OAUTH_RETURN_PATHS = ['/social-accounts'] as const;
export const oauthReturnPathSchema = z.enum(OAUTH_RETURN_PATHS);
export type OAuthReturnPath = z.infer<typeof oauthReturnPathSchema>;

/**
 * The single outcome code the callback appends to the return URL. The web app
 * maps each to FIXED copy: provider-supplied text (error_description) is never
 * reflected into the page, because anyone can craft a callback URL.
 */
export const OAUTH_CALLBACK_RESULTS = [
  'connected',
  'reconnected',
  'access_denied',
  'provider_error',
  'state_invalid',
  'state_expired',
  'session_required',
  'forbidden',
  'not_configured',
  'credential_storage_unavailable',
  'token_exchange_failed',
  'unknown_platform',
  'internal_error',
] as const;
export const oauthCallbackResultSchema = z.enum(OAUTH_CALLBACK_RESULTS);
export type OAuthCallbackResult = z.infer<typeof oauthCallbackResultSchema>;

export const oauthInitiationResultSchema = z.object({
  /** The platform's consent URL. Carries the state and PKCE challenge — never a token. */
  authorizationUrl: urlSchema,
  /** After this instant the state embedded in the URL is no longer accepted. */
  expiresAt: isoDateTimeSchema,
});
export type OAuthInitiationResult = z.infer<typeof oauthInitiationResultSchema>;

/** Query parameters a platform sends to the callback (RFC 6749 section 4.1.2). */
export const oauthCallbackQuerySchema = z.object({
  state: z.string().min(1).max(512).optional(),
  code: z.string().min(1).max(4096).optional(),
  error: z.string().min(1).max(256).optional(),
  error_description: z.string().max(2048).optional(),
});
export type OAuthCallbackQuery = z.infer<typeof oauthCallbackQuerySchema>;

export const tokenRefreshResultSchema = z.object({
  connectionId: uuidSchema,
  status: z.enum(['REFRESHED', 'NOT_SUPPORTED', 'REAUTH_REQUIRED', 'FAILED']),
  accessTokenExpiresAt: isoDateTimeSchema.nullish(),
  /** Fixed, human-readable explanation. Never a provider response body. */
  detail: z.string().max(500),
});
export type TokenRefreshResult = z.infer<typeof tokenRefreshResultSchema>;

/** Outcome of asking the platform to revoke a token on disconnect (RFC 7009). */
export const providerRevocationSchema = z.enum(['REVOKED', 'NOT_SUPPORTED', 'FAILED', 'SKIPPED']);
export type ProviderRevocation = z.infer<typeof providerRevocationSchema>;

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
