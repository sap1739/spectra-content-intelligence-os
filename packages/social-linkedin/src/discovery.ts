import type {
  AccountDiscoveryPort,
  DiscoveredCapabilities,
  DiscoveredDestination,
  DiscoveredIdentity,
  DiscoveryContext,
} from '@spectra/social-core';
import { z } from 'zod';

import { linkedInAccountCapabilities } from './capabilities';
import { LinkedInApiError, LinkedInClient, type LinkedInApiOptions } from './client';
import {
  LINKEDIN_ADAPTER_VERSION,
  LINKEDIN_PLATFORM,
  LINKEDIN_SCOPES,
  ORGANIC_POSTING_ROLES,
} from './constants';

/**
 * LinkedIn account discovery, through official endpoints only:
 * - identity: OpenID Connect `GET /v2/userinfo` (openid + profile) — `sub` is
 *   the member id used in `urn:li:person:{sub}`;
 * - pages: `GET /rest/organizationAcls?q=roleAssignee` (r_ or
 *   rw_organization_admin), keeping only APPROVED roles that can post
 *   organically, with names from `GET /rest/organizationsLookup`.
 *
 * Nothing is inferred: no page access granted means no pages looked up, and a
 * page whose name LinkedIn will not return is labelled by its id.
 */

const userInfoSchema = z.object({
  sub: z.string().min(1).max(200),
  name: z.string().max(300).optional(),
  given_name: z.string().max(150).optional(),
  family_name: z.string().max(150).optional(),
});

const aclSchema = z.object({
  elements: z
    .array(
      z
        .object({
          role: z.string().optional(),
          state: z.string().optional(),
          // LinkedIn's own examples use both spellings.
          organization: z.string().optional(),
          organizationTarget: z.string().optional(),
          organizationalTarget: z.string().optional(),
        })
        .passthrough(),
    )
    .default([]),
});

const lookupSchema = z.object({
  results: z
    .record(
      z
        .object({ localizedName: z.string().optional(), vanityName: z.string().optional() })
        .passthrough(),
    )
    .default({}),
});

const MEMBER_ID = /^[^\s:/]{1,200}$/;
const ORG_URN = /^urn:li:organization:(\d{1,20})$/;
const ACL_PAGE_SIZE = 100;
const ACL_MAX_PAGES = 5;
const LOOKUP_CHUNK = 50;

export class LinkedInAccountDiscovery implements AccountDiscoveryPort {
  readonly platform = LINKEDIN_PLATFORM;
  readonly adapterVersion = LINKEDIN_ADAPTER_VERSION;

