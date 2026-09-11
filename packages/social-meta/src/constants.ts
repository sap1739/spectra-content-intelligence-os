/**
 * Meta facts the adapters depend on, each from Meta's own documentation
 * (Pages API, Page Photos, Instagram content publishing, IG media reference,
 * access tokens), checked 2026-09-11. See docs/META_SETUP.md.
 */

export const META_ADAPTER_VERSION = 'meta-graph-1.0.0';

/** Graph ids for Pages, users, Instagram accounts and containers are numeric. */
export const GRAPH_ID = /^\d{1,30}$/;

export const DEFAULT_META_GRAPH_BASE_URL = 'https://graph.facebook.com';
/** The newest Graph API version when this was written (released 2026-07-29). */
export const DEFAULT_META_GRAPH_VERSION = 'v26.0';

/** Facebook Page posts: declared character limit. */
export const FACEBOOK_MAX_MESSAGE_CHARS = 63_206;
/** Page Photos: .jpeg .bmp .png .gif .tiff, files under 10 MB. */
export const FACEBOOK_PHOTO_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/bmp',
  'image/tiff',
];
export const FACEBOOK_MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Instagram image containers: JPEG only, 8 MB, aspect 4:5 to 1.91:1. */
export const INSTAGRAM_IMAGE_MIME_TYPES: readonly string[] = ['image/jpeg'];
export const INSTAGRAM_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const INSTAGRAM_MIN_ASPECT_RATIO = 4 / 5;
export const INSTAGRAM_MAX_ASPECT_RATIO = 1.91;
/** Caption: 2,200 characters, 30 hashtags, 20 @ tags. */
export const INSTAGRAM_MAX_CAPTION_CHARS = 2200;
export const INSTAGRAM_MAX_HASHTAGS = 30;
export const INSTAGRAM_MAX_MENTIONS = 20;
export const INSTAGRAM_MAX_ALT_TEXT_CHARS = 1000;
export const INSTAGRAM_MEDIA_REQUIRED =
  'Instagram posts need an image; Instagram has no text-only posts.';

export const META_SCOPES = {
  pagesList: 'pages_show_list',
  pagesRead: 'pages_read_engagement',
  pagesPost: 'pages_manage_posts',
  instagramBasic: 'instagram_basic',
  instagramPublish: 'instagram_content_publish',
} as const;

/** Page tasks that allow creating content (Pages API). */
export const PAGE_POSTING_TASKS: ReadonlySet<string> = new Set(['CREATE_CONTENT', 'MANAGE']);

export const FACEBOOK_PUBLISHING_SUMMARY =
  'Text posts and single-photo posts (JPEG, PNG, GIF, BMP, TIFF) to Facebook Pages where you can create content. Facebook does not let apps post to personal profiles; video and multi-photo posts are not implemented.';

export const INSTAGRAM_PUBLISHING_SUMMARY =
  'Single-image JPEG feed posts to Instagram professional (Business or Creator) accounts linked to a Facebook Page, through a Meta (Facebook) connection. Accounts that are not professional cannot be published to; Reels, stories, carousels and video are not implemented.';
