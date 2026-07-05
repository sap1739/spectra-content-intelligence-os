import { z } from 'zod';

import {
  auditTimestampsSchema,
  isoDateTimeSchema,
  languageCodeSchema,
  organizationScopeSchema,
  slugSchema,
  uuidSchema,
} from './common';

/**
 * Authorization is permission-oriented: roles are named bundles of permissions,
 * and memberships may carry additional explicit grants. Checks in code always
 * test permissions, never role names. See packages/security.
 */
export const PERMISSIONS = [
  'org:manage',
  'org:billing:manage',
  'org:members:manage',
  'workspace:manage',
  'workspace:members:manage',
  'brand:read',
  'brand:write',
  'vertical:read',
  'vertical:write',
  'research:read',
  'research:run',
  'research:review',
  'trend:read',
  'trend:review',
  'knowledge:read',
  'knowledge:write',
  'strategy:read',
  'strategy:write',
  'content:read',
  'content:write',
  'content:review',
  'content:approve',
  'campaign:read',
  'campaign:write',
  'media:read',
  'media:write',
  'social:connect',
  'social:publish',
  'analytics:read',
  'audit:read',
] as const;

export const permissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof permissionSchema>;

export const ROLES = [
  'ORG_OWNER',
  'ORG_ADMIN',
  'WORKSPACE_ADMIN',
  'RESEARCHER',
  'CONTENT_STRATEGIST',
  'CREATOR',
  'DESIGNER',
  'EDITOR',
  'APPROVER',
  'PUBLISHER',
  'ANALYST',
  'CLIENT_REVIEWER',
  'READ_ONLY',
] as const;

export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const userStatusSchema = z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED']);

export const userSchema = z
  .object({
    id: uuidSchema,
    email: z.string().email(),
    name: z.string().min(1).max(200),
    /** IANA timezone, e.g. `Asia/Kolkata`. Timestamps are stored in UTC. */
    timezone: z.string().min(1).default('UTC'),
    locale: languageCodeSchema.default('en'),
    status: userStatusSchema,
  })
  .merge(auditTimestampsSchema);
export type User = z.infer<typeof userSchema>;

export const organizationStatusSchema = z.enum(['ACTIVE', 'SUSPENDED', 'PENDING_DELETION']);

export const organizationSchema = z
  .object({
    id: uuidSchema,
    slug: slugSchema,
    name: z.string().min(1).max(200),
    status: organizationStatusSchema,
    settings: z.record(z.unknown()).default({}),
  })
  .merge(auditTimestampsSchema);
export type Organization = z.infer<typeof organizationSchema>;

export const membershipStatusSchema = z.enum(['INVITED', 'ACTIVE', 'SUSPENDED']);

export const membershipSchema = z
  .object({
    id: uuidSchema,
    userId: uuidSchema,
    role: roleSchema,
    /** Explicit permission grants beyond the role bundle. */
    extraPermissions: z.array(permissionSchema).default([]),
    status: membershipStatusSchema,
    invitedById: uuidSchema.nullish(),
    /** Optional restriction to specific workspaces; empty = all in org. */
    workspaceIds: z.array(uuidSchema).default([]),
  })
  .merge(organizationScopeSchema)
  .merge(auditTimestampsSchema);
export type Membership = z.infer<typeof membershipSchema>;

export const workspaceStatusSchema = z.enum(['ACTIVE', 'ARCHIVED']);

export const workspaceSchema = z
  .object({
    id: uuidSchema,
    slug: slugSchema,
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullish(),
    /** Default display timezone for calendars; storage remains UTC. */
    timezone: z.string().min(1).default('UTC'),
    settings: z.record(z.unknown()).default({}),
    status: workspaceStatusSchema,
  })
  .merge(organizationScopeSchema)
  .merge(auditTimestampsSchema);
export type Workspace = z.infer<typeof workspaceSchema>;

export const auditActorTypeSchema = z.enum(['USER', 'SYSTEM', 'API_CLIENT']);

export const auditLogEntrySchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  workspaceId: uuidSchema.nullish(),
  actorType: auditActorTypeSchema,
  actorUserId: uuidSchema.nullish(),
  action: z.string().min(1).max(200),
  resourceType: z.string().min(1).max(120),
  resourceId: z.string().max(120).nullish(),
  correlationId: z.string().nullish(),
  /** Structured diff/context. Sensitive values must be redacted before write. */
  changes: z.record(z.unknown()).nullish(),
  metadata: z.record(z.unknown()).default({}),
  createdAt: isoDateTimeSchema,
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;
