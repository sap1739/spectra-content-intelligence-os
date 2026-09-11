import type { PublishFailureCode } from '@spectra/contracts';
import type {
  PostPublisher,
  PublishInput,
  PublishMediaInput,
  PublishOutcome,
  PublishValidationIssue,
  SupportedMedia,
} from '@spectra/social-core';
import { z } from 'zod';

import { MetaApiError, MetaGraphClient, type MetaErrorKind, type MetaGraphOptions } from './client';
import {
  FACEBOOK_MAX_PHOTO_BYTES,
  FACEBOOK_PHOTO_MIME_TYPES,
  GRAPH_ID,
  INSTAGRAM_IMAGE_MIME_TYPES,
  INSTAGRAM_MAX_IMAGE_BYTES,
  META_ADAPTER_VERSION,
} from './constants';
import { metaPostText, validateFacebookPost, validateInstagramPost } from './text';

export interface MetaPublisherOptions extends MetaGraphOptions {
  /** The Page access token (Instagram publishing through Facebook Login uses it too). */
  accessToken: string;
  /** Meta rejected the token: the caller marks the connection for reconnect. */
  onAuthRejected?: () => Promise<void>;
  now?: () => Date;
}

/**
 * Where one publish's Instagram media container got to, keyed by the publish
 * idempotency key and persisted by the caller. A container is staged, not
 * posted, so a retry that finds one checks it first: a PUBLISHED container is
 * never published again, and a FINISHED one is published rather than
 * recreated.
 */
export interface ContainerLedger {
  find(idempotencyKey: string): Promise<string | null>;
  /** Returns false when the container could not be recorded for this key. */
  staged(idempotencyKey: string, containerId: string): Promise<boolean>;
  cleared(idempotencyKey: string): Promise<void>;
}

export interface InstagramPublisherOptions extends MetaPublisherOptions {
  instagramAccountId: string;
  ledger?: ContainerLedger;
  /** Container status checks before giving up for this attempt. */
  statusChecks?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const FAILURE_CODE: Record<MetaErrorKind, PublishFailureCode> = {
  AUTH: 'AUTH',
  PERMISSION: 'PERMISSION',
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'VALIDATION',
  RATE_LIMIT: 'RATE_LIMIT',
  TRANSIENT: 'TRANSIENT',
  UNKNOWN: 'UNKNOWN',
};

const ADVICE: Partial<Record<MetaErrorKind, string>> = {
  AUTH: 'Meta rejected the access token (expired, revoked, or the password changed) — reconnect Meta.',
  PERMISSION:
    'The connection lacks the permission for this, or your role on the Page no longer allows publishing.',
  RATE_LIMIT: 'Meta rate limit reached — try again later.',
  TRANSIENT: 'Meta had a temporary problem — try again.',
};

const idSchema = z.object({ id: z.string().min(1).max(200) });
const photoSchema = z.object({
  id: z.string().min(1).max(200),
  post_id: z.string().min(1).max(200).optional(),
});
const permalinkSchema = z.object({
  permalink_url: z.string().optional(),
  permalink: z.string().optional(),
});
const statusSchema = z.object({ status_code: z.string().max(40).optional() });
const limitSchema = z.object({
  data: z
    .array(
      z.object({
        quota_usage: z.number().optional(),
        config: z.object({ quota_total: z.number().optional() }).optional(),
      }),
    )
    .default([]),
});

const EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
};

class MediaReadError extends Error {
  constructor(what: string) {
    super(`The attached image ${what}`);
    this.name = 'MediaReadError';
  }
}

/** A permalink is kept only if it points where the platform lives. */
function trustedLink(
  value: string | undefined,
  host: 'facebook.com' | 'instagram.com',
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === host || url.hostname.endsWith(`.${host}`))
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

