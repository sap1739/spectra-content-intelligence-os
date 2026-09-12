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
  YouTubeApiError,
  YouTubeClient,
  type YouTubeApiOptions,
  type YouTubeErrorKind,
} from './client';
import {
  DEFAULT_UPLOAD_CHUNK_BYTES,
  UNAUDITED_PROJECT_NOTE,
  UPLOAD_CHUNK_MULTIPLE,
  VIDEO_ID,
  YOUTUBE_ADAPTER_VERSION,
  YOUTUBE_PLATFORM,
  YOUTUBE_VIDEO_MIME_TYPES,
  youTubeWatchUrl,
} from './constants';
import { resolveYouTubeMetadata, validateYouTubeVideo, videoResource } from './text';

/**
 * How far one asset's upload to one channel got, persisted by the caller so an
 * interrupted upload resumes instead of starting again — Google's resumable
 * protocol is what makes that safe, and a finished upload is never sent twice.
 * The session URL is a capability: whoever holds it can write to that upload,
 * so the caller seals it.
 */
export interface ResumableUploadLedger {
  find(assetId: string): Promise<{
    sessionUrl: string | null;
    uploadedBytes: number;
    videoId: string | null;
    status: 'REGISTERED' | 'UPLOADED' | 'FAILED';
  } | null>;
  started(assetId: string, sessionUrl: string): Promise<void>;
  progressed(assetId: string, uploadedBytes: number): Promise<void>;
  finished(assetId: string, videoId: string): Promise<void>;
  failed(assetId: string, reason: string): Promise<void>;
}

export interface YouTubePublisherOptions extends YouTubeApiOptions {
  accessToken: string;
  /** The channel this account publishes to, for the outcome's link. */
  channelId: string;
  grantedScopes: readonly string[] | null;
  ledger?: ResumableUploadLedger;
  /** Resumable chunk size; Google requires a multiple of 256 KiB. */
  chunkBytes?: number;
  /** Whether the operator declared this API project audited by Google. */
  projectAudited?: boolean;
  /** YouTube rejected the token: the caller marks the connection for reconnect. */
  onAuthRejected?: () => Promise<void>;
  now?: () => Date;
}

const FAILURE_CODE: Record<YouTubeErrorKind, PublishFailureCode> = {
  AUTH: 'AUTH',
  PERMISSION: 'PERMISSION',
  QUOTA: 'QUOTA',
  RATE_LIMIT: 'RATE_LIMIT',
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'VALIDATION',
  TRANSIENT: 'TRANSIENT',
  UNKNOWN: 'UNKNOWN',
};

const ADVICE: Partial<Record<YouTubeErrorKind, string>> = {
  AUTH: 'YouTube rejected the authorization (expired or revoked) — reconnect YouTube.',
  PERMISSION:
    'The connection lacks the scope for this, or the Google account may not act on this channel.',
  QUOTA:
    "This project's YouTube Data API quota is used up. It resets at midnight Pacific Time; Google can also grant more quota on request.",
  RATE_LIMIT: 'YouTube is rate-limiting this channel or project — try again later.',
  TRANSIENT: 'YouTube had a temporary problem — try again.',
};

const videoSchema = z.object({
  id: z.string().min(1).max(100),
  status: z
    .object({
      uploadStatus: z.string().max(40).optional(),
      privacyStatus: z.string().max(40).optional(),
      failureReason: z.string().max(80).optional(),
      rejectionReason: z.string().max(80).optional(),
    })
    .passthrough()
    .optional(),
});

class MediaReadError extends Error {
  constructor(what: string) {
    super(`The attached ${what}`);
    this.name = 'MediaReadError';
  }
}

function invalid(issues: PublishValidationIssue[]): PublishOutcome {
  return {
    status: 'FAILED',
    failureCode: 'VALIDATION',
    failureReason: issues.map((issue) => issue.message).join(' '),
  };
}

