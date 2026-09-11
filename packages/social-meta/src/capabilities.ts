import type { AccountCapabilitySnapshot, PostTypeSupport } from '@spectra/contracts';

import {
  FACEBOOK_MAX_MESSAGE_CHARS,
  FACEBOOK_PHOTO_MIME_TYPES,
  INSTAGRAM_IMAGE_MIME_TYPES,
  INSTAGRAM_MAX_CAPTION_CHARS,
  INSTAGRAM_MEDIA_REQUIRED,
  META_ADAPTER_VERSION,
  META_SCOPES,
  PAGE_POSTING_TASKS,
} from './constants';

/**
 * What one Meta account can publish, from the grant, the Page role and the
 * account type. Four distinct answers, never blurred: AVAILABLE; a missing
 * permission or role (fixable); NOT_IMPLEMENTED (Meta supports it, Spectra
 * does not yet); NOT_SUPPORTED (Meta itself does not allow it).
 */

type Support = { status: PostTypeSupport; reason: string; requiredScopes: string[] };

const PAGE_SCOPES = [META_SCOPES.pagesList, META_SCOPES.pagesRead, META_SCOPES.pagesPost];
const INSTAGRAM_SCOPES = [
  META_SCOPES.instagramBasic,
  META_SCOPES.instagramPublish,
  META_SCOPES.pagesRead,
];

function missingOf(scopes: readonly string[] | null, required: string[]): string[] | null {
  return scopes === null ? null : required.filter((scope) => !scopes.includes(scope));
}

function allNotSupported(
  reason: string,
  checkedAt: Date,
  limits: AccountCapabilitySnapshot['limits'],
): AccountCapabilitySnapshot {
  const support: Support = { status: 'NOT_SUPPORTED', reason, requiredScopes: [] };
  return {
    adapterVersion: META_ADAPTER_VERSION,
    checkedAt: checkedAt.toISOString(),
    postTypes: { TEXT: support, IMAGE: support, VIDEO: support, DOCUMENT: support },
    limits,
    notes: [],
  };
}

export function facebookPageCapabilities(input: {
  grantedScopes: readonly string[] | null;
  tasks: readonly string[] | null;
  hasToken: boolean;
  checkedAt: Date;
}): AccountCapabilitySnapshot {
  const missing = missingOf(input.grantedScopes, PAGE_SCOPES);
  const canCreate =
    input.tasks === null ? null : input.tasks.some((task) => PAGE_POSTING_TASKS.has(task));
  const write = (label: string): Support => {
    if (!input.hasToken) {
      return {
        status: 'MISSING_PERMISSION',
        reason:
          'Facebook returned no Page access token for this Page — your role may not allow publishing. Ask for a role with "Create content", then reconnect.',
        requiredScopes: PAGE_SCOPES,
      };
    }
    if (missing === null) {
      return {
        status: 'UNKNOWN',
        reason: `Meta did not report the granted permissions, so ${label.toLowerCase()} cannot be confirmed.`,
        requiredScopes: PAGE_SCOPES,
      };
    }
    if (missing.length > 0) {
      return {
        status: 'MISSING_PERMISSION',
        reason: `Needs ${missing.join(', ')} (Meta App Review). Add it to the app, then reconnect.`,
        requiredScopes: PAGE_SCOPES,
      };
    }
    if (canCreate === false) {
      return {
        status: 'MISSING_PERMISSION',
        reason: 'Your role on this Page does not include "Create content".',
        requiredScopes: PAGE_SCOPES,
      };
    }
    return {
      status: 'AVAILABLE',
      reason: `${label} are published through the Pages API.`,
      requiredScopes: PAGE_SCOPES,
    };
  };

  return {
    adapterVersion: META_ADAPTER_VERSION,
    checkedAt: input.checkedAt.toISOString(),
    postTypes: {
      TEXT: write('Text posts'),
      IMAGE: write('Photo posts'),
      VIDEO: {
        status: 'NOT_IMPLEMENTED',
        reason: "Facebook Pages support video; Spectra's Meta adapter does not upload video yet.",
        requiredScopes: PAGE_SCOPES,
      },
      DOCUMENT: {
        status: 'NOT_SUPPORTED',
        reason: 'Facebook Page posts have no document type.',
        requiredScopes: [],
      },
    },
    limits: {
      maxCharacters: FACEBOOK_MAX_MESSAGE_CHARS,
      maxImages: 1,
      imageMimeTypes: [...FACEBOOK_PHOTO_MIME_TYPES],
    },
    notes: [],
  };
}

