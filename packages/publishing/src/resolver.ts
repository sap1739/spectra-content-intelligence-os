import type { SpectraPrismaClient } from '@spectra/database';
import type { Logger } from '@spectra/logging';
import { decryptSecret, type KeyRing } from '@spectra/security';
import {
  LinkedInPublisher,
  type LinkedInApiOptions,
  type MediaUploadLedger,
} from '@spectra/social-linkedin';
import {
  FacebookPagePublisher,
  InstagramPublisher,
  type ContainerLedger,
  type MetaGraphOptions,
} from '@spectra/social-meta';
import {
  OAuthTokenError,
  openTokenBundle,
  refreshAccessToken,
  sealTokenBundle,
  type ResolvedOAuthConfig,
  type TokenBundle,
} from '@spectra/social-oauth';
import { WordPressPublisher, parseWordPressCredential } from '@spectra/social-wordpress';
import { assertKeyWithinTenant, type ObjectStorageProvider } from '@spectra/storage';

import type {
  LoadMedia,
  MediaUrl,
  PublishAccount,
  PublisherUnavailable,
  ResolvePublisher,
} from './executor';

/**
 * Live publisher resolution, shared by the worker and the integration tests
 * (the async executor pattern: one code path, driven by both).
 *
 * WordPress: a sealed `username:application-password` on the account.
 * LinkedIn (ADR-0035): an account discovered through an OAuth connection; the
 * token lives on the connection, is refreshed shortly before expiry when
 * LinkedIn issued a refresh token, and is opened in memory for one publish.
 * Facebook Pages and Instagram (ADR-0036): accounts discovered through a Meta
 * connection, each carrying its own sealed Page access token.
 *
 * Anything missing yields an honest UNSUPPORTED or FAILED with the reason —
 * never a publisher that pretends. Decrypted secrets never leave this module
 * and are never logged.
 */

/** Refresh when the access token has less than this left. */
const REFRESH_MARGIN_MS = 5 * 60_000;

const LINKEDIN_POSTING_SCOPE: Readonly<Record<string, string>> = {
  PROFILE: 'w_member_social',
  PAGE: 'w_organization_social',
};
const LINKEDIN_AUTHOR = /^urn:li:(person|organization):/;

export interface PublisherResolverDeps {
  prisma: SpectraPrismaClient;
  /** Social credential key ring; undefined => nothing can be opened => UNSUPPORTED. */
  ring: KeyRing | undefined;
  linkedin: {
    api: LinkedInApiOptions;
    /** LinkedIn OAuth client config, needed only to refresh a token. */
    oauth: ResolvedOAuthConfig | null;
    imageStatusChecks?: number;
    sleep?: (ms: number) => Promise<void>;
  };
  /** Meta (Facebook Pages, Instagram). Omitted: those targets resolve to UNSUPPORTED. */
  meta?: {
    api: MetaGraphOptions;
    /** Why Instagram cannot fetch images from this deployment, or null (publicMediaLinkProblem). */
    instagramMediaProblem?: string | null;
    statusChecks?: number;
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  };
  logger?: Logger;
  now?: () => Date;
}

function unavailable(
  status: PublisherUnavailable['status'],
  reason: string,
  failureCode: PublisherUnavailable['failureCode'],
): PublisherUnavailable {
  return { unavailable: true, status, reason, failureCode };
}

export function createPublisherResolver(deps: PublisherResolverDeps): ResolvePublisher {
  return async (account) => {
    if (account.platform === 'WORDPRESS') return resolveWordPress(deps, account);
    if (account.platform === 'LINKEDIN') return resolveLinkedIn(deps, account);
    if (account.platform === 'FACEBOOK' || account.platform === 'INSTAGRAM') {
      return deps.meta ? resolveMeta(deps, deps.meta, account) : undefined;
    }
    return undefined;
  };
}

