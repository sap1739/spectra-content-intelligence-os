import { Injectable } from '@nestjs/common';
import type { CreateResearchProjectInput, UpdateResearchProjectInput } from '@spectra/contracts';
import { Prisma } from '@spectra/database';
import { TenantIsolationError } from '@spectra/security';

import { definedOnly } from '../common/data';
import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

@Injectable()
export class ResearchProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(tenant: TenantContext) {
    return this.prisma.client.researchProject.findMany({
      where: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(tenant: TenantContext, id: string) {
    const project = await this.prisma.client.researchProject.findFirst({
      where: {
        id,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        deletedAt: null,
      },
    });
    if (!project) throw new TenantIsolationError();
    return project;
  }

  /** Referenced vertical/brand must live in the same tenant — 404 otherwise. */
  private async assertReferences(
    tenant: TenantContext,
    input: { verticalId?: string; brandId?: string },
  ): Promise<void> {
    if (input.verticalId) {
      const vertical = await this.prisma.client.customVertical.findFirst({
        where: {
          id: input.verticalId,
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId as string,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!vertical) throw new TenantIsolationError();
    }
    if (input.brandId) {
      const brand = await this.prisma.client.brand.findFirst({
        where: {
          id: input.brandId,
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId as string,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!brand) throw new TenantIsolationError();
    }
  }

  async create(tenant: TenantContext, principal: Principal, input: CreateResearchProjectInput) {
    await this.assertReferences(tenant, input);
    const project = await this.prisma.client.researchProject.create({
      data: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        createdById: principal.userId,
        status: 'DRAFT',
        ...definedOnly(input),
      } as Prisma.ResearchProjectUncheckedCreateInput,
    });
    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'research_project.created',
      resourceType: 'ResearchProject',
      resourceId: project.id,
      changes: { name: input.name },
    });
    return project;
  }

  async update(
    tenant: TenantContext,
    principal: Principal,
    id: string,
    input: UpdateResearchProjectInput,
  ) {
    await this.get(tenant, id);
    await this.assertReferences(tenant, input);
    const project = await this.prisma.client.researchProject.update({
      where: { id },
      data: definedOnly(input) as Prisma.ResearchProjectUncheckedUpdateInput,
    });
    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'research_project.updated',
      resourceType: 'ResearchProject',
      resourceId: id,
      changes: definedOnly(input),
    });
    return project;
  }

  async archive(tenant: TenantContext, principal: Principal, id: string) {
    await this.get(tenant, id);
    const project = await this.prisma.client.researchProject.update({
      where: { id },
      data: { status: 'ARCHIVED', deletedAt: new Date() },
    });
    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'research_project.archived',
      resourceType: 'ResearchProject',
      resourceId: id,
    });
    return project;
  }
}
