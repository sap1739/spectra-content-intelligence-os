import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { RegisterSocialAccountInput, ValidateVariantInput } from '@spectra/contracts';
import { TenantIsolationError } from '@spectra/security';
import {
  allPlatformCapabilities,
  getPlatformCapability,
  socialPublisherRegistry,
  validateVariant,
} from '@spectra/social-core';
import { WordPressCredentialError, parseWordPressCredential } from '@spectra/social-wordpress';

import { AuditService } from '../infra/audit.service';
import { SocialCryptoService } from '../infra/social-crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

/** Public account projection — the sealed credential is NEVER selected. */
const ACCOUNT_SELECT = {
  id: true,
  platform: true,
  externalAccountId: true,
  displayName: true,
  kind: true,
  status: true,
  scopes: true,
  tokenRef: true,
  connectedById: true,
  connectedAt: true,
  lastRefreshedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class SocialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: SocialCryptoService,
  ) {}

  /** Declared capabilities + whether a live publisher is wired (none yet). */
  platforms() {
    return {
      credentialStorageConfigured: this.crypto.isConfigured,
      platforms: allPlatformCapabilities().map((capability) => ({
        capability,
        publisherWired: socialPublisherRegistry.isWired(capability.platform),
      })),
    };
  }

  validate(input: ValidateVariantInput) {
    return validateVariant(getPlatformCapability(input.platform), {
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.hashtagCount !== undefined ? { hashtagCount: input.hashtagCount } : {}),
      ...(input.mediaCount !== undefined ? { mediaCount: input.mediaCount } : {}),
      ...(input.mediaKinds !== undefined ? { mediaKinds: input.mediaKinds } : {}),
    });
  }

  list(tenant: TenantContext) {
    return this.prisma.client.socialAccount.findMany({
      where: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: ACCOUNT_SELECT,
    });
  }

  async register(tenant: TenantContext, principal: Principal, input: RegisterSocialAccountInput) {
    let tokenRef: string | null = null;
    let encryptedToken: string | null = null;

    if (input.accessToken) {
      if (!this.crypto.isConfigured) {
        throw new ServiceUnavailableException(
          'Credential storage is not configured (SOCIAL_TOKEN_ENCRYPTION_KEY). ' +
            'Register the account without a token, or configure the key.',
        );
      }
      // WordPress uses application-password Basic auth: the credential must be
      // "username:application-password" and the account id a valid site URL.
      // Reject a malformed one now so it never seals a credential the worker
      // can't use.
      if (input.platform === 'WORDPRESS') {
        try {
          parseWordPressCredential(input.externalAccountId, input.accessToken);
          new URL(input.externalAccountId);
        } catch (error) {
          throw new BadRequestException(
            error instanceof WordPressCredentialError
              ? error.message
              : 'WordPress requires a site URL and a "username:application-password" credential.',
          );
        }
      }
      encryptedToken = this.crypto.seal(input.accessToken);
      tokenRef = randomUUID();
    }

    const account = await this.prisma.client.socialAccount.create({
      data: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        platform: input.platform,
        externalAccountId: input.externalAccountId,
        displayName: input.displayName,
        kind: input.kind,
        scopes: input.scopes,
        // PENDING: registered target, not OAuth-verified (no live adapter wired).
        status: 'PENDING',
        tokenRef,
        encryptedToken,
        connectedById: principal.userId,
      },
      select: ACCOUNT_SELECT,
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'social_account.registered',
      resourceType: 'SocialAccount',
      resourceId: account.id,
      changes: { platform: input.platform, hasCredential: encryptedToken !== null },
    });
    return account;
  }

  async disconnect(tenant: TenantContext, principal: Principal, id: string) {
    const existing = await this.prisma.client.socialAccount.findFirst({
      where: {
        id,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!existing) throw new TenantIsolationError();

    // Soft-delete and purge the sealed credential.
    await this.prisma.client.socialAccount.update({
      where: { id },
      data: { deletedAt: new Date(), status: 'REVOKED', encryptedToken: null, tokenRef: null },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'social_account.disconnected',
      resourceType: 'SocialAccount',
      resourceId: id,
    });
  }
}