/**
 * Uploads a video to one YouTube channel through the Data API v3, using
 * Google's documented resumable upload: start a session, send the bytes in
 * chunks, and resume from what YouTube confirms it already has.
 *
 * Videos only. Community posts, livestreams, playlists, editing and deleting
 * are real YouTube features this adapter does not implement, so
 * `supportedMedia` says VIDEO and the executor refuses anything else as
 * UNSUPPORTED before a request is made.
 */
export class YouTubeVideoPublisher implements PostPublisher {
  readonly platform = YOUTUBE_PLATFORM;
  readonly adapterVersion = YOUTUBE_ADAPTER_VERSION;
  readonly supportedMedia: SupportedMedia = {
    kinds: ['VIDEO'],
    mimeTypes: YOUTUBE_VIDEO_MIME_TYPES,
    maxItems: 1,
  };

  private readonly client: YouTubeClient;

  constructor(private readonly options: YouTubePublisherOptions) {
    this.client = new YouTubeClient(options.accessToken, options);
  }

  validate(input: PublishInput): PublishValidationIssue[] {
    return validateYouTubeVideo(input);
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    const issues = this.validate(input);
    if (issues.length > 0) return invalid(issues);

    const media = input.media?.[0];
    if (!media) return invalid([{ code: 'VIDEO_REQUIRED', message: 'YouTube publishes videos.' }]);
    const { metadata } = resolveYouTubeMetadata(input);
    const ledger = this.options.ledger;
    const now = () => (this.options.now ?? (() => new Date()))();

    const previous = await ledger?.find(media.assetId);
    if (previous?.videoId && VIDEO_ID.test(previous.videoId)) {
      // The upload finished on an earlier attempt: never upload it twice.
      return {
        status: 'PUBLISHED',
        externalPostId: previous.videoId,
        externalUrl: youTubeWatchUrl(previous.videoId),
        publishedAt: now().toISOString(),
        note: 'An earlier attempt had already uploaded this video, so Spectra did not upload it again.',
      };
    }

    let bytes: Buffer;
    try {
      bytes = await media.load();
    } catch {
      await ledger?.failed(media.assetId, 'video could not be read from storage');
      return {
        status: 'FAILED',
        failureCode: 'VALIDATION',
        failureReason: new MediaReadError('video could not be read from storage.').message,
      };
    }
    const total = bytes.byteLength;
    if (total === 0) {
      return {
        status: 'FAILED',
        failureCode: 'VALIDATION',
        failureReason: 'The attached video file is empty.',
      };
    }

    let sessionUrl = previous?.sessionUrl ?? null;
    let start = 0;
    let video: unknown = null;

    if (sessionUrl) {
      try {
        const progress = await this.client.probeUpload(sessionUrl, total);
        if (progress.done) video = progress.video;
        start = progress.nextByte;
      } catch (error) {
        if (error instanceof YouTubeApiError && error.sessionExpired) {
          // The session is gone; nothing was published, so start a fresh one.
          sessionUrl = null;
        } else {
          return this.failure(error, 'check the interrupted upload');
        }
      }
    }

    if (!video) {
      if (!sessionUrl) {
        try {
          sessionUrl = await this.client.initiateUpload({
            part: 'snippet,status',
            params: { notifySubscribers: String(metadata.notifySubscribers) },
            metadata: videoResource(metadata),
            contentLength: total,
            contentType: media.mimeType,
          });
        } catch (error) {
          return this.failure(error, 'start the upload');
        }
        await ledger?.started(media.assetId, sessionUrl);
        start = 0;
      }

      const chunk = this.chunkSize();
      while (start < total) {
        const end = Math.min(start + chunk, total);
        let progress;
        try {
          progress = await this.client.uploadChunk(sessionUrl, {
            bytes: bytes.subarray(start, end),
            start,
            total,
            contentType: media.mimeType,
          });
        } catch (error) {
          if (error instanceof YouTubeApiError && error.sessionExpired) {
            await ledger?.failed(media.assetId, 'upload session expired');
            return {
              status: 'FAILED',
              failureCode: 'TRANSIENT',
              failureReason:
                'The YouTube upload session expired before the video finished uploading. Publish again to start a fresh upload; nothing was published.',
            };
          }
          return this.failure(error, 'upload the video');
        }
        if (progress.done) {
          video = progress.video;
          await ledger?.progressed(media.assetId, total);
          break;
        }
        const next = progress.nextByte;
        if (next <= start) {
          // YouTube is not advancing; keep the session and stop rather than spin.
          return {
            status: 'FAILED',
            failureCode: 'TRANSIENT',
            failureReason:
              'YouTube stopped accepting the video part-way through. Publish again to resume from where it stopped; nothing was published.',
          };
        }
        start = next;
        await ledger?.progressed(media.assetId, start);
      }
    }

    if (!video) {
      return {
        status: 'FAILED',
        failureCode: 'TRANSIENT',
        failureReason:
          'YouTube received the whole video but did not confirm it. Publish again to resume; the upload is kept.',
      };
    }

    const parsed = videoSchema.safeParse(video);
    if (!parsed.success || !VIDEO_ID.test(parsed.data.id)) {
      return {
        status: 'FAILED',
        failureCode: 'AMBIGUOUS',
        failureReason:
          'YouTube accepted the upload but did not return a video id. Check the channel before publishing again, or the video may appear twice.',
      };
    }
    const videoId = parsed.data.id;
    await ledger?.finished(media.assetId, videoId);

    const status = parsed.data.status ?? {};
    if (status.uploadStatus === 'rejected' || status.uploadStatus === 'failed') {
      const why = status.rejectionReason ?? status.failureReason ?? 'no reason given';
      return {
        status: 'FAILED',
        failureCode: 'VALIDATION',
        failureReason: `YouTube ${status.uploadStatus} the video (${why}). It was uploaded as ${videoId} but will not be viewable; fix the file and publish again.`,
      };
    }

    const notes: string[] = [];
    const applied = status.privacyStatus;
    if (applied && applied !== metadata.privacyStatus) {
      notes.push(
        `You asked for ${metadata.privacyStatus}, and YouTube set this video to ${applied}.${
          applied === 'private' && !this.options.projectAudited ? ` ${UNAUDITED_PROJECT_NOTE}` : ''
        }`,
      );
    }
    if (status.uploadStatus === 'uploaded') {
      notes.push('YouTube is still processing the video; it is not viewable until that finishes.');
    }

    if (input.thumbnail) {
      const thumbnail = input.thumbnail;
      try {
        const image = await thumbnail.load();
        await this.client.setThumbnail(videoId, image, thumbnail.mimeType);
      } catch (error) {
        // The video is published; only the thumbnail failed, and saying so is
        // the honest outcome — not a failed publish.
        const why =
          error instanceof YouTubeApiError
            ? error.message
            : 'the image could not be read from storage';
        notes.push(`The video is published, but YouTube did not set the custom thumbnail: ${why}.`);
      }
    }

    return {
      status: 'PUBLISHED',
      externalPostId: videoId,
      externalUrl: youTubeWatchUrl(videoId),
      publishedAt: now().toISOString(),
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    };
  }

  /** Google requires a multiple of 256 KiB; anything else is rounded down. */
  private chunkSize(): number {
    const requested = this.options.chunkBytes ?? DEFAULT_UPLOAD_CHUNK_BYTES;
    const rounded = Math.floor(requested / UPLOAD_CHUNK_MULTIPLE) * UPLOAD_CHUNK_MULTIPLE;
    return Math.max(UPLOAD_CHUNK_MULTIPLE, rounded);
  }

  private async failure(error: unknown, step: string): Promise<PublishOutcome> {
    if (!(error instanceof YouTubeApiError)) throw error;
    if (error.kind === 'AUTH') await this.options.onAuthRejected?.().catch(() => undefined);
    if (error.ambiguous) {
      return {
        status: 'FAILED',
        failureCode: 'AMBIGUOUS',
        failureReason: `YouTube did not answer while Spectra tried to ${step}; the video may exist. Check the channel before publishing again.`,
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
