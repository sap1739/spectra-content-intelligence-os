import type {
  AccountDiscoveryPort,
  DiscoveredCapabilities,
  DiscoveredDestination,
  DiscoveredIdentity,
  DiscoveryContext,
} from '@spectra/social-core';
import { z } from 'zod';

import {
  facebookPageCapabilities,
  facebookProfileCapabilities,
  instagramCapabilities,
} from './capabilities';
import { MetaApiError, MetaGraphClient, type MetaGraphOptions } from './client';
import { GRAPH_ID, META_ADAPTER_VERSION, META_SCOPES } from './constants';

/**
 * Meta account discovery, through documented Graph API endpoints only:
 * - what was granted: `GET /me/permissions` (Meta's token response reports
 *   no scopes, so this is the only honest source);
 * - who authorized: `GET /me?fields=id,name` — a personal profile, which
 *   Facebook does not let apps publish to, recorded as such;
 * - where they can publish: `GET /me/accounts` — the Pages they have a role
 *   on, each with its tasks and its own Page access token, and the Instagram
 *   account linked to each Page.
 *
 * An Instagram account is eligible only when Facebook reports it as the
 * Page's `instagram_business_account` (the professional account the content
 * publishing API addresses). One connected through Page settings alone
 * (`connected_instagram_account`) is recorded as not eligible, with the
 * reason — never silently dropped, never presented as publishable.
 */

const permissionsSchema = z.object({
  data: z
    .array(z.object({ permission: z.string().max(100), status: z.string().max(40) }).passthrough())
    .default([]),
});
const meSchema = z.object({ id: z.string().regex(GRAPH_ID), name: z.string().max(300).optional() });
const instagramSchema = z
  .object({
    id: z.string().regex(GRAPH_ID),
    username: z.string().max(100).optional(),
    name: z.string().max(300).optional(),
  })
  .passthrough();
const pageSchema = z
  .object({
    id: z.string().regex(GRAPH_ID),
    name: z.string().max(300).optional(),
    access_token: z.string().min(1).max(4096).optional(),
    tasks: z.array(z.string().max(60)).max(50).optional(),
    category: z.string().max(200).optional(),
    instagram_business_account: instagramSchema.optional(),
    connected_instagram_account: instagramSchema.optional(),
  })
  .passthrough();
const accountsSchema = z.object({
  data: z.array(z.unknown()).default([]),
  paging: z
    .object({
      cursors: z.object({ after: z.string().max(1000).optional() }).optional(),
      next: z.string().optional(),
    })
    .optional(),
});

type Page = z.infer<typeof pageSchema>;

const PAGE_LIMIT = 100;
const MAX_PAGES = 5;
const USERNAME = /^[A-Za-z0-9._]{1,30}$/;

export class MetaAccountDiscovery implements AccountDiscoveryPort {
  readonly platform = 'FACEBOOK' as const;
  readonly adapterVersion = META_ADAPTER_VERSION;

  constructor(
    private readonly options: MetaGraphOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private client(context: DiscoveryContext): MetaGraphClient {
    return new MetaGraphClient(context.accessToken, this.options);
  }

  async discoverCapabilities(context: DiscoveryContext): Promise<DiscoveredCapabilities> {
    if (context.grantedScopes) {
      return {
        grantedScopes: [...context.grantedScopes],
        capabilityVersion: META_ADAPTER_VERSION,
        notes: [],
      };
    }
    const body = await this.client(context).get<unknown>('me/permissions');
    const parsed = permissionsSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new MetaApiError(
        'UNKNOWN',
        null,
        null,
        null,
        'Meta returned an unexpected permissions response',
      );
    }
    const byStatus = (status: string) =>
      [
        ...new Set(parsed.data.data.filter((p) => p.status === status).map((p) => p.permission)),
      ].sort();
    const declined = byStatus('declined');
    return {
      grantedScopes: byStatus('granted'),
      capabilityVersion: META_ADAPTER_VERSION,
      notes: declined.length
        ? [
            `Declined in the Meta dialog: ${declined.join(', ')}. Reconnect and allow them to use what they unlock.`,
          ]
        : [],
    };
  }

