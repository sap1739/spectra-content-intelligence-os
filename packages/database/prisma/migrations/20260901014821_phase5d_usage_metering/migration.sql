-- CreateEnum
CREATE TYPE "UsageKind" AS ENUM ('AI_GENERATION', 'AI_EMBEDDING', 'WEB_SEARCH', 'NEWS_SEARCH', 'PAGE_FETCH');

-- CreateTable
CREATE TABLE "usage_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID,
    "kind" "UsageKind" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "requests" INTEGER NOT NULL DEFAULT 1,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "bytes" INTEGER,
    "estimatedCostMicros" INTEGER,
    "rateVersion" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "resourceType" TEXT,
    "resourceId" UUID,
    "correlationId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "usage_events_organizationId_occurredAt_idx" ON "usage_events"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "usage_events_organizationId_workspaceId_occurredAt_idx" ON "usage_events"("organizationId", "workspaceId", "occurredAt");

-- CreateIndex
CREATE INDEX "usage_events_resourceType_resourceId_idx" ON "usage_events"("resourceType", "resourceId");

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

