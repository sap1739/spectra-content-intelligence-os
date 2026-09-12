import type {
  AccountDiscoveryPort,
  DiscoveredCapabilities,
  DiscoveredDestination,
  DiscoveredIdentity,
  DiscoveryContext,
} from '@spectra/social-core';
import { z } from 'zod';

import { xAccountCapabilities } from './capabilities';
import { XApiError, XClient, type XApiOptions } from './client';
import { X_ADAPTER_VERSION, X_ID, X_PLATFORM, X_PRICING_NOTE, X_SCOPES } from './constants';

/**
 * X account discovery, through one documented endpoint: `GET /2/users/me`
 * (`tweet.read` + `users.read`). A grant authorizes ONE account, so there is
 * nothing else to list and nothing is invented to fill a list.
 */

const meSchema = z.object({
  data: z.object({
    id: z.string().regex(X_ID),
    username: z.string().max(60).optional(),
    name: z.string().max(200).optional(),
  }),
});

export class XAccountDiscovery implements AccountDiscoveryPort {
  readonly platform = X_PLATFORM;
  readonly adapterVersion = X_ADAPTER_VERSION;

  constructor(
    private readonly options: XApiOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async discoverCapabilities(context: DiscoveryContext): Promise<DiscoveredCapabilities> {
    return {
      grantedScopes: context.grantedScopes ? [...context.grantedScopes] : null,
      capabilityVersion: X_ADAPTER_VERSION,
      notes: [
        `Posting needs ${X_SCOPES.write}; images also need ${X_SCOPES.media}; ${X_SCOPES.offline} keeps the connection refreshable.`,
        X_PRICING_NOTE,
      ],
    };
  }

  async discoverIdentity(context: DiscoveryContext): Promise<DiscoveredIdentity> {
    const body = await new XClient(context.accessToken, this.options).get<unknown>('/2/users/me', {
      'user.fields': 'username,name',
    });
    const parsed = meSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new XApiError('UNKNOWN', null, null, 'X did not return a usable account id');
    }
    const { id, username, name } = parsed.data.data;
    const handle = username?.trim() ?? '';
    return {
      externalId: id,
      displayName: handle ? `@${handle}` : name?.trim() || 'X account',
      kind: 'PROFILE',
      metadata: {
        nameReported: Boolean(handle || name),
        ...(handle ? { username: handle } : {}),
      },
      capabilities: xAccountCapabilities({
        grantedScopes: context.grantedScopes,
        checkedAt: this.now(),
      }),
    };
  }

  /** An X grant authorizes one account; there is no list of places to post. */
  async discoverDestinations(): Promise<DiscoveredDestination[]> {
    return [];
  }
}
