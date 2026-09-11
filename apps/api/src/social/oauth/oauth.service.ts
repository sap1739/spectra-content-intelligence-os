import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  OAUTH_PLATFORMS,
  OAUTH_RETURN_PATHS,
  oauthCallbackQuerySchema,
  type OAuthCallbackResult,
  type OAuthInitiationResult,
  type OAuthPlatform,
  type ReconnectOAuthInput,
  type StartOAuthInput,
} from '@spectra/contracts';
import { TenantIsolationError, hasPermission } from '@spectra/security';
import {
  OAuthTokenError,
  buildAuthorizationUrl,
  codeChallengeS256,
  exchangeAuthorizationCode,
  generateCodeVerifier,
  generateState,
  hashState,
  isWellFormedState,
  usesPkce,
  type TokenSet,
} from '@spectra/social-oauth';
import { METRICS, metrics } from '@spectra/telemetry';

import { AuditService } from '../../infra/audit.service';
import { SocialCryptoService } from '../../infra/social-crypto.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { Principal, TenantContext } from '../../auth/types';
import { ConnectionsService, type GrantAttempt } from './connections.service';
import { OAuthConfigService } from './oauth-config.service';

const DEFAULT_RETURN_PATH = OAUTH_RETURN_PATHS[0];
/** Spent or expired attempts are pruned after a day; they are audit-logged anyway. */
const ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const PROVIDER_ERROR_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;

interface AttemptRow extends GrantAttempt {
  userId: string;
  returnPath: string;
  encryptedCodeVerifier: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
}

/**
 * The OAuth flow: start (and reconnect) and the callback (ADR-0034).
 *
 * The properties this class exists to guarantee:
 * - the redirect URI is fixed per platform and the return path allow-listed —
 *   neither is ever taken from a caller;
 * - a state is single-use (consumed atomically), expires, and is bound to the
 *   user whose browser session started the flow;
 * - PKCE is used wherever the platform accepts it;
 * - nothing is started when tokens could not be stored, so a user is never
 *   sent to consent for a grant Spectra would have to throw away;
 * - the callback always answers with a redirect carrying one fixed outcome
 *   code — never a token, never provider text.
 */
