import type { PublishFailureCode, SocialPlatform } from '@spectra/contracts';

/**
 * The publish port real adapters implement (the full `SocialPublisher` port is
 * the aspirational surface — analytics, webhooks — filled in over later
 * phases). A `PostPublisher` turns a piece of content into a published post on
 * one platform, carrying its own credentials.
 */

export type PublishMediaKind = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'OTHER';

export interface PublishMediaInput {
  assetId: string;
  kind: PublishMediaKind;
  mimeType: string;
  sizeBytes: number;
  widthPx: number | null;
  heightPx: number | null;
  altText: string | null;
  /** Reads the bytes from tenant-scoped storage. Called only when an upload is needed. */
  load(): Promise<Buffer>;
  /**
   * A short-lived link the platform can fetch the file from, for platforms
   * that pull media rather than accept an upload (Instagram). Absent when this
   * deployment cannot produce one.
   */
  url?(): Promise<string>;
}

export interface PublishInput {
  /** Idempotency key — publishing the same input twice must be safe. */
  idempotencyKey: string;
  title: string;
  body: string;
  /** Attached media. Absent or empty means a text-only post. */
  media?: PublishMediaInput[];
}

export interface PublishOutcome {
  status: 'PUBLISHED' | 'FAILED';
  externalPostId?: string;
  externalUrl?: string;
  /** ISO-8601 UTC. */
  publishedAt?: string;
  failureReason?: string;
  /** What kind of failure, so the UI can offer the right next step. */
  failureCode?: PublishFailureCode;
}

export interface PublishValidationIssue {
  code: string;
  message: string;
}

/** Media an adapter can genuinely upload. Absent means text only. */
export interface SupportedMedia {
  kinds: readonly PublishMediaKind[];
  mimeTypes: readonly string[];
  maxItems: number;
}

export interface PostPublisher {
  readonly platform: SocialPlatform;
  readonly adapterVersion: string;
  readonly supportedMedia?: SupportedMedia;
  /** Checks that need no network — limits, formats. Run before anything is sent. */
  validate?(input: PublishInput): PublishValidationIssue[];
  publish(input: PublishInput): Promise<PublishOutcome>;
}

/** The media in `media` whose KIND the publisher cannot upload at all. */
export function unsupportedMediaKinds(
  publisher: PostPublisher,
  media: readonly PublishMediaInput[] = [],
): PublishMediaInput[] {
  const kinds = publisher.supportedMedia?.kinds ?? [];
  return media.filter((item) => !kinds.includes(item.kind));
}
