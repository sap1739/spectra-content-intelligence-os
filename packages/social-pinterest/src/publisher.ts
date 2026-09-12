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
  PinterestApiError,
  PinterestClient,
  type PinterestApiOptions,
  type PinterestErrorKind,
} from './client';
import {
  PINTEREST_ADAPTER_VERSION,
  PINTEREST_ID,
  PINTEREST_PATHS,
  PINTEREST_PLATFORM,
  pinUrl,
} from './constants';
import { pinCreateBody, pinDescription, pinLink, pinTitle, validatePinterestPin } from './text';

export interface PinterestPublisherOptions extends PinterestApiOptions {
  accessToken: string;
  /** The board this account publishes to — a pin always belongs to one. */
  boardId: string;
  grantedScopes: readonly string[] | null;
  /** A fallback destination link, where the entry carries none. */
  link?: string | null;
  onAuthRejected?: () => Promise<void>;
  now?: () => Date;
}

const FAILURE_CODE: Record<PinterestErrorKind, PublishFailureCode> = {
  AUTH: 'AUTH',
  PERMISSION: 'PERMISSION',
  IMAGE_REFUSED: 'VALIDATION',
  RATE_LIMIT: 'RATE_LIMIT',
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'VALIDATION',
  TRANSIENT: 'TRANSIENT',
  UNKNOWN: 'UNKNOWN',
};

const ADVICE: Partial<Record<PinterestErrorKind, string>> = {
  AUTH: 'Pinterest rejected the authorization (expired or revoked) — reconnect Pinterest.',
  PERMISSION:
    'The connection lacks a Pinterest scope, or the app only has Trial access — check the Pinterest developer portal.',
  IMAGE_REFUSED:
    'Pinterest refused the image itself (it answers this when an image is too small, too large or broken). Try a different image.',
  NOT_FOUND: 'Pinterest could not find that board — reconnect Pinterest to refresh the board list.',
  RATE_LIMIT: 'Pinterest is rate-limiting this account — try again later.',
  TRANSIENT: 'Pinterest had a temporary problem — try again.',
};

const pinSchema = z.object({ id: z.string().min(1).max(80) });

function invalid(issues: PublishValidationIssue[]): PublishOutcome {
  return {
    status: 'FAILED',
    failureCode: 'VALIDATION',
    failureReason: issues.map((issue) => issue.message).join(' '),
  };
}

/**
 * Creates one image pin on a board (`POST /v5/pins`), with Pinterest fetching
 * the image from a short-lived link to this deployment's storage.
 *
 * Image pins only. Video pins, carousels, board creation and edits are real
 * Pinterest features this adapter does not implement, so `supportedMedia`
 * says IMAGE and the executor refuses anything else before a request is made.
 */
export class PinterestPublisher implements PostPublisher {
  readonly platform = PINTEREST_PLATFORM;
  readonly adapterVersion = PINTEREST_ADAPTER_VERSION;
  readonly supportedMedia: SupportedMedia = {
    kinds: ['IMAGE'],
    // Pinterest documents no format list; it refuses what it will not take.
    mimeTypes: [],
    maxItems: 1,
  };

  private readonly client: PinterestClient;

  constructor(private readonly options: PinterestPublisherOptions) {
    if (!PINTEREST_ID.test(options.boardId)) throw new Error('A Pinterest board id is required');
    this.client = new PinterestClient(options.accessToken, options);
  }

  validate(input: PublishInput): PublishValidationIssue[] {
    return validatePinterestPin(input, {
      boardId: this.options.boardId,
      link: pinLink(input) ?? this.options.link ?? null,
    });
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    const issues = this.validate(input);
    if (issues.length > 0) return invalid(issues);

    const media = input.media?.[0];
    if (!media) return invalid([{ code: 'IMAGE_REQUIRED', message: 'A pin needs an image.' }]);
    if (!media.url) {
      return {
        status: 'FAILED',
        failureCode: 'UNSUPPORTED_MEDIA',
        failureReason:
          'Pinterest fetches the image itself, and this deployment cannot give it a link to the file (object storage is not reachable from the internet). Serve storage publicly to pin. Nothing was published.',
      };
    }

    let imageUrl: string;
    try {
      imageUrl = await media.url();
    } catch {
      return {
        status: 'FAILED',
        failureCode: 'VALIDATION',
        failureReason: 'A link to the attached image could not be made. Nothing was published.',
      };
    }

    try {
      const body = await this.client.post<unknown>(
        PINTEREST_PATHS.pins,
        pinCreateBody({
          boardId: this.options.boardId,
          imageUrl,
          title: pinTitle(input),
          description: pinDescription(input),
          altText: media.altText,
          link: pinLink(input) ?? this.options.link ?? null,
        }),
      );
      const parsed = pinSchema.safeParse(body ?? {});
      if (!parsed.success) {
        return {
          status: 'FAILED',
          failureCode: 'AMBIGUOUS',
          failureReason:
            'Pinterest accepted the pin but did not return its id. Check the board before publishing again, or it may appear twice.',
        };
      }
      return {
        status: 'PUBLISHED',
        externalPostId: parsed.data.id,
        externalUrl: pinUrl(parsed.data.id),
        publishedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      };
    } catch (error) {
      return this.failure(error, 'create the pin');
    }
  }

  private async failure(error: unknown, step: string): Promise<PublishOutcome> {
    if (!(error instanceof PinterestApiError)) throw error;
    if (error.kind === 'AUTH') await this.options.onAuthRejected?.().catch(() => undefined);
    if (error.ambiguous) {
      return {
        status: 'FAILED',
        failureCode: 'AMBIGUOUS',
        failureReason: `Pinterest did not answer while Spectra tried to ${step}; the pin may exist. Check the board before publishing again.`,
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
