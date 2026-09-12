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
  TikTokApiError,
  TikTokClient,
  type TikTokApiOptions,
  type TikTokErrorKind,
} from './client';
import {
  TIKTOK_ADAPTER_VERSION,
  TIKTOK_ID,
  TIKTOK_PATHS,
  TIKTOK_PLATFORM,
  TIKTOK_VIDEO_MIME_TYPES,
  UNAUDITED_CLIENT_NOTE,
  chunkPlan,
  chunkRange,
  tikTokPostUrl,
} from './constants';
import { creatorInfoSchema } from './discovery';
import { postInfo, resolveTikTokMetadata, validateTikTokVideo } from './text';

/**
 * How far one asset's TikTok publish got, persisted by the caller. TikTok's
 * `publish_id` is the guard against double-posting: a retry asks TikTok what
 * happened to that publish instead of starting another one.
 */
export interface TikTokPublishLedger {
  find(assetId: string): Promise<{
    publishId: string | null;
    uploadUrl: string | null;
    uploadedBytes: number;
    postId: string | null;
    status: 'REGISTERED' | 'UPLOADED' | 'FAILED';
  } | null>;
  started(assetId: string, publishId: string, uploadUrl: string): Promise<void>;
  progressed(assetId: string, uploadedBytes: number): Promise<void>;
  finished(assetId: string, postId: string): Promise<void>;
  failed(assetId: string, reason: string): Promise<void>;
}

export interface TikTokPublisherOptions extends TikTokApiOptions {
  accessToken: string;
  /** The creator's open id, for the outcome and the ledger. */
  openId: string;
  grantedScopes: readonly string[] | null;
  ledger?: TikTokPublishLedger;
  /** Preferred chunk size; TikTok requires 5–64 MB (a small file goes whole). */
  chunkBytes?: number;
  /** Whether the operator declared this API client audited by TikTok. */
  clientAudited?: boolean;
  /** Status checks after the upload before giving up for this attempt. */
  statusChecks?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onAuthRejected?: () => Promise<void>;
  now?: () => Date;
}

const FAILURE_CODE: Record<TikTokErrorKind, PublishFailureCode> = {
  AUTH: 'AUTH',
  PERMISSION: 'PERMISSION',
  AUDIT: 'PERMISSION',
  RATE_LIMIT: 'RATE_LIMIT',
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'VALIDATION',
  TRANSIENT: 'TRANSIENT',
  UNKNOWN: 'UNKNOWN',
};

const ADVICE: Partial<Record<TikTokErrorKind, string>> = {
  AUTH: 'TikTok rejected the authorization (expired or revoked) — reconnect TikTok.',
  PERMISSION: `The grant lacks the scope for this, or the creator withdrew it.`,
  AUDIT: UNAUDITED_CLIENT_NOTE,
  RATE_LIMIT:
    'TikTok is rate-limiting this creator (it caps posting attempts and flags rapid posting) — try again later.',
  TRANSIENT: 'TikTok had a temporary problem — try again.',
};

const initSchema = z.object({
  data: z.object({
    publish_id: z.string().min(1).max(120),
    upload_url: z.string().url().max(2000).optional(),
  }),
});

const statusSchema = z.object({
  data: z
    .object({
      status: z.string().max(40).optional(),
      fail_reason: z.string().max(120).optional(),
      publicaly_available_post_id: z.array(z.union([z.string(), z.number()])).optional(),
      uploaded_bytes: z.number().int().nonnegative().optional(),
    })
    .passthrough(),
});

function invalid(issues: PublishValidationIssue[]): PublishOutcome {
  return {
    status: 'FAILED',
    failureCode: 'VALIDATION',
    failureReason: issues.map((issue) => issue.message).join(' '),
  };
}

/**
 * Publishes one video to a TikTok creator account with Direct Post: ask TikTok
 * what the creator allows, initialize the publish, upload the file in chunks,
 * then read the status TikTok reports.
 *
 * Video only, one per post. Photo posts, inbox drafts, edits and deletions are
 * real TikTok features this adapter does not implement, so `supportedMedia`
 * says VIDEO and the executor refuses anything else before a request is made.
 */
