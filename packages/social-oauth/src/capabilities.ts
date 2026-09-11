import {
  CONNECTION_CAPABILITIES,
  type ConnectionCapability,
  type OAuthPlatformDefinition,
} from './definitions';

/**
 * What a connection can do, answered in two independent halves that must BOTH
 * hold: the platform granted the scopes, and Spectra has an adapter that can
 * use them. A granted `publish` scope with no adapter is not a working
 * publisher, and this never reports it as one.
 */

export interface AdapterWiring {
  /** A discovery adapter (identity + destinations) is registered. */
  discovery: boolean;
  /** A publisher is registered. */
  publish: boolean;
  /** An analytics reader is registered. */
  analytics: boolean;
}

export interface ConnectionCapabilityStatus {
  capability: ConnectionCapability;
  requiredScopes: string[];
  /** true/false, or null when the platform did not report granted scopes. */
  scopesGranted: boolean | null;
  adapterWired: boolean;
  /** The only field that means "usable": scopes granted AND adapter wired. */
  available: boolean;
  reason: string;
}

const CAPABILITY_LABEL: Record<ConnectionCapability, string> = {
  read_profile: 'profile lookup',
  list_destinations: 'account discovery',
  publish: 'publishing',
  analytics: 'analytics',
};

function wiredFor(capability: ConnectionCapability, wiring: AdapterWiring): boolean {
  if (capability === 'publish') return wiring.publish;
  if (capability === 'analytics') return wiring.analytics;
  return wiring.discovery;
}

export function resolveConnectionCapabilities(
  definition: OAuthPlatformDefinition,
  grantedScopes: readonly string[] | null,
  wiring: AdapterWiring,
): ConnectionCapabilityStatus[] {
  return CONNECTION_CAPABILITIES.map((capability) => {
    const requiredScopes = [...(definition.capabilityScopes[capability] ?? [])];
    const adapterWired = wiredFor(capability, wiring);
    const label = CAPABILITY_LABEL[capability];

    if (requiredScopes.length === 0) {
      return {
        capability,
        requiredScopes,
        scopesGranted: false,
        adapterWired,
        available: false,
        reason: `No ${definition.displayName} OAuth scope grants ${label}.`,
      };
    }

    const missing = grantedScopes
      ? requiredScopes.filter((scope) => !grantedScopes.includes(scope))
      : null;
    const scopesGranted = missing === null ? null : missing.length === 0;

    let reason: string;
    if (scopesGranted === false) {
      reason = `Needs ${missing?.join(', ')}, which this connection was not granted. Reconnect to request it.`;
    } else if (scopesGranted === null) {
      reason = `${definition.displayName} did not report which scopes were granted, so ${label} cannot be confirmed.`;
    } else if (!adapterWired) {
      reason = `Scopes are granted, but no ${definition.displayName} ${label} adapter is wired yet — nothing is ${capability === 'publish' ? 'posted' : 'fetched'}.`;
    } else {
      reason = 'Granted, and an adapter is wired.';
    }

    return {
      capability,
      requiredScopes,
      scopesGranted,
      adapterWired,
      available: scopesGranted === true && adapterWired,
      reason,
    };
  });
}
