/**
 * Pinterest facts the adapter depends on, from Pinterest's own documentation
 * (API v5: create boards and Pins guide, and Pinterest's generated client
 * reference for POST /pins and GET /boards), checked 2026-09-12. See
 * docs/PINTEREST_SETUP.md.
 *
 * Pinterest does NOT document image formats, a maximum file size or character
 * limits for a pin's title, description or alt text. Nothing is invented here:
 * the adapter sends what the operator chose and reports Pinterest's own
 * refusal — its 403 is documented as "The Pin's image is too small, too large
 * or is broken".
 */

export const PINTEREST_ADAPTER_VERSION = 'pinterest-v5-1.0.0';
export const PINTEREST_PLATFORM = 'PINTEREST' as const;

export const DEFAULT_PINTEREST_API_BASE_URL = 'https://api.pinterest.com';
export const PINTEREST_API_VERSION = 'v5';

export const PINTEREST_PATHS = {
  pins: '/pins',
  boards: '/boards',
  userAccount: '/user_account',
} as const;

export const PINTEREST_SCOPES = {
  profile: 'user_accounts:read',
  boardsRead: 'boards:read',
  pinsRead: 'pins:read',
  pinsWrite: 'pins:write',
} as const;

/** The documented media_source variants; this adapter uses image_url. */
export const PINTEREST_SOURCE_TYPES = [
  'image_url',
  'image_base64',
  'multiple_image_urls',
  'video_id',
] as const;

/** Volume limits Pinterest documents per account. */
export const PINTEREST_LIMITS = {
  boardsPerAccount: 2000,
  pinsPerPersonalAccount: 200_000,
} as const;

/**
 * Pinterest starts an app in Trial access; Standard access needs its review.
 * Phrased as the gate it is, without claiming limits Pinterest has not stated.
 */
export const PINTEREST_ACCESS_NOTE =
  'A new Pinterest app has Trial access: it can act only for accounts you have granted it, and Pinterest must review the app for Standard access before wider use.';

export const PINTEREST_PUBLISHING_SUMMARY =
  'One image pin to a board on the connected Pinterest account, created from a short-lived link to the image, with a title, description and destination link. Video pins, carousels, board creation and edits after publishing are not implemented.';

export const PINTEREST_ID = /^[A-Za-z0-9_-]{1,60}$/;

export function pinUrl(pinId: string): string {
  return `https://www.pinterest.com/pin/${encodeURIComponent(pinId)}/`;
}
