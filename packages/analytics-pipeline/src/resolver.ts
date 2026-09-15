import { unimplementedAnalyticsCapability, type AnalyticsProvider } from '@spectra/analytics-core';
import type {
  AnalyticsAvailability,
  AnalyticsErrorCode,
  AnalyticsProviderCapability,
  SocialPlatform,
} from '@spectra/contracts';
import {
  openConnection,
  type ConnectionDeps,
  type PublisherUnavailable,
} from '@spectra/publishing';
import { decryptSecret } from '@spectra/security';
import {
  LinkedInAnalyticsProvider,
  describeLinkedInAnalytics,
  type LinkedInApiOptions,
} from '@spectra/social-linkedin';
import {
  MetaAnalyticsProvider,
  describeMetaAnalytics,
  type MetaGraphOptions,
} from '@spectra/social-meta';
import type { ResolvedOAuthConfig } from '@spectra/social-oauth';
import {
  WordPressAnalyticsProvider,
  describeWordPressAnalytics,
  parseWordPressCredential,
} from '@spectra/social-wordpress';
import {
  CHANNEL_ID,
  YouTubeAnalyticsProvider,
  describeYouTubeAnalytics,
  type YouTubeApiOptions,
} from '@spectra/social-youtube';

/**
 * Analytics provider resolution (ADR-0039), shared by the worker and the
 * integration tests — the same honest-resolution pattern as publishing.
 *
 * An account resolves to a live provider built from its own opened token, or
 * to an AnalyticsUnavailable saying exactly why not (not connected, reconnect
 * needed, not implemented, unsupported). Decrypted secrets never leave this
 * module and are never logged.
 */

/** Platforms with a real analytics adapter in this codebase. */
export const ANALYTICS_ADAPTER_PLATFORMS: ReadonlySet<SocialPlatform> = new Set([
  'WORDPRESS',
  'YOUTUBE',
  'LINKEDIN',
  'FACEBOOK',
  'INSTAGRAM',
]);

export function hasAnalyticsAdapter(platform: SocialPlatform): boolean {
  return ANALYTICS_ADAPTER_PLATFORMS.has(platform);
}

export interface AnalyticsTargetAccount {
  id: string;
  organizationId: string;
  workspaceId: string;
  platform: SocialPlatform;
  kind: string;
  externalAccountId: string;
  displayName: string;
  encryptedToken: string | null;
  connectionId: string | null;
}

export interface AnalyticsUnavailable {
  unavailable: true;
  availability: AnalyticsAvailability;
  errorCode: AnalyticsErrorCode;
  reason: string;
}

export type ResolveAnalyticsProvider = (
  account: AnalyticsTargetAccount,
) => Promise<AnalyticsProvider | AnalyticsUnavailable>;

export interface AnalyticsResolverDeps extends ConnectionDeps {
  youtube?: {
    api: YouTubeApiOptions;
    oauth: ResolvedOAuthConfig | null;
    analyticsApiBaseUrl?: string;
  };
  linkedin?: { api: LinkedInApiOptions; oauth: ResolvedOAuthConfig | null };
  meta?: { api: MetaGraphOptions };
  wordpress?: { fetch?: typeof fetch };
}

const NOTHING_FETCHED = 'No analytics were fetched.';

export function isAnalyticsUnavailable(
  value: AnalyticsProvider | AnalyticsUnavailable,
): value is AnalyticsUnavailable {
  return (value as AnalyticsUnavailable).unavailable === true;
}

function unavailable(
  availability: AnalyticsAvailability,
  errorCode: AnalyticsErrorCode,
  reason: string,
): AnalyticsUnavailable {
  return { unavailable: true, availability, errorCode, reason };
}

/** A connection that cannot be opened, in analytics terms. */
function fromPublisherUnavailable(value: PublisherUnavailable): AnalyticsUnavailable {
  switch (value.failureCode) {
    case 'REAUTH_REQUIRED':
      return unavailable('REAUTH_REQUIRED', 'REAUTH_REQUIRED', value.reason);
    case 'PERMISSION':
      return unavailable('MISSING_SCOPE', 'MISSING_SCOPE', value.reason);
    case 'UNSUPPORTED_ACCOUNT':
      return unavailable('UNSUPPORTED', 'UNSUPPORTED', value.reason);
    case 'TRANSIENT':
      return unavailable('AVAILABLE', 'TRANSIENT', value.reason);
    default:
      return unavailable('NOT_CONNECTED', 'NOT_CONNECTED', value.reason);
  }
}

async function markReconnect(
  deps: AnalyticsResolverDeps,
  account: AnalyticsTargetAccount,
  connectionId: string,
): Promise<void> {
  await deps.prisma.socialConnection.updateMany({
    where: { id: connectionId, organizationId: account.organizationId },
    data: { status: 'REAUTH_REQUIRED', lastErrorCode: 'analytics_unauthorized' },
  });
}