export class TikTokVideoPublisher implements PostPublisher {
  readonly platform = TIKTOK_PLATFORM;
  readonly adapterVersion = TIKTOK_ADAPTER_VERSION;
  readonly supportedMedia: SupportedMedia = {
    kinds: ['VIDEO'],
    mimeTypes: TIKTOK_VIDEO_MIME_TYPES,
    maxItems: 1,
  };

  private readonly client: TikTokClient;

  constructor(private readonly options: TikTokPublisherOptions) {
    this.client = new TikTokClient(options.accessToken, options);
  }

  validate(input: PublishInput): PublishValidationIssue[] {
    return validateTikTokVideo(input);
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    const issues = this.validate(input);
    if (issues.length > 0) return invalid(issues);

    const media = input.media?.[0];
    if (!media) return invalid([{ code: 'VIDEO_REQUIRED', message: 'TikTok publishes videos.' }]);
    const { metadata } = resolveTikTokMetadata(input);
    const ledger = this.options.ledger;
    const now = () => (this.options.now ?? (() => new Date()))();

    // A publish TikTok already finished is never sent again.
    const previous = await ledger?.find(media.assetId);
    if (previous?.postId) {
      return {
        status: 'PUBLISHED',
        externalPostId: previous.postId,
        publishedAt: now().toISOString(),
        note: 'An earlier attempt had already published this video, so Spectra did not upload it again.',
      };
    }
    if (previous?.publishId && previous.status !== 'FAILED') {
      // Mid-flight from an earlier attempt: ask TikTok, never re-initialize.
      const settled = await this.settle(previous.publishId, media.assetId, null, now);
      if (settled) return settled;
    }

    let creator;
    try {
      creator = await this.creatorInfo();
    } catch (error) {
      return this.failure(error, 'read what the creator allows');
    }
    if (!creator.privacyLevelOptions.includes(metadata.privacyLevel)) {
      const options = creator.privacyLevelOptions.join(', ') || 'none';
      return {
        status: 'FAILED',
        failureCode: 'PERMISSION',
        failureReason: `TikTok does not allow ${metadata.privacyLevel} for this creator right now (it allows: ${options}). ${
          this.options.clientAudited ? '' : `${UNAUDITED_CLIENT_NOTE} `
        }Nothing was published.`,
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
        failureReason: 'The attached video could not be read from storage.',
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
    const plan = chunkPlan(total, this.options.chunkBytes ?? 10 * 1024 * 1024);

    let publishId: string;
    let uploadUrl: string | undefined;
    try {
      const body = await this.client.post<unknown>(TIKTOK_PATHS.videoInit, {
        post_info: postInfo(metadata, creator),
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: total,
          chunk_size: plan.chunkSize,
          total_chunk_count: plan.totalChunkCount,
        },
      });
      const parsed = initSchema.safeParse(body ?? {});
      if (!parsed.success) {
        return {
          status: 'FAILED',
          failureCode: 'AMBIGUOUS',
          failureReason:
            'TikTok accepted the publish but did not return a publish id. Check the TikTok account before publishing again.',
        };
      }
      publishId = parsed.data.data.publish_id;
      uploadUrl = parsed.data.data.upload_url;
    } catch (error) {
      return this.failure(error, 'start the post');
    }
    if (!uploadUrl) {
      return {
        status: 'FAILED',
        failureCode: 'AMBIGUOUS',
        failureReason:
          'TikTok returned no upload URL for this publish. Check the TikTok account before publishing again.',
      };
    }
    await ledger?.started(media.assetId, publishId, uploadUrl);

    for (let index = 0; index < plan.totalChunkCount; index += 1) {
      const { start, end } = chunkRange(total, plan, index);
      try {
        await this.client.uploadChunk(uploadUrl, {
          bytes: bytes.subarray(start, end + 1),
          start,
          end,
          total,
          contentType: media.mimeType,
        });
      } catch (error) {
        if (error instanceof TikTokApiError && error.uploadExpired) {
          await ledger?.failed(media.assetId, 'upload url expired');
          return {
            status: 'FAILED',
            failureCode: 'TRANSIENT',
            failureReason:
              "TikTok's upload link expired before the video finished uploading. Publish again to start a fresh upload; nothing was published.",
          };
        }
        return this.failure(error, 'upload the video');
      }
      await ledger?.progressed(media.assetId, end + 1);
    }

    const settled = await this.settle(publishId, media.assetId, creator.username, now);
    return (
      settled ?? {
        status: 'FAILED',
        failureCode: 'TRANSIENT',
        failureReason:
          'TikTok is still processing the video. Publish again and Spectra will check this same post rather than uploading it twice.',
      }
    );
  }

  /** Polls the publish status; null means "still processing for now". */
  private async settle(
    publishId: string,
    assetId: string,
    username: string | null,
    now: () => Date,
  ): Promise<PublishOutcome | null> {
    const checks = Math.max(1, this.options.statusChecks ?? 4);
    const sleep =
      this.options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < checks; attempt += 1) {
      let status: string | undefined;
      let failReason: string | undefined;
      let postId: string | null = null;
      try {
        const body = await this.client.post<unknown>(TIKTOK_PATHS.status, {
          publish_id: publishId,
        });
        const data = statusSchema.safeParse(body ?? {}).data?.data;
        status = data?.status;
        failReason = data?.fail_reason;
        const ids = data?.publicaly_available_post_id ?? [];
        const first = ids[0];
        if (first !== undefined) postId = String(first);
      } catch (error) {
        return this.failure(error, 'check whether the post went out');
      }

      if (status === 'PUBLISH_COMPLETE') {
        if (postId && TIKTOK_ID.test(postId)) {
          await this.options.ledger?.finished(assetId, postId);
          const url = tikTokPostUrl(username, postId);
          return {
            status: 'PUBLISHED',
            externalPostId: postId,
            ...(url ? { externalUrl: url } : {}),
            publishedAt: now().toISOString(),
          };
        }
        // Published, but TikTok gives a post id only once moderation passes for
        // a public post: record the publish id so a retry never re-posts.
        await this.options.ledger?.finished(assetId, publishId);
        return {
          status: 'PUBLISHED',
          externalPostId: publishId,
          publishedAt: now().toISOString(),
          note: 'TikTok reports the post as complete but has not returned a post id for it yet (it returns one for a public post after moderation), so there is no link to it.',
        };
      }
      if (status === 'FAILED') {
        await this.options.ledger?.failed(assetId, failReason ?? 'failed');
        return {
          status: 'FAILED',
          failureCode: 'VALIDATION',
          failureReason: `TikTok could not publish the video${failReason ? ` (${failReason})` : ''}. Fix the file or caption and publish again.`,
        };
      }
      if (status === 'SEND_TO_USER_INBOX') {
        await this.options.ledger?.finished(assetId, publishId);
        return {
          status: 'FAILED',
          failureCode: 'UNKNOWN',
          failureReason:
            "TikTok sent the video to the creator's inbox instead of publishing it, so it is not live: the creator has to finish the post in the TikTok app.",
        };
      }
      if (attempt < checks - 1) await sleep(this.options.pollIntervalMs ?? 1000);
    }
    return null;
  }