/** Reads media for the executor, refusing any key outside the entry's tenant. */
export function createMediaLoader(storage: Pick<ObjectStorageProvider, 'getObject'>): LoadMedia {
  return async (asset, tenant) => {
    assertKeyWithinTenant(asset.storageKey, tenant);
    return storage.getObject(asset.storageKey);
  };
}

/** Signed links lasting long enough for the platform to fetch the file once. */
const MEDIA_LINK_TTL_SECONDS = 15 * 60;

/**
 * Short-lived signed links for platforms that fetch media themselves
 * (Instagram), refusing any key outside the entry's tenant.
 */
export function createMediaUrlSigner(
  storage: Pick<ObjectStorageProvider, 'createSignedDownloadUrl'>,
  expiresInSeconds = MEDIA_LINK_TTL_SECONDS,
): MediaUrl {
  return async (asset, tenant) => {
    assertKeyWithinTenant(asset.storageKey, tenant);
    return (await storage.createSignedDownloadUrl(asset.storageKey, expiresInSeconds)).url;
  };
}

const PRIVATE_HOSTS = [
  /^localhost$/i,
  /\.(localhost|local|internal)$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
];

/**
 * Whether a platform on the internet could fetch a signed link to this
 * storage endpoint: null when it plausibly can, otherwise the reason. A
 * loopback, private or link-local address, or a bare hostname (a
 * docker-compose service), cannot be reached from outside. A public-looking
 * name is not proof of reachability; the live checklist verifies it.
 */
export function publicMediaLinkProblem(storageEndpoint: string): string | null {
  let host: string;
  try {
    host = new URL(storageEndpoint).hostname;
  } catch {
    return 'STORAGE_ENDPOINT is not a valid URL, so no link to the image can be made.';
  }
  const ip = /^[\d.]+$/.test(host) || host.includes(':');
  if ((!ip && !host.includes('.')) || PRIVATE_HOSTS.some((pattern) => pattern.test(host))) {
    return `Instagram fetches the image from a link to this deployment's object storage, and STORAGE_ENDPOINT (${host}) is a local or private address Instagram cannot reach. Serve storage from a public address to publish to Instagram.`;
  }
  return null;
}

function resolveWordPress(
  deps: PublisherResolverDeps,
  account: PublishAccount,
): WordPressPublisher | undefined {
  if (!account.encryptedToken || !deps.ring) return undefined; // no credential/key → UNSUPPORTED
  let secret: string;
  try {
    secret = decryptSecret(account.encryptedToken, deps.ring);
  } catch (error) {
    deps.logger?.warn(
      { accountId: account.id, err: error instanceof Error ? error.message : 'decrypt failed' },
      'Could not decrypt social credential — treating as UNSUPPORTED',
    );
    return undefined;
  }
  try {
    return new WordPressPublisher(parseWordPressCredential(account.externalAccountId, secret));
  } catch (error) {
    deps.logger?.warn(
      { accountId: account.id, err: error instanceof Error ? error.message : 'invalid credential' },
      'Invalid WordPress credential — treating as UNSUPPORTED',
    );
    return undefined;
  }
}

