import type { DiscoveryContext } from '@spectra/social-core';
import { describe, expect, it } from 'vitest';

import { YouTubeAccountDiscovery } from './discovery';
import { YOUTUBE_SCOPES } from './constants';

/**
 * Channel discovery reads one documented endpoint and reports exactly what it
 * returned: no channel is invented, and a grant that cannot list channels
 * looks up nothing.
 */

const BASE = 'https://youtube.test';
const NOW = new Date('2026-09-12T10:00:00.000Z');

function fakeFetch(body: unknown, status = 200) {
  const calls: string[] = [];
  const impl: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl, calls };
}

const discovery = (impl: typeof fetch, projectAudited = true) =>
  new YouTubeAccountDiscovery({ apiBaseUrl: BASE, fetchImpl: impl, projectAudited }, () => NOW);

const context = (over: Partial<DiscoveryContext> = {}): DiscoveryContext => ({
  accessToken: 'ya29.token',
  grantedScopes: [YOUTUBE_SCOPES.upload, YOUTUBE_SCOPES.readonly],
  ...over,
});

const channel = (over: Record<string, unknown> = {}) => ({
  id: 'UC_x5XG1OV2P6uZZ5FSM9Ttw',
  snippet: { title: 'Acme Coffee', customUrl: '@acmecoffee' },
  status: { privacyStatus: 'public', longUploadsStatus: 'allowed', madeForKids: false },
  ...over,
});

describe('discoverDestinations', () => {
  it('asks channels.list for the channels this account owns', async () => {
    const { impl, calls } = fakeFetch({ items: [channel()] });
    const found = await discovery(impl).discoverDestinations(context());
    const url = new URL(calls[0] as string);
    expect(url.pathname).toBe('/youtube/v3/channels');
    expect(url.searchParams.get('mine')).toBe('true');
    expect(url.searchParams.get('part')).toBe('snippet,status');

    expect(found).toHaveLength(1);
    expect(found[0]?.externalId).toBe('UC_x5XG1OV2P6uZZ5FSM9Ttw');
    expect(found[0]?.displayName).toBe('Acme Coffee');
    expect(found[0]?.kind).toBe('CHANNEL');
    expect(found[0]?.metadata).toMatchObject({
      nameReported: true,
      customUrl: '@acmecoffee',
      longUploadsStatus: 'allowed',
    });
    expect(found[0]?.capabilities?.postTypes.VIDEO.status).toBe('AVAILABLE');
  });

  it('looks up nothing when the grant cannot read channels', async () => {
    const { impl, calls } = fakeFetch({ items: [channel()] });
    const found = await discovery(impl).discoverDestinations(
      context({ grantedScopes: [YOUTUBE_SCOPES.upload] }),
    );
    expect(found).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('labels a channel by its id when YouTube returned no title, and never guesses', async () => {
    const { impl } = fakeFetch({ items: [channel({ snippet: {} })] });
    const found = await discovery(impl).discoverDestinations(context());
    expect(found[0]?.displayName).toBe('YouTube channel UC_x5XG1OV2P6uZZ5FSM9Ttw');
    expect(found[0]?.metadata?.nameReported).toBe(false);
  });

  it('skips anything that is not a usable channel rather than storing it', async () => {
    const { impl } = fakeFetch({ items: [{ id: '' }, { nope: true }, channel()] });
    expect(await discovery(impl).discoverDestinations(context())).toHaveLength(1);
  });

  it('carries the long-uploads warning into the snapshot', async () => {
    const { impl } = fakeFetch({
      items: [channel({ status: { longUploadsStatus: 'disallowed' } })],
    });
    const found = await discovery(impl).discoverDestinations(context());
    expect(found[0]?.capabilities?.notes.some((n) => n.includes('15 minutes'))).toBe(true);
  });
});

describe('discoverIdentity', () => {
  it('is the channel that authorized', async () => {
    const { impl } = fakeFetch({ items: [channel()] });
    const identity = await discovery(impl).discoverIdentity(context());
    expect(identity.kind).toBe('CHANNEL');
    expect(identity.externalId).toBe('UC_x5XG1OV2P6uZZ5FSM9Ttw');
  });

  it('says plainly when the Google account has no channel', async () => {
    const { impl } = fakeFetch({ items: [] });
    await expect(discovery(impl).discoverIdentity(context())).rejects.toThrow(
      /no YouTube channel/i,
    );
  });
});

describe('discoverCapabilities', () => {
  it('reports the granted scopes and the limits worth knowing', async () => {
    const { impl } = fakeFetch({});
    const caps = await discovery(impl, false).discoverCapabilities(context());
    expect(caps.grantedScopes).toEqual([YOUTUBE_SCOPES.upload, YOUTUBE_SCOPES.readonly]);
    expect(caps.notes.some((note) => note.includes('daily quota'))).toBe(true);
    expect(caps.notes.some((note) => note.includes('restricted to private viewing mode'))).toBe(
      true,
    );
  });
});
