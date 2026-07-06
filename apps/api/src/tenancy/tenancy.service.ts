import { ConflictException, Injectable } from '@nestjs/common';
import type { CreateWorkspaceInput } from '@spectra/contracts';
import { Prisma, type Workspace } from '@spectra/database';

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
}
