-- CreateEnum
CREATE TYPE "ClaimType" AS ENUM ('FACTUAL', 'STATISTIC', 'PREDICTION', 'OPINION', 'QUOTE');

-- CreateEnum
CREATE TYPE "ClaimVerificationStatus" AS ENUM ('UNVERIFIED', 'CORROBORATED', 'DISPUTED', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "EvidencePackStatus" AS ENUM ('DRAFT', 'READY', 'STALE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TrendAlertType" AS ENUM ('STATE_CHANGE', 'SCORE_THRESHOLD', 'NEW_EVIDENCE', 'RISK_FLAG');

-- CreateTable
CREATE TABLE "extracted_claims" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "normalizedKey" TEXT NOT NULL,
    "claimType" "ClaimType" NOT NULL DEFAULT 'FACTUAL',
    "verificationStatus" "ClaimVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "supportingFindingIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "sourceCount" INTEGER NOT NULL DEFAULT 1,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "extracted_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "citations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "findingId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "snapshotId" UUID,
    "claimId" UUID,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "publisher" TEXT,
    "publishedAt" TIMESTAMPTZ(6),
    "retrievedAt" TIMESTAMPTZ(6) NOT NULL,
    "excerpt" TEXT,
    "startOffset" INTEGER,
    "endOffset" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "citations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_packs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "trendCandidateId" UUID,
    "topicKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "status" "EvidencePackStatus" NOT NULL DEFAULT 'DRAFT',
    "findingIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "claimIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "citationIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "usedByContentItemIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "evidence_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_chunks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "collection" TEXT NOT NULL,
    "documentId" UUID NOT NULL,
    "index" INTEGER NOT NULL DEFAULT 0,
    "text" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "embeddingProvider" TEXT NOT NULL,
    "embeddingModel" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "embedding" vector(256),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trend_alerts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "trendCandidateId" UUID NOT NULL,
    "alertType" "TrendAlertType" NOT NULL,
    "message" TEXT NOT NULL,
    "triggeredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMPTZ(6),
    "acknowledgedById" UUID,

    CONSTRAINT "trend_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "extracted_claims_workspaceId_verificationStatus_idx" ON "extracted_claims"("workspaceId", "verificationStatus");

-- CreateIndex
CREATE UNIQUE INDEX "extracted_claims_projectId_normalizedKey_key" ON "extracted_claims"("projectId", "normalizedKey");

-- CreateIndex
CREATE INDEX "citations_projectId_idx" ON "citations"("projectId");

-- CreateIndex
CREATE INDEX "citations_findingId_idx" ON "citations"("findingId");

-- CreateIndex
CREATE INDEX "citations_claimId_idx" ON "citations"("claimId");

-- CreateIndex
CREATE INDEX "evidence_packs_workspaceId_status_idx" ON "evidence_packs"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_packs_projectId_topicKey_key" ON "evidence_packs"("projectId", "topicKey");

-- CreateIndex
CREATE INDEX "document_chunks_organizationId_workspaceId_collection_idx" ON "document_chunks"("organizationId", "workspaceId", "collection");

-- CreateIndex
CREATE INDEX "document_chunks_documentId_idx" ON "document_chunks"("documentId");

-- CreateIndex
CREATE INDEX "trend_alerts_workspaceId_acknowledgedAt_idx" ON "trend_alerts"("workspaceId", "acknowledgedAt");

-- AddForeignKey
ALTER TABLE "extracted_claims" ADD CONSTRAINT "extracted_claims_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "research_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citations" ADD CONSTRAINT "citations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "research_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citations" ADD CONSTRAINT "citations_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "research_findings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citations" ADD CONSTRAINT "citations_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "extracted_claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_packs" ADD CONSTRAINT "evidence_packs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "research_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trend_alerts" ADD CONSTRAINT "trend_alerts_trendCandidateId_fkey" FOREIGN KEY ("trendCandidateId") REFERENCES "trend_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Approximate-nearest-neighbour index for cosine search (pgvector HNSW).
CREATE INDEX "document_chunks_embedding_hnsw_idx" ON "document_chunks"
  USING hnsw (embedding vector_cosine_ops);
