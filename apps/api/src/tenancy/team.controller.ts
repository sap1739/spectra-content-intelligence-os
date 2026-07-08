import { randomBytes } from 'node:crypto';

import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createInvitationInputSchema, type CreateInvitationInput } from '@spectra/contracts';
import { TenantIsolationError } from '@spectra/security';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

const INVITATION_TTL_DAYS = 14;

@ApiTags('tenancy')
@Controller({ path: 'organizations/:organizationId', version: '1' })
export class TeamController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get('members')
  @ApiOperation({ summary: 'Members of the organization' })
  async members(
    @Param('organizationId', ParseUUIDPipe) _organizationId: string,
    @CurrentTenant() tenant: TenantContext,
  ) {
    const memberships = await this.prisma.client.membership.findMany({
      where: { organizationId: tenant.organizationId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, email: true, name: true, status: true } } },
    });
    return memberships.map((m) => ({
      membershipId: m.id,
      role: m.role,
      status: m.status,
      joinedAt: m.createdAt,
      user: m.user,
    }));
  }

  @Get('invitations')
  @RequirePermissions('org:members:manage')
  @ApiOperation({ summary: 'Pending invitations (link-based — no email is sent yet)' })
  invitations(
    @Param('organizationId', ParseUUIDPipe) _organizationId: string,
    @CurrentTenant() tenant: TenantContext,
  ) {
    return this.prisma.client.invitation.findMany({
      where: {
        organizationId: tenant.organizationId,
        acceptedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Post('invitations')
  @RequirePermissions('org:members:manage')
  @ApiOperation({
    summary:
      'Invite an email to the organization with a role. No SMTP integration exists yet — share the register link; signing up with this email joins automatically.',
  })
  async invite(
    @Param('organizationId', ParseUUIDPipe) _organizationId: string,
    @Body(new ZodValidationPipe(createInvitationInputSchema)) body: CreateInvitationInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    const email = body.email.toLowerCase();

    const existingMember = await this.prisma.client.membership.findFirst({
      where: {
        organizationId: tenant.organizationId,
        deletedAt: null,
        user: { email },
      },
      select: { id: true },
    });
    if (existingMember) {
      throw new ConflictException('This email already belongs to a member');
    }

    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000);
    const invitation = await this.prisma.client.invitation.upsert({
      where: {
        organizationId_email: { organizationId: tenant.organizationId, email },
      },
      create: {
        organizationId: tenant.organizationId,
        email,
        role: body.role,
        token: randomBytes(24).toString('base64url'),
        invitedById: principal.userId,
        expiresAt,
      },
      update: {
        role: body.role,
        invitedById: principal.userId,
        expiresAt,
        acceptedAt: null,
      },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      actorUserId: principal.userId,
      action: 'invitation.created',
      resourceType: 'Invitation',
      resourceId: invitation.id,
      changes: { email, role: body.role },
    });
    return invitation;
  }

  @Delete('invitations/:invitationId')
  @HttpCode(204)
  @RequirePermissions('org:members:manage')
  @ApiOperation({ summary: 'Revoke a pending invitation' })
  async revoke(
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    const invitation = await this.prisma.client.invitation.findFirst({
      where: { id: invitationId, organizationId: tenant.organizationId },
      select: { id: true },
    });
    if (!invitation) throw new TenantIsolationError();
    await this.prisma.client.invitation.delete({ where: { id: invitationId } });
    await this.audit.record({
      organizationId: tenant.organizationId,
      actorUserId: principal.userId,
      action: 'invitation.revoked',
      resourceType: 'Invitation',
      resourceId: invitationId,
    });
  }
}
