import type {
  AccountDiscoveryPort,
  DiscoveredCapabilities,
  DiscoveredDestination,
  DiscoveredIdentity,
  DiscoveryContext,
} from '@spectra/social-core';
import { z } from 'zod';

import { threadsProfileCapabilities } from './capabilities';
import { ThreadsApiError, ThreadsClient, type ThreadsApiOptions } from './client';
import {
  THREADS_ACCESS_NOTE,
  THREADS_ADAPTER_VERSION,
  THREADS_ID,
  THREADS_PLATFORM,
  THREADS_SCOPES,
} from './constants';

/**
 * Threads account discovery, through one documented endpoint: `GET /v1.0/me`,
 * which returns the app-scoped id used by the publishing endpoints. A grant
 * authorizes ONE profile, so there is nothing else to list and nothing is
 * invented to fill a list.
 */

const meSchema = z.object({
  id: z.string().regex(THREADS_ID),
  username: z.string().max(100).optional(),
  name: z.string().max(300).optional(),
});

export interface ThreadsDiscoveryOptions extends ThreadsApiOptions {
  /** Why Threads cannot fetch images from this deployment, or null. */
  mediaProblem?: string | null;
}

export class ThreadsAccountDiscovery implements AccountDiscoveryPort {
  readonly platform = THREADS_PLATFORM;
  readonly adapterVersion = THREADS_ADAPTER_VERSION;

  constructor(
    private readonly options: ThreadsDiscoveryOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async discoverCapabilities(context: DiscoveryContext): Promise<DiscoveredCapabilities> {
    return {
      grantedScopes: context.grantedScopes ? [...context.grantedScopes] : null,
      capabilityVersion: THREADS_ADAPTER_VERSION,
      notes: [
        `${THREADS_SCOPES.basic} is required for every call; ${THREADS_SCOPES.publish} for publishing.`,
        THREADS_ACCESS_NOTE,
      ],
    };
  }

  async discoverIdentity(context: DiscoveryContext): Promise<DiscoveredIdentity> {
    const body = await new ThreadsClient(context.accessToken, this.options).get<unknown>('me', {
      fields: 'id,username,name',
    });
    const parsed = meSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new ThreadsApiError(
        'UNKNOWN',
        null,
        null,
        null,
        'Threads did not return a usable profile id',
      );
    }
    const { id, username, name } = parsed.data;
    const handle = username?.trim() ?? '';
    return {
      externalId: id,
      displayName: handle ? `@${handle}` : name?.trim() || 'Threads profile',
      kind: 'PROFILE',
      metadata: {
        nameReported: Boolean(handle || name),
        ...(handle ? { username: handle } : {}),
      },
      capabilities: threadsProfileCapabilities({
        grantedScopes: context.grantedScopes,
        mediaProblem: this.options.mediaProblem ?? null,
        checkedAt: this.now(),
      }),
    };
  }

  /** A Threads grant authorizes one profile; there is no list of places to post. */
  async discoverDestinations(): Promise<DiscoveredDestination[]> {
    return [];
  }
}
