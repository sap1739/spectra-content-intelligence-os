/**
 * Threads facts the adapter depends on, from Meta's own Threads API
 * documentation (create posts, publishing reference, profiles), checked
 * 2026-09-12. See docs/THREADS_SETUP.md.
 */

export const THREADS_ADAPTER_VERSION = 'threads-api-1.0.0';
export const THREADS_PLATFORM = 'THREADS' as const;

export const DEFAULT_THREADS_API_BASE_URL = 'https://graph.threads.net';
/** Every documented path is under this version segment. */
export const THREADS_API_VERSION = 'v1.0';

export const THREADS_SCOPES = {
  /** "Required for making any calls to all Threads API endpoints." */
  basic: 'threads_basic',
  /** "Required for Threads publishing endpoints only." */
  publish: 'threads_content_publish',
} as const;

/** Posts are limited to 500 characters. */
export const THREADS_MAX_TEXT_CHARS = 500;

/** Images: JPEG and PNG, 8 MB, width 320–1440, aspect ratio up to 10:1. */
export const THREADS_IMAGE_MIME_TYPES: readonly string[] = ['image/jpeg', 'image/png'];
export const THREADS_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const THREADS_MIN_IMAGE_WIDTH = 320;
export const THREADS_MAX_IMAGE_WIDTH = 1440;
export const THREADS_MAX_ASPECT_RATIO = 10;

/** Alt text is accepted on a container; Meta does not document a length. */
export const THREADS_MAX_ALT_TEXT_CHARS = 1000;

/** Threads profiles are limited to 250 API-published posts per 24 hours. */
export const THREADS_POSTS_PER_DAY = 250;

/**
 * Meta recommends waiting about 30 seconds after creating a container before
 * publishing it, so its media finishes processing.
 */
export const THREADS_PUBLISH_DELAY_MS = 30_000;

export const THREADS_MEDIA_TYPES = ['TEXT', 'IMAGE', 'VIDEO', 'CAROUSEL'] as const;

/**
 * Quoted from Meta's Threads documentation, so the words an operator reads are
 * Meta's own.
 */
export const THREADS_ACCESS_NOTE =
  'Until Meta grants advanced access for threads_content_publish, "you can only post to Threads for your account and your app\'s tester accounts."';

export const THREADS_PUBLISHING_SUMMARY =
  'Text posts and single-image posts to the connected Threads profile, published through a media container. Video, carousels, replies, quotes and deletions are not implemented.';

export const THREADS_ID = /^\d{1,30}$/;

export function threadsPostUrl(username: string | null, postId: string): string | undefined {
  if (!username || !/^[A-Za-z0-9._]{1,30}$/.test(username)) return undefined;
  return `https://www.threads.net/@${username}/post/${encodeURIComponent(postId)}`;
}
