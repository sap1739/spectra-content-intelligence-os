import { YOUTUBE_LIMITS } from '@spectra/contracts';

/**
 * YouTube facts the adapter depends on, from Google's own documentation
 * (videos.insert, the resumable upload protocol, thumbnails.set, quota costs,
 * channels.list), checked 2026-09-11. See docs/YOUTUBE_SETUP.md.
 */

export const YOUTUBE_ADAPTER_VERSION = 'youtube-data-v3-1.0.0';
export const YOUTUBE_PLATFORM = 'YOUTUBE' as const;

export const DEFAULT_YOUTUBE_API_BASE_URL = 'https://www.googleapis.com';
/** Google requires resumable chunks to be a multiple of 256 KiB. */
export const UPLOAD_CHUNK_MULTIPLE = 262_144;
export const DEFAULT_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

export const YOUTUBE_SCOPES = {
  upload: 'https://www.googleapis.com/auth/youtube.upload',
  readonly: 'https://www.googleapis.com/auth/youtube.readonly',
  manage: 'https://www.googleapis.com/auth/youtube',
} as const;

/** videos.insert accepts `video/*` and `application/octet-stream`. */
export const VIDEO_MIME_PREFIX = 'video/';
export const YOUTUBE_VIDEO_MIME_TYPES: readonly string[] = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-m4v',
  'video/mpeg',
  'video/x-msvideo',
];

/**
 * YouTube accepts files up to 256 GB, far beyond what Spectra stores or can
 * hold in memory to upload: its own media policy caps an object at 500 MB.
 */
export const SPECTRA_MAX_VIDEO_BYTES = 500 * 1024 * 1024;

/** thumbnails.set: image/jpeg, image/png, up to 2 MB. */
export const THUMBNAIL_MIME_TYPES: readonly string[] = ['image/jpeg', 'image/png'];
export const MAX_THUMBNAIL_BYTES = YOUTUBE_LIMITS.thumbnailBytes;

export { YOUTUBE_LIMITS };

export const YOUTUBE_PUBLISHING_SUMMARY =
  'Video uploads to a YouTube channel through the Data API v3, resumable and retry-safe, with title, description, tags, category, privacy and an optional custom thumbnail. Community posts, livestreams, playlists and edits after publishing are not implemented.';

/**
 * Google restricts what an unaudited API project may publish. Quoted from
 * videos.insert so the wording shown to operators is Google's own.
 */
export const UNAUDITED_PROJECT_NOTE =
  'Google restricts videos uploaded through the API by unverified projects: "All videos uploaded via the videos.insert endpoint from unverified API projects created after 28 July 2020 will be restricted to private viewing mode."';

export function youTubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

export const VIDEO_ID = /^[A-Za-z0-9_-]{5,40}$/;
export const CHANNEL_ID = /^[A-Za-z0-9_-]{5,64}$/;
