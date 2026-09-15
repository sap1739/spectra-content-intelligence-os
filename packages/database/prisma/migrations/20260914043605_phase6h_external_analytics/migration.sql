-- CreateEnum
CREATE TYPE "AnalyticsSyncStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "AnalyticsSyncTrigger" AS ENUM ('MANUAL', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "AnalyticsSyncTarget" AS ENUM ('WORKSPACE', 'SOCIAL_ACCOUNT', 'SCHEDULE_ENTRY');

-- CreateEnum
CREATE TYPE "AnalyticsSnapshotLevel" AS ENUM ('ACCOUNT', 'CONTENT');

-- CreateEnum
CREATE TYPE "AnalyticsSnapshotCompleteness" AS ENUM ('COMPLETE', 'PARTIAL', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "AnalyticsMetricCompleteness" AS ENUM ('EXACT', 'APPROXIMATE', 'DERIVED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "AnalyticsUnavailableReason" AS ENUM ('NOT_EXPOSED_BY_PLATFORM', 'DEPRECATED_BY_PLATFORM', 'NOT_IMPLEMENTED', 'MISSING_SCOPE', 'APPROVAL_REQUIRED', 'PROVIDER_UNCONFIGURED', 'NOT_CONNECTED', 'REAUTH_REQUIRED', 'ACCOUNT_KIND_UNSUPPORTED', 'CONTENT_NOT_PUBLISHED', 'CONTENT_TYPE_UNSUPPORTED', 'OUTSIDE_RETENTION_WINDOW', 'NOT_YET_AVAILABLE', 'RATE_LIMITED', 'QUOTA_EXCEEDED', 'PROVIDER_ERROR', 'DENOMINATOR_UNKNOWN', 'NOT_ADDITIVE', 'BUDGET_BLOCKED', 'NOT_REPORTED');

-- AlterEnum
ALTER TYPE "UsageKind" ADD VALUE 'ANALYTICS_SYNC';

-- CreateTable
CREATE TABLE "analytics_sync_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "trigger" "AnalyticsSyncTrigger" NOT NULL DEFAULT 'MANUAL',
    "target" "AnalyticsSyncTarget" NOT NULL,
    "socialAccountId" UUID,
    "scheduleEntryId" UUID,
    "status" "AnalyticsSyncStatus" NOT NULL DEFAULT 'QUEUED',
    "idempotencyKey" TEXT NOT NULL,
    "requestedById" UUID,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextAttemptAt" TIMESTAMPTZ(6),
    "succeededCount" INTEGER NOT NULL DEFAULT 0,
    "partialCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "unavailableCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "retryAfterSeconds" INTEGER,
    "results" JSONB NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMPTZ(6),
    "finishedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "analytics_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "syncRunId" UUID,
    "platform" "SocialPlatform" NOT NULL,
    "providerId" TEXT NOT NULL,
    "level" "AnalyticsSnapshotLevel" NOT NULL,
    "socialAccountId" UUID,
    "scheduleEntryId" UUID,
    "contentItemId" UUID,
    "campaignId" UUID,
    "externalAccountId" TEXT,
    "externalContentId" TEXT,
    "publishedAt" TIMESTAMPTZ(6),
    "completeness" "AnalyticsSnapshotCompleteness" NOT NULL,
    "retrievedAt" TIMESTAMPTZ(6) NOT NULL,
    "staleAfter" TIMESTAMPTZ(6) NOT NULL,
    "dataAsOf" TIMESTAMPTZ(6),
    "providerMetadata" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_metric_values" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "metricKey" TEXT NOT NULL,
    "sourceMetricName" TEXT,
    "value" DOUBLE PRECISION,
    "unit" TEXT NOT NULL,
    "completeness" "AnalyticsMetricCompleteness" NOT NULL,
    "unavailableReason" "AnalyticsUnavailableReason",
    "detail" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_metric_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "analytics_sync_runs_idempotencyKey_key" ON "analytics_sync_runs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "analytics_sync_runs_workspaceId_createdAt_idx" ON "analytics_sync_runs"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "analytics_sync_runs_status_nextAttemptAt_idx" ON "analytics_sync_runs"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_snapshots_dedupeKey_key" ON "analytics_snapshots"("dedupeKey");

-- CreateIndex
CREATE INDEX "analytics_snapshots_workspaceId_level_retrievedAt_idx" ON "analytics_snapshots"("workspaceId", "level", "retrievedAt");

-- CreateIndex
CREATE INDEX "analytics_snapshots_scheduleEntryId_retrievedAt_idx" ON "analytics_snapshots"("scheduleEntryId", "retrievedAt");

-- CreateIndex
CREATE INDEX "analytics_snapshots_contentItemId_retrievedAt_idx" ON "analytics_snapshots"("contentItemId", "retrievedAt");

-- CreateIndex
CREATE INDEX "analytics_snapshots_campaignId_retrievedAt_idx" ON "analytics_snapshots"("campaignId", "retrievedAt");

-- CreateIndex
CREATE INDEX "analytics_snapshots_socialAccountId_level_retrievedAt_idx" ON "analytics_snapshots"("socialAccountId", "level", "retrievedAt");

-- CreateIndex
CREATE INDEX "analytics_metric_values_workspaceId_metricKey_idx" ON "analytics_metric_values"("workspaceId", "metricKey");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_metric_values_snapshotId_metricKey_key" ON "analytics_metric_values"("snapshotId", "metricKey");

-- AddForeignKey
ALTER TABLE "analytics_sync_runs" ADD CONSTRAINT "analytics_sync_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_sync_runs" ADD CONSTRAINT "analytics_sync_runs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_sync_runs" ADD CONSTRAINT "analytics_sync_runs_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "social_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_sync_runs" ADD CONSTRAINT "analytics_sync_runs_scheduleEntryId_fkey" FOREIGN KEY ("scheduleEntryId") REFERENCES "content_schedule_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "analytics_sync_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "social_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_scheduleEntryId_fkey" FOREIGN KEY ("scheduleEntryId") REFERENCES "content_schedule_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "content_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_metric_values" ADD CONSTRAINT "analytics_metric_values_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_metric_values" ADD CONSTRAINT "analytics_metric_values_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_metric_values" ADD CONSTRAINT "analytics_metric_values_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "analytics_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Unavailable is not zero (ADR-0039). A metric row is EITHER a value OR a
-- reason, and completeness says UNAVAILABLE exactly when there is no value, so
-- no code path can store a missing metric that later reads back as 0.
ALTER TABLE "analytics_metric_values"
  ADD CONSTRAINT "analytics_metric_value_xor_reason"
  CHECK (("value" IS NULL) = ("unavailableReason" IS NOT NULL));

ALTER TABLE "analytics_metric_values"
  ADD CONSTRAINT "analytics_metric_unavailable_has_no_value"
  CHECK (("value" IS NULL) = ("completeness" = 'UNAVAILABLE'));
