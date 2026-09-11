import { AccountDiscoveryRegistry, SocialPublisherRegistry } from '@spectra/social-core';
import { describe, expect, it } from 'vitest';

import { LinkedInApiError } from './client';
import { LinkedInAccountDiscovery } from './discovery';
import { registerLinkedInAdapter } from './register';

type Route = (url: URL) => Response;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function linkedIn(routes: Record<string, Route>) {
  const calls: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    const route = routes[url.pathname];
    return route ? route(url) : json(404, {});
  }) as typeof fetch;
  const discovery = new LinkedInAccountDiscovery(
    { apiBaseUrl: 'https://api.linkedin.com', version: '202608', fetchImpl },
    () => new Date('2026-09-11T10:00:00.000Z'),
  );
  return { discovery, calls };
}

const MEMBER_SCOPES = ['openid', 'profile', 'w_member_social'];
const PAGE_SCOPES = [...MEMBER_SCOPES, 'r_organization_admin', 'w_organization_social'];
const context = (grantedScopes: string[] | null) => ({ accessToken: 'token', grantedScopes });

describe('LinkedIn identity discovery', () => {
  it('turns the OpenID Connect subject into the member URN, and keeps no email', async () => {
    const { discovery } = linkedIn({
      '/v2/userinfo': () =>
        json(200, {
          sub: '782bbtaQ',
          name: 'Jane Doe',
          email: 'jane@example.com',
          email_verified: true,
        }),
    });
    const identity = await discovery.discoverIdentity(context(MEMBER_SCOPES));
    expect(identity.externalId).toBe('urn:li:person:782bbtaQ');
    expect(identity.displayName).toBe('Jane Doe');
    expect(identity.kind).toBe('PROFILE');
    expect(identity.capabilities?.postTypes.TEXT.status).toBe('AVAILABLE');
    expect(JSON.stringify(identity)).not.toContain('jane@example.com');
  });

  it('builds the name from given and family names when there is no full name', async () => {
    const { discovery } = linkedIn({
      '/v2/userinfo': () => json(200, { sub: 'abc', given_name: 'Jane', family_name: 'Doe' }),
    });
    expect((await discovery.discoverIdentity(context(MEMBER_SCOPES))).displayName).toBe('Jane Doe');
  });

  it('does not call LinkedIn when the grant lacks openid/profile', async () => {
    const { discovery, calls } = linkedIn({});
    await expect(discovery.discoverIdentity(context(['w_member_social']))).rejects.toMatchObject({
      kind: 'PERMISSION',
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses a subject it cannot turn into a URN', async () => {
    const { discovery } = linkedIn({ '/v2/userinfo': () => json(200, { sub: 'a:b' }) });
    await expect(discovery.discoverIdentity(context(MEMBER_SCOPES))).rejects.toBeInstanceOf(
      LinkedInApiError,
    );
  });
});

describe('LinkedIn page discovery', () => {
  it('looks nothing up without page access — and invents nothing', async () => {
    const { discovery, calls } = linkedIn({});
    expect(await discovery.discoverDestinations(context(MEMBER_SCOPES))).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('keeps only APPROVED roles that can post organically, whichever field LinkedIn uses', async () => {
    const { discovery, calls } = linkedIn({
      '/rest/organizationAcls': () =>
        json(200, {
          elements: [
            { role: 'ADMINISTRATOR', state: 'APPROVED', organization: 'urn:li:organization:1' },
            {
              role: 'CONTENT_ADMINISTRATOR',
              state: 'APPROVED',
              organizationTarget: 'urn:li:organization:2',
            },
            { role: 'ANALYST', state: 'APPROVED', organization: 'urn:li:organization:3' },
            {
              role: 'DIRECT_SPONSORED_CONTENT_POSTER',
              state: 'APPROVED',
              organization: 'urn:li:organization:4',
            },
            { role: 'ADMINISTRATOR', state: 'REQUESTED', organization: 'urn:li:organization:5' },
          ],
        }),
      '/rest/organizationsLookup': () =>
        json(200, { results: { '1': { localizedName: 'Acme Corp', vanityName: 'acme' } } }),
    });
    const pages = await discovery.discoverDestinations(context(PAGE_SCOPES));
    expect(pages.map((p) => p.externalId)).toEqual([
      'urn:li:organization:1',
      'urn:li:organization:2',
    ]);
    expect(pages[0]).toMatchObject({ displayName: 'Acme Corp', kind: 'PAGE' });
    expect(pages[0]?.metadata).toMatchObject({ vanityName: 'acme', nameReported: true });
    // A name LinkedIn would not return is labelled by id, not guessed.
    expect(pages[1]).toMatchObject({ displayName: 'LinkedIn page 2' });
    expect(pages[1]?.metadata).toMatchObject({ nameReported: false });
    expect(pages[0]?.capabilities?.postTypes.TEXT.status).toBe('AVAILABLE');

    const acl = calls.find((c) => c.pathname === '/rest/organizationAcls');
    expect(acl?.search).toContain('q=roleAssignee&state=APPROVED');
    const lookup = calls.find((c) => c.pathname === '/rest/organizationsLookup');
    expect(decodeURIComponent(lookup?.search ?? '')).toBe('?ids=List(1,2)');
  });

  it('pages through the access list', async () => {
    const analysts = Array.from({ length: 100 }, (_, i) => ({
      role: 'ANALYST',
      state: 'APPROVED',
      organization: `urn:li:organization:${1000 + i}`,
    }));
    const { discovery, calls } = linkedIn({
      '/rest/organizationAcls': (url) =>
        json(200, { elements: url.searchParams.get('start') === '0' ? analysts : [] }),
    });
    expect(await discovery.discoverDestinations(context(PAGE_SCOPES))).toEqual([]);
    expect(calls.filter((c) => c.pathname === '/rest/organizationAcls')).toHaveLength(2);
  });

  it('treats a refusal as "no page access" only when scopes were not reported', async () => {
    const refused = { '/rest/organizationAcls': () => json(403, { code: 'ACCESS_DENIED' }) };
    expect(await linkedIn(refused).discovery.discoverDestinations(context(null))).toEqual([]);
    await expect(
      linkedIn(refused).discovery.discoverDestinations(context(PAGE_SCOPES)),
    ).rejects.toMatchObject({ kind: 'PERMISSION' });
  });

  it('fails loudly on a response shape it does not understand', async () => {
    const { discovery } = linkedIn({
      '/rest/organizationAcls': () => json(200, { elements: 'nope' }),
    });
    await expect(discovery.discoverDestinations(context(PAGE_SCOPES))).rejects.toMatchObject({
      kind: 'UNKNOWN',
    });
  });
});

describe('registerLinkedInAdapter', () => {
  it('marks LinkedIn publishing wired with a summary of exactly what it posts, and registers discovery', () => {
    const publishers = new SocialPublisherRegistry();
    const discovery = new AccountDiscoveryRegistry();
    registerLinkedInAdapter(
      { publishers, discovery },
      { apiBaseUrl: 'https://api.linkedin.com', version: '202608' },
    );
    expect(publishers.isWired('LINKEDIN')).toBe(true);
    expect(publishers.summary('LINKEDIN')).toMatch(/Video, document, multi-image/);
    expect(discovery.isWired('LINKEDIN')).toBe(true);
  });
});