export function createAnalyticsProviderResolver(
  deps: AnalyticsResolverDeps,
): ResolveAnalyticsProvider {
  return async (account) => {
    const publishAccount = { ...account, discoveryMetadata: null };
    switch (account.platform) {
      case 'WORDPRESS':
        return resolveWordPress(deps, account);
      case 'YOUTUBE': {
        if (!deps.youtube) return notConfigured('YouTube');
        const opened = await openConnection(deps, publishAccount, {
          platform: 'YOUTUBE',
          name: 'YouTube',
          kind: 'CHANNEL',
          scopes: [],
          oauth: deps.youtube.oauth,
          noRefreshToken:
            'Google issued no refresh token for it (an app in "Testing" also has refresh tokens expire after 7 days).',
          missingOAuthEnv: 'SOCIAL_OAUTH_YOUTUBE_CLIENT_ID/SECRET',
          wrongKind: 'YouTube analytics are read for channels.',
          idPattern: CHANNEL_ID,
          consequence: NOTHING_FETCHED,
          purpose: 'Reading analytics from',
        });
        if ('unavailable' in opened) return fromPublisherUnavailable(opened);
        return new YouTubeAnalyticsProvider({
          ...deps.youtube.api,
          ...(deps.youtube.analyticsApiBaseUrl
            ? { analyticsApiBaseUrl: deps.youtube.analyticsApiBaseUrl }
            : {}),
          accessToken: opened.accessToken,
          channelId: account.externalAccountId,
          grantedScopes: opened.grantedScopes,
          ...(deps.now ? { now: deps.now } : {}),
          onAuthRejected: () => markReconnect(deps, account, opened.connectionId),
        });
      }
      case 'LINKEDIN': {
        if (!deps.linkedin) return notConfigured('LinkedIn');
        if (account.kind !== 'PROFILE' && account.kind !== 'PAGE') {
          return unavailable(
            'UNSUPPORTED',
            'UNSUPPORTED',
            `LinkedIn analytics are read for members and pages. ${NOTHING_FETCHED}`,
          );
        }
        const opened = await openConnection(deps, publishAccount, {
          platform: 'LINKEDIN',
          name: 'LinkedIn',
          kind: account.kind,
          scopes: [],
          oauth: deps.linkedin.oauth,
          noRefreshToken:
            'LinkedIn issued no refresh token (it does so only for approved partners).',
          missingOAuthEnv: 'SOCIAL_OAUTH_LINKEDIN_CLIENT_ID/SECRET',
          wrongKind: 'LinkedIn analytics are read for members and pages.',
          idPattern: /^urn:li:(person|organization):[A-Za-z0-9_-]{1,64}$/,
          consequence: NOTHING_FETCHED,
          purpose: 'Reading analytics from',
        });
        if ('unavailable' in opened) return fromPublisherUnavailable(opened);
        return new LinkedInAnalyticsProvider({
          ...deps.linkedin.api,
          accessToken: opened.accessToken,
          authorUrn: account.externalAccountId,
          kind: account.kind,
          grantedScopes: opened.grantedScopes,
          ...(deps.now ? { now: deps.now } : {}),
          onAuthRejected: () => markReconnect(deps, account, opened.connectionId),
        });
      }
      case 'FACEBOOK':
      case 'INSTAGRAM':
        return deps.meta ? resolveMeta(deps, deps.meta, account) : notConfigured('Meta');
      default: {
        const capability = unimplementedAnalyticsCapability(account.platform);
        return unavailable(
          capability?.availability ?? 'NOT_IMPLEMENTED',
          'UNSUPPORTED',
          `${capability?.summary ?? `No ${account.platform} analytics adapter exists.`} ${NOTHING_FETCHED}`,
        );
      }
    }
  };
}

function notConfigured(name: string): AnalyticsUnavailable {
  return unavailable(
    'UNCONFIGURED',
    'UNCONFIGURED',
    `${name} analytics are not configured on this worker. ${NOTHING_FETCHED}`,
  );
}

function resolveWordPress(
  deps: AnalyticsResolverDeps,
  account: AnalyticsTargetAccount,
): AnalyticsProvider | AnalyticsUnavailable {
  if (!account.encryptedToken) {
    return unavailable(
      'NOT_CONNECTED',
      'NOT_CONNECTED',
      `No application password is stored for this WordPress site. ${NOTHING_FETCHED}`,
    );
  }
  if (!deps.ring) {
    return unavailable(
      'UNCONFIGURED',
      'UNCONFIGURED',
      `Credential storage is not configured on the worker (SOCIAL_TOKEN_ENCRYPTION_KEY), so the WordPress credential cannot be read. ${NOTHING_FETCHED}`,
    );
  }
  try {
    const credential = parseWordPressCredential(
      account.externalAccountId,
      decryptSecret(account.encryptedToken, deps.ring),
    );
    return new WordPressAnalyticsProvider({
      ...credential,
      ...(deps.wordpress?.fetch ? { fetch: deps.wordpress.fetch } : {}),
    });
  } catch {
    return unavailable(
      'REAUTH_REQUIRED',
      'REAUTH_REQUIRED',
      `The stored WordPress credential could not be read. Store the application password again. ${NOTHING_FETCHED}`,
    );
  }
}

