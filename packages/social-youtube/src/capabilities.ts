import type { AccountCapabilitySnapshot, PostTypeSupport } from '@spectra/contracts';

import {
  MAX_THUMBNAIL_BYTES,
  THUMBNAIL_MIME_TYPES,
  UNAUDITED_PROJECT_NOTE,
  YOUTUBE_ADAPTER_VERSION,
  YOUTUBE_LIMITS,
  YOUTUBE_SCOPES,
} from './constants';

/**
 * What one YouTube channel can publish, from the grant and the channel's own
 * status. YouTube's API publishes videos: text and image posts are community
 * posts, which have no public API at all, and are reported as such rather than
 * as something Spectra has not built.
 */

type Support = { status: PostTypeSupport; reason: string; requiredScopes: string[] };

const UPLOAD_SCOPES = [YOUTUBE_SCOPES.upload];

export function youTubeChannelCapabilities(input: {
  grantedScopes: readonly string[] | null;
  /** channels.list status.longUploadsStatus: allowed, eligible, disallowed. */
  longUploadsStatus?: string | null;
  /** Whether the operator declared this API project audited by Google. */
  projectAudited: boolean;
  checkedAt: Date;
}): AccountCapabilitySnapshot {
  let video: Support;
  if (input.grantedScopes === null) {
    video = {
      status: 'UNKNOWN',
      reason: 'YouTube did not report the granted scopes, so uploading cannot be confirmed.',
      requiredScopes: UPLOAD_SCOPES,
    };
  } else if (!input.grantedScopes.includes(YOUTUBE_SCOPES.upload)) {
    video = {
      status: 'MISSING_PERMISSION',
      reason: `Uploading needs the ${YOUTUBE_SCOPES.upload} scope, which this connection was not granted. Reconnect YouTube and allow uploads.`,
      requiredScopes: UPLOAD_SCOPES,
    };
  } else {
    video = {
      status: 'AVAILABLE',
      reason: 'Videos are uploaded through the YouTube Data API with a resumable upload.',
      requiredScopes: UPLOAD_SCOPES,
    };
  }

  const notes: string[] = [];
  if (!input.projectAudited) notes.push(UNAUDITED_PROJECT_NOTE);
  if (input.longUploadsStatus && input.longUploadsStatus !== 'allowed') {
    notes.push(
      `YouTube reports this channel's long-uploads status as "${input.longUploadsStatus}", so videos longer than 15 minutes may be refused until the channel is verified.`,
    );
  }
  notes.push(
    'The YouTube Data API has a daily quota, and uploads are limited per project and per channel; a refusal is reported with what YouTube said.',
  );

  return {
    adapterVersion: YOUTUBE_ADAPTER_VERSION,
    checkedAt: input.checkedAt.toISOString(),
    postTypes: {
      TEXT: {
        status: 'NOT_SUPPORTED',
        reason: 'YouTube publishes videos; text-only community posts have no public API.',
        requiredScopes: [],
      },
      IMAGE: {
        status: 'NOT_SUPPORTED',
        reason:
          'YouTube has no public API for image posts. An image can only be a custom thumbnail on a video.',
        requiredScopes: [],
      },
      VIDEO: video,
      DOCUMENT: {
        status: 'NOT_SUPPORTED',
        reason: 'YouTube has no document posts.',
        requiredScopes: [],
      },
    },
    limits: {
      maxCharacters: YOUTUBE_LIMITS.descriptionBytes,
      // The one image a YouTube video takes is its thumbnail.
      maxImages: 1,
      imageMimeTypes: [...THUMBNAIL_MIME_TYPES],
    },
    notes,
  };
}

export const THUMBNAIL_LIMIT_NOTE = `JPEG or PNG, up to ${Math.round(MAX_THUMBNAIL_BYTES / (1024 * 1024))} MB.`;