async function failure(
  error: unknown,
  step: string,
  onAuthRejected: (() => Promise<void>) | undefined,
  ambiguous: { code: PublishFailureCode; reason: string },
): Promise<PublishOutcome> {
  if (error instanceof MediaReadError) {
    return { status: 'FAILED', failureCode: 'VALIDATION', failureReason: `${error.message}.` };
  }
  if (!(error instanceof MetaApiError)) throw error;
  if (error.kind === 'AUTH') await onAuthRejected?.().catch(() => undefined);
  if (error.ambiguous)
    return { status: 'FAILED', failureCode: ambiguous.code, failureReason: ambiguous.reason };
  const advice = ADVICE[error.kind];
  return {
    status: 'FAILED',
    failureCode: FAILURE_CODE[error.kind],
    failureReason: `Could not ${step}: ${error.message}.${advice ? ` ${advice}` : ''}`,
  };
}

function invalid(issues: PublishValidationIssue[]): PublishOutcome {
  return {
    status: 'FAILED',
    failureCode: 'VALIDATION',
    failureReason: issues.map((issue) => issue.message).join(' '),
  };
}

/**
 * Publishes to a Facebook Page through the Pages API: text as
 * `POST /{page-id}/feed` (`message`), one photo as a multipart
 * `POST /{page-id}/photos` (`source` + `caption`). Always with the Page's own
 * access token. Video and multi-photo posts are not implemented, so
 * `supportedMedia` says IMAGE and the executor refuses anything else first.
 */
export class FacebookPagePublisher implements PostPublisher {
  readonly platform = 'FACEBOOK' as const;
  readonly adapterVersion = META_ADAPTER_VERSION;
  readonly supportedMedia: SupportedMedia = {
    kinds: ['IMAGE'],
    mimeTypes: FACEBOOK_PHOTO_MIME_TYPES,
    maxItems: 1,
  };

  private readonly client: MetaGraphClient;

  constructor(private readonly options: MetaPublisherOptions & { pageId: string }) {
    if (!GRAPH_ID.test(options.pageId)) throw new Error('A Facebook Page id is numeric');
    this.client = new MetaGraphClient(options.accessToken, options);
  }

  validate(input: PublishInput): PublishValidationIssue[] {
    return validateFacebookPost(input);
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    const issues = this.validate(input);
    if (issues.length > 0) return invalid(issues);

    const message = metaPostText(input);
    const media = input.media?.[0];
    let postId: string;
    try {
      if (media) {
        let bytes: Buffer;
        try {
          bytes = await media.load();
        } catch {
          throw new MediaReadError('could not be read from storage');
        }
        if (bytes.length > FACEBOOK_MAX_PHOTO_BYTES)
          throw new MediaReadError('is over 10 MB, the Facebook limit');
        const body = await this.client.postFile<unknown>(
          `${this.options.pageId}/photos`,
          message ? { caption: message } : {},
          {
            field: 'source',
            bytes,
            mimeType: media.mimeType,
            filename: `image.${EXTENSION[media.mimeType] ?? 'jpg'}`,
          },
        );
        const parsed = photoSchema.safeParse(body ?? {});
        if (!parsed.success) return this.noId();
        postId = parsed.data.post_id ?? parsed.data.id;
      } else {
        const body = await this.client.post<unknown>(`${this.options.pageId}/feed`, { message });
        const parsed = idSchema.safeParse(body ?? {});
        if (!parsed.success) return this.noId();
        postId = parsed.data.id;
      }
    } catch (error) {
      return failure(
        error,
        media ? 'publish the photo' : 'publish the post',
        this.options.onAuthRejected,
        {
          code: 'AMBIGUOUS',
          reason:
            'Meta did not answer while Spectra published; the post may have been created. Check the Facebook Page before publishing again, or it may appear twice.',
        },
      );
    }

    return {
      status: 'PUBLISHED',
      externalPostId: postId,
      ...(await this.permalink(postId)),
      publishedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    };
  }

  private noId(): PublishOutcome {
    return {
      status: 'FAILED',
      failureCode: 'AMBIGUOUS',
      failureReason:
        'Meta accepted the post but did not return its id. Check the Facebook Page before publishing again, or it may appear twice.',
    };
  }

  /** Cosmetic: a failed lookup leaves the post without a link, never fails it. */
  private async permalink(postId: string): Promise<{ externalUrl?: string }> {
    try {
      const body = await this.client.get<unknown>(postId, { fields: 'permalink_url' });
      const url = trustedLink(
        permalinkSchema.safeParse(body ?? {}).data?.permalink_url,
        'facebook.com',
      );
      return url ? { externalUrl: url } : {};
    } catch {
      return {};
    }
  }
}