const GRAPH_ID = /^\d{1,30}$/;

/** Facebook Pages and Instagram read with the Page token sealed on the account (as publishing does). */
async function resolveMeta(
  deps: AnalyticsResolverDeps,
  meta: NonNullable<AnalyticsResolverDeps['meta']>,
  account: AnalyticsTargetAccount,
): Promise<AnalyticsProvider | AnalyticsUnavailable> {
  const platform = account.platform as 'FACEBOOK' | 'INSTAGRAM';
  const name = platform === 'FACEBOOK' ? 'Facebook' : 'Instagram';
  if (!account.connectionId || !GRAPH_ID.test(account.externalAccountId)) {
    return unavailable(
      'NOT_CONNECTED',
      'NOT_CONNECTED',
      `This ${name} target was registered by hand, not found through a Meta connection. Connect Meta (Facebook) on Social Accounts. ${NOTHING_FETCHED}`,
    );
  }
  const expectedKind = platform === 'FACEBOOK' ? 'PAGE' : 'BUSINESS_ACCOUNT';
  if (account.kind !== expectedKind) {
    return unavailable(
      'UNSUPPORTED',
      'UNSUPPORTED',
      platform === 'FACEBOOK'
        ? `Facebook insights are read for Pages, not personal profiles. ${NOTHING_FETCHED}`
        : `Instagram insights are available only for professional (Business or Creator) accounts. ${NOTHING_FETCHED}`,
    );
  }
  const ring = deps.ring;
  if (!ring) {
    return unavailable(
      'UNCONFIGURED',
      'UNCONFIGURED',
      `Credential storage is not configured on the worker (SOCIAL_TOKEN_ENCRYPTION_KEY), so the ${name} token cannot be read. ${NOTHING_FETCHED}`,
    );
  }
  const connection = await deps.prisma.socialConnection.findFirst({
    where: {
      id: account.connectionId,
      organizationId: account.organizationId,
      workspaceId: account.workspaceId,
      platform: 'FACEBOOK',
    },
    select: {
      id: true,
      status: true,
      disconnectedAt: true,
      grantedScopes: true,
      grantedScopesReported: true,
    },
  });
  if (!connection || connection.disconnectedAt) {
    return unavailable(
      'NOT_CONNECTED',
      'NOT_CONNECTED',
      `The Meta connection behind this ${name} account was disconnected. ${NOTHING_FETCHED}`,
    );
  }
  if (connection.status === 'REAUTH_REQUIRED' || connection.status === 'REVOKED') {
    return unavailable(
      'REAUTH_REQUIRED',
      'REAUTH_REQUIRED',
      `Meta needs to be reconnected. ${NOTHING_FETCHED}`,
    );
  }
  if (!account.encryptedToken) {
    return unavailable(
      'MISSING_SCOPE',
      'MISSING_SCOPE',
      `Facebook issued no Page access token for this ${name} account, so its insights cannot be read. ${NOTHING_FETCHED}`,
    );
  }
  let pageToken: string;
  try {
    pageToken = decryptSecret(account.encryptedToken, ring);
  } catch {
    return unavailable(
      'REAUTH_REQUIRED',
      'REAUTH_REQUIRED',
      `The stored Page token could not be decrypted with the configured keys. Reconnect Meta. ${NOTHING_FETCHED}`,
    );
  }
  return new MetaAnalyticsProvider({
    ...meta.api,
    platform,
    accessToken: pageToken,
    accountId: account.externalAccountId,
    grantedScopes: connection.grantedScopesReported ? connection.grantedScopes : null,
    ...(deps.now ? { now: deps.now } : {}),
    onAuthRejected: () => markReconnect(deps, account, connection.id),
  });
}

// ---------------------------------------------------------------------------
// Static capability (no token)
// ---------------------------------------------------------------------------

/**
 * What analytics a platform offers, from its grant and account kind alone —
 * for listing and availability, where no token is opened.
 */
export function describeAnalyticsCapability(input: {
  platform: SocialPlatform;
  kind?: string | null;
  grantedScopes: readonly string[] | null;
  configured: boolean;
}): AnalyticsProviderCapability {
  switch (input.platform) {
    case 'WORDPRESS':
      return describeWordPressAnalytics();
    case 'YOUTUBE':
      return describeYouTubeAnalytics(input);
    case 'LINKEDIN':
      return describeLinkedInAnalytics({ ...input, kind: input.kind ?? 'PROFILE' });
    case 'FACEBOOK':
    case 'INSTAGRAM':
      return describeMetaAnalytics({ ...input, platform: input.platform });
    default:
      return unimplementedAnalyticsCapability(input.platform) as AnalyticsProviderCapability;
  }
}
