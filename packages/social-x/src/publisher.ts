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

import { XApiError, XClient, type XApiOptions, type XErrorKind } from './client';
import {
  X_ADAPTER_VERSION,
  X_ID,
  X_MAX_IMAGES,
  X_MAX_SEGMENT_BYTES,
  X_MEDIA_CATEGORY,
  X_PATHS,
  X_PLATFORM,
  X_SCOPES,
  xPostUrl,
} from './constants';
import { validateXPost, xPostText } from './text';

/**
 * Where one asset's X upload got to, persisted by the caller so a retry reuses
 * a media id X already has instead of uploading the file again.
 */
export interface XMediaLedger {
  find(assetId: string): Promise<{ mediaId: string | null; verified: boolean } | null>;
  registered(assetId: string, mediaId: string): Promise<void>;
  uploaded(assetId: string, verified: boolean): Promise<void>;
  failed(assetId: string, reason: string): Promise<void>;
  attached(assetId: string, postId: string): Promise<void>;
}

export interface XPublisherOptions extends XApiOptions {
  accessToken: string;
  grantedScopes: readonly string[] | null;
  /** For the post's link, when discovery reported the handle. */
  username?: string | null;
  ledger?: XMediaLedger;
  /** Processing checks after an image upload is finalized. */
  statusChecks?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onAuthRejected?: () => Promise<void>;
  now?: () => Date;
}

const FAILURE_CODE: Record<XErrorKind, PublishFailureCode> = {
  AUTH: 'AUTH',
  PERMISSION: 'PERMISSION',
  ACCESS: 'PERMISSION',
  RATE_LIMIT: 'RATE_LIMIT',
  VALIDATION: 'VALIDATION',
  DUPLICATE: 'VALIDATION',
  NOT_FOUND: 'VALIDATION',
  TRANSIENT: 'TRANSIENT',
  UNKNOWN: 'UNKNOWN',
};

const ADVICE: Partial<Record<XErrorKind, string>> = {
  AUTH: 'X rejected the authorization (expired or revoked) — reconnect X.',
  PERMISSION: 'The connection lacks the scope for this — reconnect X and allow posting.',
  ACCESS:
    "X refused the call for this app's API access: pay-per-use credits or a plan that covers posting are needed. Check the X developer portal.",
  RATE_LIMIT: 'X is rate-limiting this account or app — try again later.',
  DUPLICATE: 'X rejects an identical post twice; change the text before publishing again.',
  TRANSIENT: 'X had a temporary problem — try again.',
};

const postSchema = z.object({ data: z.object({ id: z.string().min(1).max(40) }) });
const mediaSchema = z.object({
  data: z.object({
    id: z.string().min(1).max(40),
    processing_info: z.object({ state: z.string().optional() }).passthrough().optional(),
  }),
});

function invalid(issues: PublishValidationIssue[]): PublishOutcome {
  return {
    status: 'FAILED',
    failureCode: 'VALIDATION',
    failureReason: issues.map((issue) => issue.message).join(' '),
  };
}

/**
 * Publishes to one X account through the v2 API: images go up through the
 * chunked upload endpoints (initialize, append, finalize, and a status check
 * while X processes them), then `POST /2/tweets` carries their ids.
 *
 * Text and up to four images. Video, polls, quotes, threads and replies are
 * real X features this adapter does not implement, so `supportedMedia` says
 * IMAGE and the executor refuses anything else before a request is made.
 */
export class XPublisher implements PostPublisher {
  readonly platform = X_PLATFORM;
  readonly adapterVersion = X_ADAPTER_VERSION;
  readonly supportedMedia: SupportedMedia = {
    kinds: ['IMAGE'],
    // X's reference does not enumerate accepted types; it refuses what it will
    // not take, and the refusal is reported in its own words.
    mimeTypes: [],
    maxItems: X_MAX_IMAGES,
  };

  private readonly client: XClient;

  constructor(private readonly options: XPublisherOptions) {
    this.client = new XClient(options.accessToken, options);
  }