async function resolveLinkedIn(
  deps: PublisherResolverDeps,
  account: PublishAccount,
): Promise<LinkedInPublisher | PublisherUnavailable> {
  const now = (deps.now ?? (() => new Date()))();
  const scope = LINKEDIN_POSTING_SCOPE[account.kind];

  if (!account.connectionId || !scope || !LINKEDIN_AUTHOR.test(account.externalAccountId)) {
    return unavailable(
      'UNSUPPORTED',
      'This LinkedIn target was registered by hand, not connected through LinkedIn. Connect LinkedIn on Social Accounts and publish to a discovered profile or page. Nothing was published.',
      'NOT_CONNECTED',
    );
  }
  const ring = deps.ring;
  if (!ring) {
    return unavailable(
      'UNSUPPORTED',
      'Credential storage is not configured on the worker (SOCIAL_TOKEN_ENCRYPTION_KEY), so the LinkedIn token cannot be read. Nothing was published.',
      'NOT_CONNECTED',
    );
  }

  const connection = await deps.prisma.socialConnection.findFirst({
    where: {
      id: account.connectionId,
      organizationId: account.organizationId,
      workspaceId: account.workspaceId,
      platform: 'LINKEDIN',
    },
    select: {
      id: true,
      status: true,
      disconnectedAt: true,
      encryptedCredential: true,
      hasRefreshToken: true,
      accessTokenExpiresAt: true,
      lastRefreshedAt: true,
      grantedScopes: true,
      grantedScopesReported: true,
    },
  });
  if (!connection || connection.disconnectedAt || !connection.encryptedCredential) {
    return unavailable(
      'UNSUPPORTED',
      'The LinkedIn connection behind this target was disconnected. Reconnect LinkedIn to publish. Nothing was published.',
      'NOT_CONNECTED',
    );
  }
  if (connection.status === 'REAUTH_REQUIRED' || connection.status === 'REVOKED') {
    return unavailable(
      'FAILED',
      'LinkedIn needs to be reconnected: it rejected this authorization. Nothing was published.',
      'REAUTH_REQUIRED',
    );
  }

  const grantedScopes = connection.grantedScopesReported ? connection.grantedScopes : null;
  if (grantedScopes && !grantedScopes.includes(scope)) {
    return unavailable(
      'FAILED',
      account.kind === 'PAGE'
        ? `Posting as a LinkedIn page needs ${scope} (Community Management API, reviewed by LinkedIn), which this connection was not granted. Nothing was published.`
        : `Posting as a LinkedIn member needs ${scope} (Share on LinkedIn), which this connection was not granted. Nothing was published.`,
      'PERMISSION',
    );
  }

  let bundle: TokenBundle;
  try {
    bundle = openTokenBundle(connection.encryptedCredential, ring);
  } catch {
    return unavailable(
      'FAILED',
      'The stored LinkedIn credential could not be decrypted with the configured keys. Reconnect LinkedIn. Nothing was published.',
      'REAUTH_REQUIRED',
    );
  }

  let accessToken = bundle.accessToken;
  const expiresAt = connection.accessTokenExpiresAt;
  if (expiresAt && expiresAt.getTime() - REFRESH_MARGIN_MS <= now.getTime()) {
    const refreshed = await refreshLinkedIn(deps, ring, account, connection, bundle, now);
    if ('unavailable' in refreshed) return refreshed;
    accessToken = refreshed.accessToken;
  }

  return new LinkedInPublisher({
    ...deps.linkedin.api,
    accessToken,
    authorUrn: account.externalAccountId,
    grantedScopes,
    ledger: prismaUploadLedger(deps.prisma, account),
    onAuthRejected: async () => {
      await deps.prisma.socialConnection.updateMany({
        where: { id: connection.id, organizationId: account.organizationId },
        data: { status: 'REAUTH_REQUIRED', lastErrorCode: 'publish_unauthorized' },
      });
    },
    ...(deps.linkedin.imageStatusChecks !== undefined
      ? { imageStatusChecks: deps.linkedin.imageStatusChecks }
      : {}),
    ...(deps.linkedin.sleep ? { sleep: deps.linkedin.sleep } : {}),
  });
}

interface ConnectionForRefresh {
  id: string;
  hasRefreshToken: boolean;
  accessTokenExpiresAt: Date | null;
  lastRefreshedAt: Date | null;
}

/**
 * Renews the access token before publishing. LinkedIn issues refresh tokens
 * only to approved partners; without one, an expired token means reconnect.
 * If another publish refreshed concurrently and this attempt's refresh token
 * was already spent, the newer stored token is used instead of declaring the
 * connection dead.
 */