  async discoverIdentity(context: DiscoveryContext): Promise<DiscoveredIdentity> {
    const body = await this.client(context).get<unknown>('me', { fields: 'id,name' });
    const parsed = meSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new MetaApiError('UNKNOWN', null, null, null, 'Meta did not return a usable user id');
    }
    const name = parsed.data.name?.trim() ?? '';
    return {
      externalId: parsed.data.id,
      displayName: name || 'Facebook user',
      kind: 'PROFILE',
      metadata: { nameReported: name.length > 0, personalProfile: true },
      capabilities: facebookProfileCapabilities(this.now()),
    };
  }

  async discoverDestinations(context: DiscoveryContext): Promise<DiscoveredDestination[]> {
    const scopes = context.grantedScopes;
    // No Page access granted: nothing is looked up and nothing is invented.
    if (scopes && !scopes.includes(META_SCOPES.pagesList)) return [];
    const withInstagram = scopes === null || scopes.includes(META_SCOPES.instagramBasic);

    let pages: Page[];
    try {
      pages = await this.listPages(context, withInstagram);
    } catch (error) {
      // Permissions unknown and Meta refused the Instagram fields: list Pages alone.
      if (!(
        withInstagram &&
        scopes === null &&
        error instanceof MetaApiError &&
        error.kind === 'PERMISSION'
      )) {
        throw error;
      }
      pages = await this.listPages(context, false);
    }

    const checkedAt = this.now();
    const destinations: DiscoveredDestination[] = [];
    const instagram = new Map<string, DiscoveredDestination>();
    for (const page of pages) {
      const name = page.name?.trim() ?? '';
      const hasToken = Boolean(page.access_token);
      const business = page.instagram_business_account;
      const connected = page.connected_instagram_account;
      destinations.push({
        externalId: page.id,
        displayName: name || `Facebook Page ${page.id}`,
        kind: 'PAGE',
        // Null clears a token stored before the role was lost.
        accessToken: page.access_token ?? null,
        metadata: {
          nameReported: name.length > 0,
          pageTokenIssued: hasToken,
          instagramLinked: Boolean(business ?? connected),
          ...(page.category ? { category: page.category } : {}),
          ...(page.tasks ? { tasks: [...page.tasks].sort().join(',') } : {}),
        },
        capabilities: facebookPageCapabilities({
          grantedScopes: scopes,
          tasks: page.tasks ?? null,
          hasToken,
          checkedAt,
        }),
      });

      const linked: Array<{ account: z.infer<typeof instagramSchema>; eligible: boolean }> = [];
      if (business) linked.push({ account: business, eligible: true });
      if (connected && connected.id !== business?.id)
        linked.push({ account: connected, eligible: false });
      for (const { account, eligible } of linked) {
        // An eligible link wins over an ineligible sighting of the same account.
        if (instagram.get(account.id)?.kind === 'BUSINESS_ACCOUNT') continue;
        const username =
          account.username && USERNAME.test(account.username) ? account.username : null;
        instagram.set(account.id, {
          externalId: account.id,
          displayName: username
            ? `@${username}`
            : account.name?.trim() || `Instagram account ${account.id}`,
          // Only an eligible professional account is a business account here;
          // anything else is a profile Spectra cannot publish to.
          kind: eligible ? 'BUSINESS_ACCOUNT' : 'PROFILE',
          platform: 'INSTAGRAM',
          // Instagram publishing through Facebook Login uses the Page's token.
          accessToken: eligible ? (page.access_token ?? null) : null,
          metadata: {
            eligible,
            linkedVia: eligible ? 'instagram_business_account' : 'connected_instagram_account',
            linkedPageId: page.id,
            ...(name ? { linkedPageName: name } : {}),
            ...(username ? { username } : {}),
          },
          capabilities: instagramCapabilities({
            grantedScopes: scopes,
            eligible,
            hasToken,
            checkedAt,
          }),
        });
      }
    }
    return [...destinations, ...instagram.values()];
  }

  private async listPages(context: DiscoveryContext, withInstagram: boolean): Promise<Page[]> {
    const client = this.client(context);
    const fields = [
      'id',
      'name',
      'access_token',
      'tasks',
      'category',
      ...(withInstagram
        ? [
            'instagram_business_account{id,username,name}',
            'connected_instagram_account{id,username}',
          ]
        : []),
    ].join(',');
    const pages: Page[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await client.get<unknown>('me/accounts', {
        fields,
        limit: String(PAGE_LIMIT),
        ...(after ? { after } : {}),
      });
      const parsed = accountsSchema.safeParse(body ?? {});
      if (!parsed.success) {
        throw new MetaApiError(
          'UNKNOWN',
          null,
          null,
          null,
          'Meta returned an unexpected Pages response',
        );
      }
      for (const raw of parsed.data.data) {
        const one = pageSchema.safeParse(raw);
        if (one.success) pages.push(one.data);
      }
      after = parsed.data.paging?.cursors?.after;
      if (!parsed.data.paging?.next || !after) break;
    }
    return pages;
  }
}
