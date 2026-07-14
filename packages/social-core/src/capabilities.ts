import type { PlatformCapability, SocialPlatform } from '@spectra/contracts';

/**
 * First-party DECLARED platform capabilities.
 *
 * Honesty: these are reference constraints compiled from public platform docs,
 * NOT values fetched from a live API. `capabilityVersion` is `declared-1.0.0`
 * and every record says so in `notes`. A live adapter (later phase) will
 * replace these with values it fetches and version accordingly. Unknown
 * support flags are `null` (unknown) and fail closed via `assertCapability`.
 */

export const DECLARED_CAPABILITY_VERSION = 'declared-1.0.0';
const RECORDED_AT = '2026-07-13T00:00:00.000Z';

type SupportKey = keyof PlatformCapability['supports'];

const UNKNOWN_SUPPORTS: Record<SupportKey, boolean | null> = {
  nativeScheduling: null,
  editAfterPublish: null,
  deletion: null,
  analytics: null,
  comments: null,
  webhooks: null,
  stories: null,
  drafts: null,
};

interface CapabilityInput {
  mediaFormats?: PlatformCapability['mediaFormats'];
  limits: PlatformCapability['limits'];
  supports?: Partial<Record<SupportKey, boolean | null>>;
  oauth?: Partial<PlatformCapability['oauth']>;
  notes: string;
}

function declare(platform: SocialPlatform, input: CapabilityInput): PlatformCapability {
  return {
    platform,
    capabilityVersion: DECLARED_CAPABILITY_VERSION,
    recordedAt: RECORDED_AT,
    mediaFormats: input.mediaFormats ?? [],
    limits: input.limits,
    supports: { ...UNKNOWN_SUPPORTS, ...(input.supports ?? {}) },
    oauth: {
      scopes: input.oauth?.scopes ?? [],
      refreshSupported: input.oauth?.refreshSupported ?? null,
      ...(input.oauth?.tokenLifetimeSeconds
        ? { tokenLifetimeSeconds: input.oauth.tokenLifetimeSeconds }
        : {}),
    },
    notes: `Declared reference (not live-verified): ${input.notes}`,
  };
}

// Declared media kinds. mimeTypes/aspectRatios are left empty in the declared
// matrix — a live adapter enumerates exact formats; we only assert the kind.
type MediaFormat = PlatformCapability['mediaFormats'][number];
const mf = (kind: MediaFormat['kind']): MediaFormat => ({ kind, mimeTypes: [], aspectRatios: [] });
const img = mf('IMAGE');
const vid = mf('VIDEO');
const doc = mf('DOCUMENT');
const aud = mf('AUDIO');

const CAPABILITIES: Record<SocialPlatform, PlatformCapability> = {
  X: declare('X', {
    mediaFormats: [img, vid],
    limits: { maxCharacters: 280, maxHashtags: null, maxMediaPerPost: 4 },
    supports: { analytics: true, comments: true, deletion: true, nativeScheduling: false },
    oauth: { scopes: ['tweet.read', 'tweet.write', 'users.read'], refreshSupported: true },
    notes: '280-char posts; up to 4 images or 1 video per post.',
  }),
  LINKEDIN: declare('LINKEDIN', {
    mediaFormats: [img, vid, doc],
    limits: { maxCharacters: 3000, maxHashtags: null, maxMediaPerPost: 9 },
    supports: { analytics: true, comments: true, deletion: true, nativeScheduling: false },
    oauth: { scopes: ['w_member_social', 'r_liteprofile'], refreshSupported: true },
    notes: '~3000-char posts; documents supported for carousels.',
  }),
  WORDPRESS: declare('WORDPRESS', {
    mediaFormats: [img, vid, doc, aud],
    limits: { maxCharacters: null, maxHashtags: null, maxMediaPerPost: null },
    supports: {
      nativeScheduling: true,
      editAfterPublish: true,
      deletion: true,
      drafts: true,
    },
    oauth: { scopes: [], refreshSupported: false },
    notes: 'Long-form; native scheduling, drafts and post editing via REST API.',
  }),
  YOUTUBE: declare('YOUTUBE', {
    mediaFormats: [vid],
    limits: { maxCharacters: 5000, maxHashtags: 15, maxMediaPerPost: 1 },
    supports: {
      nativeScheduling: true,
      editAfterPublish: true,
      deletion: true,
      analytics: true,
      comments: true,
    },
    oauth: { scopes: ['youtube.upload', 'youtube.readonly'], refreshSupported: true },
    notes: 'One video per upload; 5000-char description.',
  }),
  INSTAGRAM: declare('INSTAGRAM', {
    mediaFormats: [img, vid],
    limits: { maxCharacters: 2200, maxHashtags: 30, maxMediaPerPost: 10 },
    supports: { analytics: true, comments: true, stories: true, nativeScheduling: false },
    oauth: { scopes: ['instagram_basic', 'instagram_content_publish'], refreshSupported: true },
    notes: 'Carousels up to 10 items; 30-hashtag limit; business accounts only for publishing.',
  }),
  FACEBOOK: declare('FACEBOOK', {
    mediaFormats: [img, vid],
    limits: { maxCharacters: 63206, maxHashtags: null, maxMediaPerPost: 10 },
    supports: {
      nativeScheduling: true,
      deletion: true,
      analytics: true,
      comments: true,
    },
    oauth: { scopes: ['pages_manage_posts', 'pages_read_engagement'], refreshSupported: true },
    notes: 'Page publishing with native scheduling.',
  }),
  TIKTOK: declare('TIKTOK', {
    mediaFormats: [vid],
    limits: { maxCharacters: 2200, maxHashtags: null, maxMediaPerPost: 1 },
    supports: { analytics: true, comments: true },
    oauth: { scopes: ['video.publish', 'video.list'], refreshSupported: true },
    notes: 'Single video per post.',
  }),
  THREADS: declare('THREADS', {
    mediaFormats: [img, vid],
    limits: { maxCharacters: 500, maxHashtags: null, maxMediaPerPost: 10 },
    supports: { deletion: true, comments: true },
    oauth: { scopes: ['threads_basic', 'threads_content_publish'], refreshSupported: true },
    notes: '500-char posts; carousels up to 10.',
  }),
  PINTEREST: declare('PINTEREST', {
    mediaFormats: [img, vid],
    limits: { maxCharacters: 500, maxHashtags: null, maxMediaPerPost: 1 },
    supports: { analytics: true, deletion: true },
    oauth: { scopes: ['pins:write', 'boards:read'], refreshSupported: true },
    notes: 'One media per pin; 500-char description.',
  }),
  EMAIL: declare('EMAIL', {
    mediaFormats: [img, doc],
    limits: { maxCharacters: null, maxHashtags: null, maxMediaPerPost: null },
    supports: { nativeScheduling: true, drafts: true, analytics: true },
    oauth: { scopes: [], refreshSupported: false },
    notes: 'Newsletter delivery; open/click analytics depend on the ESP.',
  }),
};

export function getPlatformCapability(platform: SocialPlatform): PlatformCapability {
  return CAPABILITIES[platform];
}

export function allPlatformCapabilities(): PlatformCapability[] {
  return Object.values(CAPABILITIES);
}
