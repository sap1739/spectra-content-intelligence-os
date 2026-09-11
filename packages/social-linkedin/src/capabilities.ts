import type { AccountCapabilitySnapshot, PostTypeSupport } from '@spectra/contracts';

import {
  LINKEDIN_ADAPTER_VERSION,
  LINKEDIN_IMAGE_MIME_TYPES,
  LINKEDIN_MAX_COMMENTARY_CHARS,
  LINKEDIN_SCOPES,
} from './constants';

/**
 * What one LinkedIn account can publish through this adapter, given the scopes
 * its connection was granted. Computed at discovery and stored on the account.
 *
 * A member profile posts with w_member_social ("Share on LinkedIn", self-serve);
 * a page posts with w_organization_social (Community Management API, reviewed).
 * Video and documents are real LinkedIn features this adapter does not
 * implement — reported as NOT_IMPLEMENTED, never as unsupported-by-LinkedIn.
 */
export function linkedInAccountCapabilities(input: {
  kind: 'PROFILE' | 'PAGE';
  grantedScopes: readonly string[] | null;
  checkedAt: Date;
}): AccountCapabilitySnapshot {
  const scope = input.kind === 'PROFILE' ? LINKEDIN_SCOPES.memberSocial : LINKEDIN_SCOPES.orgSocial;
  const product =
    input.kind === 'PROFILE'
      ? 'Share on LinkedIn'
      : 'Community Management API (reviewed by LinkedIn)';
  const granted = input.grantedScopes === null ? null : input.grantedScopes.includes(scope);

  const writeStatus = (
    label: string,
  ): { status: PostTypeSupport; reason: string; requiredScopes: string[] } => {
    if (granted === null) {
      return {
        status: 'UNKNOWN',
        reason: `LinkedIn did not report the granted scopes, so ${label} cannot be confirmed.`,
        requiredScopes: [scope],
      };
    }
    if (!granted) {
      return {
        status: 'MISSING_PERMISSION',
        reason: `Needs ${scope} (${product}). Add the product to the LinkedIn app, then reconnect.`,
        requiredScopes: [scope],
      };
    }
    return {
      status: 'AVAILABLE',
      reason: `${label} are published through LinkedIn's Posts API.`,
      requiredScopes: [scope],
    };
  };

  const notes: string[] = [];
  if (input.kind === 'PROFILE') {
    notes.push(
      'LinkedIn does not let a member-only token check whether an uploaded image finished processing; if LinkedIn fails to process one, the post may not be visible.',
    );
  }

  return {
    adapterVersion: LINKEDIN_ADAPTER_VERSION,
    checkedAt: input.checkedAt.toISOString(),
    postTypes: {
      TEXT: writeStatus('Text posts'),
      IMAGE: writeStatus('Single-image posts'),
      VIDEO: {
        status: 'NOT_IMPLEMENTED',
        reason:
          "LinkedIn supports video posts (Videos API); Spectra's LinkedIn adapter does not upload video yet.",
        requiredScopes: [scope],
      },
      DOCUMENT: {
        status: 'NOT_IMPLEMENTED',
        reason:
          "LinkedIn supports document posts (Documents API); Spectra's LinkedIn adapter does not upload documents yet.",
        requiredScopes: [scope],
      },
    },
    limits: {
      maxCharacters: LINKEDIN_MAX_COMMENTARY_CHARS,
      maxImages: 1,
      imageMimeTypes: [...LINKEDIN_IMAGE_MIME_TYPES],
    },
    notes,
  };
}
