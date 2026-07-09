-- CreateEnum
CREATE TYPE "TopicIdeaStatus" AS ENUM ('PROPOSED', 'SHORTLISTED', 'IN_USE', 'DISCARDED');

-- CreateTable
CREATE TABLE "audience_personas" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "seniority" TEXT,
    "industries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "painPoints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "goals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preferredPlatforms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "audience_personas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_pillars" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "content_pillars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topic_ideas" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "pillarId" UUID,
    "verticalId" UUID,
    "status" "TopicIdeaStatus" NOT NULL DEFAULT 'PROPOSED',
    "evidencePackId" UUID,
    "findingIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "trendCandidateIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "citationIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "topic_ideas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_briefs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "background" TEXT,
    "objectives" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "keyMessages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mandatories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "doNots" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tone" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "campaign_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audience_personas_workspaceId_idx" ON "audience_personas"("workspaceId");

-- CreateIndex
CREATE INDEX "content_pillars_workspaceId_idx" ON "content_pillars"("workspaceId");

-- CreateIndex
CREATE INDEX "topic_ideas_workspaceId_status_idx" ON "topic_ideas"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_briefs_campaignId_key" ON "campaign_briefs"("campaignId");

-- CreateIndex
CREATE INDEX "campaign_briefs_workspaceId_idx" ON "campaign_briefs"("workspaceId");

-- AddForeignKey
ALTER TABLE "audience_personas" ADD CONSTRAINT "audience_personas_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audience_personas" ADD CONSTRAINT "audience_personas_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_pillars" ADD CONSTRAINT "content_pillars_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_pillars" ADD CONSTRAINT "content_pillars_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_ideas" ADD CONSTRAINT "topic_ideas_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_ideas" ADD CONSTRAINT "topic_ideas_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_briefs" ADD CONSTRAINT "campaign_briefs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_briefs" ADD CONSTRAINT "campaign_briefs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_briefs" ADD CONSTRAINT "campaign_briefs_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
