import {
  YOUTUBE_FORBIDDEN_TEXT,
  YOUTUBE_LIMITS,
  utf8ByteLength,
  youtubeVideoMetadataSchema,
  type YouTubeVideoMetadata,
} from '@spectra/contracts';
import { toPlainText, type PublishInput, type PublishValidationIssue } from '@spectra/social-core';

import {
  MAX_THUMBNAIL_BYTES,
  SPECTRA_MAX_VIDEO_BYTES,
  THUMBNAIL_MIME_TYPES,
  VIDEO_MIME_PREFIX,
} from './constants';

/**
 * What YouTube will receive, and what it would refuse.
 *
 * Video details come from the entry's own metadata where an operator set them.
 * Without any, the content item fills in — its title, its body as the
 * description — and privacy stays `private`, the narrowest setting: an upload
 * is never made more public than was actually asked for.
 */

const byteLength = utf8ByteLength;

export interface ResolvedMetadata {
  metadata: YouTubeVideoMetadata;
  /** Issues from the metadata the operator supplied, reported as its own. */
  issues: PublishValidationIssue[];
}

export function resolveYouTubeMetadata(input: PublishInput): ResolvedMetadata {
  const supplied = (input.metadata as { youtube?: unknown } | undefined)?.youtube;
  if (supplied !== undefined) {
    const parsed = youtubeVideoMetadataSchema.safeParse(supplied);
    if (parsed.success) return { metadata: parsed.data, issues: [] };
    return {
      metadata: fallback(input),
      issues: parsed.error.issues.map((issue) => ({
        code: `METADATA_${(issue.path[0] ?? 'INVALID').toString().toUpperCase()}`,
        message: `Video details: ${issue.message}${issue.path.length > 0 ? ` (${issue.path.join('.')})` : ''}.`,
      })),
    };
  }
  return { metadata: fallback(input), issues: [] };
}

function fallback(input: PublishInput): YouTubeVideoMetadata {
  return {
    title: toPlainText(input.title ?? '').trim(),
    description: toPlainText(input.body ?? ''),
    tags: [],
    // The safest of YouTube's three settings, never widened by default.
    privacyStatus: 'private',
    madeForKids: false,
    notifySubscribers: true,
  };
}

export function validateYouTubeVideo(input: PublishInput): PublishValidationIssue[] {
  const { metadata, issues: metadataIssues } = resolveYouTubeMetadata(input);
  const issues: PublishValidationIssue[] = [...metadataIssues];

  const title = metadata.title.trim();
  if (!title) {
    issues.push({ code: 'TITLE_REQUIRED', message: 'A YouTube video needs a title.' });
  } else {
    if ([...title].length > YOUTUBE_LIMITS.titleChars) {
      issues.push({
        code: 'TITLE_TOO_LONG',
        message: `YouTube allows ${YOUTUBE_LIMITS.titleChars} characters in a title; this one has ${[...title].length}.`,
      });
    }
    if (YOUTUBE_FORBIDDEN_TEXT.test(title)) {
      issues.push({
        code: 'TITLE_CHARACTERS',
        message: 'YouTube does not allow < or > in a title.',
      });
    }
  }

  const description = metadata.description ?? '';
  if (byteLength(description) > YOUTUBE_LIMITS.descriptionBytes) {
    issues.push({
      code: 'DESCRIPTION_TOO_LONG',
      message: `YouTube allows ${YOUTUBE_LIMITS.descriptionBytes.toLocaleString('en-US')} bytes of description; this one uses ${byteLength(description).toLocaleString('en-US')}.`,
    });
  }
  if (YOUTUBE_FORBIDDEN_TEXT.test(description)) {
    issues.push({
      code: 'DESCRIPTION_CHARACTERS',
      message: 'YouTube does not allow < or > in a description.',
    });
  }
  const tagChars = metadata.tags.join('').length;
  if (tagChars > YOUTUBE_LIMITS.tagsChars) {
    issues.push({
      code: 'TAGS_TOO_LONG',
      message: `YouTube allows ${YOUTUBE_LIMITS.tagsChars} characters of tags in total; these use ${tagChars}.`,
    });
  }

  const media = input.media ?? [];
  if (media.length === 0) {
    issues.push({
      code: 'VIDEO_REQUIRED',
      message: 'YouTube publishes videos: attach a video to this entry.',
    });
  }
  if (media.length > 1) {
    issues.push({ code: 'TOO_MANY_MEDIA', message: 'One video per YouTube upload.' });
  }
  for (const item of media) {
    if (item.kind !== 'VIDEO') {
      issues.push({
        code: 'NOT_A_VIDEO',
        message: `YouTube uploads videos; this attachment is ${item.kind.toLowerCase()}.`,
      });
      continue;
    }
    if (!item.mimeType.toLowerCase().startsWith(VIDEO_MIME_PREFIX)) {
      issues.push({
        code: 'UNSUPPORTED_VIDEO_FORMAT',
        message: `YouTube accepts video files; this one is ${item.mimeType}.`,
      });
    }
    if (item.sizeBytes > SPECTRA_MAX_VIDEO_BYTES) {
      issues.push({
        code: 'VIDEO_TOO_LARGE',
        message: `Spectra uploads videos up to ${Math.round(SPECTRA_MAX_VIDEO_BYTES / (1024 * 1024))} MB (YouTube itself accepts far larger files).`,
      });
    }
  }

  const thumbnail = input.thumbnail;
  if (thumbnail) {
    if (!THUMBNAIL_MIME_TYPES.includes(thumbnail.mimeType)) {
      issues.push({
        code: 'UNSUPPORTED_THUMBNAIL_FORMAT',
        message: `A YouTube thumbnail must be JPEG or PNG; this one is ${thumbnail.mimeType}.`,
      });
    }
    if (thumbnail.sizeBytes > MAX_THUMBNAIL_BYTES) {
      issues.push({
        code: 'THUMBNAIL_TOO_LARGE',
        message: 'A YouTube thumbnail must be 2 MB or smaller.',
      });
    }
  }
  return issues;
}

/** The `snippet`/`status` resource videos.insert expects. */
export function videoResource(metadata: YouTubeVideoMetadata): Record<string, unknown> {
  return {
    snippet: {
      title: metadata.title.trim(),
      ...(metadata.description ? { description: metadata.description } : {}),
      ...(metadata.tags.length > 0 ? { tags: metadata.tags } : {}),
      ...(metadata.categoryId ? { categoryId: metadata.categoryId } : {}),
    },
    status: {
      privacyStatus: metadata.privacyStatus,
      selfDeclaredMadeForKids: metadata.madeForKids,
    },
  };
}
