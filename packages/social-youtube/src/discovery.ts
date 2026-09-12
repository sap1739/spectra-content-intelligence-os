import type {
  AccountDiscoveryPort,
  DiscoveredCapabilities,
  DiscoveredDestination,
  DiscoveredIdentity,
  DiscoveryContext,
} from '@spectra/social-core';
import { z } from 'zod';

import { youTubeChannelCapabilities } from './capabilities';
import { YouTubeApiError, YouTubeClient, type YouTubeApiOptions } from './client';
import {
  CHANNEL_ID,
  UNAUDITED_PROJECT_NOTE,
  YOUTUBE_ADAPTER_VERSION,
  YOUTUBE_PLATFORM,
  YOUTUBE_SCOPES,
} from './constants';

/**
 * YouTube channel discovery, through one documented endpoint:
 * `GET /youtube/v3/channels?part=snippet,status&mine=true`, which returns the
 * channels the authorizing Google account owns (quota cost 1).
 *
 * A Google account may own several channels, but YouTube only returns the ones
 * the consent screen was given: a brand channel the user did not pick is not
 * inferred, and nothing is invented when the list is empty.
 */

const channelSchema = z
  .object({
    id: z.string().min(1).max(100),
    snippet: z
      .object({
        title: z.string().max(300).optional(),
        customUrl: z.string().max(120).optional(),
      })
      .passthrough()
      .optional(),
    status: z
      .object({
        privacyStatus: z.string().max(40).optional(),
        isLinked: z.boolean().optional(),
        longUploadsStatus: z.string().max(40).optional(),
        madeForKids: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const channelsSchema = z.object({ items: z.array(z.unknown()).default([]) });

export interface YouTubeDiscoveryOptions extends YouTubeApiOptions {
  /** Whether the operator declared this API project audited by Google. */
  projectAudited: boolean;
}

export class YouTubeAccountDiscovery implements AccountDiscoveryPort {
  readonly platform = YOUTUBE_PLATFORM;
  readonly adapterVersion = YOUTUBE_ADAPTER_VERSION;

  constructor(
    private readonly options: YouTubeDiscoveryOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private client(context: DiscoveryContext): YouTubeClient {
    return new YouTubeClient(context.accessToken, this.options);
  }

  async discoverCapabilities(context: DiscoveryContext): Promise<DiscoveredCapabilities> {
    const notes = [
      'Uploading needs youtube.upload; listing channels needs youtube.readonly.',
      'The YouTube Data API has a daily quota shared by this deployment; uploads also have their own per-project daily limit.',
    ];
    if (!this.options.projectAudited) notes.push(UNAUDITED_PROJECT_NOTE);
    return {
      grantedScopes: context.grantedScopes ? [...context.grantedScopes] : null,
      capabilityVersion: YOUTUBE_ADAPTER_VERSION,
      notes,
    };
  }

  async discoverIdentity(context: DiscoveryContext): Promise<DiscoveredIdentity> {
    const channels = await this.listChannels(context);
    const first = channels[0];
    if (!first) {
      throw new YouTubeApiError(
        'NOT_FOUND',
        null,
        null,
        'This Google account has no YouTube channel. Create a channel, then reconnect',
      );
    }
    return { ...first, kind: 'CHANNEL' as const };
  }

  async discoverDestinations(context: DiscoveryContext): Promise<DiscoveredDestination[]> {
    const scopes = context.grantedScopes;
    // Listing channels needs a read scope; without one nothing is looked up.
    if (
      scopes &&
      !scopes.includes(YOUTUBE_SCOPES.readonly) &&
      !scopes.includes(YOUTUBE_SCOPES.manage)
    ) {
      return [];
    }
    return this.listChannels(context);
  }

  private async listChannels(
    context: DiscoveryContext,
  ): Promise<Array<DiscoveredDestination & { kind: 'CHANNEL' }>> {
    const body = await this.client(context).get<unknown>('channels', {
      part: 'snippet,status',
      mine: 'true',
      maxResults: '50',
    });
    const parsed = channelsSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new YouTubeApiError(
        'UNKNOWN',
        null,
        null,
        'YouTube returned an unexpected channel list',
      );
    }
    const checkedAt = this.now();
    const channels: Array<DiscoveredDestination & { kind: 'CHANNEL' }> = [];
    for (const item of parsed.data.items) {
      const channel = channelSchema.safeParse(item);
      if (!channel.success || !CHANNEL_ID.test(channel.data.id)) continue;
      const { id, snippet, status } = channel.data;
      const title = snippet?.title?.trim() ?? '';
      channels.push({
        externalId: id,
        displayName: title || `YouTube channel ${id}`,
        kind: 'CHANNEL',
        metadata: {
          nameReported: title.length > 0,
          ...(snippet?.customUrl ? { customUrl: snippet.customUrl } : {}),
          ...(status?.privacyStatus ? { privacyStatus: status.privacyStatus } : {}),
          ...(status?.longUploadsStatus ? { longUploadsStatus: status.longUploadsStatus } : {}),
          ...(status?.madeForKids !== undefined ? { madeForKids: status.madeForKids } : {}),
        },
        capabilities: youTubeChannelCapabilities({
          grantedScopes: context.grantedScopes,
          longUploadsStatus: status?.longUploadsStatus ?? null,
          projectAudited: this.options.projectAudited,
          checkedAt,
        }),
      });
    }
    return channels;
  }
}
