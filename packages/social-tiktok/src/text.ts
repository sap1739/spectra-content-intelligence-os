import { tiktokVideoMetadataSchema, type TikTokVideoMetadata } from '@spectra/contracts';
import { toPlainText, type PublishInput, type PublishValidationIssue } from '@spectra/social-core';

import {
  SPECTRA_MAX_VIDEO_BYTES,
  TIKTOK_MAX_TITLE_RUNES,
  TIKTOK_VIDEO_MIME_TYPES,
} from './constants';

/**
 * What TikTok will receive, and what it would refuse.
 *
 * The caption comes from the entry's own TikTok details where an operator set
 * them; without any, the content item fills in and privacy stays SELF_ONLY —
 * the narrowest of TikTok's levels. A post is never made more public than was
 * actually asked for, which also happens to be the only thing an unaudited
 * client may do.
 */

export interface ResolvedTikTokMetadata {
  metadata: TikTokVideoMetadata;
  issues: PublishValidationIssue[];
}

export function resolveTikTokMetadata(input: PublishInput): ResolvedTikTokMetadata {
  const supplied = (input.metadata as { tiktok?: unknown } | undefined)?.tiktok;
  if (supplied !== undefined) {
    const parsed = tiktokVideoMetadataSchema.safeParse(supplied);
    if (parsed.success) return { metadata: parsed.data, issues: [] };
    return {
      metadata: fallback(input),
      issues: parsed.error.issues.map((issue) => ({
        code: `METADATA_${(issue.path[0] ?? 'INVALID').toString().toUpperCase()}`,
        message: `TikTok details: ${issue.message}${issue.path.length > 0 ? ` (${issue.path.join('.')})` : ''}.`,
      })),
    };
  }
  return { metadata: fallback(input), issues: [] };
}

function fallback(input: PublishInput): TikTokVideoMetadata {
  const body = toPlainText(input.body ?? '').trim();
  return {
    title: (body || toPlainText(input.title ?? '').trim()).slice(0, TIKTOK_MAX_TITLE_RUNES),
    privacyLevel: 'SELF_ONLY',
    disableComment: false,
    disableDuet: false,
    disableStitch: false,
    brandContentToggle: false,
    brandOrganicToggle: false,
    isAigc: false,
  };
}

export function validateTikTokVideo(input: PublishInput): PublishValidationIssue[] {
  const { metadata, issues: metadataIssues } = resolveTikTokMetadata(input);
  const issues: PublishValidationIssue[] = [...metadataIssues];

  // TikTok counts the caption in UTF-16 runes, which is what String#length is.
  if (metadata.title.length > TIKTOK_MAX_TITLE_RUNES) {
    issues.push({
      code: 'CAPTION_TOO_LONG',
      message: `TikTok allows ${TIKTOK_MAX_TITLE_RUNES.toLocaleString('en-US')} characters in a caption; this one has ${metadata.title.length.toLocaleString('en-US')}.`,
    });
  }

  const media = input.media ?? [];
  if (media.length === 0) {
    issues.push({
      code: 'VIDEO_REQUIRED',
      message: 'TikTok publishes videos: attach a video to this entry.',
    });
  }
  if (media.length > 1) {
    issues.push({ code: 'TOO_MANY_MEDIA', message: 'One video per TikTok post.' });
  }
  for (const item of media) {
    if (item.kind !== 'VIDEO') {
      issues.push({
        code: 'NOT_A_VIDEO',
        message: `TikTok uploads videos; this attachment is ${item.kind.toLowerCase()}.`,
      });
      continue;
    }
    if (!TIKTOK_VIDEO_MIME_TYPES.includes(item.mimeType.toLowerCase())) {
      issues.push({
        code: 'UNSUPPORTED_VIDEO_FORMAT',
        message: `TikTok accepts MP4, MOV or WebM video; this one is ${item.mimeType}.`,
      });
    }
    if (item.sizeBytes > SPECTRA_MAX_VIDEO_BYTES) {
      issues.push({
        code: 'VIDEO_TOO_LARGE',
        message: `Spectra uploads videos up to ${Math.round(SPECTRA_MAX_VIDEO_BYTES / (1024 * 1024))} MB (TikTok itself accepts up to 4 GB).`,
      });
    }
    if (item.sizeBytes === 0) {
      issues.push({ code: 'VIDEO_EMPTY', message: 'The attached video file is empty.' });
    }
  }
  return issues;
}

/** The `post_info` TikTok's direct post endpoint expects. */
export function postInfo(
  metadata: TikTokVideoMetadata,
  creator: { commentDisabled: boolean; duetDisabled: boolean; stitchDisabled: boolean },
): Record<string, unknown> {
  return {
    title: metadata.title,
    privacy_level: metadata.privacyLevel,
    // A creator who turned an interaction off keeps it off: TikTok's UX rules
    // do not allow an app to re-enable it on their behalf.
    disable_comment: metadata.disableComment || creator.commentDisabled,
    disable_duet: metadata.disableDuet || creator.duetDisabled,
    disable_stitch: metadata.disableStitch || creator.stitchDisabled,
    ...(metadata.coverTimestampMs !== undefined
      ? { video_cover_timestamp_ms: metadata.coverTimestampMs }
      : {}),
    ...(metadata.brandContentToggle ? { brand_content_toggle: true } : {}),
    ...(metadata.brandOrganicToggle ? { brand_organic_toggle: true } : {}),
    ...(metadata.isAigc ? { is_aigc: true } : {}),
  };
}