/**
 * Publishes one JPEG image to an Instagram professional account through the
 * Instagram API with Facebook Login: `POST /{ig-id}/media` (`image_url`,
 * `caption`, `alt_text`) creates a container, its `status_code` is checked
 * until FINISHED, then `POST /{ig-id}/media_publish` (`creation_id`) posts
 * it. Instagram fetches the image itself, from a short-lived signed link to
 * this deployment's storage. Text-only posts do not exist on Instagram;
 * video, Reels, stories and carousels are not implemented.
 */
export class InstagramPublisher implements PostPublisher {
  readonly platform = 'INSTAGRAM' as const;
  readonly adapterVersion = META_ADAPTER_VERSION;
  readonly supportedMedia: SupportedMedia = {
    kinds: ['IMAGE'],
    mimeTypes: INSTAGRAM_IMAGE_MIME_TYPES,
    maxItems: 1,
  };

  private readonly client: MetaGraphClient;

  constructor(private readonly options: InstagramPublisherOptions) {
    if (!GRAPH_ID.test(options.instagramAccountId))
      throw new Error('An Instagram account id is numeric');
    this.client = new MetaGraphClient(options.accessToken, options);
  }

  validate(input: PublishInput): PublishValidationIssue[] {
    return validateInstagramPost(input);
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    const issues = this.validate(input);
    if (issues.length > 0) return invalid(issues);
    const media = input.media?.[0] as PublishMediaInput;
    if (!media.url) {
      return {
        status: 'FAILED',
        failureCode: 'UNSUPPORTED_MEDIA',
        failureReason:
          "Instagram fetches the image from a link to this deployment's object storage, and no such link can be made here. Nothing was published.",
      };
    }
    if (media.sizeBytes > INSTAGRAM_MAX_IMAGE_BYTES) {
      return invalid([
        { code: 'IMAGE_FILE_TOO_LARGE', message: 'Instagram images must be 8 MB or smaller.' },
      ]);
    }

    const ig = this.options.instagramAccountId;
    const key = input.idempotencyKey;
    const ledger = this.options.ledger;
    let protectedRetry = false;
    let step = 'check the earlier attempt';
    try {
      let containerId = (await ledger?.find(key)) ?? null;
      if (containerId) {
        protectedRetry = true;
        const status = await this.containerStatus(containerId).catch((error: unknown) => {
          if (error instanceof MetaApiError && error.kind === 'NOT_FOUND') return 'GONE';
          throw error;
        });
        if (status === 'PUBLISHED') {
          return {
            status: 'FAILED',
            failureCode: 'AMBIGUOUS',
            failureReason:
              'Instagram reports this post was already published by an earlier attempt, but its id was not received. Check Instagram; Spectra will not publish it again.',
          };
        }
        if (status === 'ERROR' || status === 'EXPIRED' || status === 'GONE') {
          await ledger?.cleared(key);
          containerId = null;
        }
      }

      if (!containerId) {
        step = 'check the Instagram publishing limit';
        const quota = await this.quota();
        if (quota) {
          return {
            status: 'FAILED',
            failureCode: 'RATE_LIMIT',
            failureReason: `This Instagram account has used ${quota.usage} of its ${quota.total} API posts for the last 24 hours. Try again later. Nothing was published.`,
          };
        }
        step = 'create the media container';
        let imageUrl: string;
        try {
          imageUrl = await media.url();
        } catch {
          throw new MediaReadError('link could not be created from storage');
        }
        const caption = metaPostText(input);
        const body = await this.client.post<unknown>(`${ig}/media`, {
          image_url: imageUrl,
          ...(caption ? { caption } : {}),
          ...(media.altText ? { alt_text: media.altText } : {}),
        });
        const parsed = idSchema.safeParse(body ?? {});
        if (!parsed.success) {
          throw new MetaApiError(
            'UNKNOWN',
            null,
            null,
            null,
            'Instagram did not return a media container id',
          );
        }
        containerId = parsed.data.id;
        protectedRetry = (await ledger?.staged(key, containerId)) ?? false;
      }

      step = 'wait for Instagram to process the image';
      await this.awaitContainer(key, containerId);

      step = 'publish the post';
      const published = await this.client.post<unknown>(`${ig}/media_publish`, {
        creation_id: containerId,
      });
      const parsed = idSchema.safeParse(published ?? {});
      if (!parsed.success) {
        return {
          status: 'FAILED',
          failureCode: 'AMBIGUOUS',
          failureReason: protectedRetry
            ? 'Instagram accepted the post but did not return its id. Check Instagram; a retry will not publish it twice.'
            : 'Instagram accepted the post but did not return its id. Check Instagram before publishing again, or it may appear twice.',
        };
      }
      return {
        status: 'PUBLISHED',
        externalPostId: parsed.data.id,
        ...(await this.permalink(parsed.data.id)),
        publishedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      };
    } catch (error) {
      return failure(
        error,
        step,
        this.options.onAuthRejected,
        this.ambiguity(step, protectedRetry),
      );
    }
  }

