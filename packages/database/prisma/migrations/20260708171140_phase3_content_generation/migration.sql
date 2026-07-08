-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'PLANNED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "FunnelStage" AS ENUM ('AWARENESS', 'CONSIDERATION', 'CONVERSION', 'RETENTION', 'ADVOCACY');

-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('POST', 'ARTICLE', 'THREAD', 'VIDEO_SCRIPT', 'IMAGE', 'CAROUSEL', 'SHORT_VIDEO', 'LONG_VIDEO', 'AUDIO', 'EMAIL', 'OTHER');

-- CreateEnum
CREATE TYPE "ContentLifecycleState" AS ENUM ('IDEA', 'RESEARCHING', 'RESEARCH_READY', 'BRIEF', 'STRATEGY', 'DRAFT', 'GENERATED', 'EDITING', 'REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'PARTIALLY_PUBLISHED', 'FAILED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ContentDraftStatus" AS ENUM ('GENERATING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID,
    "verticalId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "startAt" TIMESTAMPTZ(6),
    "endAt" TIMESTAMPTZ(6),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "campaignId" UUID,
    "brandId" UUID,
    "verticalId" UUID,
    "title" TEXT NOT NULL,
    "contentType" "ContentType" NOT NULL DEFAULT 'POST',
    "lifecycleState" "ContentLifecycleState" NOT NULL DEFAULT 'IDEA',
    "funnelStage" "FunnelStage",
    "body" TEXT,
    "evidencePackId" UUID,
    "researchProjectId" UUID,
    "topicKey" TEXT,
    "findingIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "citationIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "content_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_drafts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "contentItemId" UUID NOT NULL,
    "status" "ContentDraftStatus" NOT NULL DEFAULT 'GENERATING',
    "body" TEXT,
    "evidencePackId" UUID,
    "citationIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "findingIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "modelProvider" TEXT,
    "modelName" TEXT,
    "modelVersion" TEXT,
    "promptTemplateId" TEXT,
    "promptVersion" TEXT,
    "usageInputTokens" INTEGER,
    "usageOutputTokens" INTEGER,
    "finishReason" TEXT,
    "failureReason" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "content_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaigns_workspaceId_status_idx" ON "campaigns"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "content_items_workspaceId_lifecycleState_idx" ON "content_items"("workspaceId", "lifecycleState");

-- CreateIndex
CREATE INDEX "content_items_campaignId_idx" ON "content_items"("campaignId");

-- CreateIndex
CREATE INDEX "content_drafts_contentItemId_createdAt_idx" ON "content_drafts"("contentItemId", "createdAt");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_verticalId_fkey" FOREIGN KEY ("verticalId") REFERENCES "custom_verticals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_verticalId_fkey" FOREIGN KEY ("verticalId") REFERENCES "custom_verticals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_drafts" ADD CONSTRAINT "content_drafts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_drafts" ADD CONSTRAINT "content_drafts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_drafts" ADD CONSTRAINT "content_drafts_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "content_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
