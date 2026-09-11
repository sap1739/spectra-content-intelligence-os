import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  AccountCapabilityBadges,
  LinkedInSetupGuide,
  MetaSetupGuide,
  PostTypeBadges,
} from '@/components/social/capabilities';
import { ConnectionsList } from '@/components/social/oauth-panels';
import {
  accountKindLabel,
  cannotPublishReason,
  capabilitiesOf,
  type AccountCapabilities,
  type SocialConnectionRow,
} from '@/lib/social';

/**
 * Per-account capabilities and missing-product warnings (Phase 6D, 6E). A
 * missing permission, an unimplemented feature, something the platform itself
 * does not allow, and an unconfirmed one must each read as what they are.
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

const PERSONAL_INSTAGRAM =
  'Instagram only allows publishing through its API to professional (Business or Creator) accounts linked to a Facebook Page.';

function notSupported(reason: string): AccountCapabilities {
  const caps = snapshot();
  for (const type of ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'] as const) {
    caps.postTypes[type] = { status: 'NOT_SUPPORTED', reason, requiredScopes: [] };
  }
  return caps;
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

  it('labels what the platform itself does not allow apart from what Spectra has not built', () => {
    const caps = snapshot();
    caps.postTypes.TEXT = {
      status: 'NOT_SUPPORTED',
      reason: 'Instagram posts need an image; Instagram has no text-only posts.',
      requiredScopes: [],
    };
    render(<PostTypeBadges capabilities={caps} />);
    expect(screen.getByText('Text — not supported by the platform')).toBeInTheDocument();
    expect(screen.getByText('Video — not implemented')).toBeInTheDocument();
    expect(screen.getByText(/no text-only posts/)).toBeInTheDocument();
  });

  it('shows one plain warning for an account the platform will not publish to at all', () => {
    render(<PostTypeBadges capabilities={notSupported(PERSONAL_INSTAGRAM)} />);
    expect(screen.getByRole('note')).toHaveTextContent('Cannot publish here.');
    expect(screen.getByRole('note')).toHaveTextContent('professional (Business or Creator)');
    expect(screen.queryByText(/not supported by the platform/)).not.toBeInTheDocument();
  });
});

describe('capabilitiesOf and cannotPublishReason', () => {
  it('accepts a snapshot and rejects anything else', () => {
    expect(capabilitiesOf(snapshot())).not.toBeNull();
    expect(capabilitiesOf({})).toBeNull();
    expect(capabilitiesOf(null)).toBeNull();
    expect(capabilitiesOf({ postTypes: { TEXT: { status: 'AVAILABLE' } } })).toBeNull();
  });

  it('gives a reason only when nothing at all can be published', () => {
    expect(cannotPublishReason(notSupported(PERSONAL_INSTAGRAM))).toBe(PERSONAL_INSTAGRAM);
    expect(cannotPublishReason(snapshot())).toBeNull();
    expect(cannotPublishReason({})).toBeNull();
  });
});

describe('accountKindLabel', () => {
  it('names Meta account types plainly', () => {
    expect(accountKindLabel('FACEBOOK', 'PAGE')).toBe('Facebook Page');
    expect(accountKindLabel('FACEBOOK', 'PROFILE')).toBe('personal profile');
    expect(accountKindLabel('INSTAGRAM', 'BUSINESS_ACCOUNT')).toBe(
      'Instagram professional account',
    );
    expect(accountKindLabel('INSTAGRAM', 'PROFILE')).toBe('Instagram account');
    expect(accountKindLabel('LINKEDIN', 'PAGE')).toBe('page');
    expect(accountKindLabel(undefined, 'PROFILE')).toBe('profile');
  });
});

const baseConnection = {
  status: 'CONNECTED',
  hasRefreshToken: false,
  accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
  accessTokenExpired: false,
  lastRefreshedAt: null,
  lastErrorCode: null,
  connectedAt: '2026-09-11T09:00:00.000Z',
} as const;

describe('ConnectionsList — LinkedIn', () => {
  const connection: SocialConnectionRow = {
    ...baseConnection,
    id: 'conn-li',
    platform: 'LINKEDIN',
    platformDisplayName: 'LinkedIn',
    label: 'Acme on LinkedIn',
    externalSubjectId: 'urn:li:person:782bbtaQ',
    requestedScopes: ['openid', 'profile', 'w_member_social'],
    grantedScopes: ['openid', 'profile', 'w_member_social'],
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

describe('ConnectionsList — Meta', () => {
  const connection: SocialConnectionRow = {
    ...baseConnection,
    id: 'conn-meta',
    platform: 'FACEBOOK',
    platformDisplayName: 'Meta — Facebook Pages & Instagram',
    label: 'Acme on Meta',
    externalSubjectId: '10001',
    requestedScopes: ['pages_show_list', 'pages_manage_posts', 'instagram_basic'],
    grantedScopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
    refresh: {
      available: false,
      reason: 'Meta issues no refresh tokens; Page tokens obtained with it do not expire.',
    },
    discovery: { status: 'COMPLETE', note: '3 account(s) discovered.' },
    publishing: { wired: true, note: 'Text posts and single-photo posts to Facebook Pages.' },
    tokenNote: 'Page tokens obtained with it do not expire.',
    permissions: [
      {
        id: 'instagram-publishing',
        name: 'Instagram API with Facebook Login — content publishing',
        scopes: ['instagram_basic', 'instagram_content_publish'],
        anyOf: false,
        reviewRequired: true,
        enables: 'Publishing to Instagram professional accounts linked to your Pages.',
        status: 'MISSING',
        missingScopes: ['instagram_basic', 'instagram_content_publish'],
      },
    ],
    accounts: [
      {
        id: 'page',
        platform: 'FACEBOOK',
        displayName: 'Acme Coffee',
        kind: 'PAGE',
        externalAccountId: '20001',
        status: 'CONNECTED',
        capabilities: snapshot(),
      },
      {
        id: 'ig-personal',
        platform: 'INSTAGRAM',
        displayName: '@jane.gardens',
        kind: 'PROFILE',
        externalAccountId: '17841400000000002',
        status: 'CONNECTED',
        capabilities: notSupported(PERSONAL_INSTAGRAM),
      },
    ],
  };

  it('tells Pages and Instagram accounts apart, and warns about an ineligible account and a missing permission', () => {
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
    expect(screen.getByText(/Facebook Page ·/)).toBeInTheDocument();
    expect(screen.getByText(/Instagram account ·/)).toBeInTheDocument();
    expect(screen.getByText(/Cannot publish here\./)).toBeInTheDocument();
    expect(
      screen.getByText('Missing Meta — Facebook Pages & Instagram products'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Needs instagram_basic, instagram_content_publish/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Page tokens obtained with it do not expire/)).toBeInTheDocument();
  });
});

describe('Setup guides', () => {
  it('LinkedIn: names the products to add and the redirect URL to register', () => {
    render(
      <LinkedInSetupGuide redirectUri="https://api.example.com/v1/social/oauth/linkedin/callback" />,
    );
    expect(screen.getByText('Share on LinkedIn')).toBeInTheDocument();
    expect(screen.getByText('Community Management API')).toBeInTheDocument();
    expect(
      screen.getByText('https://api.example.com/v1/social/oauth/linkedin/callback'),
    ).toBeInTheDocument();
  });

  it('Meta: names App Review, the permissions, the redirect URI and who can be published to', () => {
    render(
      <MetaSetupGuide redirectUri="https://api.example.com/v1/social/oauth/facebook/callback" />,
    );
    expect(screen.getByText('Advanced Access')).toBeInTheDocument();
    expect(screen.getByText(/instagram_content_publish/)).toBeInTheDocument();
    expect(
      screen.getByText('https://api.example.com/v1/social/oauth/facebook/callback'),
    ).toBeInTheDocument();
    expect(screen.getByText(/professional \(Business or Creator\)/)).toBeInTheDocument();
    expect(screen.getByText(/reachable from the internet/)).toBeInTheDocument();
  });
});
