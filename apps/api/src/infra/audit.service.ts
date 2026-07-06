import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@spectra/database';
import { deepRedact } from '@spectra/security';

import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntryInput {
  organizationId: string;
  workspaceId?: string | null;
  actorType?: 'USER' | 'SYSTEM' | 'API_CLIENT';
  actorUserId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  correlationId?: string | null;
  changes?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only audit trail. Change sets pass through deepRedact so secrets can
 * never land in audit rows. Failures are logged, never thrown — auditing must
 * not break the primary operation.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntryInput): Promise<void> {
    try {
      await this.prisma.client.auditLog.create({
        data: {
          organizationId: entry.organizationId,
          workspaceId: entry.workspaceId ?? null,
          actorType: entry.actorType ?? 'USER',
          actorUserId: entry.actorUserId ?? null,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId ?? null,
          correlationId: entry.correlationId ?? null,
          changes: entry.changes ? (deepRedact(entry.changes) as Prisma.InputJsonValue) : undefined,
          metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      this.logger.warn(
        { action: entry.action, err: error instanceof Error ? error.message : error },
        'Audit write failed',
      );
    }
  }
}
