/**
 * TikTok facts the adapter depends on, from TikTok's own documentation
 * (Content Posting API: get started, direct post reference, media transfer
 * guide, post status reference, OAuth token management), checked 2026-09-12.
 * See docs/TIKTOK_SETUP.md.
 */

export const TIKTOK_ADAPTER_VERSION = 'tiktok-content-posting-1.0.0';
export const TIKTOK_PLATFORM = 'TIKTOK' as const;

export const DEFAULT_TIKTOK_API_BASE_URL = 'https://open.tiktokapis.com';

export const TIKTOK_PATHS = {
  creatorInfo: '/v2/post/publish/creator_info/query/',
  videoInit: '/v2/post/publish/video/init/',
  status: '/v2/post/publish/status/fetch/',
} as const;

export const TIKTOK_SCOPES = {
  profile: 'user.info.basic',
  /** Direct Post needs video.publish; video.upload only sends to the inbox. */
  publish: 'video.publish',
  upload: 'video.upload',
} as const;

/**
 * The privacy levels TikTok documents. Which of these a creator may use comes
 * from creator_info at publish time — never assumed.
 */
export const TIKTOK_PRIVACY_LEVELS = [
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
] as const;
export type TikTokPrivacyLevel = (typeof TIKTOK_PRIVACY_LEVELS)[number];

/** Captions are capped at 2,200 UTF-16 runes. */
export const TIKTOK_MAX_TITLE_RUNES = 2200;

/** Content types the upload accepts. */
export const TIKTOK_VIDEO_MIME_TYPES: readonly string[] = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
];

/**
 * Media transfer rules: "Each chunk must be at least 5 MB but no greater than
 * 64 MB, except for the final chunk, which can be greater than chunk_size (up
 * to 128 MB)." A video under 5 MB goes as a single chunk whose chunk_size is
 * the whole file; total_chunk_count is video_size / chunk_size rounded DOWN, so
 * the last chunk carries the remainder.
 */
export const TIKTOK_MIN_CHUNK_BYTES = 5 * 1024 * 1024;
export const TIKTOK_MAX_CHUNK_BYTES = 64 * 1024 * 1024;
export const TIKTOK_MAX_FINAL_CHUNK_BYTES = 128 * 1024 * 1024;
export const TIKTOK_MAX_CHUNKS = 1000;
/** TikTok accepts up to 4 GB; Spectra's own media policy caps an object at 500 MB. */
export const TIKTOK_MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;
export const SPECTRA_MAX_VIDEO_BYTES = 500 * 1024 * 1024;
/** Videos posted through the API may run up to 10 minutes. */
export const TIKTOK_MAX_DURATION_SECONDS = 600;

/** Status values from the post status endpoint. */
export const TIKTOK_STATUSES = [
  'PROCESSING_UPLOAD',
  'PROCESSING_DOWNLOAD',
  'SEND_TO_USER_INBOX',
  'PUBLISH_COMPLETE',
  'FAILED',
] as const;

/** Rate limits TikTok documents per user access token. */
export const TIKTOK_RATE_LIMITS = {
  initPerMinute: 6,
  statusPerMinute: 30,
} as const;

/**
 * Quoted from TikTok's Content Posting API documentation, so the words an
 * operator reads are TikTok's own.
 */
export const UNAUDITED_CLIENT_NOTE =
  'TikTok restricts unaudited API clients: "All content posted by unaudited clients will be restricted to private viewing mode." To post publicly, the API client must pass TikTok\'s audit.';

export const TIKTOK_PUBLISHING_SUMMARY =
  'Direct Post of one video to a TikTok creator account through the Content Posting API, uploaded in chunks and resumable across attempts, with the caption, privacy level and interaction settings the creator allows. Photo posts, drafts to the inbox, edits and deletions are not implemented.';

/** The chunk plan TikTok's rules imply for one file. */
export function chunkPlan(
  videoSize: number,
  preferredChunkBytes: number,
): {
  chunkSize: number;
  totalChunkCount: number;
} {
  if (videoSize <= TIKTOK_MIN_CHUNK_BYTES) {
    // Under 5 MB must be a single chunk of the whole file.
    return { chunkSize: videoSize, totalChunkCount: 1 };
  }
  const bounded = Math.min(
    Math.max(preferredChunkBytes, TIKTOK_MIN_CHUNK_BYTES),
    TIKTOK_MAX_CHUNK_BYTES,
  );
  // total_chunk_count rounds DOWN: the final chunk absorbs the remainder.
  let count = Math.max(1, Math.floor(videoSize / bounded));
  if (count > TIKTOK_MAX_CHUNKS) count = TIKTOK_MAX_CHUNKS;
  return { chunkSize: bounded, totalChunkCount: count };
}

/** Byte range of chunk `index` (0-based) under a plan. */
export function chunkRange(
  videoSize: number,
  plan: { chunkSize: number; totalChunkCount: number },
  index: number,
): { start: number; end: number } {
  const start = index * plan.chunkSize;
  const last = index === plan.totalChunkCount - 1;
  const end = last ? videoSize - 1 : start + plan.chunkSize - 1;
  return { start, end };
}

export const TIKTOK_ID = /^[A-Za-z0-9_.-]{1,120}$/;

/** A published TikTok post, where TikTok returned an id for it. */
export function tikTokPostUrl(username: string | null, postId: string): string | undefined {
  if (!username || !/^[A-Za-z0-9_.]{1,30}$/.test(username)) return undefined;
  return `https://www.tiktok.com/@${username}/video/${encodeURIComponent(postId)}`;
}
