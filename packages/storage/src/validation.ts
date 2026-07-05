/** Upload validation: MIME allow-lists and size caps per storage domain. */

import type { StorageDomain } from './keys';

export interface UploadPolicy {
  allowedMimeTypes: readonly string[];
  maxSizeBytes: number;
}

const MB = 1024 * 1024;

export const UPLOAD_POLICIES: Record<StorageDomain, UploadPolicy> = {
  'research-snapshots': {
    allowedMimeTypes: ['text/html', 'text/plain', 'application/json', 'application/pdf'],
    maxSizeBytes: 25 * MB,
  },
  documents: {
    allowedMimeTypes: [
      'application/pdf',
      'text/plain',
      'text/markdown',
      'text/csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
    maxSizeBytes: 50 * MB,
  },
  media: {
    allowedMimeTypes: [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/avif',
      'image/svg+xml',
      'video/mp4',
      'video/webm',
      'audio/mpeg',
      'audio/wav',
      'audio/aac',
    ],
    maxSizeBytes: 500 * MB,
  },
  renders: {
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'audio/mpeg'],
    maxSizeBytes: 1024 * MB,
  },
  exports: {
    allowedMimeTypes: ['application/json', 'application/zip', 'text/csv'],
    maxSizeBytes: 200 * MB,
  },
  webhooks: {
    allowedMimeTypes: ['application/json', 'text/plain'],
    maxSizeBytes: 5 * MB,
  },
};

export interface UploadValidationInput {
  domain: StorageDomain;
  mimeType: string;
  sizeBytes: number;
}

export type UploadValidationResult =
  { ok: true } | { ok: false; reason: 'MIME_NOT_ALLOWED' | 'TOO_LARGE' | 'EMPTY'; message: string };

export function validateUpload(input: UploadValidationInput): UploadValidationResult {
  const policy = UPLOAD_POLICIES[input.domain];
  const mime = input.mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (input.sizeBytes <= 0) {
    return { ok: false, reason: 'EMPTY', message: 'Upload is empty' };
  }
  if (!policy.allowedMimeTypes.includes(mime)) {
    return {
      ok: false,
      reason: 'MIME_NOT_ALLOWED',
      message: `MIME type ${mime} is not allowed for domain ${input.domain}`,
    };
  }
  if (input.sizeBytes > policy.maxSizeBytes) {
    return {
      ok: false,
      reason: 'TOO_LARGE',
      message: `Upload exceeds ${policy.maxSizeBytes} bytes for domain ${input.domain}`,
    };
  }
  return { ok: true };
}
