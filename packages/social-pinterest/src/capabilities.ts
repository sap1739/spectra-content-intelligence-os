import type { AccountCapabilitySnapshot, PostTypeSupport } from '@spectra/contracts';

import { PINTEREST_ACCESS_NOTE, PINTEREST_ADAPTER_VERSION, PINTEREST_SCOPES } from './constants';

/**
 * What one Pinterest board can publish. A pin is always an image, so there is
 * no text-only post to offer; Pinterest's own image rules are not documented,
 * so no numbers are claimed here.
 */

const PIN_SCOPES = [PINTEREST_SCOPES.pinsWrite, PINTEREST_SCOPES.boardsRead];

export function pinterestBoardCapabilities(input: {
  grantedScopes: readonly string[] | null;
  /** Why Pinterest cannot fetch images from this deployment, or null. */
  mediaProblem?: string | null;
  checkedAt: Date;
}): AccountCapabilitySnapshot {
  const missing = input.grantedScopes
    ? PIN_SCOPES.filter((scope) => !input.grantedScopes?.includes(scope))
    : null;

  let image: { status: PostTypeSupport; reason: string };
  if (missing === null) {
    image = {
      status: 'UNKNOWN',
      reason: 'Pinterest did not report the granted scopes, so pinning cannot be confirmed.',
    };
  } else if (missing.length > 0) {
    image = {
      status: 'MISSING_PERMISSION',
      reason: `Needs ${missing.join(', ')}, which this connection was not granted. Reconnect Pinterest and allow it.`,
    };
  } else if (input.mediaProblem) {
    image = { status: 'MISSING_PERMISSION', reason: input.mediaProblem };
  } else {
    image = {
      status: 'AVAILABLE',
      reason: 'One image pin, which Pinterest fetches from a short-lived link.',
    };
  }

  return {
    adapterVersion: PINTEREST_ADAPTER_VERSION,
    checkedAt: input.checkedAt.toISOString(),
    postTypes: {
      TEXT: {
        status: 'NOT_SUPPORTED',
        reason: 'Every pin carries an image; Pinterest has no text-only pins.',
        requiredScopes: [],
      },
      IMAGE: { ...image, requiredScopes: PIN_SCOPES },
      VIDEO: {
        status: 'NOT_IMPLEMENTED',
        reason:
          "Pinterest supports video pins (a registered media id); Spectra's adapter creates image pins only.",
        requiredScopes: PIN_SCOPES,
      },
      DOCUMENT: {
        status: 'NOT_SUPPORTED',
        reason: 'Pinterest has no document pins.',
        requiredScopes: [],
      },
    },
    limits: {
      // Pinterest documents no character or size limits for a pin, so none are
      // claimed: it refuses what it will not take, in its own words.
      maxCharacters: null,
      maxImages: 1,
      imageMimeTypes: [],
    },
    notes: [
      PINTEREST_ACCESS_NOTE,
      'Pinterest does not document image formats, a maximum file size or text limits for a pin; it answers 403 when an image is "too small, too large or is broken", and Spectra reports that as it came.',
      "Pinterest fetches the image from a short-lived link to this deployment's object storage, which must be reachable from the internet.",
    ],
  };
}