  private async creatorInfo(): Promise<{
    privacyLevelOptions: string[];
    commentDisabled: boolean;
    duetDisabled: boolean;
    stitchDisabled: boolean;
    username: string | null;
  }> {
    // TikTok requires this before a direct post, and it is the only honest
    // source for which privacy levels this creator may use.
    const body = await this.client.post<unknown>(TIKTOK_PATHS.creatorInfo, {});
    const data = creatorInfoSchema.safeParse(body ?? {}).data?.data;
    return {
      privacyLevelOptions: data?.privacy_level_options ? [...data.privacy_level_options] : [],
      commentDisabled: data?.comment_disabled ?? false,
      duetDisabled: data?.duet_disabled ?? false,
      stitchDisabled: data?.stitch_disabled ?? false,
      username: data?.creator_username?.trim() || null,
    };
  }

  private async failure(error: unknown, step: string): Promise<PublishOutcome> {
    if (!(error instanceof TikTokApiError)) throw error;
    if (error.kind === 'AUTH') await this.options.onAuthRejected?.().catch(() => undefined);
    if (error.ambiguous) {
      return {
        status: 'FAILED',
        failureCode: 'AMBIGUOUS',
        failureReason: `TikTok did not answer while Spectra tried to ${step}; the post may exist. Check the TikTok account before publishing again.`,
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
