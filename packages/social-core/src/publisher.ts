import type {
  AnalyticsRequest,
  AnalyticsResult,
  MediaUploadRequest,
  MediaUploadResult,
  PlatformCapability,
  PublishRequest,
  PublishResult,
  SocialComment,
  SocialPlatform,
  TenantScope,
  WebhookEnvelope,
} from '@spectra/contracts';

/**
 * SocialPublisher — the provider-neutral publishing port. One adapter per
 * platform in later phases; NONE are implemented in Phase 1.
 *
 * Capability differences (media formats, scheduling, editing, analytics,
 * comments, character limits, OAuth scopes) are NEVER assumed: adapters
 * declare a versioned PlatformCapability and optional operations are
 * capability-gated via assertCapability().
 */
export interface SocialPublisher {
  readonly platform: SocialPlatform;
  readonly adapterVersion: string;

  // OAuth is NOT part of this port. Authorization is brokered once, platform-
  // neutrally, by @spectra/social-oauth (state, PKCE, token exchange, refresh,
  // sealed storage), and accounts are found through the discovery ports in
  // ./discovery (ADR-0034). An adapter receives an already-opened token.

  // --- Capabilities ----------------------------------------------------------
  getCapabilities(): Promise<PlatformCapability>;

  // --- Publishing -----------------------------------------------------------
  uploadMedia(request: MediaUploadRequest): Promise<MediaUploadResult>;
  createPost(request: PublishRequest): Promise<PublishResult>;
  getPublishingStatus(idempotencyKey: string, tenant: TenantScope): Promise<PublishResult>;
  /** Optional: only when capabilities.supports.deletion is true. */
  deletePost?(externalPostId: string, tenant: TenantScope): Promise<void>;

  // --- Analytics & engagement -------------------------------------------------
  /** Optional: only when capabilities.supports.analytics is true. */
  fetchAnalytics?(request: AnalyticsRequest): Promise<AnalyticsResult>;
  /** Optional: only when capabilities.supports.comments is true. */
  fetchComments?(externalPostId: string, tenant: TenantScope): Promise<SocialComment[]>;

  // --- Webhooks ---------------------------------------------------------------
  /** Signature verification MUST happen before any payload is trusted. */
  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string>): boolean;
  handleWebhook(envelope: WebhookEnvelope): Promise<void>;
}

export type CapabilityFlag = keyof PlatformCapability['supports'];

export class UnsupportedCapabilityError extends Error {
  constructor(
    public readonly platform: SocialPlatform,
    public readonly capability: CapabilityFlag,
  ) {
    super(`Platform ${platform} does not support capability: ${capability}`);
    this.name = 'UnsupportedCapabilityError';
  }
}

/**
 * Guards optional operations. `null` (unknown) fails closed — a capability
 * must be positively recorded before the operation is allowed.
 */
export function assertCapability(capability: PlatformCapability, flag: CapabilityFlag): void {
  if (capability.supports[flag] !== true) {
    throw new UnsupportedCapabilityError(capability.platform, flag);
  }
}
