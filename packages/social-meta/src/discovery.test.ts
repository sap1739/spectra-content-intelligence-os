import { describe, expect, it } from 'vitest';

import { MetaAccountDiscovery } from './discovery';

const USER_TOKEN = 'EAAB-user-TOKENVALUE';
const PAGE_A_TOKEN = 'EAAB-pageA-TOKENVALUE';
const PAGE_A = '1111';
const PAGE_B = '2222';
const IG_A = '17841400000000001';
const IG_B = '17841400000000002';
const ALL = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish',
];
const NOW = new Date('2026-09-11T12:00:00Z');

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const pageA = {
  id: PAGE_A,
  name: 'Acme',
  access_token: PAGE_A_TOKEN,
  tasks: ['ANALYZE', 'ADVERTISE', 'MODERATE', 'CREATE_CONTENT', 'MANAGE'],
  category: 'Brand',
  instagram_business_account: { id: IG_A, username: 'acme', name: 'Acme' },
};
// No role that yields a token, and an Instagram account linked only through Page settings.
const pageB = {
  id: PAGE_B,
  name: 'Side project',
  tasks: ['ANALYZE'],
  connected_instagram_account: { id: IG_B, username: 'jane.personal' },
};

function graph() {
  const calls: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    const path = url.pathname.replace('/v26.0/', '');
    if (path === 'me/permissions') {
      return json(200, {
        data: [
          { permission: 'pages_show_list', status: 'granted' },
          { permission: 'pages_manage_posts', status: 'granted' },
          { permission: 'instagram_content_publish', status: 'declined' },
          { permission: 'public_profile', status: 'granted' },
        ],
      });
    }
    if (path === 'me') return json(200, { id: '9001', name: 'Jane Doe' });
    if (path === 'me/accounts') {
      return url.searchParams.get('after')
        ? json(200, { data: [pageB], paging: { cursors: { before: 'c', after: 'end' } } })
        : json(200, {
            data: [pageA],
            paging: {
              cursors: { before: 'b', after: 'cursor-2' },
              next: 'https://graph.facebook.com/v26.0/me/accounts?after=cursor-2',
            },
          });
    }
    return json(404, { error: { code: 803, message: 'Unknown path' } });
  }) as typeof fetch;
  return {
    calls,
    discovery: new MetaAccountDiscovery(
      {
        apiBaseUrl: 'https://graph.facebook.com',
        version: 'v26.0',
        appSecret: 'secret',
        fetchImpl,
      },
      () => NOW,
    ),
  };
}

describe('MetaAccountDiscovery', () => {
  it('reads the grant from /me/permissions, since Meta token responses report none', async () => {
    const { discovery } = graph();
    const reported = await discovery.discoverCapabilities({
      accessToken: USER_TOKEN,
      grantedScopes: null,
    });
    expect(reported.grantedScopes).toEqual([
      'pages_manage_posts',
      'pages_show_list',
      'public_profile',
    ]);
    expect(reported.notes.join(' ')).toContain('instagram_content_publish');
  });

  it('records the authorizing user as a personal profile nothing can be published to', async () => {
    const { discovery } = graph();
    const identity = await discovery.discoverIdentity({
      accessToken: USER_TOKEN,
      grantedScopes: ALL,
    });
    expect(identity).toMatchObject({
      externalId: '9001',
      displayName: 'Jane Doe',
      kind: 'PROFILE',
    });
    expect(identity.capabilities?.postTypes.TEXT.status).toBe('NOT_SUPPORTED');
  });

  it('finds Pages with their own tokens, and the Instagram accounts linked to them — eligible or not', async () => {
    const { discovery, calls } = graph();
    const found = await discovery.discoverDestinations({
      accessToken: USER_TOKEN,
      grantedScopes: ALL,
    });
    const byId = Object.fromEntries(found.map((d) => [d.externalId, d]));

    expect(byId[PAGE_A]).toMatchObject({
      kind: 'PAGE',
      displayName: 'Acme',
      accessToken: PAGE_A_TOKEN,
    });
    expect(byId[PAGE_A]?.capabilities?.postTypes.TEXT.status).toBe('AVAILABLE');
    expect(byId[PAGE_B]).toMatchObject({ kind: 'PAGE', accessToken: null });
    expect(byId[PAGE_B]?.capabilities?.postTypes.TEXT.status).toBe('MISSING_PERMISSION');

    expect(byId[IG_A]).toMatchObject({
      platform: 'INSTAGRAM',
      kind: 'BUSINESS_ACCOUNT',
      displayName: '@acme',
      accessToken: PAGE_A_TOKEN,
      metadata: { eligible: true, linkedPageId: PAGE_A },
    });
    expect(byId[IG_A]?.capabilities?.postTypes.IMAGE.status).toBe('AVAILABLE');
    expect(byId[IG_B]).toMatchObject({
      platform: 'INSTAGRAM',
      kind: 'PROFILE',
      accessToken: null,
      metadata: { eligible: false, linkedVia: 'connected_instagram_account' },
    });
    expect(byId[IG_B]?.capabilities?.postTypes.IMAGE.status).toBe('NOT_SUPPORTED');

    // Followed the cursor to the second page of results.
    const listings = calls.filter((c) => c.pathname.endsWith('/me/accounts'));
    expect(listings.map((c) => c.searchParams.get('after'))).toEqual([null, 'cursor-2']);
    // Tokens travel in accessToken only — never in metadata.
    expect(JSON.stringify(found.map((d) => d.metadata))).not.toContain('TOKENVALUE');
    expect(listings[0]?.searchParams.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('looks nothing up without pages_show_list', async () => {
    const { discovery, calls } = graph();
    expect(
      await discovery.discoverDestinations({
        accessToken: USER_TOKEN,
        grantedScopes: ['public_profile'],
      }),
    ).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('does not ask for Instagram fields without instagram_basic', async () => {
    const { discovery, calls } = graph();
    await discovery.discoverDestinations({
      accessToken: USER_TOKEN,
      grantedScopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
    });
    expect(calls[0]?.searchParams.get('fields')).not.toContain('instagram');
  });
});
