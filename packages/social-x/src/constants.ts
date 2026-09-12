/**
 * X facts the adapter depends on, from X's own documentation (create a post,
 * chunked media upload, rate limits, pricing), checked 2026-09-12. See
 * docs/X_SETUP.md.
 */

export const X_ADAPTER_VERSION = 'x-api-v2-1.0.0';
export const X_PLATFORM = 'X' as const;

export const DEFAULT_X_API_BASE_URL = 'https://api.x.com';

export const X_PATHS = {
  posts: '/2/tweets',
  mediaInitialize: '/2/media/upload/initialize',
  mediaUpload: '/2/media/upload',
} as const;

export const X_SCOPES = {
  read: 'tweet.read',
  write: 'tweet.write',
  users: 'users.read',
  offline: 'offline.access',
  media: 'media.write',
} as const;

/**
 * X's API reference does not state a character limit for a post, so this is
 * SPECTRA's cap — the long-standing limit for a standard account. A verified
 * account may be able to post more; the live checklist covers it.
 */
export const SPECTRA_MAX_POST_CHARS = 280;

/** A post carries 1–4 media ids. */
export const X_MAX_IMAGES = 4;

/** `tweet_image` uploads are capped at 5 MB. */
export const X_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** "Keep each segment at or below 5 MB." */
export const X_MAX_SEGMENT_BYTES = 5 * 1024 * 1024;

export const X_MEDIA_CATEGORY = {
  image: 'tweet_image',
  gif: 'tweet_gif',
  video: 'tweet_video',
} as const;

/** Rate limits X documents for creating a post. */
export const X_RATE_LIMITS = {
  perUserPer15Min: 100,
  perAppPer24Hours: 10_000,
} as const;

/**
 * X charges per request on its pay-per-use plans, so an operator should know
 * that publishing costs money before they schedule a hundred posts.
 */
export const X_PRICING_NOTE =
  'X API v2 is pay-per-usage: credits are deducted per request, and a post costs more when it contains a link. Check your plan before scheduling volume.';

export const X_PUBLISHING_SUMMARY =
  'Text posts and up to four images to the connected X account through the v2 API, with images sent by the chunked upload endpoints. Video, polls, quote posts, threads, replies and deletions are not implemented.';

export const X_ID = /^\d{1,25}$/;

export function xPostUrl(username: string | null, postId: string): string {
  const handle = username && /^[A-Za-z0-9_]{1,15}$/.test(username) ? username : 'i';
  return `https://x.com/${handle}/status/${encodeURIComponent(postId)}`;
}
