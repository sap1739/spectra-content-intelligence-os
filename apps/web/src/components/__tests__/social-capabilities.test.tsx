import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  AccountCapabilityBadges,
  LinkedInSetupGuide,
  PostTypeBadges,
} from '@/components/social/capabilities';
import { ConnectionsList } from '@/components/social/oauth-panels';
import { capabilitiesOf, type AccountCapabilities, type SocialConnectionRow } from '@/lib/social';

/**
 * Per-account capabilities and missing-product warnings (Phase 6D). A missing
 * permission, an unimplemented feature and an unconfirmed one must each read
 * as what they are.
 */

function snapshot(
  image: AccountCapabilities['postTypes']['IMAGE']['status'] = 'AVAILABLE',
): AccountCapabilities {
  return {
    adapterVersion: 'linkedin-posts-1.0.0',
    checkedAt: '2026-09-11T10:00:00.000Z',
    postTypes: {
      TEXT: {
        status: 'AVAILABLE',
        reason: 'Text posts are published.',
        requiredScopes: ['w_member_social'],
      },
      IMAGE: {
        status: image,
        reason: 'Needs w_organization_social (Community Management API).',
        requiredScopes: ['w_organization_social'],
      },
      VIDEO: {
        status: 'NOT_IMPLEMENTED',
        reason:
          "LinkedIn supports video posts; Spectra's LinkedIn adapter does not upload video yet.",
        requiredScopes: ['w_member_social'],
      },
      DOCUMENT: {
        status: 'NOT_IMPLEMENTED',
        reason: "Spectra's LinkedIn adapter does not upload documents yet.",
        requiredScopes: ['w_member_social'],
      },
    },
    limits: {
      maxCharacters: 3000,
      maxImages: 1,
      imageMimeTypes: ['image/jpeg', 'image/png', 'image/gif'],
    },
    notes: [],
  };
}

describe('PostTypeBadges', () => {
  it('labels each gap for what it is, and writes the reason out', () => {
    render(<PostTypeBadges capabilities={snapshot('MISSING_PERMISSION')} />);
    expect(screen.getByText('Text')).toBeInTheDocument();
    expect(screen.getByText('Image — permission missing')).toBeInTheDocument();
    expect(screen.getByText('Video — not implemented')).toBeInTheDocument();
    expect(screen.getByText(/Needs w_organization_social/)).toBeInTheDocument();
    expect(screen.getByText(/does not upload video yet/)).toBeInTheDocument();
  });

  it('can show the badges alone', () => {
    render(<PostTypeBadges capabilities={snapshot()} showReasons={false} />);
    expect(screen.queryByText(/does not upload video yet/)).not.toBeInTheDocument();
  });

  it('renders nothing for a manual target with no snapshot', () => {
    const { container } = render(<AccountCapabilityBadges value={{}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('capabilitiesOf', () => {
  it('accepts a snapshot and rejects anything else', () => {
    expect(capabilitiesOf(snapshot())).not.toBeNull();
    expect(capabilitiesOf({})).toBeNull();
    expect(capabilitiesOf(null)).toBeNull();
    expect(capabilitiesOf({ postTypes: { TEXT: { status: 'AVAILABLE' } } })).toBeNull();
  });
});

describe('ConnectionsList — LinkedIn', () => {
  const connection: SocialConnectionRow = {
    id: 'conn-li',
    platform: 'LINKEDIN',
    platformDisplayName: 'LinkedIn',
    status: 'CONNECTED',
    label: 'Acme on LinkedIn',
    externalSubjectId: 'urn:li:person:782bbtaQ',
    requestedScopes: ['openid', 'profile', 'w_member_social'],
    grantedScopes: ['openid', 'profile', 'w_member_social'],
    hasRefreshToken: false,
    accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
    accessTokenExpired: false,
    lastRefreshedAt: null,
    lastErrorCode: null,
    connectedAt: '2026-09-11T09:00:00.000Z',
    refresh: {
      available: false,
      reason: 'LinkedIn did not issue a refresh token for this connection.',
    },
    discovery: { status: 'COMPLETE', note: '1 account(s) discovered.' },
    publishing: { wired: true, note: 'Text posts and single-image posts.' },
    permissions: [
      {
        id: 'share-on-linkedin',
        name: 'Share on LinkedIn',
        scopes: ['w_member_social'],
        anyOf: false,
        reviewRequired: false,
        enables: 'Posting text and images as the member.',
        status: 'GRANTED',
        missingScopes: [],
      },
      {
        id: 'community-management-posting',
        name: 'Community Management API — page posting',
        scopes: ['w_organization_social'],
        anyOf: false,
        reviewRequired: true,
        enables: 'Posting text and images as those pages.',
        status: 'MISSING',
        missingScopes: ['w_organization_social'],
      },
    ],
    accounts: [
      {
        id: 'acct-1',
        displayName: 'Jane Doe',
        kind: 'PROFILE',
        externalAccountId: 'urn:li:person:782bbtaQ',
        status: 'CONNECTED',
        capabilities: snapshot(),
      },
    ],
  };

  it('names the missing products, says which need review, and how to fix it', () => {
    render(
      <ConnectionsList
        connections={[connection]}
        canManage
        busyId={null}
        feedback={null}
        onRefresh={() => undefined}
        onReconnect={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    expect(screen.getByText('Missing LinkedIn products')).toBeInTheDocument();
    expect(screen.getByText('Community Management API — page posting')).toBeInTheDocument();
    expect(screen.getByText(/reviewed by the platform/)).toBeInTheDocument();
    expect(screen.getByText(/Needs w_organization_social/)).toBeInTheDocument();
    expect(screen.getByText(/then reconnect/)).toBeInTheDocument();
    // Granted products are not listed as missing.
    expect(screen.queryByText('Share on LinkedIn')).not.toBeInTheDocument();
    // Each discovered account shows what it can publish.
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getAllByText('Video — not implemented').length).toBeGreaterThan(0);
  });
});

describe('LinkedInSetupGuide', () => {
  it('names the products to add and the redirect URL to register', () => {
    render(
      <LinkedInSetupGuide redirectUri="https://api.example.com/v1/social/oauth/linkedin/callback" />,
    );
    expect(screen.getByText('Share on LinkedIn')).toBeInTheDocument();
    expect(screen.getByText('Community Management API')).toBeInTheDocument();
    expect(
      screen.getByText('https://api.example.com/v1/social/oauth/linkedin/callback'),
    ).toBeInTheDocument();
  });
});
