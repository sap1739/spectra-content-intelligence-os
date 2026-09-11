/**
 * LinkedIn facts the adapter depends on, each from LinkedIn's own
 * documentation (Posts API, Images API, Organization Access Control, little
 * text format), checked 2026-09-11. See docs/LINKEDIN_SETUP.md.
 */

export const LINKEDIN_PLATFORM = 'LINKEDIN' as const;
export const LINKEDIN_ADAPTER_VERSION = 'linkedin-posts-1.0.0';

export const DEFAULT_LINKEDIN_API_BASE_URL = 'https://api.linkedin.com';

/**
 * The newest version LinkedIn documented when this adapter was written
 * ("August 2026 — 202608"). Every versioned call must send one; versions are
 * supported for at least a year. Move forward with LINKEDIN_API_VERSION.
 */
export const DEFAULT_LINKEDIN_API_VERSION = '202608';

/** Posts API `commentary` limit. */
export const LINKEDIN_MAX_COMMENTARY_CHARS = 3000;

/** Images API formats. */
export const LINKEDIN_IMAGE_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
];

/** Images API: images must have FEWER than this many pixels. */
export const LINKEDIN_MAX_IMAGE_PIXELS = 36_152_320;

/**
 * The most bytes Spectra reads into memory for one upload. A Spectra limit,
 * not LinkedIn's — LinkedIn documents a pixel limit, not a byte limit.
 */
export const SPECTRA_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const LINKEDIN_SCOPES = {
  openid: 'openid',
  profile: 'profile',
  memberSocial: 'w_member_social',
  orgAdminRead: 'r_organization_admin',
  orgAdminReadWrite: 'rw_organization_admin',
  orgSocial: 'w_organization_social',
} as const;

/**
 * Page roles that can create ORGANIC posts as the organization. LinkedIn's
 * Organization Access Control docs spell the content role CONTENT_ADMINISTRATOR
 * and the Posts API docs CONTENT_ADMIN, so both are accepted.
 * DIRECT_SPONSORED_CONTENT_POSTER is for sponsored content and is excluded.
 */
export const ORGANIC_POSTING_ROLES: ReadonlySet<string> = new Set([
  'ADMINISTRATOR',
  'CONTENT_ADMINISTRATOR',
  'CONTENT_ADMIN',
]);

export const LINKEDIN_PUBLISHING_SUMMARY =
  'Text posts and single-image posts (JPG, PNG, GIF) as the member (w_member_social) or as a page they administer (w_organization_social). Video, document, multi-image, article and poll posts are not implemented.';

export function linkedInPostUrl(postUrn: string): string {
  return `https://www.linkedin.com/feed/update/${postUrn}/`;
}