export function instagramCapabilities(input: {
  grantedScopes: readonly string[] | null;
  /** Linked to the Page as a professional account (instagram_business_account). */
  eligible: boolean;
  hasToken: boolean;
  checkedAt: Date;
}): AccountCapabilitySnapshot {
  const limits = {
    maxCharacters: INSTAGRAM_MAX_CAPTION_CHARS,
    maxImages: 1,
    imageMimeTypes: [...INSTAGRAM_IMAGE_MIME_TYPES],
  };
  if (!input.eligible) {
    return allNotSupported(
      'Instagram only allows publishing through its API to professional (Business or Creator) accounts linked to a Facebook Page. Facebook does not report this account as one: switch it to a professional account in Instagram, link it to the Page, then reconnect.',
      input.checkedAt,
      limits,
    );
  }

  const missing = missingOf(input.grantedScopes, INSTAGRAM_SCOPES);
  let image: Support;
  if (!input.hasToken) {
    image = {
      status: 'MISSING_PERMISSION',
      reason:
        'Facebook returned no access token for the linked Page, which Instagram publishing uses. Check your role on the Page, then reconnect.',
      requiredScopes: INSTAGRAM_SCOPES,
    };
  } else if (missing === null) {
    image = {
      status: 'UNKNOWN',
      reason: 'Meta did not report the granted permissions, so image posts cannot be confirmed.',
      requiredScopes: INSTAGRAM_SCOPES,
    };
  } else if (missing.length > 0) {
    image = {
      status: 'MISSING_PERMISSION',
      reason: `Needs ${missing.join(', ')} (Meta App Review). Add it to the app, then reconnect.`,
      requiredScopes: INSTAGRAM_SCOPES,
    };
  } else {
    image = {
      status: 'AVAILABLE',
      reason: 'Single-image JPEG posts are published through Instagram content publishing.',
      requiredScopes: INSTAGRAM_SCOPES,
    };
  }

  return {
    adapterVersion: META_ADAPTER_VERSION,
    checkedAt: input.checkedAt.toISOString(),
    postTypes: {
      TEXT: { status: 'NOT_SUPPORTED', reason: INSTAGRAM_MEDIA_REQUIRED, requiredScopes: [] },
      IMAGE: image,
      VIDEO: {
        status: 'NOT_IMPLEMENTED',
        reason:
          "Instagram supports video and Reels; Spectra's Meta adapter does not publish them yet.",
        requiredScopes: INSTAGRAM_SCOPES,
      },
      DOCUMENT: {
        status: 'NOT_SUPPORTED',
        reason: 'Instagram has no document posts.',
        requiredScopes: [],
      },
    },
    limits,
    notes: [
      "Instagram fetches the image from a short-lived link to this deployment's object storage, which must be reachable from the internet.",
      'Instagram limits API-published posts per account per 24 hours; the remaining allowance is checked before each post.',
    ],
  };
}

/** Facebook does not let apps publish to personal profiles. */
export function facebookProfileCapabilities(checkedAt: Date): AccountCapabilitySnapshot {
  return allNotSupported(
    'Facebook does not allow apps to publish to personal profiles. Publish to a Page instead.',
    checkedAt,
    { maxCharacters: FACEBOOK_MAX_MESSAGE_CHARS, maxImages: 0, imageMimeTypes: [] },
  );
}
