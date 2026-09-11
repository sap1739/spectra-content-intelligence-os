import { Injectable, Logger } from '@nestjs/common';
import type { OAuthPlatform, ProviderRevocation, TokenRefreshResult } from '@spectra/contracts';
import { Prisma } from '@spectra/database';
import type { KeyRing } from '@spectra/security';
import { TenantIsolationError } from '@spectra/security';
import {
  accountDiscoveryRegistry,
  getPlatformCapability,
  sanitizeDiscoveryMetadata,
  socialPublisherRegistry,
  type DiscoveredDestination,
} from '@spectra/social-core';
import {
  DEFINITIONS_RECORDED_AT,
  OAuthTokenError,
  getOAuthDefinition,
  openTokenBundle,
  refreshAccessToken,
  resolveConnectionCapabilities,
  resolveProductAccess,
  revokeToken,
  sealTokenBundle,
  type TokenBundle,
  type TokenSet,
} from '@spectra/social-oauth';
import { METRICS, metrics } from '@spectra/telemetry';

import { AuditService } from '../../infra/audit.service';
import { SocialCryptoService } from '../../infra/social-crypto.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { Principal, TenantContext } from '../../auth/types';
import { OAuthConfigService } from './oauth-config.service';

/** Public projection. `encryptedCredential` is NEVER selected. */
const CONNECTION_SELECT = {
  id: true,
  platform: true,
  status: true,
  label: true,
  externalSubjectId: true,
  requestedScopes: true,
  grantedScopes: true,
  grantedScopesReported: true,
  hasRefreshToken: true,
  accessTokenExpiresAt: true,
  refreshTokenExpiresAt: true,
  lastRefreshedAt: true,
  lastErrorCode: true,
  discoveryStatus: true,
  discoveredAt: true,
  connectedById: true,
  connectedAt: true,
  createdAt: true,
  updatedAt: true,
  accounts: {
    where: { deletedAt: null },
    select: {
      id: true,
      platform: true,
      externalAccountId: true,
      displayName: true,
      kind: true,
      status: true,
      discoveryMetadata: true,
      capabilities: true,
      capabilitiesCheckedAt: true,
    },
  },
} as const;

const DISCOVERY_TIMEOUT_MS = 15_000;

/** The consumed attempt a callback hands over once the code has been exchanged. */
export interface GrantAttempt {
  id: string;
  organizationId: string;
  workspaceId: string;
  platform: OAuthPlatform;
  mode: 'CONNECT' | 'RECONNECT';
  connectionId: string | null;
  label: string;
  requestedScopes: string[];
}

/**
 * OAuth connections: storing a grant, listing, refresh, disconnect and
 * capabilities (ADR-0034).
 *
 * Every read is tenant-scoped (organization + workspace); a foreign and a
 * missing connection are the same 404. Tokens are only ever handled as a
 * sealed bundle, opened in memory for the one call that needs them.
 */
@Injectable()
export class ConnectionsService {
  private readonly logger = new Logger(ConnectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: SocialCryptoService,
    private readonly config: OAuthConfigService,
  ) {}

  /** Per-platform configuration, stated honestly. Never a client id or secret. */
  listPlatforms() {
    const credentialStorageConfigured = this.crypto.isConfigured;
    return {
      credentialStorageConfigured,
      stateTtlSeconds: this.config.stateTtlSeconds,
      definitionsRecordedAt: DEFINITIONS_RECORDED_AT,
      platforms: this.config.all().map((status) => {
        const { definition } = status;
        const publishing = socialPublisherRegistry.isWired(status.platform);
        const discovery = accountDiscoveryRegistry.isWired(status.platform);
        return {
          platform: status.platform,
          displayName: definition.displayName,
          configured: status.configured,
          missingConfiguration: status.configured ? [] : status.missing,
          redirectUri: status.configured ? status.config.redirectUri : status.redirectUri,
          scopes: status.configured ? status.config.scopes : [...definition.defaultScopes],
          pkce: definition.pkce,
          refresh: definition.refresh,
          approval: definition.approval,
          docsUrl: definition.docsUrl,
          adapters: { publishing, discovery },
          canConnect: status.configured && credentialStorageConfigured,
          limitation: publishing
            ? (socialPublisherRegistry.summary(status.platform) ??
              `${definition.displayName} publishing is wired.`)
            : `Connecting stores an authorization only. No ${definition.displayName} publishing adapter is wired, so a post to ${definition.displayName} resolves to UNSUPPORTED and nothing is posted.`,
        };
      }),
    };
  }

