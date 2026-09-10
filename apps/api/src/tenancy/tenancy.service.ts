import { ConflictException, Injectable } from '@nestjs/common';
import type {
  CreateWorkspaceInput,
  UpdateOrganizationInput,
  UpdateUserPreferencesInput,
  UpdateWorkspaceInput,
} from '@spectra/contracts';
import { Prisma, type Workspace } from '@spectra/database';
import { TenantIsolationError } from '@spectra/security';

import { slugify, uniqueSuffix } from '../common/slug';
import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

@Injectable()
export class TenancyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listWorkspaces(tenant: TenantContext) {
    const workspaces = await this.prisma.client.workspace.findMany({
      where: { organizationId: tenant.organizationId, deletedAt: null, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
    const restriction = tenant.membership.workspaceIds;
    return restriction.length === 0
      ? workspaces
      : workspaces.filter((ws) => restriction.includes(ws.id));
  }

  async createWorkspace(
    tenant: TenantContext,
    principal: Principal,
    input: CreateWorkspaceInput,
  ): Promise<Workspace> {
    const slug = input.slug ?? slugify(input.name);
    try {
      const workspace = await this.prisma.client.workspace.create({
        data: {
          organizationId: tenant.organizationId,
          name: input.name,
          slug,
          description: input.description ?? null,
          timezone: input.timezone,
          status: 'ACTIVE',
        },
      });
      await this.audit.record({
        organizationId: tenant.organizationId,
        workspaceId: workspace.id,
        actorUserId: principal.userId,
        action: 'workspace.created',
        resourceType: 'Workspace',
        resourceId: workspace.id,
        changes: { name: input.name, slug },
      });
      return workspace;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Retry once with a uniqueness suffix before surfacing a conflict.
        if (!input.slug) {
          return this.createWorkspace(tenant, principal, {
            ...input,
            slug: `${slug}-${uniqueSuffix()}`,
          });
        }
        throw new ConflictException(`A workspace with slug "${slug}" already exists`);
      }
      throw error;
    }
  }

  /** Updates the active workspace. Only persisted fields are accepted. */
  async updateWorkspace(
    tenant: TenantContext,
    principal: Principal,
    input: UpdateWorkspaceInput,
  ): Promise<Workspace> {
    const workspaceId = tenant.workspaceId as string;
    const existing = await this.prisma.client.workspace.findFirst({
      where: { id: workspaceId, organizationId: tenant.organizationId, deletedAt: null },
      select: { id: true },
    });
    // Missing and foreign resources look identical — no existence leak.
    if (!existing) throw new TenantIsolationError();

    const workspace = await this.prisma.client.workspace.update({
      where: { id: workspaceId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description ?? null } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      },
    });
    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId,
      actorUserId: principal.userId,
      action: 'workspace.updated',
      resourceType: 'Workspace',
      resourceId: workspaceId,
      changes: { ...input },
    });
    return workspace as unknown as Workspace;
  }

  /** Renames the organization. There is no org timezone column to set. */
  async updateOrganization(
    tenant: TenantContext,
    principal: Principal,
    input: UpdateOrganizationInput,
  ) {
    const organization = await this.prisma.client.organization.update({
      where: { id: tenant.organizationId },
      data: { name: input.name },
      select: { id: true, name: true, slug: true, status: true, updatedAt: true },
    });
    await this.audit.record({
      organizationId: tenant.organizationId,
      actorUserId: principal.userId,
      action: 'organization.updated',
      resourceType: 'Organization',
      resourceId: tenant.organizationId,
      changes: { ...input },
    });
    return organization;
  }

  /** Updates the caller's own preferences. Never another user's. */
  async updateUserPreferences(principal: Principal, input: UpdateUserPreferencesInput) {
    return this.prisma.client.user.update({
      where: { id: principal.userId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
      },
      select: { id: true, email: true, name: true, timezone: true, locale: true },
    });
  }
}