async function refreshLinkedIn(
  deps: PublisherResolverDeps,
  ring: KeyRing,
  account: PublishAccount,
  connection: ConnectionForRefresh,
  bundle: TokenBundle,
  now: Date,
): Promise<{ accessToken: string } | PublisherUnavailable> {
  const expired =
    connection.accessTokenExpiresAt !== null && connection.accessTokenExpiresAt <= now;
  const expiredOn = connection.accessTokenExpiresAt?.toISOString().slice(0, 10);
  const scope = { id: connection.id, organizationId: account.organizationId };

  if (!connection.hasRefreshToken || !bundle.refreshToken) {
    if (!expired) return { accessToken: bundle.accessToken };
    await deps.prisma.socialConnection.updateMany({
      where: scope,
      data: { status: 'EXPIRED', lastErrorCode: 'access_token_expired' },
    });
    return unavailable(
      'FAILED',
      `The LinkedIn authorization expired on ${expiredOn}, and LinkedIn issued no refresh token (it does so only for approved partners). Reconnect LinkedIn. Nothing was published.`,
      'REAUTH_REQUIRED',
    );
  }
  if (!deps.linkedin.oauth) {
    if (!expired) return { accessToken: bundle.accessToken };
    return unavailable(
      'FAILED',
      'The LinkedIn authorization expired and LinkedIn OAuth is not configured on the worker (SOCIAL_OAUTH_LINKEDIN_CLIENT_ID/SECRET), so it cannot be refreshed. Nothing was published.',
      'REAUTH_REQUIRED',
    );
  }

  try {
    const tokens = await refreshAccessToken(deps.linkedin.oauth, bundle.refreshToken);
    const sealed = sealTokenBundle(
      {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? bundle.refreshToken,
        tokenType: tokens.tokenType ?? bundle.tokenType,
      },
      ring,
    );
    await deps.prisma.socialConnection.updateMany({
      where: scope,
      data: {
        encryptedCredential: sealed.sealed,
        credentialKeyId: sealed.keyId,
        status: 'CONNECTED',
        lastErrorCode: null,
        lastRefreshedAt: now,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        ...(tokens.refreshTokenExpiresAt
          ? { refreshTokenExpiresAt: tokens.refreshTokenExpiresAt }
          : {}),
      },
    });
    deps.logger?.info(
      { connectionId: connection.id },
      'Refreshed the LinkedIn token before publishing',
    );
    return { accessToken: tokens.accessToken };
  } catch (error) {
    if (!(error instanceof OAuthTokenError)) throw error;
    if (error.code === 'invalid_grant') {
      const latest = await deps.prisma.socialConnection.findFirst({
        where: scope,
        select: { encryptedCredential: true, lastRefreshedAt: true },
      });
      const refreshedMeanwhile =
        latest?.encryptedCredential &&
        latest.lastRefreshedAt &&
        (!connection.lastRefreshedAt || latest.lastRefreshedAt > connection.lastRefreshedAt);
      if (refreshedMeanwhile && latest?.encryptedCredential) {
        return { accessToken: openTokenBundle(latest.encryptedCredential, ring).accessToken };
      }
      await deps.prisma.socialConnection.updateMany({
        where: scope,
        data: { status: 'REAUTH_REQUIRED', lastErrorCode: 'invalid_grant' },
      });
      return unavailable(
        'FAILED',
        'LinkedIn rejected the refresh token (revoked or expired). Reconnect LinkedIn. Nothing was published.',
        'REAUTH_REQUIRED',
      );
    }
    if (!expired) return { accessToken: bundle.accessToken };
    return unavailable(
      'FAILED',
      `LinkedIn could not be reached to refresh the authorization (${error.code}). Try again. Nothing was published.`,
      'TRANSIENT',
    );
  }
}

const GRAPH_ID = /^\d{1,30}$/;
const META_TARGET = {
  FACEBOOK: {
    name: 'Facebook',
    kind: 'PAGE',
    scopes: ['pages_manage_posts'],
    wrongKind:
      'Facebook does not allow apps to publish to personal profiles. Publish to a Page instead. Nothing was published.',
  },
  INSTAGRAM: {
    name: 'Instagram',
    kind: 'BUSINESS_ACCOUNT',
    scopes: ['instagram_basic', 'instagram_content_publish'],
    wrongKind:
      'Instagram only allows API publishing to professional (Business or Creator) accounts linked to a Facebook Page, and Facebook does not report this account as one. Switch it to a professional account, link it to the Page, then reconnect Meta. Nothing was published.',
  },
} as const;

