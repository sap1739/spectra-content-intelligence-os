import { Injectable } from '@nestjs/common';
import { OAUTH_PLATFORMS, type OAuthPlatform } from '@spectra/contracts';
import {
  resolveOAuthPlatforms,
  type OAuthPlatformStatus,
  type ResolvedOAuthConfig,
} from '@spectra/social-oauth';

import { getApiEnv } from '../../config/env';

/**
 * Per-deployment OAuth configuration, resolved once at boot from the validated
 * environment (ADR-0034). Holds client secrets, so nothing in here is ever
 * serialized into a response — callers project the fields they need.
 */
@Injectable()
export class OAuthConfigService {
  private readonly statuses: ReadonlyMap<OAuthPlatform, OAuthPlatformStatus>;
  /** Where the callback returns the browser: validated at boot to be an API_CORS_ORIGIN entry. */
  readonly webOrigin: string;
  readonly stateTtlSeconds: number;

  constructor() {
    const env = getApiEnv();
    this.statuses = new Map(resolveOAuthPlatforms(env).map((status) => [status.platform, status]));
    this.webOrigin = new URL(env.WEB_APP_URL ?? (env.API_CORS_ORIGIN[0] as string)).origin;
    this.stateTtlSeconds = env.SOCIAL_OAUTH_STATE_TTL_SECONDS;
  }

  /** Accepts `linkedin` or `LINKEDIN`; anything that is not an OAuth platform is null. */
  parsePlatform(value: string): OAuthPlatform | null {
    const upper = value.toUpperCase();
    return (OAUTH_PLATFORMS as readonly string[]).includes(upper) ? (upper as OAuthPlatform) : null;
  }

  status(platform: OAuthPlatform): OAuthPlatformStatus {
    return this.statuses.get(platform) as OAuthPlatformStatus;
  }

  all(): OAuthPlatformStatus[] {
    return [...this.statuses.values()];
  }

  configFor(platform: OAuthPlatform): ResolvedOAuthConfig | null {
    const status = this.status(platform);
    return status.configured ? status.config : null;
  }
}
