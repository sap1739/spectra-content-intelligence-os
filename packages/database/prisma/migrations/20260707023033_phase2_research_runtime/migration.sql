-- CreateEnum
CREATE TYPE "SnapshotExtractionStatus" AS ENUM ('PENDING', 'EXTRACTED', 'FAILED');

-- DropIndex
DROP INDEX "trend_candidates_projectId_idx";

-- AlterTable
ALTER TABLE "research_findings" ADD COLUMN     "snapshotId" UUID;

-- AlterTable
ALTER TABLE "trend_candidates" ADD COLUMN     "topicKey" TEXT;

-- CreateTable
CREATE TABLE "source_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "retrievedAt" TIMESTAMPTZ(6) NOT NULL,
    "contentHash" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "extractionStatus" "SnapshotExtractionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "source_snapshots_sourceId_idx" ON "source_snapshots"("sourceId");

-- CreateIndex
CREATE INDEX "source_snapshots_workspaceId_contentHash_idx" ON "source_snapshots"("workspaceId", "contentHash");

-- CreateIndex
CREATE INDEX "trend_candidates_projectId_topicKey_idx" ON "trend_candidates"("projectId", "topicKey");

-- AddForeignKey
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "research_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_findings" ADD CONSTRAINT "research_findings_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "source_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