  constructor(
    private readonly options: LinkedInApiOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private client(context: DiscoveryContext): LinkedInClient {
    return new LinkedInClient(context.accessToken, this.options);
  }

  async discoverIdentity(context: DiscoveryContext): Promise<DiscoveredIdentity> {
    const scopes = context.grantedScopes;
    if (
      scopes &&
      !(scopes.includes(LINKEDIN_SCOPES.openid) && scopes.includes(LINKEDIN_SCOPES.profile))
    ) {
      throw new LinkedInApiError(
        'PERMISSION',
        null,
        null,
        'Identifying the member needs the openid and profile scopes (Sign In with LinkedIn using OpenID Connect)',
      );
    }
    const { body } = await this.client(context).v2<unknown>('/v2/userinfo');
    const parsed = userInfoSchema.safeParse(body);
    if (!parsed.success || !MEMBER_ID.test(parsed.data.sub)) {
      throw new LinkedInApiError(
        'UNKNOWN',
        null,
        null,
        'LinkedIn userinfo did not include a usable member id',
      );
    }
    const info = parsed.data;
    const name = (
      info.name ?? [info.given_name, info.family_name].filter(Boolean).join(' ')
    ).trim();
    return {
      externalId: `urn:li:person:${info.sub}`,
      displayName: name || 'LinkedIn member',
      kind: 'PROFILE',
      metadata: { nameReported: name.length > 0 },
      capabilities: linkedInAccountCapabilities({
        kind: 'PROFILE',
        grantedScopes: scopes,
        checkedAt: this.now(),
      }),
    };
  }

  async discoverDestinations(context: DiscoveryContext): Promise<DiscoveredDestination[]> {
    const scopes = context.grantedScopes;
    const pageAccess =
      scopes === null ||
      scopes.includes(LINKEDIN_SCOPES.orgAdminRead) ||
      scopes.includes(LINKEDIN_SCOPES.orgAdminReadWrite);
    // No page access granted: nothing is looked up and nothing is invented.
    if (!pageAccess) return [];

    const client = this.client(context);
    const roles = new Map<string, Set<string>>();
    for (let page = 0; page < ACL_MAX_PAGES; page += 1) {
      let body: unknown;
      try {
        ({ body } = await client.rest<unknown>('GET', '/rest/organizationAcls', {
          query: `q=roleAssignee&state=APPROVED&start=${page * ACL_PAGE_SIZE}&count=${ACL_PAGE_SIZE}`,
        }));
      } catch (error) {
        // Scopes were not reported and LinkedIn refused: the grant has no page access.
        if (scopes === null && error instanceof LinkedInApiError && error.kind === 'PERMISSION') {
          return [];
        }
        throw error;
      }
      const parsed = aclSchema.safeParse(body ?? {});
      if (!parsed.success) {
        throw new LinkedInApiError(
          'UNKNOWN',
          null,
          null,
          'LinkedIn returned an unexpected organization access response',
        );
      }
      for (const element of parsed.data.elements) {
        if (element.state && element.state !== 'APPROVED') continue;
        const urn =
          element.organization ?? element.organizationTarget ?? element.organizationalTarget;
        if (!urn || !ORG_URN.test(urn) || !element.role) continue;
        let set = roles.get(urn);
        if (!set) {
          set = new Set();
          roles.set(urn, set);
        }
        set.add(element.role);
      }
      if (parsed.data.elements.length < ACL_PAGE_SIZE) break;
    }

    const postable = [...roles.entries()].filter(([, set]) =>
      [...set].some((role) => ORGANIC_POSTING_ROLES.has(role)),
    );
    if (postable.length === 0) return [];

    const idOf = (urn: string) => (ORG_URN.exec(urn) as RegExpExecArray)[1] as string;
    const names = await this.lookupNames(
      client,
      postable.map(([urn]) => idOf(urn)),
    );
    const checkedAt = this.now();
    return postable.map(([urn, set]) => {
      const id = idOf(urn);
      const info = names.get(id);
      return {
        externalId: urn,
        displayName: info?.localizedName || `LinkedIn page ${id}`,
        kind: 'PAGE' as const,
        metadata: {
          roles: [...set].sort().join(','),
          nameReported: Boolean(info?.localizedName),
          ...(info?.vanityName ? { vanityName: info.vanityName } : {}),
        },
        capabilities: linkedInAccountCapabilities({
          kind: 'PAGE',
          grantedScopes: scopes,
          checkedAt,
        }),
      };
    });
  }

  async discoverCapabilities(context: DiscoveryContext): Promise<DiscoveredCapabilities> {
    return {
      grantedScopes: context.grantedScopes ? [...context.grantedScopes] : null,
      capabilityVersion: LINKEDIN_ADAPTER_VERSION,
      notes: [
        'Member posts need w_member_social (Share on LinkedIn); page posts need w_organization_social (Community Management API).',
      ],
    };
  }

  /** Page names are cosmetic: a failed lookup leaves the id as the label. */
  private async lookupNames(
    client: LinkedInClient,
    ids: string[],
  ): Promise<Map<string, { localizedName?: string; vanityName?: string }>> {
    const names = new Map<string, { localizedName?: string; vanityName?: string }>();
    for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
      const chunk = ids.slice(i, i + LOOKUP_CHUNK);
      try {
        const { body } = await client.rest<unknown>('GET', '/rest/organizationsLookup', {
          query: `ids=List(${chunk.join(',')})`,
        });
        const parsed = lookupSchema.safeParse(body ?? {});
        if (!parsed.success) continue;
        for (const [id, info] of Object.entries(parsed.data.results)) {
          names.set(id, {
            ...(info.localizedName ? { localizedName: info.localizedName.slice(0, 300) } : {}),
            ...(info.vanityName ? { vanityName: info.vanityName.slice(0, 200) } : {}),
          });
        }
      } catch {
        // Keep going: the page id is still the truth.
      }
    }
    return names;
  }
}