/**
 * Facebook Pages and Instagram (ADR-0036). Both publish with the Page access
 * token sealed on the account at discovery; Instagram accounts are found
 * through, and answer to, the Facebook connection.
 *
 * The connection's own user token may have lapsed without stopping anything:
 * Page tokens obtained with a long-lived user token do not expire. A Page
 * token Meta has invalidated comes back as code 190, which marks the
 * connection for reconnect.
 */
async function resolveMeta(
  deps: PublisherResolverDeps,
  meta: NonNullable<PublisherResolverDeps['meta']>,
  account: PublishAccount,
): Promise<FacebookPagePublisher | InstagramPublisher | PublisherUnavailable> {
  const platform = account.platform as 'FACEBOOK' | 'INSTAGRAM';
  const target = META_TARGET[platform];
  if (!account.connectionId || !GRAPH_ID.test(account.externalAccountId)) {
    return unavailable(
      'UNSUPPORTED',
      `This ${target.name} target was registered by hand, not found through a Meta connection. Connect Meta (Facebook) on Social Accounts and publish to a discovered ${platform === 'FACEBOOK' ? 'Page' : 'account'}. Nothing was published.`,
      'NOT_CONNECTED',
    );
  }
  if (account.kind !== target.kind)
    return unavailable('UNSUPPORTED', target.wrongKind, 'UNSUPPORTED_ACCOUNT');
  if (platform === 'INSTAGRAM' && meta.instagramMediaProblem) {
    return unavailable(
      'UNSUPPORTED',
      `${meta.instagramMediaProblem} Nothing was published.`,
      'UNSUPPORTED_MEDIA',
    );
  }
  const ring = deps.ring;
  if (!ring) {
    return unavailable(
      'UNSUPPORTED',
      `Credential storage is not configured on the worker (SOCIAL_TOKEN_ENCRYPTION_KEY), so the ${target.name} token cannot be read. Nothing was published.`,
      'NOT_CONNECTED',
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
      'UNSUPPORTED',
      'The Meta connection behind this target was disconnected. Reconnect Meta (Facebook) to publish. Nothing was published.',
      'NOT_CONNECTED',
    );
  }
  if (connection.status === 'REAUTH_REQUIRED' || connection.status === 'REVOKED') {
    return unavailable(
      'FAILED',
      'Meta needs to be reconnected: it rejected this authorization. Nothing was published.',
      'REAUTH_REQUIRED',
    );
  }
  const granted = connection.grantedScopesReported ? connection.grantedScopes : null;
  const missing = granted ? target.scopes.filter((scope) => !granted.includes(scope)) : [];
  if (missing.length > 0) {
    return unavailable(
      'FAILED',
      `Publishing to ${target.name} needs ${missing.join(', ')} (Meta App Review), which this connection was not granted. Nothing was published.`,
      'PERMISSION',
    );
  }
  if (!account.encryptedToken) {
    return unavailable(
      'FAILED',
      `Facebook issued no Page access token for this ${platform === 'FACEBOOK' ? 'Page' : "account's linked Page"} — your role may not allow publishing. Ask for a role with "Create content", then reconnect Meta. Nothing was published.`,
      'PERMISSION',
    );
  }
  let pageToken: string;
  try {
    pageToken = decryptSecret(account.encryptedToken, ring);
  } catch {
    return unavailable(
      'FAILED',
      'The stored Page token could not be decrypted with the configured keys. Reconnect Meta. Nothing was published.',
      'REAUTH_REQUIRED',
    );
  }

  const common = {
    ...meta.api,
    accessToken: pageToken,
    onAuthRejected: async () => {
      await deps.prisma.socialConnection.updateMany({
        where: { id: connection.id, organizationId: account.organizationId },
        data: { status: 'REAUTH_REQUIRED', lastErrorCode: 'publish_unauthorized' },
      });
    },
  };
  if (platform === 'FACEBOOK') {
    return new FacebookPagePublisher({ ...common, pageId: account.externalAccountId });
  }
  return new InstagramPublisher({
    ...common,
    instagramAccountId: account.externalAccountId,
    ledger: prismaContainerLedger(deps.prisma, account),
    ...(meta.statusChecks !== undefined ? { statusChecks: meta.statusChecks } : {}),
    ...(meta.pollIntervalMs !== undefined ? { pollIntervalMs: meta.pollIntervalMs } : {}),
    ...(meta.sleep ? { sleep: meta.sleep } : {}),
  });
}

