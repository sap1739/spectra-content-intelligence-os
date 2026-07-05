/**
 * Tenant-separated object key scheme:
 *
 *   org/<organizationId>/ws/<workspaceId>/<domain>/<resourceId>/<filename>
 *
 * Every key is rooted in the owning tenant so bucket policies, key-prefix
 * checks and deletion propagation all align with tenancy.
 */

export const STORAGE_DOMAINS = [
  'research-snapshots',
  'documents',
  'media',
  'renders',
  'exports',
  'webhooks',
] as const;
export type StorageDomain = (typeof STORAGE_DOMAINS)[number];

export interface ObjectKeyParts {
  organizationId: string;
  workspaceId: string;
  domain: StorageDomain;
  resourceId: string;
  filename: string;
}

const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

export class InvalidObjectKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidObjectKeyError';
  }
}

/** Strips path separators and control characters; never trusts client names. */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex -- strip control chars from untrusted filenames
  const cleaned = base.replace(/[\u0000-\u001f]/g, '').replace(/[^A-Za-z0-9._-]/g, '_');
  const trimmed = cleaned.replace(/^\.+/, '').slice(0, 200);
  if (!trimmed) {
    throw new InvalidObjectKeyError('Filename is empty after sanitization');
  }
  return trimmed;
}

function assertSegment(value: string, label: string): void {
  if (!value || !SEGMENT_PATTERN.test(value) || value.includes('..')) {
    throw new InvalidObjectKeyError(`Invalid ${label} for object key`);
  }
}

export function buildObjectKey(parts: ObjectKeyParts): string {
  assertSegment(parts.organizationId, 'organizationId');
  assertSegment(parts.workspaceId, 'workspaceId');
  assertSegment(parts.resourceId, 'resourceId');
  if (!STORAGE_DOMAINS.includes(parts.domain)) {
    throw new InvalidObjectKeyError(`Unknown storage domain: ${parts.domain}`);
  }
  const filename = sanitizeFilename(parts.filename);
  return `org/${parts.organizationId}/ws/${parts.workspaceId}/${parts.domain}/${parts.resourceId}/${filename}`;
}

export function parseObjectKey(key: string): ObjectKeyParts | null {
  const match = key.match(/^org\/([^/]+)\/ws\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  const [, organizationId, workspaceId, domain, resourceId, filename] = match;
  if (!STORAGE_DOMAINS.includes(domain as StorageDomain)) return null;
  return {
    organizationId: organizationId as string,
    workspaceId: workspaceId as string,
    domain: domain as StorageDomain,
    resourceId: resourceId as string,
    filename: filename as string,
  };
}

/** Guards every storage read/write against cross-tenant key access. */
export function assertKeyWithinTenant(
  key: string,
  tenant: { organizationId: string; workspaceId?: string },
): void {
  const parts = parseObjectKey(key);
  if (!parts || parts.organizationId !== tenant.organizationId) {
    throw new InvalidObjectKeyError('Object key does not belong to the caller tenant');
  }
  if (tenant.workspaceId !== undefined && parts.workspaceId !== tenant.workspaceId) {
    throw new InvalidObjectKeyError('Object key does not belong to the caller tenant');
  }
}
