import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  ConnectPlatforms,
  ConnectionsList,
  OAuthResultBanner,
} from '@/components/social/oauth-panels';
import { describeExpiry, oauthPlatformFrom, oauthResultFrom } from '@/lib/oauth-results';
import type { OAuthPlatformEntry, OAuthPlatformsResponse, SocialConnectionRow } from '@/lib/social';

/**
 * OAuth connection UI (Phase 6C). These cover the states a user must be able
 * to tell apart: not configured, storage off, approval needed, connected but
 * not publishable, and refresh unavailable.
 */

const LIMITATION =
  'Connecting stores an authorization only. No X publishing adapter is wired, so a post to X resolves to UNSUPPORTED and nothing is posted.';

function platform(overrides: Partial<OAuthPlatformEntry> = {}): OAuthPlatformEntry {
  return {
    platform: 'X',
    displayName: 'X',
    configured: true,
    missingConfiguration: [],
    redirectUri: 'https://api.example.com/v1/social/oauth/x/callback',
    scopes: ['tweet.write'],
    pkce: 'required',
    refresh: 'standard',
    approval: { required: true, notes: ['Posting depends on the paid API access tier.'] },
    docsUrl: 'https://docs.x.com',
    adapters: { publishing: false, discovery: false },
    canConnect: true,
    limitation: LIMITATION,
    ...overrides,
  };
}

function platforms(entries: OAuthPlatformEntry[], storage = true): OAuthPlatformsResponse {
  return {
    credentialStorageConfigured: storage,
    stateTtlSeconds: 600,
    definitionsRecordedAt: '2026-09-10',
    platforms: entries,
  };
}

function connection(overrides: Partial<SocialConnectionRow> = {}): SocialConnectionRow {
  return {
    id: 'conn-1',
    platform: 'X',
    platformDisplayName: 'X',
    status: 'CONNECTED',
    label: 'Acme on X',
    externalSubjectId: null,
    requestedScopes: ['tweet.write'],
    grantedScopes: ['tweet.read', 'tweet.write'],
    hasRefreshToken: true,
    accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
    accessTokenExpired: false,
    lastRefreshedAt: null,
    lastErrorCode: null,
    connectedAt: '2026-09-10T09:00:00.000Z',
    refresh: { available: true, reason: 'The access token can be refreshed.' },
    discovery: {
      status: 'NOT_AVAILABLE',
      note: 'No X account-discovery adapter is wired, so no profiles, pages or channels were looked up.',
    },
    publishing: { wired: false, note: 'No X publishing adapter is wired — nothing is posted.' },
    accounts: [],
    ...overrides,
  };
}

const noop = () => undefined;

