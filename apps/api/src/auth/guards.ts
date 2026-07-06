import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@spectra/contracts';
import { TenantIsolationError, hasPermission } from '@spectra/security';
import type { FastifyRequest } from 'fastify';

import { getApiEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY } from './decorators';
import { PrincipalService } from './principal.service';
import { SESSION_COOKIE, SessionService } from './session.service';
import type { PrincipalMembership } from './types';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF containment: browsers always send Origin on cross-site mutations, so a
 * mutating request carrying an Origin outside the allow-list is rejected.
 * Requests without Origin (curl, server-to-server) pass — cookies alone are
 * not ambient authority for them. Runs on every route, including public ones.
 */
@Injectable()
export class OriginCheckGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!MUTATING_METHODS.has(request.method)) return true;
    const origin = request.headers.origin;
    if (!origin) return true;
    if (getApiEnv().API_CORS_ORIGIN.includes(origin)) return true;
    throw new ForbiddenException('Origin not allowed');
  }
}

/** Resolves the session cookie into a Principal; 401 unless route is @Public. */
@Injectable()
export class PrincipalGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly principals: PrincipalService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    const sessionId = request.cookies?.[SESSION_COOKIE];
    if (sessionId) {
      const userId = await this.sessions.resolveUserId(sessionId);
      if (userId) {
        const principal = await this.principals.load(userId);
        if (principal) {
          request.principal = principal;
        }
      }
    }

    if (isPublic) return true;
    if (!request.principal) {
      throw new UnauthorizedException('Authentication required');
    }
    return true;
  }
}

function membershipCoversWorkspace(membership: PrincipalMembership, workspaceId: string): boolean {
  return membership.workspaceIds.length === 0 || membership.workspaceIds.includes(workspaceId);
}

/**
 * Resolves `:organizationId` / `:workspaceId` route params into a TenantContext
 * bound to one of the caller's memberships. Unknown and foreign resources both
 * surface as TenantIsolationError (→ 404) — no existence leaks.
 */
@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const principal = request.principal;
    if (!principal) return true; // public route — nothing to resolve

    const params = (request.params ?? {}) as Record<string, string | undefined>;
    const workspaceId = params['workspaceId'];
    const organizationId = params['organizationId'];

    if (workspaceId) {
      // findUnique (primary key): this IS the tenant-resolution lookup, the
      // one query that legitimately runs before tenant scope exists.
      const workspace = await this.prisma.client.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true, organizationId: true, deletedAt: true },
      });
      if (!workspace || workspace.deletedAt !== null) throw new TenantIsolationError();
      const membership = principal.memberships.find(
        (m) => m.organizationId === workspace.organizationId,
      );
      if (!membership || !membershipCoversWorkspace(membership, workspace.id)) {
        throw new TenantIsolationError();
      }
      request.tenant = {
        organizationId: workspace.organizationId,
        workspaceId: workspace.id,
        membership,
      };
      return true;
    }

    if (organizationId) {
      const membership = principal.memberships.find((m) => m.organizationId === organizationId);
      if (!membership) throw new TenantIsolationError();
      request.tenant = { organizationId, membership };
      return true;
    }

    return true;
  }
}

/** Enforces @RequirePermissions against the resolved tenant membership. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const membership = request.tenant?.membership;
    if (!membership) {
      // Permission-guarded routes must be tenant-scoped by construction.
      throw new ForbiddenException('No tenant membership in scope');
    }
    const subject = { role: membership.role, extraPermissions: membership.extraPermissions };
    for (const permission of required) {
      if (!hasPermission(subject, permission)) {
        throw new ForbiddenException(`Missing required permission: ${permission}`);
      }
    }
    return true;
  }
}
