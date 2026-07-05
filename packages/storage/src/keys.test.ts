import { describe, expect, it } from 'vitest';

import {
  InvalidObjectKeyError,
  assertKeyWithinTenant,
  buildObjectKey,
  parseObjectKey,
  sanitizeFilename,
} from './keys';

describe('buildObjectKey', () => {
  it('builds tenant-rooted keys', () => {
    const key = buildObjectKey({
      organizationId: 'org-1',
      workspaceId: 'ws-1',
      domain: 'documents',
      resourceId: 'doc-9',
      filename: 'whitepaper.pdf',
    });
    expect(key).toBe('org/org-1/ws/ws-1/documents/doc-9/whitepaper.pdf');
    expect(parseObjectKey(key)).toEqual({
      organizationId: 'org-1',
      workspaceId: 'ws-1',
      domain: 'documents',
      resourceId: 'doc-9',
      filename: 'whitepaper.pdf',
    });
  });

  it('rejects path traversal in identifiers', () => {
    expect(() =>
      buildObjectKey({
        organizationId: '../other-org',
        workspaceId: 'ws-1',
        domain: 'documents',
        resourceId: 'r',
        filename: 'f.txt',
      }),
    ).toThrow(InvalidObjectKeyError);
  });

  it('sanitizes hostile filenames', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('report q3 (final).pdf')).toBe('report_q3__final_.pdf');
    expect(() => sanitizeFilename('....')).toThrow(InvalidObjectKeyError);
  });
});

describe('assertKeyWithinTenant', () => {
  const key = 'org/org-1/ws/ws-1/media/asset-1/logo.png';

  it('accepts keys within the tenant', () => {
    expect(() =>
      assertKeyWithinTenant(key, { organizationId: 'org-1', workspaceId: 'ws-1' }),
    ).not.toThrow();
  });

  it('rejects cross-organization and cross-workspace keys', () => {
    expect(() => assertKeyWithinTenant(key, { organizationId: 'org-2' })).toThrow(
      InvalidObjectKeyError,
    );
    expect(() =>
      assertKeyWithinTenant(key, { organizationId: 'org-1', workspaceId: 'ws-2' }),
    ).toThrow(InvalidObjectKeyError);
  });

  it('rejects malformed keys entirely', () => {
    expect(() => assertKeyWithinTenant('random/key.txt', { organizationId: 'org-1' })).toThrow(
      InvalidObjectKeyError,
    );
  });
});