  private ambiguity(
    step: string,
    protectedRetry: boolean,
  ): { code: PublishFailureCode; reason: string } {
    if (step !== 'publish the post') {
      // A container is staged, not posted: an unanswered create published nothing.
      return {
        code: 'TRANSIENT',
        reason: `Instagram did not answer while Spectra tried to ${step}. Nothing was published; try again.`,
      };
    }
    return protectedRetry
      ? {
          code: 'TRANSIENT',
          reason:
            'Instagram did not answer while publishing. Retrying is safe: Spectra checks whether this media container was already published before trying again.',
        }
      : {
          code: 'AMBIGUOUS',
          reason:
            'Instagram did not answer while publishing; the post may have been created. Check Instagram before publishing again, or it may appear twice.',
        };
  }

  private async containerStatus(containerId: string): Promise<string | null> {
    const body = await this.client.get<unknown>(containerId, { fields: 'status_code' });
    return statusSchema.safeParse(body ?? {}).data?.status_code ?? null;
  }

  /**
   * The account's rolling 24-hour allowance, read from Instagram rather than
   * assumed. Advisory: if it cannot be read, Instagram still enforces it.
   */
  private async quota(): Promise<{ usage: number; total: number } | null> {
    try {
      const body = await this.client.get<unknown>(
        `${this.options.instagramAccountId}/content_publishing_limit`,
        {
          fields: 'quota_usage,config',
        },
      );
      const row = limitSchema.safeParse(body ?? {}).data?.data[0];
      const usage = row?.quota_usage;
      const total = row?.config?.quota_total;
      return usage !== undefined && total !== undefined && total > 0 && usage >= total
        ? { usage, total }
        : null;
    } catch (error) {
      if (error instanceof MetaApiError && error.kind === 'AUTH') throw error;
      return null;
    }
  }

  private async awaitContainer(key: string, containerId: string): Promise<void> {
    const checks = this.options.statusChecks ?? 5;
    const interval = this.options.pollIntervalMs ?? 3000;
    const sleep =
      this.options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < checks; attempt += 1) {
      const status = await this.containerStatus(containerId);
      if (status === 'FINISHED') return;
      if (status === 'ERROR') {
        await this.options.ledger?.cleared(key);
        throw new MetaApiError(
          'VALIDATION',
          null,
          null,
          null,
          'Instagram could not process the image (container status ERROR) — check its format, size and aspect ratio',
        );
      }
      if (status === 'EXPIRED') {
        await this.options.ledger?.cleared(key);
        throw new MetaApiError(
          'TRANSIENT',
          null,
          null,
          null,
          'The media container expired before it was published; publish again to create a new one',
        );
      }
      if (attempt < checks - 1) await sleep(interval);
    }
    throw new MetaApiError(
      'TRANSIENT',
      null,
      null,
      null,
      'Instagram is still processing the image; publish again shortly (the container is kept)',
    );
  }

  private async permalink(mediaId: string): Promise<{ externalUrl?: string }> {
    try {
      const body = await this.client.get<unknown>(mediaId, { fields: 'permalink' });
      const url = trustedLink(
        permalinkSchema.safeParse(body ?? {}).data?.permalink,
        'instagram.com',
      );
      return url ? { externalUrl: url } : {};
    } catch {
      return {};
    }
  }
}
