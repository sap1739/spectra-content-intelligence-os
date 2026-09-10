-- CreateEnum
CREATE TYPE "ClaimConfidenceLevel" AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'CONTESTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ClaimFreshnessStatus" AS ENUM ('CURRENT', 'AGING', 'STALE', 'EVERGREEN', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "EvidenceEligibilityDecision" AS ENUM ('ELIGIBLE', 'WEAK', 'REQUIRES_REVIEW', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ClaimReviewStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED', 'MORE_RESEARCH_REQUESTED');

-- CreateEnum
CREATE TYPE "ClaimReviewAction" AS ENUM ('APPROVE', 'REJECT', 'REQUEST_MORE_RESEARCH');

-- CreateEnum
CREATE TYPE "ClaimContradictionKind" AS ENUM ('NUMERIC_CONFLICT', 'NEGATION', 'DIRECTIONAL_CONFLICT');

-- CreateEnum
CREATE TYPE "ClaimContradictionStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- AlterTable
ALTER TABLE "extracted_claims" ADD COLUMN     "clusterKey" TEXT,
ADD COLUMN     "confidenceLevel" "ClaimConfidenceLevel" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "eligibility" "EvidenceEligibilityDecision" NOT NULL DEFAULT 'WEAK',
ADD COLUMN     "eligibilityReason" TEXT,
ADD COLUMN     "evergreen" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "freshnessStatus" "ClaimFreshnessStatus" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "independentSourceCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "latestSupportAt" TIMESTAMPTZ(6),
ADD COLUMN     "reviewStatus" "ClaimReviewStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN     "reviewedAt" TIMESTAMPTZ(6),
ADD COLUMN     "reviewedById" UUID,
ADD COLUMN     "supportingCitationIds" UUID[] DEFAULT ARRAY[]::UUID[];

-- CreateTable
CREATE TABLE "claim_reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "action" "ClaimReviewAction" NOT NULL,
    "note" TEXT,
    "reviewerId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_contradictions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "conflictingClaimId" UUID NOT NULL,
    "kind" "ClaimContradictionKind" NOT NULL,
    "detail" TEXT NOT NULL,
    "status" "ClaimContradictionStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_contradictions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "claim_reviews_workspaceId_claimId_createdAt_idx" ON "claim_reviews"("workspaceId", "claimId", "createdAt");

-- CreateIndex
CREATE INDEX "claim_contradictions_workspaceId_status_idx" ON "claim_contradictions"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "claim_contradictions_claimId_conflictingClaimId_key" ON "claim_contradictions"("claimId", "conflictingClaimId");

-- CreateIndex
CREATE INDEX "extracted_claims_projectId_clusterKey_idx" ON "extracted_claims"("projectId", "clusterKey");

-- CreateIndex
CREATE INDEX "extracted_claims_workspaceId_eligibility_idx" ON "extracted_claims"("workspaceId", "eligibility");

-- CreateIndex
CREATE INDEX "extracted_claims_workspaceId_reviewStatus_idx" ON "extracted_claims"("workspaceId", "reviewStatus");

-- AddForeignKey
ALTER TABLE "extracted_claims" ADD CONSTRAINT "extracted_claims_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_reviews" ADD CONSTRAINT "claim_reviews_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "extracted_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_reviews" ADD CONSTRAINT "claim_reviews_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_contradictions" ADD CONSTRAINT "claim_contradictions_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "extracted_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_contradictions" ADD CONSTRAINT "claim_contradictions_conflictingClaimId_fkey" FOREIGN KEY ("conflictingClaimId") REFERENCES "extracted_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

