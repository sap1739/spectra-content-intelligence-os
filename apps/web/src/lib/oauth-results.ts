import {
  OAUTH_CALLBACK_RESULTS,
  OAUTH_PLATFORMS,
  type OAuthCallbackResult,
} from '@spectra/contracts';

/**
 * Copy for the one outcome code the OAuth callback appends to the return URL
 * (ADR-0034). Anyone can craft that URL, so only KNOWN codes produce a message
 * and every message is fixed text — nothing from the query string is rendered.
 */

export interface OAuthResultMessage {
  result: OAuthCallbackResult;
  tone: 'success' | 'error';
  title: string;
  description: string;
}

const MESSAGES: Record<OAuthCallbackResult, Omit<OAuthResultMessage, 'result'>> = {
  connected: {
    tone: 'success',
    title: 'Connected',
    description:
      'The authorization was stored, sealed. Whether anything can be posted depends on a platform adapter — see the connection below.',
  },
  reconnected: {
    tone: 'success',
    title: 'Reconnected',
    description: 'The connection was renewed in place with a fresh authorization.',
  },
  access_denied: {
    tone: 'error',
    title: 'Authorization was declined',
    description: 'No credential was stored. You can start again whenever you are ready.',
  },
  provider_error: {
    tone: 'error',
    title: 'The platform returned an error',
    description: 'The platform did not complete the authorization. No credential was stored.',
  },
  state_invalid: {
    tone: 'error',
    title: 'This connection link is not valid',
    description:
      'It was already used, was started in a different session, or was not issued here. Start the connection again.',
  },
  state_expired: {
    tone: 'error',
    title: 'This connection link expired',
    description:
      'A connection has to be completed within a few minutes of starting it. Start again.',
  },
  session_required: {
    tone: 'error',
    title: 'You were signed out',
    description: 'Sign in, then start the connection again.',
  },
  forbidden: {
    tone: 'error',
    title: 'You no longer have permission to connect accounts',
    description: 'Connecting requires the social:connect permission. No credential was stored.',
  },
  not_configured: {
    tone: 'error',
    title: 'This platform is not configured',
    description:
      'OAuth for this platform is not configured in this deployment. No credential was stored.',
  },
  credential_storage_unavailable: {
    tone: 'error',
    title: 'Credentials cannot be stored',
    description:
      'Credential storage is not configured (SOCIAL_TOKEN_ENCRYPTION_KEY), so the authorization was not kept.',
  },
  token_exchange_failed: {
    tone: 'error',
    title: 'The platform rejected the authorization code',
    description:
      'The code could not be exchanged for a token. No credential was stored. Start again.',
  },
  unknown_platform: {
    tone: 'error',
    title: 'Unknown platform',
    description: 'That callback does not belong to a platform Spectra connects to.',
  },
  internal_error: {
    tone: 'error',
    title: 'Something went wrong on our side',
    description:
      'The connection did not complete and no credential was stored. Try again; if it keeps happening, contact support with the time it happened.',
  },
};

export function oauthResultFrom(value: string | null | undefined): OAuthResultMessage | null {
  if (!value || !(OAUTH_CALLBACK_RESULTS as readonly string[]).includes(value)) return null;
  const result = value as OAuthCallbackResult;
  return { result, ...MESSAGES[result] };
}

/** A platform id from the URL, only if it is one Spectra knows. */
export function oauthPlatformFrom(value: string | null | undefined): string | null {
  const upper = value?.toUpperCase();
  return upper && (OAUTH_PLATFORMS as readonly string[]).includes(upper) ? upper : null;
}

export function describeExpiry(iso: string | null, now: Date = new Date()): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(at)) return 'Token expiry not reported by the platform';
  const ms = at - now.getTime();
  if (ms <= 0) return 'Access token expired';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `Access token expires in ${Math.max(1, minutes)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Access token expires in ${hours} h`;
  return `Access token expires on ${new Date(at).toISOString().slice(0, 10)}`;
}
