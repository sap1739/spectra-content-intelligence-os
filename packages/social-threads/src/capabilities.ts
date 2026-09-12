import type { AccountCapabilitySnapshot, PostTypeSupport } from '@spectra/contracts';

import {
  THREADS_ACCESS_NOTE,
  THREADS_ADAPTER_VERSION,
  THREADS_IMAGE_MIME_TYPES,
  THREADS_MAX_TEXT_CHARS,
  THREADS_POSTS_PER_DAY,
  THREADS_SCOPES,
} from './constants';

/**
 * What one Threads profile can publish, from the grant and from whether this
 * deployment can give Threads a link to fetch an image from.
 */

const PUBLISH_SCOPES = [THREADS_SCOPES.basic, THREADS_SCOPES.publish];

export function threadsProfileCapabilities(input: {
  grantedScopes: readonly string[] | null;
  /** Why Threads cannot fetch images from this deployment, or null. */
  mediaProblem?: string | null;
  checkedAt: Date;
}): AccountCapabilitySnapshot {
  const missing = input.grantedScopes
    ? PUBLISH_SCOPES.filter((scope) => !input.grantedScopes?.includes(scope))
    : null;

  let text: { status: PostTypeSupport; reason: string };
  if (missing === null) {
    text = {
      status: 'UNKNOWN',
      reason: 'Threads did not report the granted permissions, so posting cannot be confirmed.',
    };
  } else if (missing.length > 0) {
    text = {
      status: 'MISSING_PERMISSION',
      reason: `Needs ${missing.join(', ')} (Meta App Review). Add it to the app, then reconnect.`,
    };
  } else {
    text = { status: 'AVAILABLE', reason: 'Text posts are published through a media container.' };
  }

  // An image post needs a link Threads can fetch; without one, only text works.
  const image: { status: PostTypeSupport; reason: string } =
    text.status === 'AVAILABLE' && input.mediaProblem
      ? { status: 'MISSING_PERMISSION', reason: input.mediaProblem }
      : text.status === 'AVAILABLE'
        ? {
            status: 'AVAILABLE',
            reason: 'One JPEG or PNG image, which Threads fetches from a short-lived link.',
          }
        : text;

  return {
    adapterVersion: THREADS_ADAPTER_VERSION,
    checkedAt: input.checkedAt.toISOString(),
    postTypes: {
      TEXT: { ...text, requiredScopes: PUBLISH_SCOPES },
      IMAGE: { ...image, requiredScopes: PUBLISH_SCOPES },
      VIDEO: {
        status: 'NOT_IMPLEMENTED',
        reason:
          "Threads supports video posts; Spectra's Threads adapter does not publish them yet.",
        requiredScopes: PUBLISH_SCOPES,
      },
      DOCUMENT: {
        status: 'NOT_SUPPORTED',
        reason: 'Threads has no document posts.',
        requiredScopes: [],
      },
    },
    limits: {
      maxCharacters: THREADS_MAX_TEXT_CHARS,
      maxImages: 1,
      imageMimeTypes: [...THREADS_IMAGE_MIME_TYPES],
    },
    notes: [
      THREADS_ACCESS_NOTE,
      `Threads limits a profile to ${THREADS_POSTS_PER_DAY} API-published posts per 24 hours.`,
      'Meta recommends waiting about 30 seconds after creating a post container before publishing it, so Spectra does.',
    ],
  };
}
