import type { AccountCapabilitySnapshot, SocialPlatform } from '@spectra/contracts';

/**
 * Account discovery ports (Phase 6C, ADR-0034).
 *
 * An OAuth grant gives Spectra a token, not a list of places it can publish.
 * Discovery turns one grant into three answers, each its own port so a
 * platform adapter can implement exactly what its API supports:
 *
 * - identity: who authorized (the member, creator or business profile);
 * - destinations: where they can publish — pages, channels, boards, business
 *   accounts;
 * - capabilities: what the token can actually do, as the platform reports it.
 *
 * Adapters register per platform. NONE are registered in Phase 6C, so every
 * connection records discovery as NOT_AVAILABLE rather than inventing an
 * account. Discovery never receives more than the access token it needs, and
 * never returns a raw provider payload.
 */

export interface DiscoveryContext {
  /** Plaintext access token, held in memory only for the call. Never logged. */
  accessToken: string;
  /** Scopes the token endpoint reported, or null when it reported none. */
  grantedScopes: readonly string[] | null;
  signal?: AbortSignal;
}

/** Allow-listed metadata: primitives only, bounded — see sanitizeDiscoveryMetadata. */
export type DiscoveryMetadata = Record<string, string | number | boolean | null>;

export interface DiscoveredIdentity {
  /** The platform's own id for the authorizing profile. */
  externalId: string;
  displayName: string;
  kind: 'PROFILE' | 'BUSINESS_ACCOUNT';
  metadata?: DiscoveryMetadata;
  /** What this account can publish through the adapter, given the grant. */
  capabilities?: AccountCapabilitySnapshot;
}

export interface DiscoveredDestination {
  externalId: string;
  displayName: string;
  kind: 'PROFILE' | 'PAGE' | 'CHANNEL' | 'BUSINESS_ACCOUNT' | 'SITE';
  metadata?: DiscoveryMetadata;
  capabilities?: AccountCapabilitySnapshot;
}

export interface DiscoveredCapabilities {
  /** Scopes the platform reports as granted — may differ from what was requested. */
  grantedScopes: string[] | null;
  /** Capability-record version the adapter validated against. */
  capabilityVersion: string;
  notes: string[];
}

/** Who authorized. */
export interface IdentityDiscoveryPort {
  discoverIdentity(context: DiscoveryContext): Promise<DiscoveredIdentity>;
}

/** Pages, channels, boards and business accounts the token can publish to. May be empty — never padded. */
export interface DestinationDiscoveryPort {
  discoverDestinations(context: DiscoveryContext): Promise<DiscoveredDestination[]>;
}

/** What the token can do, as the platform itself reports it. */
export interface CapabilityDiscoveryPort {
  discoverCapabilities(context: DiscoveryContext): Promise<DiscoveredCapabilities>;
}

export interface AccountDiscoveryPort
  extends IdentityDiscoveryPort, DestinationDiscoveryPort, CapabilityDiscoveryPort {
  readonly platform: SocialPlatform;
  readonly adapterVersion: string;
}

/** Discovery adapters by platform. Empty in Phase 6C — no platform is wired. */
export class AccountDiscoveryRegistry {
  private readonly adapters = new Map<SocialPlatform, AccountDiscoveryPort>();

  register(adapter: AccountDiscoveryPort): void {
    this.adapters.set(adapter.platform, adapter);
  }

  unregister(platform: SocialPlatform): void {
    this.adapters.delete(platform);
  }

  get(platform: SocialPlatform): AccountDiscoveryPort | undefined {
    return this.adapters.get(platform);
  }

  isWired(platform: SocialPlatform): boolean {
    return this.adapters.has(platform);
  }
}

export const accountDiscoveryRegistry = new AccountDiscoveryRegistry();

const METADATA_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const MAX_METADATA_KEYS = 20;
const MAX_METADATA_STRING = 256;

/**
 * Bounds what discovery may persist. Primitives only (objects and arrays are
 * where raw payloads and tokens hide), a key pattern, a key count and a string
 * length. Anything else is dropped rather than stored.
 */
export function sanitizeDiscoveryMetadata(metadata: unknown): DiscoveryMetadata {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const clean: DiscoveryMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (Object.keys(clean).length >= MAX_METADATA_KEYS) break;
    if (!METADATA_KEY.test(key)) continue;
    if (typeof value === 'string') clean[key] = value.slice(0, MAX_METADATA_STRING);
    else if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === 'boolean' || value === null) clean[key] = value;
  }
  return clean;
}
