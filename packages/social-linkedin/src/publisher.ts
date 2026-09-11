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

import {
  LinkedInApiError,
  LinkedInClient,
  type LinkedInApiOptions,
  type LinkedInErrorKind,
} from './client';
import {
  LINKEDIN_ADAPTER_VERSION,
  LINKEDIN_IMAGE_MIME_TYPES,
  LINKEDIN_PLATFORM,
  LINKEDIN_SCOPES,
  SPECTRA_MAX_IMAGE_BYTES,
  linkedInPostUrl,
} from './constants';
import { linkedInPostText, toLittleText, validateLinkedInPost } from './text';

/**
 * Where one asset's LinkedIn upload got to. Persisted by the caller so a retry
 * reuses an image LinkedIn already has instead of uploading it again — LinkedIn
 * documents Images API uploads as reusable across posts.
 */
export interface MediaUploadLedger {
  find(assetId: string): Promise<{
    externalMediaId: string | null;
    status: 'REGISTERED' | 'UPLOADED' | 'FAILED';
    verified: boolean;
  } | null>;
  registered(
    assetId: string,
    externalMediaId: string,
    uploadUrlExpiresAt: Date | null,
  ): Promise<void>;
  uploaded(assetId: string, verified: boolean): Promise<void>;
  failed(assetId: string, reason: string): Promise<void>;
  attached(assetId: string, postUrn: string): Promise<void>;
}

export interface LinkedInPublisherOptions extends LinkedInApiOptions {
  accessToken: string;
  /** `urn:li:person:{id}` or `urn:li:organization:{id}`. */
  authorUrn: string;
  grantedScopes: readonly string[] | null;
  ledger?: MediaUploadLedger;
  /** LinkedIn rejected the token (401): the caller marks the connection for reconnect. */
  onAuthRejected?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Status checks after an upload, where the token may read image status. */
  imageStatusChecks?: number;
}

const AUTHOR_URN = /^urn:li:(person|organization):[^\s:/]{1,200}$/;
const initializeSchema = z.object({
  value: z.object({
    uploadUrl: z.string().url(),
    image: z.string().regex(/^urn:li:image:[^\s/]{1,200}$/),
    uploadUrlExpiresAt: z.number().optional(),
  }),
});
const imageStatusSchema = z.object({ status: z.string().optional() });

const FAILURE_CODE: Record<LinkedInErrorKind, PublishFailureCode> = {
  AUTH: 'AUTH',
  PERMISSION: 'PERMISSION',
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'VALIDATION',
  RATE_LIMIT: 'RATE_LIMIT',
  CONFLICT: 'TRANSIENT',
  TRANSIENT: 'TRANSIENT',
  UNKNOWN: 'UNKNOWN',
};

const ADVICE: Partial<Record<LinkedInErrorKind, string>> = {
  AUTH: 'The LinkedIn authorization was rejected (expired or revoked) — reconnect LinkedIn.',
  PERMISSION:
    'The connection lacks the scope for this account, or the member no longer has a posting role on this page.',
  RATE_LIMIT: 'LinkedIn rate limit reached — try again later.',
  TRANSIENT: 'LinkedIn had a temporary problem — try again.',
  CONFLICT: 'LinkedIn reported a write conflict — try again.',
};

class MediaReadError extends Error {
  constructor() {
    super('The attached image could not be read from storage');
    this.name = 'MediaReadError';
  }
}

/**
 * Publishes to LinkedIn through the Posts API (`POST /rest/posts`), uploading
 * an image first through the Images API (initializeUpload, then PUT).
 *
 * Text and ONE image only. Video, documents, multi-image, articles and polls
 * are real LinkedIn features this adapter does not implement, so
 * `supportedMedia` says IMAGE and the executor refuses anything else as
 * UNSUPPORTED before any request is made.
 */
export class LinkedInPublisher implements PostPublisher {
  readonly platform = LINKEDIN_PLATFORM;
  readonly adapterVersion = LINKEDIN_ADAPTER_VERSION;
  readonly supportedMedia: SupportedMedia = {
    kinds: ['IMAGE'],
    mimeTypes: LINKEDIN_IMAGE_MIME_TYPES,
    maxItems: 1,
  };

  private readonly client: LinkedInClient;

  constructor(private readonly options: LinkedInPublisherOptions) {
    if (!AUTHOR_URN.test(options.authorUrn)) {
      throw new Error('A LinkedIn author must be a person or organization URN');
    }
    this.client = new LinkedInClient(options.accessToken, options);
  }

  validate(input: PublishInput): PublishValidationIssue[] {
    return validateLinkedInPost(input);
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    const issues = this.validate(input);
    if (issues.length > 0) {
      return {
        status: 'FAILED',
        failureCode: 'VALIDATION',
        failureReason: issues.map((issue) => issue.message).join(' '),
      };
    }

    const media = input.media?.[0];
    let imageUrn: string | null = null;
    if (media) {
      try {
        imageUrn = await this.ensureImage(media);
      } catch (error) {
        return this.failure(error, 'upload the image');
      }
    }

    const body = {
      author: this.options.authorUrn,
      commentary: toLittleText(linkedInPostText(input)),
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      ...(imageUrn && media
        ? {
            content: {
              media: { id: imageUrn, ...(media.altText ? { altText: media.altText } : {}) },
            },
          }
        : {}),
    };

    let postUrn: string | null;
    try {
      const response = await this.client.rest<unknown>('POST', '/rest/posts', { body });
      postUrn = response.headers.get('x-restli-id');
    } catch (error) {
      return this.failure(error, 'create the post');
    }
    if (!postUrn) {
      return {
        status: 'FAILED',
        failureCode: 'AMBIGUOUS',
        failureReason:
          'LinkedIn accepted the post but did not return its id. Check the LinkedIn page before publishing again, or it may appear twice.',
      };
    }
    if (imageUrn && media) {
      await this.options.ledger?.attached(media.assetId, postUrn).catch(() => undefined);
    }
    return {
      status: 'PUBLISHED',
      externalPostId: postUrn,
      externalUrl: linkedInPostUrl(postUrn),
      publishedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    };
  }

