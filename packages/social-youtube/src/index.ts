export {
  CHANNEL_ID,
  DEFAULT_UPLOAD_CHUNK_BYTES,
  DEFAULT_YOUTUBE_API_BASE_URL,
  MAX_THUMBNAIL_BYTES,
  SPECTRA_MAX_VIDEO_BYTES,
  THUMBNAIL_MIME_TYPES,
  UNAUDITED_PROJECT_NOTE,
  UPLOAD_CHUNK_MULTIPLE,
  VIDEO_ID,
  VIDEO_MIME_PREFIX,
  YOUTUBE_ADAPTER_VERSION,
  YOUTUBE_LIMITS,
  YOUTUBE_PLATFORM,
  YOUTUBE_PUBLISHING_SUMMARY,
  YOUTUBE_SCOPES,
  YOUTUBE_VIDEO_MIME_TYPES,
  youTubeWatchUrl,
} from './constants';
export { YouTubeApiError, YouTubeClient, isAllowedSessionUrl } from './client';
export type { UploadProgress, YouTubeApiOptions, YouTubeErrorKind } from './client';
export {
  resolveYouTubeMetadata,
  validateYouTubeVideo,
  videoResource,
  type ResolvedMetadata,
} from './text';
export { THUMBNAIL_LIMIT_NOTE, youTubeChannelCapabilities } from './capabilities';
export { YouTubeAccountDiscovery, type YouTubeDiscoveryOptions } from './discovery';
export { YouTubeVideoPublisher } from './publisher';
export type { ResumableUploadLedger, YouTubePublisherOptions } from './publisher';
export {
  registerYouTubeAdapter,
  youTubeApiOptionsFromEnv,
  type YouTubeAdapterOptions,
} from './register';