/**
 * Instagram media containers by publish idempotency key, on the schedule entry
 * itself — the guard that keeps a retry from publishing twice.
 */
function prismaContainerLedger(
  prisma: SpectraPrismaClient,
  account: PublishAccount,
): ContainerLedger {
  const where = (idempotencyKey: string) => ({
    organizationId: account.organizationId,
    workspaceId: account.workspaceId,
    socialAccountId: account.id,
    idempotencyKey,
  });
  return {
    async find(key) {
      const row = await prisma.contentScheduleEntry.findFirst({
        where: where(key),
        select: { externalContainerId: true },
      });
      return row?.externalContainerId ?? null;
    },
    async staged(key, containerId) {
      const { count } = await prisma.contentScheduleEntry.updateMany({
        where: where(key),
        data: { externalContainerId: containerId },
      });
      return count === 1;
    },
    async cleared(key) {
      await prisma.contentScheduleEntry.updateMany({
        where: where(key),
        data: { externalContainerId: null },
      });
    },
  };
}

/** The SocialMediaUpload rows behind LinkedIn's retry-safe image reuse. */
function prismaUploadLedger(
  prisma: SpectraPrismaClient,
  account: PublishAccount,
): MediaUploadLedger {
  const row = (assetId: string) => ({
    organizationId: account.organizationId,
    socialAccountId: account.id,
    mediaAssetId: assetId,
  });
  return {
    async find(assetId) {
      const found = await prisma.socialMediaUpload.findFirst({
        where: row(assetId),
        select: { externalMediaId: true, status: true, verified: true },
      });
      return found
        ? { externalMediaId: found.externalMediaId, status: found.status, verified: found.verified }
        : null;
    },
    async registered(assetId, externalMediaId, uploadUrlExpiresAt) {
      await prisma.socialMediaUpload.upsert({
        where: {
          socialAccountId_mediaAssetId: { socialAccountId: account.id, mediaAssetId: assetId },
        },
        create: {
          organizationId: account.organizationId,
          workspaceId: account.workspaceId,
          socialAccountId: account.id,
          mediaAssetId: assetId,
          platform: account.platform,
          externalMediaId,
          status: 'REGISTERED',
          attempts: 1,
          uploadUrlExpiresAt,
        },
        update: {
          externalMediaId,
          status: 'REGISTERED',
          verified: false,
          attempts: { increment: 1 },
          uploadUrlExpiresAt,
          lastError: null,
        },
      });
    },
    async uploaded(assetId, verified) {
      await prisma.socialMediaUpload.updateMany({
        where: row(assetId),
        data: { status: 'UPLOADED', verified, uploadedAt: new Date() },
      });
    },
    async failed(assetId, reason) {
      await prisma.socialMediaUpload.updateMany({
        where: row(assetId),
        data: { status: 'FAILED', lastError: reason.slice(0, 500) },
      });
    },
    async attached(assetId, postUrn) {
      await prisma.socialMediaUpload.updateMany({
        where: row(assetId),
        data: { lastPostId: postUrn },
      });
    },
  };
}
