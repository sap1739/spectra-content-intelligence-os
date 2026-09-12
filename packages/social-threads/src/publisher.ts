import type { PublishFailureCode } from '@spectra/contracts';
import type {
  PostPublisher,
  PublishInput,
  PublishOutcome,
  PublishValidationIssue,
  SupportedMedia,
} from '@spectra/social-core';
import { z } from 'zod';

import {
  ThreadsApiError,
  ThreadsClient,
  type ThreadsApiOptions,
  type ThreadsErrorKind,
} from './client';
import {
  THREADS_ADAPTER_VERSION,
  THREADS_ID,
  THREADS_IMAGE_MIME_TYPES,
  THREADS_PLATFORM,
  THREADS_PUBLISH_DELAY_MS,
  threadsPostUrl,
} from './constants';
import { threadsPostText, validateThreadsPost } from './text';

/**
 * Where one publish's Threads container got to, keyed by the publish
 * idempotency key and persisted by the caller. A container is staged, not
 * posted: a retry publishes the container it already made rather than making
 * a second one.
 */
export interface ThreadsContainerLedger {
  find(idempotencyKey: string): Promise<string | null>;
  staged(idempotencyKey: string, containerId: string): Promise<boolean>;
  cleared(idempotencyKey: string): Promise<void>;
}

export interface ThreadsPublisherOptions extends ThreadsApiOptions {
  accessToken: string;
  /** The app-scoped Threads user id the publishing endpoints address. */
  threadsUserId: string;
  grantedScopes: readonly string[] | null;
  /** For the post's link, when discovery reported the handle. */
  username?: string | null;
  ledger?: ThreadsContainerLedger;
  /** Meta recommends ~30s between container and publish. */
  publishDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onAuthRejected?: () => Promise<void>;
  now?: () => Date;
}

const FAILURE_CODE: Record<ThreadsErrorKind, PublishFailureCode> = {
  AUTH: 'AUTH',
  PERMISSION: 'PERMISSION',
  RATE_LIMIT: 'RATE_LIMIT',
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'VALIDATION',
  TRANSIENT: 'TRANSIENT',
  UNKNOWN: 'UNKNOWN',
};

const ADVICE: Partial<Record<ThreadsErrorKind, string>> = {
  AUTH: 'Threads rejected the authorization (expired or revoked) — reconnect Threads.',
  PERMISSION:
    'The connection lacks a Threads permission, or the app does not have advanced access yet.',
  RATE_LIMIT: 'Threads limits a profile to 250 API-published posts per 24 hours — try again later.',
  TRANSIENT: 'Threads had a temporary problem — try again.',
};

const idSchema = z.object({ id: z.string().min(1).max(120) });

function invalid(issues: PublishValidationIssue[]): PublishOutcome {
  return {
    status: 'FAILED',
    failureCode: 'VALIDATION',
    failureReason: issues.map((issue) => issue.message).join(' '),
  };
}

/**
 * Publishes to one Threads profile: create a media container
 * (`POST /{id}/threads`), wait for Meta to process it, then publish it
 * (`POST /{id}/threads_publish`).
 *
 * Text posts and single-image posts only. Video, carousels, replies and quotes
 * are real Threads features this adapter does not implement, so
 * `supportedMedia` says IMAGE and the executor refuses anything else first.
 */
export class ThreadsPublisher implements PostPublisher {
  readonly platform = THREADS_PLATFORM;
  readonly adapterVersion = THREADS_ADAPTER_VERSION;
  readonly supportedMedia: SupportedMedia = {
    kinds: ['IMAGE'],
    mimeTypes: THREADS_IMAGE_MIME_TYPES,
    maxItems: 1,
  };

  private readonly client: ThreadsClient;

  constructor(private readonly options: ThreadsPublisherOptions) {
    if (!THREADS_ID.test(options.threadsUserId)) {
      throw new Error('A Threads user id is numeric');
    }
    this.client = new ThreadsClient(options.accessToken, options);
  }

