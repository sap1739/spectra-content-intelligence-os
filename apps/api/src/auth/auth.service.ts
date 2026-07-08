import {
  ConflictException,
  HttpException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthMeResponse, LoginRequest, RegisterRequest } from '@spectra/contracts';
import { hashPassword, verifyPassword } from '@spectra/security';

import { slugify, uniqueSuffix } from '../common/slug';
import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { PrincipalService } from './principal.service';
import { SessionService } from './session.service';
import type { Principal } from './types';

export interface AuthResult {
  sessionId: string;
  principal: Principal;
}

/** Per email+IP failed-login throttle (ADR-0014 hardening item). */
const LOGIN_FAIL_LIMIT = 5;
const LOGIN_FAIL_WINDOW_SECONDS = 15 * 60;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly principals: PrincipalService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  private throttleKey(email: string, ip: string): string {
    return `spectra:login-fail:${email}:${ip}`;
  }

  private async assertNotThrottled(email: string, ip: string): Promise<void> {
    const count = await this.redis.client.get(this.throttleKey(email, ip));
    if (count !== null && Number(count) >= LOGIN_FAIL_LIMIT) {
      throw new HttpException('Too many failed sign-in attempts. Try again in a few minutes.', 429);
    }
  }

  private async recordLoginFailure(email: string, ip: string): Promise<void> {
    const key = this.throttleKey(email, ip);
    const count = await this.redis.client.incr(key);
    if (count === 1) {
      await this.redis.client.expire(key, LOGIN_FAIL_WINDOW_SECONDS);
    }
  }

  /** Pending invitations for this email become memberships on registration. */
  private async acceptPendingInvitations(userId: string, email: string): Promise<void> {
    const invitations = await this.prisma.client.invitation.findMany({
      where: { email, acceptedAt: null, expiresAt: { gt: new Date() } },
    });
    for (const invitation of invitations) {
      await this.prisma.client.membership.upsert({
        where: {
          organizationId_userId: {
            organizationId: invitation.organizationId,
            userId,
          },
        },
        create: {
          organizationId: invitation.organizationId,
          userId,
          role: invitation.role,
          status: 'ACTIVE',
          invitedById: invitation.invitedById,
        },
        update: {},
      });
      await this.prisma.client.invitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      });
      await this.audit.record({
        organizationId: invitation.organizationId,
        actorUserId: userId,
        action: 'invitation.accepted',
        resourceType: 'Invitation',
        resourceId: invitation.id,
      });
    }
  }

  /**
   * Registers a user and bootstraps their first organization (ORG_OWNER) with
   * a default workspace — the standard B2B onboarding shape.
   */
  async register(input: RegisterRequest, correlationId?: string): Promise<AuthResult> {
    const email = input.email.toLowerCase();
    const existing = await this.prisma.client.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await hashPassword(input.password);
    const organizationName = input.organizationName ?? `${input.name}'s organization`;
    const orgSlug = `${slugify(organizationName)}-${uniqueSuffix()}`;

    const { user, organization } = await this.prisma.client.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: { email, name: input.name, status: 'ACTIVE' },
      });
      await tx.credential.create({
        data: { userId: createdUser.id, passwordHash },
      });
      const createdOrg = await tx.organization.create({
        data: { name: organizationName, slug: orgSlug, status: 'ACTIVE' },
      });
      await tx.membership.create({
        data: {
          organizationId: createdOrg.id,
          userId: createdUser.id,
          role: 'ORG_OWNER',
          status: 'ACTIVE',
        },
      });
      await tx.workspace.create({
        data: {
          organizationId: createdOrg.id,
          name: 'General',
          slug: 'general',
          status: 'ACTIVE',
        },
      });
      return { user: createdUser, organization: createdOrg };
    });

    await this.acceptPendingInvitations(user.id, email);

    const principal = await this.principals.load(user.id);
    if (!principal) {
      throw new UnauthorizedException('Account creation failed');
    }
    const sessionId = await this.sessions.create(user.id);

    await this.audit.record({
      organizationId: organization.id,
      actorUserId: user.id,
      action: 'auth.register',
      resourceType: 'User',
      resourceId: user.id,
      correlationId: correlationId ?? null,
    });

    return { sessionId, principal };
  }

  async login(input: LoginRequest, correlationId?: string, ip = 'unknown'): Promise<AuthResult> {
    const email = input.email.toLowerCase();
    await this.assertNotThrottled(email, ip);

    const user = await this.prisma.client.user.findFirst({
      where: { email, deletedAt: null, status: 'ACTIVE' },
      include: { credential: true },
    });

    // Identical failure for unknown email and wrong password — no enumeration.
    const invalid = new UnauthorizedException('Invalid email or password');
    if (!user?.credential) {
      await this.recordLoginFailure(email, ip);
      throw invalid;
    }
    const valid = await verifyPassword(input.password, user.credential.passwordHash);
    if (!valid) {
      await this.recordLoginFailure(email, ip);
      throw invalid;
    }
    await this.redis.client.del(this.throttleKey(email, ip));

    const principal = await this.principals.load(user.id);
    if (!principal) throw invalid;

    const sessionId = await this.sessions.create(user.id);

    const primaryOrg = principal.memberships[0];
    if (primaryOrg) {
      await this.audit.record({
        organizationId: primaryOrg.organizationId,
        actorUserId: user.id,
        action: 'auth.login',
        resourceType: 'User',
        resourceId: user.id,
        correlationId: correlationId ?? null,
      });
    }

    return { sessionId, principal };
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessions.destroy(sessionId);
  }

  /** Profile + memberships + all workspaces the caller may access. */
  async me(principal: Principal): Promise<AuthMeResponse> {
    const user = await this.prisma.client.user.findUniqueOrThrow({
      where: { id: principal.userId },
      select: { id: true, email: true, name: true, timezone: true, locale: true },
    });

    const orgIds = principal.memberships.map((m) => m.organizationId);
    const workspaces =
      orgIds.length === 0
        ? []
        : await this.prisma.client.workspace.findMany({
            where: { organizationId: { in: orgIds }, deletedAt: null, status: 'ACTIVE' },
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              organizationId: true,
              slug: true,
              name: true,
              timezone: true,
            },
          });

    const accessible = workspaces.filter((ws) => {
      const membership = principal.memberships.find((m) => m.organizationId === ws.organizationId);
      if (!membership) return false;
      return membership.workspaceIds.length === 0 || membership.workspaceIds.includes(ws.id);
    });

    return {
      user,
      memberships: principal.memberships.map((m) => ({
        organizationId: m.organizationId,
        organizationName: m.organizationName,
        organizationSlug: m.organizationSlug,
        role: m.role,
        extraPermissions: m.extraPermissions,
        workspaceIds: m.workspaceIds,
      })),
      workspaces: accessible,
    };
  }
}
