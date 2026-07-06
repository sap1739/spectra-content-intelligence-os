import { ConflictException, Injectable } from '@nestjs/common';
import type { CreateVerticalInput, UpdateVerticalInput } from '@spectra/contracts';
import { Prisma, type CustomVertical } from '@spectra/database';
import { TenantIsolationError } from '@spectra/security';

import { definedOnly } from '../common/data';
import { slugify, uniqueSuffix } from '../common/slug';
import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

@Injectable()
export class VerticalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(tenant: TenantContext) {
    return this.prisma.client.customVertical.findMany({
      where: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(tenant: TenantContext, id: string) {
    const vertical = await this.prisma.client.customVertical.findFirst({
      where: {
        id,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        deletedAt: null,
      },
    });
    if (!vertical) throw new TenantIsolationError();
    return vertical;
  }

  async create(
    tenant: TenantContext,
    principal: Principal,
    input: CreateVerticalInput,
  ): Promise<CustomVertical> {
    const slug = input.slug ?? slugify(input.name);
    const { slug: _ignored, ...fields } = input;
    try {
      const vertical = await this.prisma.client.customVertical.create({
        data: {
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId as string,
          slug,
          status: 'ACTIVE',
          ...definedOnly(fields),
        } as Prisma.CustomVerticalUncheckedCreateInput,
      });
      await this.audit.record({
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        actorUserId: principal.userId,
        action: 'vertical.created',
        resourceType: 'CustomVertical',
        resourceId: vertical.id,
        changes: { name: input.name, slug },
      });
      return vertical;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        if (!input.slug) {
          return this.create(tenant, principal, { ...input, slug: `${slug}-${uniqueSuffix()}` });
        }
        throw new ConflictException(`A vertical with slug "${slug}" already exists`);
      }
      throw error;
    }
  }

  async update(
    tenant: TenantContext,
    principal: Principal,
    id: string,
    input: UpdateVerticalInput,
  ) {
    await this.get(tenant, id); // tenant assertion — 404 on foreign/missing
    const vertical = await this.prisma.client.customVertical.update({
      where: { id },
      data: definedOnly(input) as Prisma.CustomVerticalUncheckedUpdateInput,
    });
    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'vertical.updated',
      resourceType: 'CustomVertical',
      resourceId: id,
      changes: definedOnly(input),
    });
    return vertical;
  }

  async archive(tenant: TenantContext, principal: Principal, id: string) {
    await this.get(tenant, id);
    const vertical = await this.prisma.client.customVertical.update({
      where: { id },
      data: { status: 'ARCHIVED', deletedAt: new Date() },
    });
    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'vertical.archived',
      resourceType: 'CustomVertical',
      resourceId: id,
    });
    return vertical;
  }
}