  async list(tenant: TenantContext) {
    const rows = await this.prisma.client.socialConnection.findMany({
      where: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        disconnectedAt: null,
      },
      orderBy: { connectedAt: 'desc' },
      take: 100,
      select: CONNECTION_SELECT,
    });
    const now = new Date();
    return rows.map((row) => this.present(row, now));
  }

  private present(
    row: Awaited<
      ReturnType<
        typeof this.prisma.client.socialConnection.findMany<{ select: typeof CONNECTION_SELECT }>
      >
    >[number],
    now: Date,
  ) {
    const platform = row.platform as OAuthPlatform;
    const status = this.config.status(platform);
    const { definition } = status;
    const name = definition.displayName;
    const accessTokenExpired = row.accessTokenExpiresAt !== null && row.accessTokenExpiresAt <= now;

    let refreshReason: string;
    if (definition.refresh !== 'standard') {
      refreshReason = `${name} has no standard token refresh; reconnect before the token expires.`;
    } else if (!row.hasRefreshToken) {
      refreshReason = `${name} did not issue a refresh token for this connection; reconnect to renew it.`;
    } else if (!status.configured) {
      refreshReason = `OAuth for ${name} is not configured in this deployment.`;
    } else {
      refreshReason = 'The access token can be refreshed.';
    }

    const discoveryNote =
      row.discoveryStatus === 'NOT_AVAILABLE'
        ? `No ${name} account-discovery adapter is wired, so no profiles, pages or channels were looked up.`
        : row.discoveryStatus === 'FAILED'
          ? 'Account discovery failed. The connection itself is stored.'
          : row.discoveryStatus === 'PARTIAL'
            ? `${row.accounts.length} account(s) discovered; part of discovery failed (for example, the pages the member administers). Reconnect to retry.`
            : `${row.accounts.length} account(s) discovered.`;
    const grantedScopes = row.grantedScopesReported ? row.grantedScopes : null;
    const publishingWired = socialPublisherRegistry.isWired(platform);

    return {
      ...row,
      platformDisplayName: name,
      // A CONNECTED row whose token has lapsed is, honestly, expired.
      status: row.status === 'CONNECTED' && accessTokenExpired ? 'EXPIRED' : row.status,
      accessTokenExpired,
      grantedScopes,
      refresh: {
        available: definition.refresh === 'standard' && row.hasRefreshToken && status.configured,
        reason: refreshReason,
      },
      discovery: { status: row.discoveryStatus, note: discoveryNote },
      publishing: {
        wired: publishingWired,
        note: publishingWired
          ? (socialPublisherRegistry.summary(platform) ?? `${name} publishing is wired.`)
          : `No ${name} publishing adapter is wired — nothing is posted from this connection.`,
      },
      // The platform products this grant carries — "missing scope" in terms an
      // operator can act on: request the product, then reconnect.
      permissions: this.productAccess(platform, grantedScopes),
    };
  }

  private productAccess(platform: OAuthPlatform, grantedScopes: readonly string[] | null) {
    return resolveProductAccess(getOAuthDefinition(platform), grantedScopes).map((access) => ({
      id: access.product.id,
      name: access.product.name,
      scopes: [...access.product.scopes],
      anyOf: access.product.anyOf ?? false,
      reviewRequired: access.product.reviewRequired,
      enables: access.product.enables,
      status: access.status,
      missingScopes: access.missingScopes,
    }));
  }

  /**
   * Stores a freshly exchanged grant. The tokens are sealed into one bundle
   * before anything is written; a RECONNECT renews the existing connection in
   * place rather than creating a duplicate.
   */
  async storeGrant(input: {
    attempt: GrantAttempt;
    tokens: TokenSet;
    ring: KeyRing;
    principal: Principal;
  }): Promise<{ connectionId: string; reconnected: boolean }> {
    const { attempt, tokens, ring, principal } = input;
    const sealed = sealTokenBundle(
      {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenType: tokens.tokenType,
      },
      ring,
    );
    const credential = {
      status: 'CONNECTED' as const,
      encryptedCredential: sealed.sealed,
      credentialKeyId: sealed.keyId,
      hasRefreshToken: tokens.refreshToken !== null,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      requestedScopes: attempt.requestedScopes,
      // Unreported scopes are stored as UNKNOWN, never as "what we asked for".
      grantedScopes: tokens.grantedScopes ?? [],
      grantedScopesReported: tokens.grantedScopes !== null,
      lastErrorCode: null,
      ...(tokens.subjectId ? { externalSubjectId: tokens.subjectId } : {}),
    };

    const result = await this.prisma.client.$transaction(async (tx) => {
      const existing =
        attempt.mode === 'RECONNECT' && attempt.connectionId
          ? await tx.socialConnection.findFirst({
              where: {
                id: attempt.connectionId,
                organizationId: attempt.organizationId,
                workspaceId: attempt.workspaceId,
                platform: attempt.platform,
                disconnectedAt: null,
              },
              select: { id: true },
            })
          : null;
      const connection = existing
        ? await tx.socialConnection.update({
            where: { id: existing.id },
            data: credential,
            select: { id: true },
          })
        : await tx.socialConnection.create({
            data: {
              organizationId: attempt.organizationId,
              workspaceId: attempt.workspaceId,
              platform: attempt.platform,
              label: attempt.label,
              connectedById: principal.userId,
              ...credential,
            },
            select: { id: true },
          });
      await tx.socialOAuthAttempt.updateMany({
        where: { id: attempt.id, organizationId: attempt.organizationId },
        data: { outcome: 'CONNECTED', connectionId: connection.id },
      });
      return { connectionId: connection.id, reconnected: existing !== null };
    });

    const discovery = await this.discover(attempt, result.connectionId, tokens, principal);

    await this.audit.record({
      organizationId: attempt.organizationId,
      workspaceId: attempt.workspaceId,
      actorUserId: principal.userId,
      action: result.reconnected ? 'social.connection.reconnected' : 'social.connection.created',
      resourceType: 'SocialConnection',
      resourceId: result.connectionId,
      changes: {
        platform: attempt.platform,
        grantedScopes: tokens.grantedScopes,
        hasRefreshToken: tokens.refreshToken !== null,
        credentialKeyId: sealed.keyId,
        discovery,
      },
    });
    return result;
  }

  /**
   * Runs account discovery when an adapter is registered for the platform.
   * An account is only ever stored because the platform itself reported it.
   *
   * Identity and destinations succeed or fail independently: a member found
   * but pages refused is PARTIAL, not a failure that hides the member. After a
   * COMPLETE discovery, accounts this connection found before but the
   * platform no longer reports (a lost page role) are retired.
   */
  private async discover(
    attempt: GrantAttempt,
    connectionId: string,
    tokens: TokenSet,
    principal: Principal,
  ): Promise<'NOT_AVAILABLE' | 'COMPLETE' | 'PARTIAL' | 'FAILED'> {
    const adapter = accountDiscoveryRegistry.get(attempt.platform);
    if (!adapter) return 'NOT_AVAILABLE';

    const context = {
      accessToken: tokens.accessToken,
      grantedScopes: tokens.grantedScopes,
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    };
    const [identity, destinations] = await Promise.allSettled([
      adapter.discoverIdentity(context),
      adapter.discoverDestinations(context),
    ]);
    for (const [part, result] of [
      ['identity', identity],
      ['destinations', destinations],
    ] as const) {
      if (result.status === 'rejected') {
        this.logger.warn(
          {
            platform: attempt.platform,
            part,
            error: result.reason instanceof Error ? result.reason.name : 'unknown',
            kind: (result.reason as { kind?: string } | null)?.kind ?? null,
          },
          'Account discovery step failed',
        );
      }
    }

    const found = new Map<string, DiscoveredDestination>();
    if (identity.status === 'fulfilled') found.set(identity.value.externalId, identity.value);
    if (destinations.status === 'fulfilled') {
      for (const destination of destinations.value) {
        if (!found.has(destination.externalId)) found.set(destination.externalId, destination);
      }
    }

    const now = new Date();
    try {
      for (const account of found.values()) {
        const existing = await this.prisma.client.socialAccount.findFirst({
          where: {
            organizationId: attempt.organizationId,
            workspaceId: attempt.workspaceId,
            platform: attempt.platform,
            externalAccountId: account.externalId,
            deletedAt: null,
          },
          select: { id: true },
        });
        const data = {
          displayName: account.displayName.slice(0, 300),
          kind: account.kind,
          // Verified by the platform through discovery.
          status: 'CONNECTED' as const,
          connectionId,
          scopes: tokens.grantedScopes ?? [],
          discoveryMetadata: sanitizeDiscoveryMetadata(account.metadata),
          capabilities: (account.capabilities ?? {}) as Prisma.InputJsonValue,
          capabilitiesCheckedAt: account.capabilities ? now : null,
          lastRefreshedAt: now,
        };
        if (existing) {
          await this.prisma.client.socialAccount.update({ where: { id: existing.id }, data });
        } else {
          await this.prisma.client.socialAccount.create({
            data: {
              organizationId: attempt.organizationId,
              workspaceId: attempt.workspaceId,
              platform: attempt.platform,
              externalAccountId: account.externalId,
              connectedById: principal.userId,
              ...data,
            },
          });
        }
      }
    } catch (error) {
      this.logger.warn(
        { platform: attempt.platform, error: error instanceof Error ? error.name : 'unknown' },
        'Storing discovered accounts failed',
      );
      await this.prisma.client.socialConnection.update({
        where: { id: connectionId },
        data: { discoveryStatus: 'FAILED' },
      });
      return 'FAILED';
    }

    const status =
      identity.status === 'fulfilled' && destinations.status === 'fulfilled'
        ? 'COMPLETE'
        : found.size > 0
          ? 'PARTIAL'
          : 'FAILED';
    if (status === 'COMPLETE') {
      await this.prisma.client.socialAccount.updateMany({
        where: {
          organizationId: attempt.organizationId,
          connectionId,
          deletedAt: null,
          externalAccountId: { notIn: [...found.keys()] },
        },
        data: { status: 'REVOKED', deletedAt: now },
      });
    }
    await this.prisma.client.socialConnection.update({
      where: { id: connectionId },
      data: {
        discoveryStatus: status,
        ...(status === 'FAILED' ? {} : { discoveredAt: now }),
        ...(identity.status === 'fulfilled'
          ? { externalSubjectId: identity.value.externalId }
          : {}),
      },
    });
    return status;
  }

  private async findOwned(tenant: TenantContext, id: string) {
    const row = await this.prisma.client.socialConnection.findFirst({
      where: {
        id,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        disconnectedAt: null,
      },
      select: {
        id: true,
        platform: true,
        encryptedCredential: true,
        hasRefreshToken: true,
        grantedScopes: true,
        grantedScopesReported: true,
      },
    });
    // Foreign and missing are indistinguishable: no existence leak.
    if (!row) throw new TenantIsolationError();
    return { ...row, platform: row.platform as OAuthPlatform };
  }

  async refresh(
    tenant: TenantContext,
    principal: Principal,
    id: string,
  ): Promise<TokenRefreshResult> {
    const row = await this.findOwned(tenant, id);
    const status = this.config.status(row.platform);
    const name = status.definition.displayName;
    const done = (
      outcome: TokenRefreshResult['status'],
      detail: string,
      expiresAt: Date | null = null,
    ): TokenRefreshResult => {
      metrics.increment(METRICS.oauthFlows, {
        platform: row.platform,
        stage: 'refresh',
        outcome: outcome.toLowerCase(),
      });
      return {
        connectionId: row.id,
        status: outcome,
        accessTokenExpiresAt: expiresAt ? expiresAt.toISOString() : null,
        detail,
      };
    };

    if (status.definition.refresh !== 'standard') {
      return done(
        'NOT_SUPPORTED',
        `${name} has no standard token refresh. Reconnect to renew the authorization.`,
      );
    }
    if (!row.hasRefreshToken || !row.encryptedCredential) {
      return done(
        'NOT_SUPPORTED',
        `${name} did not issue a refresh token for this connection. Reconnect to renew it.`,
      );
    }
    if (!status.configured) {
      return done(
        'FAILED',
        `OAuth for ${name} is not configured in this deployment (${status.missing.join(', ')}).`,
      );
    }
    const ring = this.crypto.keyRing;
    if (!ring) {
      return done(
        'FAILED',
        'Credential storage is not configured (SOCIAL_TOKEN_ENCRYPTION_KEY), so the stored token cannot be read.',
      );
    }

    let bundle: TokenBundle;
    try {
      bundle = openTokenBundle(row.encryptedCredential, ring);
    } catch {
      await this.prisma.client.socialConnection.update({
        where: { id: row.id },
        data: { status: 'ERROR', lastErrorCode: 'credential_unreadable' },
      });
      return done(
        'FAILED',
        'The stored credential could not be decrypted with the configured keys. Reconnect to replace it.',
      );
    }
    if (!bundle.refreshToken) {
      return done(
        'NOT_SUPPORTED',
        `${name} did not issue a refresh token for this connection. Reconnect to renew it.`,
      );
    }

    try {
      const tokens = await refreshAccessToken(status.config, bundle.refreshToken);
      // Re-sealed under the ACTIVE key: every refresh advances key rotation.
      const sealed = sealTokenBundle(
        {
          accessToken: tokens.accessToken,
          // No new refresh token means "keep the old one", never "drop it".
          refreshToken: tokens.refreshToken ?? bundle.refreshToken,
          tokenType: tokens.tokenType ?? bundle.tokenType,
        },
        ring,
      );
      await this.prisma.client.socialConnection.update({
        where: { id: row.id },
        data: {
          encryptedCredential: sealed.sealed,
          credentialKeyId: sealed.keyId,
          status: 'CONNECTED',
          lastErrorCode: null,
          lastRefreshedAt: new Date(),
          accessTokenExpiresAt: tokens.accessTokenExpiresAt,
          ...(tokens.refreshTokenExpiresAt
            ? { refreshTokenExpiresAt: tokens.refreshTokenExpiresAt }
            : {}),
          ...(tokens.grantedScopes
            ? { grantedScopes: tokens.grantedScopes, grantedScopesReported: true }
            : {}),
        },
      });
      await this.audit.record({
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        actorUserId: principal.userId,
        action: 'social.connection.refreshed',
        resourceType: 'SocialConnection',
        resourceId: row.id,
        changes: {
          platform: row.platform,
          refreshTokenRotated: tokens.refreshToken !== null,
          credentialKeyId: sealed.keyId,
        },
      });
      return done(
        'REFRESHED',
        tokens.accessTokenExpiresAt
          ? 'The access token was refreshed.'
          : `The access token was refreshed; ${name} did not say when it expires.`,
        tokens.accessTokenExpiresAt,
      );
    } catch (error) {
      if (!(error instanceof OAuthTokenError)) throw error;
      const reauth = error.code === 'invalid_grant';
      await this.prisma.client.socialConnection.update({
        where: { id: row.id },
        // A transient failure leaves the status alone; a rejected grant does not.
        data: reauth
          ? { status: 'REAUTH_REQUIRED', lastErrorCode: 'invalid_grant' }
          : { lastErrorCode: error.code },
      });
      await this.audit.record({
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        actorUserId: principal.userId,
        action: 'social.connection.refresh_failed',
        resourceType: 'SocialConnection',
        resourceId: row.id,
        changes: { platform: row.platform, code: error.code, providerError: error.providerError },
      });
      if (reauth) {
        return done(
          'REAUTH_REQUIRED',
          `${name} rejected the refresh token — it was revoked or has expired. Reconnect to authorize again.`,
        );
      }
      return done(
        'FAILED',
        error.code === 'timeout' || error.code === 'network_error'
          ? `${name} could not be reached. Try again.`
          : `${name} rejected the refresh (${error.providerError ?? error.code}).`,
      );
    }
  }

  async disconnect(tenant: TenantContext, principal: Principal, id: string) {
    const row = await this.findOwned(tenant, id);
    const status = this.config.status(row.platform);
    const name = status.definition.displayName;
    const ring = this.crypto.keyRing;

    let providerRevocation: ProviderRevocation;
    if (!row.encryptedCredential) {
      providerRevocation = 'SKIPPED';
    } else if (
      !(status.configured ? status.config.revocationUrl : status.definition.revocationUrl)
    ) {
      providerRevocation = 'NOT_SUPPORTED';
    } else if (!status.configured || !ring) {
      providerRevocation = 'SKIPPED';
    } else {
      try {
        const bundle = openTokenBundle(row.encryptedCredential, ring);
        // Revoking the refresh token ends the whole grant where the two are linked.
        providerRevocation = bundle.refreshToken
          ? await revokeToken(status.config, bundle.refreshToken, 'refresh_token')
          : await revokeToken(status.config, bundle.accessToken, 'access_token');
      } catch {
        providerRevocation = 'FAILED';
      }
    }

    // The local purge happens whatever the platform said.
    const now = new Date();
    await this.prisma.client.$transaction([
      this.prisma.client.socialConnection.update({
        where: { id: row.id },
        data: {
          status: 'REVOKED',
          disconnectedAt: now,
          encryptedCredential: null,
          credentialKeyId: null,
          hasRefreshToken: false,
        },
      }),
      this.prisma.client.socialAccount.updateMany({
        where: { organizationId: tenant.organizationId, connectionId: row.id, deletedAt: null },
        data: { status: 'REVOKED', deletedAt: now, encryptedToken: null, tokenRef: null },
      }),
    ]);

    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'social.connection.disconnected',
      resourceType: 'SocialConnection',
      resourceId: row.id,
      changes: { platform: row.platform, providerRevocation },
    });
    metrics.increment(METRICS.oauthFlows, {
      platform: row.platform,
      stage: 'disconnect',
      outcome: providerRevocation.toLowerCase(),
    });

    const notes: Record<ProviderRevocation, string> = {
      REVOKED: `${name} confirmed the authorization was revoked. The stored credential was deleted.`,
      NOT_SUPPORTED: `${name} has no standard revocation endpoint, so Spectra may still be listed in your ${name} account settings — remove it there to fully revoke access. The stored credential was deleted.`,
      FAILED: `${name} did not confirm the revocation. The stored credential was deleted here; remove Spectra's access in your ${name} account settings to be certain.`,
      SKIPPED: row.encryptedCredential
        ? `Revocation was not attempted because OAuth or credential storage is not configured. The stored credential was deleted.`
        : 'No credential was stored for this connection.',
    };
    return {
      connectionId: row.id,
      disconnected: true,
      providerRevocation,
      note: notes[providerRevocation],
    };
  }

  async capabilities(tenant: TenantContext, id: string) {
    const row = await this.findOwned(tenant, id);
    const definition = getOAuthDefinition(row.platform);
    const grantedScopes = row.grantedScopesReported ? row.grantedScopes : null;
    return {
      connectionId: row.id,
      platform: row.platform,
      grantedScopes,
      capabilities: resolveConnectionCapabilities(definition, grantedScopes, {
        discovery: accountDiscoveryRegistry.isWired(row.platform),
        publish: socialPublisherRegistry.isWired(row.platform),
        analytics: false,
      }),
      declared: getPlatformCapability(row.platform),
      approval: definition.approval,
      permissions: this.productAccess(row.platform, grantedScopes),
      note: 'A capability is available only when the platform granted its scopes AND Spectra has an adapter that uses them.',
    };
  }
}