  private async failure(error: unknown, step: string): Promise<PublishOutcome> {
    if (error instanceof MediaReadError) {
      return { status: 'FAILED', failureCode: 'VALIDATION', failureReason: `${error.message}.` };
    }
    if (!(error instanceof LinkedInApiError)) throw error;
    if (error.kind === 'AUTH') await this.options.onAuthRejected?.().catch(() => undefined);
    if (error.ambiguous) {
      return {
        status: 'FAILED',
        failureCode: 'AMBIGUOUS',
        failureReason: `LinkedIn did not answer while Spectra tried to ${step}; the post may have been created. Check LinkedIn before publishing again, or it may appear twice.`,
      };
    }
    const advice = ADVICE[error.kind];
    return {
      status: 'FAILED',
      failureCode: FAILURE_CODE[error.kind],
      failureReason: `Could not ${step}: ${error.message}.${advice ? ` ${advice}` : ''}`,
    };
  }

  /** Only page authors with w_organization_social can read image status; member tokens are write-only. */
  private canCheckImages(): boolean {
    return (
      this.options.authorUrn.startsWith('urn:li:organization:') &&
      (this.options.grantedScopes?.includes(LINKEDIN_SCOPES.orgSocial) ?? false)
    );
  }

  private async ensureImage(media: PublishMediaInput): Promise<string> {
    const ledger = this.options.ledger;
    const previous = await ledger?.find(media.assetId);
    if (previous?.status === 'UPLOADED' && previous.externalMediaId) {
      // Already on LinkedIn from an earlier attempt — reuse, never upload twice.
      if (!previous.verified && this.canCheckImages()) {
        await this.awaitProcessing(media.assetId, previous.externalMediaId);
      }
      return previous.externalMediaId;
    }

    const init = await this.client.rest<unknown>('POST', '/rest/images', {
      query: 'action=initializeUpload',
      body: { initializeUploadRequest: { owner: this.options.authorUrn } },
    });
    const parsed = initializeSchema.safeParse(init.body);
    if (!parsed.success) {
      throw new LinkedInApiError(
        'UNKNOWN',
        init.status,
        null,
        'LinkedIn did not return an upload URL for the image',
      );
    }
    const { uploadUrl, image, uploadUrlExpiresAt } = parsed.data.value;
    await ledger?.registered(
      media.assetId,
      image,
      uploadUrlExpiresAt ? new Date(uploadUrlExpiresAt) : null,
    );

    let bytes: Buffer;
    try {
      bytes = await media.load();
    } catch {
      await ledger?.failed(media.assetId, 'image could not be read from storage');
      throw new MediaReadError();
    }
    if (bytes.length > SPECTRA_MAX_IMAGE_BYTES) {
      await ledger?.failed(media.assetId, 'image over 20 MB');
      throw new LinkedInApiError(
        'VALIDATION',
        null,
        null,
        'The image is over 20 MB (a Spectra limit)',
      );
    }

    try {
      await this.client.upload(uploadUrl, bytes);
    } catch (error) {
      await ledger?.failed(
        media.assetId,
        error instanceof Error ? error.message.slice(0, 300) : 'upload failed',
      );
      throw error;
    }

    let verified = false;
    if (this.canCheckImages()) verified = await this.awaitProcessing(media.assetId, image);
    await ledger?.uploaded(media.assetId, verified);
    return image;
  }

  /**
   * Waits for LinkedIn to finish processing an image. LinkedIn warns that a
   * post created on an image that then fails processing is not shown, so
   * where the token can check, the post waits for AVAILABLE.
   */
  private async awaitProcessing(assetId: string, imageUrn: string): Promise<boolean> {
    const checks = this.options.imageStatusChecks ?? 5;
    const sleep =
      this.options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < checks; attempt += 1) {
      const { body } = await this.client.rest<unknown>(
        'GET',
        `/rest/images/${encodeURIComponent(imageUrn)}`,
      );
      const status = imageStatusSchema.safeParse(body ?? {}).data?.status;
      if (status === 'AVAILABLE') return true;
      if (status === 'PROCESSING_FAILED') {
        await this.options.ledger?.failed(assetId, 'LinkedIn could not process the image');
        throw new LinkedInApiError(
          'VALIDATION',
          null,
          'PROCESSING_FAILED',
          'LinkedIn could not process the image (unsupported or corrupt file)',
        );
      }
      if (attempt < checks - 1) await sleep(1000);
    }
    // Keep the upload so the next attempt reuses it rather than uploading again.
    await this.options.ledger?.uploaded(assetId, false);
    throw new LinkedInApiError(
      'TRANSIENT',
      null,
      null,
      'LinkedIn is still processing the image; publish again shortly (the upload is kept)',
    );
  }
}