  validate(input: PublishInput): PublishValidationIssue[] {
    return validateThreadsPost(input);
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    const issues = this.validate(input);
    if (issues.length > 0) return invalid(issues);

    const text = threadsPostText(input);
    const media = input.media?.[0];
    const ledger = this.options.ledger;
    const now = () => (this.options.now ?? (() => new Date()))();
    const sleep =
      this.options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    let imageUrl: string | undefined;
    if (media) {
      if (!media.url) {
        return {
          status: 'FAILED',
          failureCode: 'UNSUPPORTED_MEDIA',
          failureReason:
            'Threads fetches the image itself, and this deployment cannot give it a link to the file (object storage is not reachable from the internet). Post without the image, or serve storage publicly. Nothing was published.',
        };
      }
      try {
        imageUrl = await media.url();
      } catch {
        return {
          status: 'FAILED',
          failureCode: 'VALIDATION',
          failureReason: 'A link to the attached image could not be made. Nothing was published.',
        };
      }
    }

    // A container an earlier attempt staged is published, never remade.
    let containerId = (await ledger?.find(input.idempotencyKey)) ?? null;
    const reused = containerId !== null;
    if (!containerId) {
      try {
        const body = await this.client.post<unknown>(`${this.options.threadsUserId}/threads`, {
          media_type: media ? 'IMAGE' : 'TEXT',
          ...(text ? { text } : {}),
          ...(imageUrl ? { image_url: imageUrl } : {}),
          ...(media?.altText ? { alt_text: media.altText } : {}),
        });
        const parsed = idSchema.safeParse(body ?? {});
        if (!parsed.success) {
          return {
            status: 'FAILED',
            failureCode: 'TRANSIENT',
            failureReason:
              'Threads did not return a container id for the post. Nothing was published; try again.',
          };
        }
        containerId = parsed.data.id;
      } catch (error) {
        return this.failure(error, 'prepare the post', false);
      }
      const recorded = (await ledger?.staged(input.idempotencyKey, containerId)) ?? true;
      if (!recorded) {
        return {
          status: 'FAILED',
          failureCode: 'TRANSIENT',
          failureReason:
            'The Threads post was prepared but Spectra could not record it, so it was not published (publishing without that record risks posting twice). Try again.',
        };
      }
      // Meta's own recommendation: let the container finish processing.
      await sleep(this.options.publishDelayMs ?? THREADS_PUBLISH_DELAY_MS);
    }

    let postId: string;
    try {
      const body = await this.client.post<unknown>(
        `${this.options.threadsUserId}/threads_publish`,
        { creation_id: containerId },
      );
      const parsed = idSchema.safeParse(body ?? {});
      if (!parsed.success) {
        return {
          status: 'FAILED',
          failureCode: 'AMBIGUOUS',
          failureReason:
            'Threads accepted the post but did not return its id. Check the profile before publishing again, or it may appear twice.',
        };
      }
      postId = parsed.data.id;
    } catch (error) {
      // A container this attempt did not create may already have been
      // published by the attempt that made it.
      return this.failure(error, 'publish the post', reused);
    }

    const url = threadsPostUrl(this.options.username ?? null, postId);
    return {
      status: 'PUBLISHED',
      externalPostId: postId,
      ...(url ? { externalUrl: url } : {}),
      publishedAt: now().toISOString(),
      ...(reused
        ? {
            note: 'This post was prepared by an earlier attempt; Spectra published that same one rather than preparing another.',
          }
        : {}),
    };
  }

  private async failure(
    error: unknown,
    step: string,
    reusedContainer: boolean,
  ): Promise<PublishOutcome> {
    if (!(error instanceof ThreadsApiError)) throw error;
    if (error.kind === 'AUTH') await this.options.onAuthRejected?.().catch(() => undefined);
    if (error.ambiguous) {
      return {
        status: 'FAILED',
        failureCode: 'AMBIGUOUS',
        failureReason: `Threads did not answer while Spectra tried to ${step}; the post may exist. Check the profile before publishing again.`,
      };
    }
    if (reusedContainer && error.kind === 'VALIDATION') {
      return {
        status: 'FAILED',
        failureCode: 'AMBIGUOUS',
        failureReason: `Threads refused to publish the post an earlier attempt prepared (${error.message}), which usually means that attempt already published it. Check the profile before publishing again.`,
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
