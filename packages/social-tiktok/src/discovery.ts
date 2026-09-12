import type {
  AccountDiscoveryPort,
  DiscoveredCapabilities,
  DiscoveredDestination,
  DiscoveredIdentity,
  DiscoveryContext,
} from '@spectra/social-core';
import { z } from 'zod';

import { tikTokCreatorCapabilities } from './capabilities';
import { TikTokApiError, TikTokClient, type TikTokApiOptions } from './client';
import {
  TIKTOK_ADAPTER_VERSION,
  TIKTOK_ID,
  TIKTOK_PATHS,
  TIKTOK_PLATFORM,
  TIKTOK_SCOPES,
  UNAUDITED_CLIENT_NOTE,
} from './constants';

/**
 * TikTok account discovery. There is nothing to list: a grant authorizes ONE
 * creator account, so discovery names that account and reports nothing else —
 * no destinations are invented to fill a list.
 *
 * The creator's own name and the privacy levels they may use come from
 * `creator_info/query`, which TikTok requires before a direct post anyway. A
 * grant without `video.publish` cannot call it, so the account is still
 * recorded — from the open id the token came with — with the missing scope
 * stated instead of a guess.
 */

export const creatorInfoSchema = z.object({
  data: z
    .object({
      creator_username: z.string().max(100).optional(),
      creator_nickname: z.string().max(200).optional(),
      privacy_level_options: z.array(z.string().max(40)).max(10).optional(),
      comment_disabled: z.boolean().optional(),
      duet_disabled: z.boolean().optional(),
      stitch_disabled: z.boolean().optional(),
      max_video_post_duration_sec: z.number().int().positive().optional(),
    })
    .passthrough(),
});

export interface TikTokDiscoveryOptions extends TikTokApiOptions {
  /** Whether the operator declared this API client audited by TikTok. */
  clientAudited: boolean;
}

export class TikTokAccountDiscovery implements AccountDiscoveryPort {
  readonly platform = TIKTOK_PLATFORM;
  readonly adapterVersion = TIKTOK_ADAPTER_VERSION;

  constructor(
    private readonly options: TikTokDiscoveryOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async discoverCapabilities(context: DiscoveryContext): Promise<DiscoveredCapabilities> {
    const notes = [
      `Direct Post needs ${TIKTOK_SCOPES.publish}; ${TIKTOK_SCOPES.upload} only sends a draft to the creator's inbox, which this adapter does not use.`,
    ];
    if (!this.options.clientAudited) notes.push(UNAUDITED_CLIENT_NOTE);
    return {
      grantedScopes: context.grantedScopes ? [...context.grantedScopes] : null,
      capabilityVersion: TIKTOK_ADAPTER_VERSION,
      notes,
    };
  }

  async discoverIdentity(context: DiscoveryContext): Promise<DiscoveredIdentity> {
    const openId = context.subjectId ?? null;
    if (!openId || !TIKTOK_ID.test(openId)) {
      throw new TikTokApiError(
        'UNKNOWN',
        null,
        null,
        'TikTok did not return an open id for the authorizing creator',
      );
    }
    const checkedAt = this.now();
    const scopes = context.grantedScopes;
    const canQuery = scopes === null || scopes.includes(TIKTOK_SCOPES.publish);

    let creator: z.infer<typeof creatorInfoSchema>['data'] | null = null;
    if (canQuery) {
      try {
        const body = await new TikTokClient(context.accessToken, this.options).post<unknown>(
          TIKTOK_PATHS.creatorInfo,
          {},
        );
        creator = creatorInfoSchema.safeParse(body ?? {}).data?.data ?? null;
      } catch (error) {
        // A grant that cannot read creator info still has an account worth
        // recording; anything else is a real discovery failure.
        const soft =
          error instanceof TikTokApiError &&
          (error.kind === 'PERMISSION' || error.kind === 'AUDIT' || error.kind === 'RATE_LIMIT');
        if (!soft) throw error;
      }
    }

    const username = creator?.creator_username?.trim() ?? '';
    const nickname = creator?.creator_nickname?.trim() ?? '';
    return {
      externalId: openId,
      displayName: nickname || (username ? `@${username}` : 'TikTok creator'),
      kind: 'PROFILE',
      metadata: {
        nameReported: Boolean(nickname || username),
        ...(username ? { username } : {}),
        creatorInfoRead: creator !== null,
        ...(creator?.privacy_level_options
          ? { privacyLevelOptions: creator.privacy_level_options.join(',') }
          : {}),
        ...(creator?.max_video_post_duration_sec
          ? { maxVideoPostDurationSec: creator.max_video_post_duration_sec }
          : {}),
        ...(creator?.comment_disabled !== undefined
          ? { commentDisabled: creator.comment_disabled }
          : {}),
      },
      capabilities: tikTokCreatorCapabilities({
        grantedScopes: scopes,
        privacyLevelOptions: creator?.privacy_level_options ?? null,
        maxVideoPostDurationSec: creator?.max_video_post_duration_sec ?? null,
        clientAudited: this.options.clientAudited,
        checkedAt,
      }),
    };
  }

  /** A TikTok grant authorizes one creator; there is no list of places to post. */
  async discoverDestinations(): Promise<DiscoveredDestination[]> {
    return [];
  }
}
