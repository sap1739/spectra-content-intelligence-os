import { describe, expect, it } from 'vitest';

import { resolveConnectionCapabilities, type ConnectionCapabilityStatus } from './capabilities';
import { getOAuthDefinition, type ConnectionCapability } from './definitions';

const linkedin = getOAuthDefinition('LINKEDIN');
const NOTHING_WIRED = { discovery: false, publish: false, analytics: false };

function pick(
  statuses: ConnectionCapabilityStatus[],
  capability: ConnectionCapability,
): ConnectionCapabilityStatus {
  const status = statuses.find((s) => s.capability === capability);
  if (!status) throw new Error(`missing ${capability}`);
  return status;
}

describe('connection capabilities', () => {
  it('never reports publishing as available without a wired adapter, even with the scope', () => {
    const publish = pick(
      resolveConnectionCapabilities(
        linkedin,
        ['openid', 'profile', 'w_member_social'],
        NOTHING_WIRED,
      ),
      'publish',
    );
    expect(publish.scopesGranted).toBe(true);
    expect(publish.adapterWired).toBe(false);
    expect(publish.available).toBe(false);
    expect(publish.reason).toMatch(/no LinkedIn publishing adapter is wired/);
  });

  it('names the scopes a connection was not granted', () => {
    const publish = pick(
      resolveConnectionCapabilities(linkedin, ['openid', 'profile'], NOTHING_WIRED),
      'publish',
    );
    expect(publish.scopesGranted).toBe(false);
    expect(publish.reason).toContain('w_member_social');
  });

  it('does not guess when the platform did not report granted scopes', () => {
    const publish = pick(resolveConnectionCapabilities(linkedin, null, NOTHING_WIRED), 'publish');
    expect(publish.scopesGranted).toBeNull();
    expect(publish.available).toBe(false);
    expect(publish.reason).toMatch(/did not report/);
  });

  it('is available only when scopes are granted AND an adapter is wired', () => {
    const publish = pick(
      resolveConnectionCapabilities(linkedin, ['w_member_social'], {
        discovery: true,
        publish: true,
        analytics: true,
      }),
      'publish',
    );
    expect(publish.available).toBe(true);
  });

  it('says so when no scope grants a capability at all', () => {
    const analytics = pick(
      resolveConnectionCapabilities(linkedin, ['openid'], NOTHING_WIRED),
      'analytics',
    );
    expect(analytics.available).toBe(false);
    expect(analytics.reason).toMatch(/No LinkedIn OAuth scope grants analytics/);
  });

  it('reports every capability', () => {
    expect(resolveConnectionCapabilities(linkedin, [], NOTHING_WIRED)).toHaveLength(4);
  });
});