@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: SocialCryptoService,
    private readonly config: OAuthConfigService,
    private readonly connections: ConnectionsService,
  ) {}

  async start(
    tenant: TenantContext,
    principal: Principal,
    platformParam: string,
    input: StartOAuthInput,
  ): Promise<OAuthInitiationResult> {
    const platform = this.config.parsePlatform(platformParam);
    if (!platform) {
      throw new BadRequestException(
        `Not an OAuth platform. OAuth platforms: ${OAUTH_PLATFORMS.join(', ')}. WordPress connects with an application password instead.`,
      );
    }
    const label =
      input.label ?? `${this.config.status(platform).definition.displayName} connection`;
    return this.begin(tenant, principal, platform, {
      label,
      returnPath: input.returnPath,
      mode: 'CONNECT',
      connectionId: null,
    });
  }

  /** Re-authorizes an existing connection; the callback renews it in place. */
  async startReconnect(
    tenant: TenantContext,
    principal: Principal,
    connectionId: string,
    input: ReconnectOAuthInput,
  ): Promise<OAuthInitiationResult> {
    const existing = await this.prisma.client.socialConnection.findFirst({
      where: {
        id: connectionId,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        disconnectedAt: null,
      },
      select: { id: true, platform: true, label: true },
    });
    if (!existing) throw new TenantIsolationError();
    return this.begin(tenant, principal, existing.platform as OAuthPlatform, {
      label: existing.label,
      returnPath: input.returnPath,
      mode: 'RECONNECT',
      connectionId: existing.id,
    });
  }

  private async begin(
    tenant: TenantContext,
    principal: Principal,
    platform: OAuthPlatform,
    flow: {
      label: string;
      returnPath: string;
      mode: 'CONNECT' | 'RECONNECT';
      connectionId: string | null;
    },
  ): Promise<OAuthInitiationResult> {
    const status = this.config.status(platform);
    const name = status.definition.displayName;
    if (!status.configured) {
      this.count(platform, 'start', 'not_configured');
      throw new ServiceUnavailableException(
        `OAuth for ${name} is not configured in this deployment. Set ${status.missing.join(', ')}.`,
      );
    }
    if (!this.crypto.isConfigured) {
      // Refused BEFORE the user is sent to consent: a grant we could not store
      // would have to be thrown away after they approved it.
      this.count(platform, 'start', 'credential_storage_unavailable');
      throw new ServiceUnavailableException(
        `Credential storage is not configured (SOCIAL_TOKEN_ENCRYPTION_KEY), so tokens from ${name} could not be stored. Configure it before connecting.`,
      );
    }

    const { config } = status;
    const state = generateState();
    const verifier = usesPkce(config.definition) ? generateCodeVerifier() : null;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.stateTtlSeconds * 1000);

    const attempt = await this.prisma.client.socialOAuthAttempt.create({
      data: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        userId: principal.userId,
        platform,
        mode: flow.mode,
        connectionId: flow.connectionId,
        label: flow.label,
        // Only the hash is stored; the raw state lives in the URL and nowhere else.
        stateHash: hashState(state),
        encryptedCodeVerifier: verifier ? this.crypto.seal(verifier) : null,
        redirectUri: config.redirectUri,
        requestedScopes: config.scopes,
        returnPath: flow.returnPath,
        expiresAt,
      },
      select: { id: true },
    });

    await this.prisma.client.socialOAuthAttempt.deleteMany({
      where: {
        organizationId: tenant.organizationId,
        createdAt: { lt: new Date(now.getTime() - ATTEMPT_RETENTION_MS) },
      },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'social.oauth.started',
      resourceType: 'SocialOAuthAttempt',
      resourceId: attempt.id,
      changes: { platform, mode: flow.mode, pkce: verifier !== null },
    });
    this.count(platform, 'start', 'started');

    return {
      authorizationUrl: buildAuthorizationUrl(config, {
        state,
        codeChallenge: verifier ? codeChallengeS256(verifier) : null,
      }),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Completes a flow and returns where to send the browser. Never throws:
   * every outcome, including an unexpected failure, becomes a redirect with a
   * fixed outcome code.
   */
  async handleCallback(input: {
    platformParam: string;
    query: unknown;
    principal: Principal | null;
  }): Promise<string> {
    const platform = this.config.parsePlatform(input.platformParam);
    if (!platform) return this.returnUrl(DEFAULT_RETURN_PATH, 'unknown_platform', null);
    try {
      return await this.complete(platform, input.query, input.principal);
    } catch (error) {
      // The error NAME only: a database error message can quote the values it
      // was given, and some of those are sealed credentials.
      this.logger.error(
        { platform, error: error instanceof Error ? error.name : 'unknown' },
        'OAuth callback failed unexpectedly',
      );
      this.count(platform, 'callback', 'internal_error');
      return this.returnUrl(DEFAULT_RETURN_PATH, 'internal_error', platform);
    }
  }

  private async complete(
    platform: OAuthPlatform,
    query: unknown,
    principal: Principal | null,
  ): Promise<string> {
    const parsed = oauthCallbackQuerySchema.safeParse(query ?? {});
    const state = parsed.success ? parsed.data.state : undefined;
    if (!parsed.success || !state || !isWellFormedState(state)) {
      this.count(platform, 'callback', 'state_invalid');
      return this.returnUrl(DEFAULT_RETURN_PATH, 'state_invalid', platform);
    }
    if (!principal) {
      // Not consumed: the flow is bound to a signed-in user, and there is none.
      this.count(platform, 'callback', 'session_required');
      return this.returnUrl(DEFAULT_RETURN_PATH, 'session_required', platform);
    }
    const orgIds = principal.memberships.map((membership) => membership.organizationId);
    if (orgIds.length === 0) {
      this.count(platform, 'callback', 'state_invalid');
      return this.returnUrl(DEFAULT_RETURN_PATH, 'state_invalid', platform);
    }

    const stateHash = hashState(state);
    const now = new Date();
    // Single use, atomically: of any number of concurrent callbacks carrying
    // this state, exactly one flips consumedAt from NULL. It must also belong
    // to THIS user — a state lifted from someone else's flow is useless.
    const consumed = await this.prisma.client.socialOAuthAttempt.updateMany({
      where: {
        organizationId: { in: orgIds },
        stateHash,
        userId: principal.userId,
        platform,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    const attempt = (await this.prisma.client.socialOAuthAttempt.findFirst({
      where: { organizationId: { in: orgIds }, stateHash },
      select: {
        id: true,
        organizationId: true,
        workspaceId: true,
        userId: true,
        platform: true,
        mode: true,
        connectionId: true,
        label: true,
        requestedScopes: true,
        returnPath: true,
        encryptedCodeVerifier: true,
        expiresAt: true,
        consumedAt: true,
      },
    })) as AttemptRow | null;

    if (consumed.count === 0 || !attempt) {
      return this.rejectState(attempt, principal, platform, now);
    }

    const { code, error } = parsed.data;

    // Permission is re-checked at the callback: it may have been revoked
    // while the user was away at the platform.
    const membership = principal.memberships.find(
      (m) => m.organizationId === attempt.organizationId,
    );
    const allowed =
      membership !== undefined &&
      (membership.workspaceIds.length === 0 ||
        membership.workspaceIds.includes(attempt.workspaceId)) &&
      hasPermission(
        { role: membership.role, extraPermissions: membership.extraPermissions },
        'social:connect',
      );
    if (!allowed) return this.fail(attempt, principal, 'FAILED', 'forbidden', 'forbidden');

    if (error) {
      const providerError = PROVIDER_ERROR_TOKEN.test(error) ? error : 'unrecognized';
      const denied = error === 'access_denied';
      return this.fail(
        attempt,
        principal,
        denied ? 'DENIED' : 'FAILED',
        `provider_${providerError}`,
        denied ? 'access_denied' : 'provider_error',
      );
    }
    if (!code) return this.fail(attempt, principal, 'FAILED', 'missing_code', 'provider_error');

    const config = this.config.configFor(platform);
    if (!config) return this.fail(attempt, principal, 'FAILED', 'not_configured', 'not_configured');
    const ring = this.crypto.keyRing;
    if (!ring) {
      return this.fail(
        attempt,
        principal,
        'FAILED',
        'credential_storage_unavailable',
        'credential_storage_unavailable',
      );
    }

    let codeVerifier: string | null = null;
    if (attempt.encryptedCodeVerifier) {
      try {
        codeVerifier = this.crypto.open(attempt.encryptedCodeVerifier);
      } catch {
        return this.fail(
          attempt,
          principal,
          'FAILED',
          'verifier_unreadable',
          'credential_storage_unavailable',
        );
      }
    }

    let tokens: TokenSet;
    try {
      tokens = await exchangeAuthorizationCode(config, { code, codeVerifier });
    } catch (exchangeError) {
      if (!(exchangeError instanceof OAuthTokenError)) throw exchangeError;
      this.logger.warn(
        {
          platform,
          code: exchangeError.code,
          providerError: exchangeError.providerError,
          httpStatus: exchangeError.httpStatus,
        },
        'OAuth code exchange failed',
      );
      return this.fail(
        attempt,
        principal,
        'FAILED',
        `token_${exchangeError.code}`,
        'token_exchange_failed',
      );
    }

    const stored = await this.connections.storeGrant({ attempt, tokens, ring, principal });
    const result: OAuthCallbackResult = stored.reconnected ? 'reconnected' : 'connected';
    this.count(platform, 'callback', result);
    return this.returnUrl(attempt.returnPath, result, platform, stored.connectionId);
  }

  /** Why a state was not accepted — audited in detail, reported to the browser coarsely. */
  private async rejectState(
    attempt: AttemptRow | null,
    principal: Principal,
    platform: OAuthPlatform,
    now: Date,
  ): Promise<string> {
    if (!attempt) {
      this.count(platform, 'callback', 'state_invalid');
      return this.returnUrl(DEFAULT_RETURN_PATH, 'state_invalid', platform);
    }

    const ownAttempt = attempt.userId === principal.userId;
    const reason = !ownAttempt
      ? 'user_mismatch'
      : attempt.platform !== platform
        ? 'platform_mismatch'
        : attempt.consumedAt
          ? 'replayed'
          : 'expired';

    if (reason === 'expired') {
      await this.prisma.client.socialOAuthAttempt.updateMany({
        where: { id: attempt.id, organizationId: attempt.organizationId, consumedAt: null },
        data: { consumedAt: now, outcome: 'FAILED', failureCode: 'state_expired' },
      });
    }
    await this.audit.record({
      organizationId: attempt.organizationId,
      workspaceId: attempt.workspaceId,
      actorUserId: principal.userId,
      action:
        reason === 'replayed' ? 'social.oauth.replay_rejected' : 'social.oauth.state_rejected',
      resourceType: 'SocialOAuthAttempt',
      resourceId: attempt.id,
      changes: { platform, reason },
    });

    const result: OAuthCallbackResult = reason === 'expired' ? 'state_expired' : 'state_invalid';
    this.count(platform, 'callback', reason);
    // Only the user who started the flow is returned to its chosen path.
    return this.returnUrl(ownAttempt ? attempt.returnPath : DEFAULT_RETURN_PATH, result, platform);
  }

  private async fail(
    attempt: AttemptRow,
    principal: Principal,
    outcome: 'DENIED' | 'FAILED',
    failureCode: string,
    result: OAuthCallbackResult,
  ): Promise<string> {
    await this.prisma.client.socialOAuthAttempt.updateMany({
      where: { id: attempt.id, organizationId: attempt.organizationId },
      data: { outcome, failureCode },
    });
    await this.audit.record({
      organizationId: attempt.organizationId,
      workspaceId: attempt.workspaceId,
      actorUserId: principal.userId,
      action: outcome === 'DENIED' ? 'social.oauth.denied' : 'social.oauth.failed',
      resourceType: 'SocialOAuthAttempt',
      resourceId: attempt.id,
      changes: { platform: attempt.platform, failureCode },
    });
    this.count(attempt.platform, 'callback', result);
    return this.returnUrl(attempt.returnPath, result, attempt.platform);
  }

  /** The web return URL: allow-listed origin + allow-listed path + one fixed outcome code. */
  private returnUrl(
    returnPath: string,
    result: OAuthCallbackResult,
    platform: OAuthPlatform | null,
    connectionId?: string,
  ): string {
    const path = (OAUTH_RETURN_PATHS as readonly string[]).includes(returnPath)
      ? returnPath
      : DEFAULT_RETURN_PATH;
    const url = new URL(path, this.config.webOrigin);
    url.searchParams.set('oauth', result);
    if (platform) url.searchParams.set('platform', platform.toLowerCase());
    if (connectionId) url.searchParams.set('connection', connectionId);
    return url.toString();
  }

  private count(platform: OAuthPlatform, stage: string, outcome: string): void {
    metrics.increment(METRICS.oauthFlows, { platform, stage, outcome });
  }
}
