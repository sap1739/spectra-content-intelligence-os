import type { AccountCapabilitySnapshot, PostTypeSupport } from '@spectra/contracts';

import {
  SPECTRA_MAX_VIDEO_BYTES,
  TIKTOK_ADAPTER_VERSION,
  TIKTOK_MAX_DURATION_SECONDS,
  TIKTOK_MAX_TITLE_RUNES,
  TIKTOK_SCOPES,
  UNAUDITED_CLIENT_NOTE,
} from './constants';

/**
 * What one TikTok creator account can publish, from the grant and what TikTok
 * says about the creator. TikTok's API publishes videos; text posts do not
 * exist there at all, and photo posts are a real TikTok feature this adapter
 * has not built — reported as different things, because they are.
 */

const PUBLISH_SCOPES = [TIKTOK_SCOPES.publish];

export function tikTokCreatorCapabilities(input: {
  grantedScopes: readonly string[] | null;
  /** Privacy levels the creator may use, as creator_info reported them. */
  privacyLevelOptions?: readonly string[] | null;
  maxVideoPostDurationSec?: number | null;
  /** Whether the operator declared this API client audited by TikTok. */
  clientAudited: boolean;
  checkedAt: Date;
}): AccountCapabilitySnapshot {
  let video: PostTypeSupport;
  let reason: string;
  if (input.grantedScopes === null) {
    video = 'UNKNOWN';
    reason = 'TikTok did not report the granted scopes, so posting cannot be confirmed.';
  } else if (!input.grantedScopes.includes(TIKTOK_SCOPES.publish)) {
    video = 'MISSING_PERMISSION';
    reason = `Direct Post needs the ${TIKTOK_SCOPES.publish} scope, which this connection was not granted. TikTok must approve that scope for the app, then reconnect.`;
  } else {
    video = 'AVAILABLE';
    reason = 'One video per post, uploaded in chunks through the Content Posting API.';
  }

  const notes: string[] = [];
  const options = input.privacyLevelOptions ?? null;
  if (options && options.length > 0) {
    notes.push(
      `TikTok reports this creator may post as: ${[...options].join(', ')}. The privacy level is checked against that list at publish time.`,
    );
    if (options.length === 1 && options[0] === 'SELF_ONLY') {
      notes.push(
        'Only private (SELF_ONLY) posting is available for this creator — often because the API client has not been audited.',
      );
    }
  }
  if (!input.clientAudited) notes.push(UNAUDITED_CLIENT_NOTE);
  notes.push(
    `Videos may run up to ${TIKTOK_MAX_DURATION_SECONDS / 60} minutes through the API${
      input.maxVideoPostDurationSec
        ? `, and TikTok reports ${input.maxVideoPostDurationSec} seconds for this creator`
        : ''
    }; Spectra uploads files up to ${Math.round(SPECTRA_MAX_VIDEO_BYTES / (1024 * 1024))} MB.`,
  );

  return {
    adapterVersion: TIKTOK_ADAPTER_VERSION,
    checkedAt: input.checkedAt.toISOString(),
    postTypes: {
      TEXT: {
        status: 'NOT_SUPPORTED',
        reason: 'TikTok has no text-only posts.',
        requiredScopes: [],
      },
      IMAGE: {
        status: 'NOT_IMPLEMENTED',
        reason:
          "TikTok supports photo posts; Spectra's TikTok adapter publishes video only for now.",
        requiredScopes: PUBLISH_SCOPES,
      },
      VIDEO: { status: video, reason, requiredScopes: PUBLISH_SCOPES },
      DOCUMENT: {
        status: 'NOT_SUPPORTED',
        reason: 'TikTok has no document posts.',
        requiredScopes: [],
      },
    },
    limits: { maxCharacters: TIKTOK_MAX_TITLE_RUNES, maxImages: 0, imageMimeTypes: [] },
    notes,
  };
}