describe('ConnectPlatforms', () => {
  it('names the missing settings for an unconfigured platform and cannot connect it', () => {
    render(
      <ConnectPlatforms
        data={platforms([
          platform({
            platform: 'FACEBOOK',
            displayName: 'Facebook Pages',
            configured: false,
            canConnect: false,
            missingConfiguration: [
              'SOCIAL_OAUTH_FACEBOOK_CLIENT_ID',
              'SOCIAL_OAUTH_FACEBOOK_CLIENT_SECRET',
            ],
          }),
        ])}
        canManage
        pendingPlatform={null}
        onConnect={noop}
        error={null}
      />,
    );
    expect(screen.getByText('SOCIAL_OAUTH_FACEBOOK_CLIENT_ID')).toBeInTheDocument();
    expect(screen.getByText('not configured')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Facebook Pages' })).toBeDisabled();
  });

  it('starts a flow for a configured platform', async () => {
    const onConnect = vi.fn();
    render(
      <ConnectPlatforms
        data={platforms([platform()])}
        canManage
        pendingPlatform={null}
        onConnect={onConnect}
        error={null}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Connect X' }));
    expect(onConnect).toHaveBeenCalledWith('X');
  });

  it('refuses to connect while credential storage is off, and says why', () => {
    render(
      <ConnectPlatforms
        data={platforms([platform({ canConnect: false })], false)}
        canManage
        pendingPlatform={null}
        onConnect={noop}
        error={null}
      />,
    );
    expect(screen.getByText('SOCIAL_TOKEN_ENCRYPTION_KEY')).toBeInTheDocument();
    expect(screen.getByText('storage off')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect X' })).toBeDisabled();
  });

  it('shows approval requirements and the publishing limitation', () => {
    render(
      <ConnectPlatforms
        data={platforms([platform()])}
        canManage
        pendingPlatform={null}
        onConnect={noop}
        error={null}
      />,
    );
    expect(screen.getByText('Platform approval required')).toBeInTheDocument();
    expect(screen.getByText('Posting depends on the paid API access tier.')).toBeInTheDocument();
    expect(screen.getByText(LIMITATION)).toBeInTheDocument();
  });

  it('offers no connect action without social:connect', () => {
    render(
      <ConnectPlatforms
        data={platforms([platform()])}
        canManage={false}
        pendingPlatform={null}
        onConnect={noop}
        error={null}
      />,
    );
    expect(screen.queryByRole('button', { name: /connect/i })).not.toBeInTheDocument();
  });
});

describe('ConnectionsList', () => {
  const handlers = { onRefresh: noop, onReconnect: noop, onDisconnect: noop };

  it('renders an honest empty state', () => {
    render(
      <ConnectionsList connections={[]} canManage busyId={null} feedback={null} {...handlers} />,
    );
    expect(screen.getByText('No platform connected yet.')).toBeInTheDocument();
  });

  it('separates "connected" from "can publish"', () => {
    render(
      <ConnectionsList
        connections={[connection()]}
        canManage
        busyId={null}
        feedback={null}
        {...handlers}
      />,
    );
    expect(screen.getByText('connected')).toBeInTheDocument();
    expect(screen.getByText(/No X publishing adapter is wired/)).toBeInTheDocument();
    expect(screen.getByText(/No X account-discovery adapter is wired/)).toBeInTheDocument();
    expect(screen.getByText('Access token expires on 2099-01-01')).toBeInTheDocument();
  });

  it('says so when the platform did not report granted scopes', () => {
    render(
      <ConnectionsList
        connections={[connection({ grantedScopes: null })]}
        canManage
        busyId={null}
        feedback={null}
        {...handlers}
      />,
    );
    expect(screen.getByText('not reported by the platform')).toBeInTheDocument();
  });

  it('hides refresh when it is unavailable and explains why', () => {
    render(
      <ConnectionsList
        connections={[
          connection({
            refresh: {
              available: false,
              reason:
                'LinkedIn did not issue a refresh token for this connection; reconnect to renew it.',
            },
          }),
        ]}
        canManage
        busyId={null}
        feedback={null}
        {...handlers}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Refresh token' })).not.toBeInTheDocument();
    expect(screen.getByText(/did not issue a refresh token/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('requires confirmation before disconnecting', async () => {
    const onDisconnect = vi.fn();
    render(
      <ConnectionsList
        connections={[connection()]}
        canManage
        busyId={null}
        feedback={null}
        onRefresh={noop}
        onReconnect={noop}
        onDisconnect={onDisconnect}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm disconnect' }));
    expect(onDisconnect).toHaveBeenCalledWith('conn-1');
  });

  it('shows no management actions without social:connect', () => {
    render(
      <ConnectionsList
        connections={[connection()]}
        canManage={false}
        busyId={null}
        feedback={null}
        {...handlers}
      />,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('OAuth callback results', () => {
  it('maps a known code to fixed copy', () => {
    const message = oauthResultFrom('connected');
    expect(message?.tone).toBe('success');
    if (!message) throw new Error('expected a message');
    render(<OAuthResultBanner message={message} platformName="X" />);
    expect(screen.getByRole('status')).toHaveTextContent('Connected — X');
  });

  it('renders failures as alerts', () => {
    const message = oauthResultFrom('state_expired');
    if (!message) throw new Error('expected a message');
    render(<OAuthResultBanner message={message} platformName={null} />);
    expect(screen.getByRole('alert')).toHaveTextContent('This connection link expired');
  });

  it('ignores anything that is not a known code or platform — nothing is reflected', () => {
    expect(oauthResultFrom('<img src=x onerror=alert(1)>')).toBeNull();
    expect(oauthResultFrom(null)).toBeNull();
    expect(oauthPlatformFrom('x')).toBe('X');
    expect(oauthPlatformFrom('myspace')).toBeNull();
    expect(oauthPlatformFrom('wordpress')).toBeNull();
  });

  it('describes token expiry without inventing one', () => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    expect(describeExpiry(null, now)).toBe('Token expiry not reported by the platform');
    expect(describeExpiry('2026-09-10T11:00:00.000Z', now)).toBe('Access token expired');
    expect(describeExpiry('2026-09-10T12:30:00.000Z', now)).toBe('Access token expires in 30 min');
    expect(describeExpiry('2026-09-10T14:00:00.000Z', now)).toBe('Access token expires in 2 h');
    expect(describeExpiry('2026-11-10T12:00:00.000Z', now)).toBe(
      'Access token expires on 2026-11-10',
    );
  });
});
