import { ConflictException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { CreateBrandInput, UpdateBrandInput, UpdateBrandKitInput } from '@spectra/contracts';
import { Prisma, type Brand } from '@spectra/database';
import { TenantIsolationError } from '@spectra/security';

import { definedOnly } from '../common/data';
import { slugify, uniqueSuffix } from '../common/slug';
import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

/** Maps nullable Json inputs to Prisma's JsonNull sentinel. */
function jsonOrNull(value: unknown) {
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue | undefined);
}

@Injectable()
export class BrandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(tenant: TenantContext) {
    return this.prisma.client.brand.findMany({
      where: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(tenant: TenantContext, id: string) {
    const brand = await this.prisma.client.brand.findFirst({
      where: {
        id,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        deletedAt: null,
      },
    });
    if (!brand) throw new TenantIsolationError();
    return brand;
  }

  async create(
    tenant: TenantContext,
    principal: Principal,
    input: CreateBrandInput,
  ): Promise<Brand> {
    const slug = input.slug ?? slugify(input.name);
    const { slug: _ignored, voice, ...fields } = input;
    try {
      const brand = await this.prisma.client.brand.create({
        data: {
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId as string,
          slug,
          status: 'ACTIVE',
          ...definedOnly(fields),
          ...(voice !== undefined ? { voice: jsonOrNull(voice) } : {}),
        } as Prisma.BrandUncheckedCreateInput,
      });
      await this.audit.record({
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        actorUserId: principal.userId,
        action: 'brand.created',
        resourceType: 'Brand',
        resourceId: brand.id,
        changes: { name: input.name, slug },
      });
      return brand;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        if (!input.slug) {
          return this.create(tenant, principal, { ...input, slug: `${slug}-${uniqueSuffix()}` });
        }
        throw new ConflictException(`A brand with slug "${slug}" already exists`);
      }
      throw error;
    }
  }

  async update(tenant: TenantContext, principal: Principal, id: string, input: UpdateBrandInput) {
    await this.get(tenant, id);
    const { voice, ...fields } = input;
    const brand = await this.prisma.client.brand.update({
      where: { id },
      data: {
        ...definedOnly(fields),
        ...(voice !== undefined ? { voice: jsonOrNull(voice) } : {}),
      } as Prisma.BrandUncheckedUpdateInput,
    });
    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'brand.updated',
      resourceType: 'Brand',
      resourceId: id,
      changes: definedOnly(fields),
    });
    return brand;
  }

  /**
   * Sets the brand kit (Phase 7A, ADR-0040). A logo must be a PNG, JPEG or WebP
   * media asset and a font a TTF/OTF media asset, both in THIS workspace — a
   * foreign or missing asset is refused the same way, so a kit can never point
   * a render at another tenant's file.
   */
  async updateKit(
    tenant: TenantContext,
    principal: Principal,
    id: string,
    input: UpdateBrandKitInput,
  ) {
    await this.get(tenant, id);
    const scope = {
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId as string,
    };
    const check = async (assetId: string, allowed: string[], label: string) => {
      const asset = await this.prisma.client.mediaAsset.findFirst({
        where: { id: assetId, ...scope },
        select: { mimeType: true },
      });
      if (!asset || !allowed.includes(asset.mimeType)) {
        throw new UnprocessableEntityException(
          `The ${label} must be a ${allowed.join(', ')} media asset in this workspace.`,
        );
      }
    };
    if (input.logoAssetId)
      await check(input.logoAssetId, ['image/png', 'image/jpeg', 'image/webp'], 'logo');
    for (const role of ['heading', 'body'] as const) {
      const fontAssetId = input.typography?.[role]?.fontAssetId;
      if (fontAssetId) await check(fontAssetId, ['font/ttf', 'font/otf'], `${role} font`);
    }
    const brand = await this.prisma.client.brand.update({
      where: { id },
      data: {
        ...(input.logoAssetId !== undefined ? { logoAssetId: input.logoAssetId } : {}),
        ...(input.palette !== undefined ? { palette: input.palette as Prisma.InputJsonValue } : {}),
        ...(input.typography !== undefined
          ? { typography: input.typography as Prisma.InputJsonValue }
          : {}),
        ...(input.tagline !== undefined ? { tagline: input.tagline } : {}),
        ...(input.visualStyle !== undefined ? { visualStyle: input.visualStyle } : {}),
        ...(input.offerings !== undefined
          ? { offerings: input.offerings as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });
    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'brand.kit_updated',
      resourceType: 'Brand',
      resourceId: id,
      changes: { fields: Object.keys(input) },
    });
    return brand;
  }

  async archive(tenant: TenantContext, principal: Principal, id: string) {
    await this.get(tenant, id);
    const brand = await this.prisma.client.brand.update({
      where: { id },
      data: { status: 'ARCHIVED', deletedAt: new Date() },
    });
    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'brand.archived',
      resourceType: 'Brand',
      resourceId: id,
    });
    return brand;
  }
}
