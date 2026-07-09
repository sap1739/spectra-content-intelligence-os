import { Injectable } from '@nestjs/common';
import type {
  CreateCampaignInput,
  CreatePersonaInput,
  CreatePillarInput,
  CreateTopicIdeaInput,
  UpdateTopicIdeaStatusInput,
  UpsertCampaignBriefInput,
} from '@spectra/contracts';
import { TenantIsolationError } from '@spectra/security';

import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

@Injectable()
export class StrategyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private scope(tenant: TenantContext) {
    return {
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId as string,
    };
  }

  private record(
    tenant: TenantContext,
    principal: Principal,
    action: string,
    resourceType: string,
    resourceId: string,
    changes?: Record<string, unknown>,
  ) {
    return this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action,
      resourceType,
      resourceId,
      ...(changes ? { changes } : {}),
    });
  }

  // --- Campaigns -----------------------------------------------------------

  listCampaigns(tenant: TenantContext) {
    return this.prisma.client.campaign.findMany({
      where: { ...this.scope(tenant), deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { brief: true, _count: { select: { contentItems: true } } },
      take: 100,
    });
  }

  async getCampaign(tenant: TenantContext, id: string) {
    const campaign = await this.prisma.client.campaign.findFirst({
      where: { id, ...this.scope(tenant), deletedAt: null },
      include: { brief: true, _count: { select: { contentItems: true } } },
    });
    if (!campaign) throw new TenantIsolationError();
    return campaign;
  }

  async createCampaign(tenant: TenantContext, principal: Principal, input: CreateCampaignInput) {
    const campaign = await this.prisma.client.campaign.create({
      data: {
        ...this.scope(tenant),
        name: input.name,
        description: input.description ?? null,
        brandId: input.brandId ?? null,
        verticalId: input.verticalId ?? null,
        status: input.status,
        timezone: input.timezone,
        startAt: input.startAt ? new Date(input.startAt) : null,
        endAt: input.endAt ? new Date(input.endAt) : null,
        createdById: principal.userId,
      },
    });
    await this.record(tenant, principal, 'campaign.created', 'Campaign', campaign.id, {
      name: input.name,
    });
    return campaign;
  }

  async upsertBrief(
    tenant: TenantContext,
    principal: Principal,
    campaignId: string,
    input: UpsertCampaignBriefInput,
  ) {
    await this.getCampaign(tenant, campaignId); // tenant assertion
    const data = {
      background: input.background ?? null,
      objectives: input.objectives,
      keyMessages: input.keyMessages,
      mandatories: input.mandatories,
      doNots: input.doNots,
      tone: input.tone ?? null,
    };
    const brief = await this.prisma.client.campaignBrief.upsert({
      where: { campaignId },
      create: { ...this.scope(tenant), campaignId, createdById: principal.userId, ...data },
      update: data,
    });
    await this.record(tenant, principal, 'campaign_brief.upserted', 'CampaignBrief', brief.id);
    return brief;
  }

  // --- Audience personas ---------------------------------------------------

  listPersonas(tenant: TenantContext) {
    return this.prisma.client.audiencePersona.findMany({
      where: { ...this.scope(tenant), deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async createPersona(tenant: TenantContext, principal: Principal, input: CreatePersonaInput) {
    const persona = await this.prisma.client.audiencePersona.create({
      data: {
        ...this.scope(tenant),
        name: input.name,
        description: input.description ?? null,
        roles: input.roles,
        seniority: input.seniority ?? null,
        industries: input.industries,
        painPoints: input.painPoints,
        goals: input.goals,
        preferredPlatforms: input.preferredPlatforms,
        languages: input.languages,
        createdById: principal.userId,
      },
    });
    await this.record(tenant, principal, 'persona.created', 'AudiencePersona', persona.id, {
      name: input.name,
    });
    return persona;
  }

  async deletePersona(tenant: TenantContext, principal: Principal, id: string) {
    await this.softDelete(tenant, 'audiencePersona', id);
    await this.record(tenant, principal, 'persona.deleted', 'AudiencePersona', id);
  }

  // --- Content pillars -----------------------------------------------------

  listPillars(tenant: TenantContext) {
    return this.prisma.client.contentPillar.findMany({
      where: { ...this.scope(tenant), deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async createPillar(tenant: TenantContext, principal: Principal, input: CreatePillarInput) {
    const pillar = await this.prisma.client.contentPillar.create({
      data: {
        ...this.scope(tenant),
        name: input.name,
        description: input.description ?? null,
        keywords: input.keywords,
        brandId: input.brandId ?? null,
        createdById: principal.userId,
      },
    });
    await this.record(tenant, principal, 'pillar.created', 'ContentPillar', pillar.id, {
      name: input.name,
    });
    return pillar;
  }

  async deletePillar(tenant: TenantContext, principal: Principal, id: string) {
    await this.softDelete(tenant, 'contentPillar', id);
    await this.record(tenant, principal, 'pillar.deleted', 'ContentPillar', id);
  }

  // --- Topic ideas ---------------------------------------------------------

  listTopicIdeas(tenant: TenantContext) {
    return this.prisma.client.topicIdea.findMany({
      where: { ...this.scope(tenant), deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async createTopicIdea(tenant: TenantContext, principal: Principal, input: CreateTopicIdeaInput) {
    const idea = await this.prisma.client.topicIdea.create({
      data: {
        ...this.scope(tenant),
        title: input.title,
        description: input.description ?? null,
        pillarId: input.pillarId ?? null,
        verticalId: input.verticalId ?? null,
        evidencePackId: input.evidencePackId ?? null,
        findingIds: input.findingIds,
        trendCandidateIds: input.trendCandidateIds,
        citationIds: input.citationIds,
        createdById: principal.userId,
      },
    });
    await this.record(tenant, principal, 'topic_idea.created', 'TopicIdea', idea.id, {
      title: input.title,
    });
    return idea;
  }

  async setTopicIdeaStatus(
    tenant: TenantContext,
    principal: Principal,
    id: string,
    input: UpdateTopicIdeaStatusInput,
  ) {
    const existing = await this.prisma.client.topicIdea.findFirst({
      where: { id, ...this.scope(tenant), deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new TenantIsolationError();
    const idea = await this.prisma.client.topicIdea.update({
      where: { id },
      data: { status: input.status },
    });
    await this.record(tenant, principal, 'topic_idea.status_changed', 'TopicIdea', id, {
      status: input.status,
    });
    return idea;
  }

  async deleteTopicIdea(tenant: TenantContext, principal: Principal, id: string) {
    await this.softDelete(tenant, 'topicIdea', id);
    await this.record(tenant, principal, 'topic_idea.deleted', 'TopicIdea', id);
  }

  // --- shared --------------------------------------------------------------

  /** Tenant-checked soft delete. Missing/foreign fail identically (404). */
  private async softDelete(
    tenant: TenantContext,
    model: 'audiencePersona' | 'contentPillar' | 'topicIdea',
    id: string,
  ): Promise<void> {
    const delegate = this.prisma.client[model] as {
      findFirst: (args: unknown) => Promise<{ id: string } | null>;
      update: (args: unknown) => Promise<unknown>;
    };
    const existing = await delegate.findFirst({
      where: { id, ...this.scope(tenant), deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new TenantIsolationError();
    await delegate.update({ where: { id }, data: { deletedAt: new Date() } });
  }
}
