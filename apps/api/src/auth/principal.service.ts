import { Injectable } from '@nestjs/common';
import type { Permission, Role } from '@spectra/contracts';

import { PrismaService } from '../prisma/prisma.service';
import type { Principal } from './types';

/** Builds the Principal fresh from the database on every request. */
@Injectable()
export class PrincipalService {
  constructor(private readonly prisma: PrismaService) {}

  async load(userId: string): Promise<Principal | null> {
    const user = await this.prisma.client.user.findFirst({
      where: { id: userId, deletedAt: null, status: 'ACTIVE' },
      include: {
        memberships: {
          where: { status: 'ACTIVE', deletedAt: null },
          include: { organization: { select: { id: true, name: true, slug: true, status: true } } },
        },
      },
    });
    if (!user) return null;

    return {
      userId: user.id,
      email: user.email,
      name: user.name,
      memberships: user.memberships
        .filter((m) => m.organization.status === 'ACTIVE')
        .map((m) => ({
          organizationId: m.organizationId,
          organizationName: m.organization.name,
          organizationSlug: m.organization.slug,
          role: m.role as Role,
          extraPermissions: m.extraPermissions as Permission[],
          workspaceIds: m.workspaceIds,
        })),
    };
  }
}