  validate(input: PublishInput): PublishValidationIssue[] {
    return validateXPost(input);
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    const issues = this.validate(input);
    if (issues.length > 0) return invalid(issues);

    const media = input.media ?? [];
    const scopes = this.options.grantedScopes;
    if (media.length > 0 && scopes && !scopes.includes(X_SCOPES.media)) {
      return {
        status: 'FAILED',
        failureCode: 'PERMISSION',
        failureReason: `Uploading an image to X needs the ${X_SCOPES.media} scope, which this connection was not granted. Reconnect X, or post without the image. Nothing was published.`,
      };
    }

    const mediaIds: string[] = [];
    for (const item of media) {
      try {
        mediaIds.push(await this.ensureMedia(item));
      } catch (error) {
        return this.failure(error, 'upload the image');
      }
    }

    let postId: string;
    try {
      const body = await this.client.postJson<unknown>(X_PATHS.posts, {
        text: xPostText(input),
        ...(mediaIds.length > 0 ? { media: { media_ids: mediaIds } } : {}),
      });
      const parsed = postSchema.safeParse(body ?? {});
      if (!parsed.success || !X_ID.test(parsed.data.data.id)) {
        return {
          status: 'FAILED',
          failureCode: 'AMBIGUOUS',
          failureReason:
            'X accepted the post but did not return its id. Check the account before publishing again, or it may appear twice.',
        };
      }
      postId = parsed.data.data.id;
    } catch (error) {
      return this.failure(error, 'create the post');
    }

    for (const item of media) {
      await this.options.ledger?.attached(item.assetId, postId).catch(() => undefined);
    }
    return {
      status: 'PUBLISHED',
      externalPostId: postId,
      externalUrl: xPostUrl(this.options.username ?? null, postId),
      publishedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    };
  }

  /** Uploads one image, reusing what an earlier attempt already sent. */
  private async ensureMedia(item: PublishMediaInput): Promise<string> {
    const ledger = this.options.ledger;
    const previous = await ledger?.find(item.assetId);
    if (previous?.mediaId && previous.verified) return previous.mediaId;

    const bytes = await item.load().catch(() => null);
    if (!bytes) {
      await ledger?.failed(item.assetId, 'image could not be read from storage');
      throw new XApiError(
        'VALIDATION',
        null,
        null,
        'The attached image could not be read from storage',
      );
    }

    const initialized = mediaSchema.safeParse(
      await this.client.initializeMedia({
        mediaType: item.mimeType,
        totalBytes: bytes.byteLength,
        mediaCategory:
          item.mimeType === 'image/gif' ? X_MEDIA_CATEGORY.gif : X_MEDIA_CATEGORY.image,
      }),
    );
    if (!initialized.success) {
      throw new XApiError('UNKNOWN', null, null, 'X did not return a media id for the upload');
    }
    const mediaId = initialized.data.data.id;
    await ledger?.registered(item.assetId, mediaId);

    // "Keep each segment at or below 5 MB."
    let index = 0;
    for (let offset = 0; offset < bytes.byteLength; offset += X_MAX_SEGMENT_BYTES) {
      await this.client.appendMedia(mediaId, {
        segmentIndex: index,
        bytes: bytes.subarray(offset, Math.min(offset + X_MAX_SEGMENT_BYTES, bytes.byteLength)),
        contentType: item.mimeType,
      });
      index += 1;
    }
    await this.client.finalizeMedia(mediaId);

    const verified = await this.awaitProcessing(mediaId);
    await ledger?.uploaded(item.assetId, verified);
    return mediaId;
  }

  /**
   * X may still be processing a finalized upload. A file that is not ready
   * cannot be attached, so this waits — and says so rather than posting
   * something that would come back rejected.
   */
  private async awaitProcessing(mediaId: string): Promise<boolean> {
    const checks = Math.max(1, this.options.statusChecks ?? 4);
    const sleep =
      this.options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < checks; attempt += 1) {
      const status = await this.client.mediaStatus(mediaId);
      // No processing_info at all means the file is ready to use.
      if (status.state === null || status.state === 'succeeded') return true;
      if (status.state === 'failed') {
        throw new XApiError(
          'VALIDATION',
          null,
          'media-processing-failed',
          `X could not process the image${status.error ? `: ${status.error}` : ''}`,
        );
      }
      if (attempt < checks - 1) {
        await sleep(
          (status.checkAfterSeconds ?? 1) * 1000 || (this.options.pollIntervalMs ?? 1000),
        );
      }
    }
    throw new XApiError(
      'TRANSIENT',
      null,
      'media-still-processing',
      'X is still processing the image; publish again shortly (the upload is kept)',
    );
  }

  private async failure(error: unknown, step: string): Promise<PublishOutcome> {
    if (!(error instanceof XApiError)) throw error;
    if (error.kind === 'AUTH') await this.options.onAuthRejected?.().catch(() => undefined);
    if (error.ambiguous) {
      return {
        status: 'FAILED',
        failureCode: 'AMBIGUOUS',
        failureReason: `X did not answer while Spectra tried to ${step}; the post may exist. Check the account before publishing again.`,
      };
    }
    const advice = ADVICE[error.kind];
    return {
      status: 'FAILED',
      failureCode: FAILURE_CODE[error.kind],
      failureReason: `Could not ${step}: ${error.message}.${advice ? ` ${advice}` : ''}`,
    };
  }
}
