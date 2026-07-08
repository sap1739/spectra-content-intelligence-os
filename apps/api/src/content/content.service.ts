import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { CreateContentItemInput, GenerateDraftInput } from '@spectra/contracts';
import { AiProviderUnavailableError } from '@spectra/ai-anthropic';
import {
  type DraftEvidence,
  type GroundingCitation,
  type GroundingFinding,
  generateDraft,
} from '@spectra/content-pipeline';

import { AiTextService } from '../infra/ai.service';
import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantIsolationError } from '@spectra/security';
import type { Principal, TenantContext } from '../auth/types';

@Injectable()
export class ContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ai: AiTextService,
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

  /** Assembles grounding evidence for an item from its evidence pack. */
  private async loadEvidence(tenant: TenantContext, packId: string): Promise<DraftEvidence> {
    const pack = await this.loadPack(tenant, packId);

    const findingRows = pack.findingIds.length
      ? await this.prisma.client.researchFinding.findMany({
          where: {
            id: { in: pack.findingIds },
            organizationId: tenant.organizationId,
            workspaceId: tenant.workspaceId as string,
          },
          select: {
            id: true,
            summary: true,
            excerpt: true,
            source: { select: { url: true, title: true, publisher: true } },
          },
          take: 12,
        })
      : [];

    const citationRows = pack.citationIds.length
      ? await this.prisma.client.citation.findMany({
          where: {
            id: { in: pack.citationIds },
            organizationId: tenant.organizationId,
            workspaceId: tenant.workspaceId as string,
          },
          select: {
            id: true,
            excerpt: true,
            url: true,
            title: true,
            publisher: true,
            findingId: true,
          },
          take: 12,
        })
      : [];

    const findings: GroundingFinding[] = findingRows.map((f) => ({
      id: f.id,
      summary: f.summary,
      excerpt: f.excerpt,
      sourceTitle: f.source.title ?? f.source.publisher,
      sourceUrl: f.source.url,
    }));

    const citations: GroundingCitation[] = citationRows
      .filter((c) => c.excerpt)
      .map((c) => ({
        id: c.id,
        quote: c.excerpt as string,
        sourceTitle: c.title ?? c.publisher,
        sourceUrl: c.url,
        findingId: c.findingId,
      }));

    return {
      packId: pack.id,
      packTitle: pack.title,
      packSummary: pack.summary,
      findings,
      citations,
    };
  }

  /**
   * Generates an evidence-grounded draft. Requires the item to be grounded on
   * an evidence pack (no pack => nothing to ground on => 422-style guard). If
   * the AI provider is unconfigured, returns 503 — never fabricated output.
   */
  async generate(
    tenant: TenantContext,
    principal: Principal,
    contentItemId: string,
    input: GenerateDraftInput,
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

    const evidence = await this.loadEvidence(tenant, item.evidencePackId);

    // Record the attempt up-front so failures are auditable, not silent.
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

    try {
      const result = await generateDraft(this.ai.provider, {
        tenant: {
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId as string,
        },
        contentType: item.contentType,
        title: item.title,
        objective: item.objective,
        funnelStage: item.funnelStage,
        ...(input.targetPlatform ? { targetPlatform: input.targetPlatform } : {}),
        ...(input.additionalGuidance ? { additionalGuidance: input.additionalGuidance } : {}),
        evidence,
        ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
      });

      const updated = await this.prisma.client.contentDraft.update({
        where: { id: draft.id },
        data: {
          status: result.finishReason === 'content_filter' ? 'FAILED' : 'READY',
          body: result.body,
          citationIds: result.groundedCitationIds,
          findingIds: result.groundedFindingIds,
          modelProvider: result.modelRef.provider,
          modelName: result.modelRef.model,
          modelVersion: result.modelRef.version ?? null,
          promptTemplateId: result.promptTemplateId,
          promptVersion: result.promptVersion,
          usageInputTokens: result.usage?.inputTokens ?? null,
          usageOutputTokens: result.usage?.outputTokens ?? null,
          finishReason: result.finishReason,
          ...(result.finishReason === 'content_filter'
            ? { failureReason: 'The model declined to generate this content.' }
            : {}),
        },
      });

      if (updated.status === 'READY') {
        await this.prisma.client.contentItem.update({
          where: { id: item.id },
          data: { body: result.body, lifecycleState: 'GENERATED' },
        });
        // Forward lineage on the evidence pack.
        await this.prisma.client.evidencePack.update({
          where: { id: item.evidencePackId },
          data: { usedByContentItemIds: { push: item.id } },
        });
      }

      await this.audit.record({
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        actorUserId: principal.userId,
        action: 'content_draft.generated',
        resourceType: 'ContentDraft',
        resourceId: draft.id,
        changes: {
          model: `${result.modelRef.provider}/${result.modelRef.model}`,
          promptVersion: result.promptVersion,
          citations: result.groundedCitationIds.length,
          finishReason: result.finishReason,
        },
      });

      return updated;
    } catch (error) {
      const failureReason =
        error instanceof AiProviderUnavailableError
          ? 'AI provider unavailable'
          : 'Generation failed';
      await this.prisma.client.contentDraft.update({
        where: { id: draft.id },
        data: { status: 'FAILED', failureReason },
      });
      if (error instanceof AiProviderUnavailableError) {
        throw new ServiceUnavailableException(error.message);
      }
      throw error;
    }
  }
}
