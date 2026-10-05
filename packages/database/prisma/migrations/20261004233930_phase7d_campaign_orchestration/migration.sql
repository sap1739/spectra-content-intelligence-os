-- CreateEnum
CREATE TYPE "OrchestrationStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrchestrationFailureReason" AS ENUM ('INPUTS_UNAVAILABLE', 'NO_TRENDS_SELECTED', 'NO_EVIDENCE', 'ALL_ITEMS_BLOCKED', 'GENERATION_NOT_CONFIGURED', 'GENERATION_FAILED', 'BUDGET_REFUSED', 'CANCELLED', 'TIMEOUT', 'WORKER_LOST', 'INTERNAL_ERROR');

-- CreateTable
CREATE TABLE "campaign_orchestration_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "OrchestrationStatus" NOT NULL DEFAULT 'QUEUED',
    "input" JSONB NOT NULL,
    "runKey" TEXT NOT NULL,
    "verticalId" UUID,
    "researchProjectId" UUID,
    "brandId" UUID,
    "campaignId" UUID,
    "trendCandidateIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "strategy" JSONB,
    "plan" JSONB,
    "stages" JSONB NOT NULL DEFAULT '[]',
    "items" JSONB NOT NULL DEFAULT '[]',
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "itemsPlanned" INTEGER NOT NULL DEFAULT 0,
    "itemsCreated" INTEGER NOT NULL DEFAULT 0,
    "itemsDrafted" INTEGER NOT NULL DEFAULT 0,
    "itemsBlocked" INTEGER NOT NULL DEFAULT 0,
    "itemsFailed" INTEGER NOT NULL DEFAULT 0,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "queueJobId" TEXT,
    "cancelRequestedAt" TIMESTAMPTZ(6),
    "startedAt" TIMESTAMPTZ(6),
    "finishedAt" TIMESTAMPTZ(6),
    "failureReason" "OrchestrationFailureReason",
    "failureDetail" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "campaign_orchestration_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "campaign_orchestration_runs_runKey_key" ON "campaign_orchestration_runs"("runKey");

-- CreateIndex
CREATE INDEX "campaign_orchestration_runs_workspaceId_status_createdAt_idx" ON "campaign_orchestration_runs"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "campaign_orchestration_runs_campaignId_idx" ON "campaign_orchestration_runs"("campaignId");

-- AddForeignKey
ALTER TABLE "campaign_orchestration_runs" ADD CONSTRAINT "campaign_orchestration_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_orchestration_runs" ADD CONSTRAINT "campaign_orchestration_runs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_orchestration_runs" ADD CONSTRAINT "campaign_orchestration_runs_verticalId_fkey" FOREIGN KEY ("verticalId") REFERENCES "custom_verticals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_orchestration_runs" ADD CONSTRAINT "campaign_orchestration_runs_researchProjectId_fkey" FOREIGN KEY ("researchProjectId") REFERENCES "research_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_orchestration_runs" ADD CONSTRAINT "campaign_orchestration_runs_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_orchestration_runs" ADD CONSTRAINT "campaign_orchestration_runs_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
