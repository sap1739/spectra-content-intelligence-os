import type { AccountCapabilitySnapshot, PostTypeSupport } from '@spectra/contracts';

import {
  SPECTRA_MAX_POST_CHARS,
  X_MAX_IMAGES,
  X_PRICING_NOTE,
  X_RATE_LIMITS,
  X_SCOPES,
  X_ADAPTER_VERSION,
} from './constants';

/**
 * What one X account can publish, from the grant. X's plan limits are not
 * visible through the API — a request either succeeds or comes back refused —
 * so they are stated as notes rather than pretended to be checked.
 */

const POST_SCOPES = [X_SCOPES.write, X_SCOPES.read, X_SCOPES.users];
const IMAGE_SCOPES = [...POST_SCOPES, X_SCOPES.media];

export function xAccountCapabilities(input: {
  grantedScopes: readonly string[] | null;
  checkedAt: Date;
}): AccountCapabilitySnapshot {
  const granted = input.grantedScopes;
  const missing = (required: readonly string[]) =>
    granted ? required.filter((scope) => !granted.includes(scope)) : null;

  const support = (
    required: readonly string[],
    available: string,
  ): {
    status: PostTypeSupport;
    reason: string;
  } => {
    const gap = missing(required);
    if (gap === null) {
      return {
        status: 'UNKNOWN',
        reason: 'X did not report the granted scopes, so posting cannot be confirmed.',
      };
    }
    if (gap.length > 0) {
      return {
        status: 'MISSING_PERMISSION',
        reason: `Needs ${gap.join(', ')}, which this connection was not granted. Reconnect X and allow it.`,
      };
    }
    return { status: 'AVAILABLE', reason: available };
  };

  return {
    adapterVersion: X_ADAPTER_VERSION,
    checkedAt: input.checkedAt.toISOString(),
    postTypes: {
      TEXT: {
        ...support(POST_SCOPES, 'Text posts are created through the v2 API.'),
        requiredScopes: [...POST_SCOPES],
      },
      IMAGE: {
        ...support(
          IMAGE_SCOPES,
          `Up to ${X_MAX_IMAGES} images, uploaded through the chunked media endpoints.`,
        ),
        requiredScopes: [...IMAGE_SCOPES],
      },
      VIDEO: {
        status: 'NOT_IMPLEMENTED',
        reason: "X supports video posts; Spectra's X adapter does not upload video yet.",
        requiredScopes: [...IMAGE_SCOPES],
      },
      DOCUMENT: {
        status: 'NOT_SUPPORTED',
        reason: 'X has no document posts.',
        requiredScopes: [],
      },
    },
    limits: {
      maxCharacters: SPECTRA_MAX_POST_CHARS,
      maxImages: X_MAX_IMAGES,
      // X's reference does not enumerate accepted image types; it refuses what
      // it will not take, and that refusal is reported as X worded it.
      imageMimeTypes: [],
    },
    notes: [
      X_PRICING_NOTE,
      `X documents ${X_RATE_LIMITS.perUserPer15Min} posts per user per 15 minutes and ${X_RATE_LIMITS.perAppPer24Hours.toLocaleString('en-US')} per app per 24 hours; a refusal is reported with what X said.`,
      `Spectra caps a post at ${SPECTRA_MAX_POST_CHARS} characters: X's API reference states no limit, and a verified account may be allowed more.`,
      'An access token lasts about two hours, so the connection is refreshed before publishing (offline.access).',
    ],
  };
}
