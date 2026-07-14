import type { SocialPlatform } from '@spectra/contracts';

/**
 * Minimal publish port implemented by real adapters now (the full
 * `SocialPublisher` port is the aspirational surface — OAuth, analytics,
 * webhooks — filled in over later phases). A `PostPublisher` turns a piece of
 * content into a published post on one platform, carrying its own credentials.
 */

export interface PublishInput {
  /** Idempotency key — publishing the same input twice must be safe. */
  idempotencyKey: string;
  title: string;
  body: string;
}

export interface PublishOutcome {
  status: 'PUBLISHED' | 'FAILED';
  externalPostId?: string;
  externalUrl?: string;
  /** ISO-8601 UTC. */
  publishedAt?: string;
  failureReason?: string;
}

export interface PostPublisher {
  readonly platform: SocialPlatform;
  readonly adapterVersion: string;
  publish(input: PublishInput): Promise<PublishOutcome>;
}
