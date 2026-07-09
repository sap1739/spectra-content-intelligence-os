import {
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  InvalidLifecycleTransitionError,
  assertTransitionContent,
  type ContentLifecycleState,
  type CreateContentItemInput,
  type GenerateDraftInput,
  type ReviewNoteInput,
  type UpdateContentBodyInput,
} from '@spectra/contracts';
import { moderateContent, type ModerationOutcome } from '@spectra/content-pipeline';
import { TenantIsolationError } from '@spectra/security';
import { JOB_NAMES } from '@spectra/workflow-core';

import { AiTextService } from '../infra/ai.service';
import { AuditService } from '../infra/audit.service';
import { QueueService } from '../infra/queue.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

@Injectable()
export class ContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ai: AiTextService,
    private readonly queue: QueueService,
  ) {}

  list(tenant: TenantContext) {
    return this.prisma.client.contentItem.findMany({
      where: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /** READY evidence packs across the workspace — the grounding menu for Studio. */
  listEvidencePacks(tenant: TenantContext) {
    return this.prisma.client.evidencePack.findMany({
      where: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        status: 'READY',
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        title: true,
        summary: true,
        topicKey: true,
        status: true,
        findingIds: true,
        citationIds: true,
        updatedAt: true,
      },
    });
  }

  async get(tenant: TenantContext, id: string) {
    const item = await this.prisma.client.contentItem.findFirst({
      where: {
        id,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        deletedAt: null,
      },
      include: { drafts: { orderBy: { createdAt: 'desc' } } },
    });
    if (!item) throw new TenantIsolationError();
    return item;
  }

  /** Missing and foreign resources fail identically — no existence leak. */
  private async loadPack(tenant: TenantContext, packId: string) {
    const pack = await this.prisma.client.evidencePack.findFirst({
      where: {
        id: packId,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
      },
    });
    if (!pack) throw new TenantIsolationError();
    return pack;
  }

  private async assertTenantRef(
    tenant: TenantContext,
    model: 'campaign' | 'brand' | 'customVertical',
    id: string | undefined,
  ): Promise<void> {
    if (!id) return;
    const delegate = this.prisma.client[model] as {
      findFirst: (args: unknown) => Promise<{ id: string } | null>;
    };
    const found = await delegate.findFirst({
      where: {
        id,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!found) throw new TenantIsolationError();
  }

  async create(tenant: TenantContext, principal: Principal, input: CreateContentItemInput) {
    await this.assertTenantRef(tenant, 'campaign', input.campaignId);
    await this.assertTenantRef(tenant, 'brand', input.brandId);
    await this.assertTenantRef(tenant, 'customVertical', input.verticalId);

    let grounding: {
      evidencePackId: string | null;
      researchProjectId: string | null;
      topicKey: string | null;
      findingIds: string[];
      citationIds: string[];
      lifecycleState: 'IDEA' | 'RESEARCH_READY';
    } = {
      evidencePackId: null,
      researchProjectId: null,
      topicKey: null,
      findingIds: [],
      citationIds: [],
      lifecycleState: 'IDEA',
    };

    if (input.evidencePackId) {
      const pack = await this.loadPack(tenant, input.evidencePackId);
      grounding = {
        evidencePackId: pack.id,
        researchProjectId: pack.projectId,
        topicKey: pack.topicKey,
        findingIds: pack.findingIds,
        citationIds: pack.citationIds,
        lifecycleState: 'RESEARCH_READY',
      };
    }

    const item = await this.prisma.client.contentItem.create({
      data: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        title: input.title,
        contentType: input.contentType,
        ...(input.objective ? { objective: input.objective } : {}),
        ...(input.funnelStage ? { funnelStage: input.funnelStage } : {}),
        ...(input.campaignId ? { campaignId: input.campaignId } : {}),
        ...(input.brandId ? { brandId: input.brandId } : {}),
        ...(input.verticalId ? { verticalId: input.verticalId } : {}),
        evidencePackId: grounding.evidencePackId,
        researchProjectId: grounding.researchProjectId,
        topicKey: grounding.topicKey,
        findingIds: grounding.findingIds,
        citationIds: grounding.citationIds,
        lifecycleState: grounding.lifecycleState,
        createdById: principal.userId,
      },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'content_item.created',
      resourceType: 'ContentItem',
      resourceId: item.id,
      changes: { title: input.title, contentType: input.contentType },
    });
    return item;
  }

  listDrafts(tenant: TenantContext, contentItemId: string) {
    return this.prisma.client.contentDraft.findMany({
      where: {
        contentItemId,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /**
   * Queues an evidence-grounded draft. The honesty guards run synchronously so
   * the caller gets an immediate, truthful answer:
   * - no configured provider  → 503 (never fabricated text), no draft row;
   * - item not grounded        → 503, nothing to cite.
   * Otherwise a GENERATING draft is created and a job enqueued; the worker
   * generates, validates citations, and flips it to READY/FAILED.
   */
  async generate(
    tenant: TenantContext,
    principal: Principal,
    contentItemId: string,
    _input: GenerateDraftInput,
  ) {
    const item = await this.get(tenant, contentItemId);

    if (!this.ai.isConfigured) {
      throw new ServiceUnavailableException(
        'AI text generation is not configured. Set ANTHROPIC_API_KEY to enable drafting.',
      );
    }
    if (!item.evidencePackId) {
      throw new ServiceUnavailableException(
        'This content item is not grounded on an evidence pack. Attach research evidence before drafting.',
      );
    }

    const draft = await this.prisma.client.contentDraft.create({
      data: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        contentItemId: item.id,
        status: 'GENERATING',
        evidencePackId: item.evidencePackId,
        createdById: principal.userId,
      },
    });

    await this.queue.enqueue(
      JOB_NAMES.contentDraftGenerate,
      { draftId: draft.id },
      {
        tenant: {
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId as string,
        },
      },
    );

    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'content_draft.queued',
      resourceType: 'ContentDraft',
      resourceId: draft.id,
    });

    return draft;
  }

  // --- Lifecycle, human edits, review & approval ---------------------------

  /** Validated transition helper — maps the contract error to 422. */
  private assertTransition(from: string, to: ContentLifecycleState): void {
    try {
      assertTransitionContent(from as ContentLifecycleState, to);
    } catch (error) {
      if (error instanceof InvalidLifecycleTransitionError) {
        throw new UnprocessableEntityException(error.message);
      }
      throw error;
    }
  }

  /** A human edit: replaces the body and records who/when. Moves to EDITING. */
  async updateBody(
    tenant: TenantContext,
    principal: Principal,
    id: string,
    input: UpdateContentBodyInput,
  ) {
    const item = await this.get(tenant, id);
    if (item.lifecycleState !== 'EDITING') {
      this.assertTransition(item.lifecycleState, 'EDITING');
    }
    const edit = {
      editedById: principal.userId,
      editedAt: new Date().toISOString(),
      note: input.note ?? null,
    };
    const updated = await this.prisma.client.contentItem.update({
      where: { id },
      data: {
        body: input.body,
        lifecycleState: 'EDITING',
        humanEdits: [...(item.humanEdits as unknown[]), edit],
      },
    });
    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'content_item.edited',
      resourceType: 'ContentItem',
      resourceId: id,
    });
    return updated;
  }

  async submitForReview(tenant: TenantContext, principal: Principal, id: string) {
    const item = await this.get(tenant, id);
    this.assertTransition(item.lifecycleState, 'REVIEW');
    return this.transition(tenant, principal, id, 'REVIEW', 'content_item.submitted');
  }

  async requestChanges(
    tenant: TenantContext,
    principal: Principal,
    id: string,
    input: ReviewNoteInput,
  ) {
    const item = await this.get(tenant, id);
    this.assertTransition(item.lifecycleState, 'CHANGES_REQUESTED');
    return this.decide(
      tenant,
      principal,
      item,
      'CHANGES_REQUESTED',
      'CHANGES_REQUESTED',
      input.note,
    );
  }

  async reject(tenant: TenantContext, principal: Principal, id: string, input: ReviewNoteInput) {
    const item = await this.get(tenant, id);
    this.assertTransition(item.lifecycleState, 'ARCHIVED');
    return this.decide(tenant, principal, item, 'REJECTED', 'ARCHIVED', input.note);
  }

  /**
   * Approve. When AI is configured the body is moderated first; a FLAGGED
   * verdict blocks approval (422) — nothing unsafe is silently approved. With
   * no provider, moderation is honestly recorded as SKIPPED (not faked).
   */
  async approve(tenant: TenantContext, principal: Principal, id: string, input: ReviewNoteInput) {
    const item = await this.get(tenant, id);
    this.assertTransition(item.lifecycleState, 'APPROVED');

    let moderation:
      (ModerationOutcome & { moderatedAt: string }) | { status: 'SKIPPED'; moderatedAt: string };
    if (this.ai.isConfigured && item.body) {
      const outcome = await moderateContent(
        this.ai.provider,
        { organizationId: tenant.organizationId, workspaceId: tenant.workspaceId as string },
        item.body,
      );
      moderation = { ...outcome, moderatedAt: new Date().toISOString() };
      if (outcome.status === 'FLAGGED') {
        await this.prisma.client.contentItem.update({
          where: { id },
          data: { moderation: moderation as unknown as object },
        });
        throw new UnprocessableEntityException(
          `Content was flagged by moderation (${outcome.categories.join(', ') || 'unspecified'}) and cannot be approved.`,
        );
      }
    } else {
      moderation = { status: 'SKIPPED', moderatedAt: new Date().toISOString() };
    }

    const approval = {
      approverId: principal.userId,
      decision: 'APPROVED' as const,
      decidedAt: new Date().toISOString(),
      note: input.note ?? null,
    };
    const updated = await this.prisma.client.contentItem.update({
      where: { id },
      data: {
        lifecycleState: 'APPROVED',
        approvals: [...(item.approvals as unknown[]), approval],
        moderation: moderation as unknown as object,
      },
    });
    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'content_item.approved',
      resourceType: 'ContentItem',
      resourceId: id,
      changes: { moderation: moderation.status },
    });
    return updated;
  }

  private async transition(
    tenant: TenantContext,
    principal: Principal,
    id: string,
    to: ContentLifecycleState,
    action: string,
  ) {
    const updated = await this.prisma.client.contentItem.update({
      where: { id },
      data: { lifecycleState: to },
    });
    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action,
      resourceType: 'ContentItem',
      resourceId: id,
    });
    return updated;
  }

  private async decide(
    tenant: TenantContext,
    principal: Principal,
    item: { id: string; approvals: unknown },
    decision: 'CHANGES_REQUESTED' | 'REJECTED',
    to: ContentLifecycleState,
    note?: string,
  ) {
    const approval = {
      approverId: principal.userId,
      decision,
      decidedAt: new Date().toISOString(),
      note: note ?? null,
    };
    const updated = await this.prisma.client.contentItem.update({
      where: { id: item.id },
      data: {
        lifecycleState: to,
        approvals: [...(item.approvals as unknown[]), approval],
      },
    });
    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: `content_item.${decision.toLowerCase()}`,
      resourceType: 'ContentItem',
      resourceId: item.id,
    });
    return updated;
  }
}
