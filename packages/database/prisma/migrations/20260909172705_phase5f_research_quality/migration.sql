-- CreateEnum
CREATE TYPE "RobotsDecision" AS ENUM ('ALLOWED', 'DISALLOWED', 'UNAVAILABLE', 'NOT_CHECKED');

-- CreateEnum
CREATE TYPE "StalenessStatus" AS ENUM ('FRESH', 'AGING', 'STALE', 'EVERGREEN', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DomainStance" AS ENUM ('TRUSTED', 'NEUTRAL', 'BLOCKED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SourceProcessingStatus" ADD VALUE 'ROBOTS_BLOCKED';
ALTER TYPE "SourceProcessingStatus" ADD VALUE 'BLOCKED_DOMAIN';

-- AlterTable
ALTER TABLE "research_sources" ADD COLUMN     "diversityWeight" DOUBLE PRECISION NOT NULL DEFAULT 1,
ADD COLUMN     "evidenceEligible" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "evidenceExclusionReason" TEXT,
ADD COLUMN     "robotsCheckedAt" TIMESTAMPTZ(6),
ADD COLUMN     "robotsDecision" "RobotsDecision" NOT NULL DEFAULT 'NOT_CHECKED',
ADD COLUMN     "snippetOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stalenessStatus" "StalenessStatus" NOT NULL DEFAULT 'UNKNOWN';

-- CreateTable
CREATE TABLE "domain_policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "stance" "DomainStance" NOT NULL DEFAULT 'NEUTRAL',
    "credibilityOverride" DOUBLE PRECISION,
    "evergreen" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "domain_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "robots_cache_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "origin" TEXT NOT NULL,
    "disallow" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allow" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "crawlDelaySeconds" INTEGER,
    "retrieved" BOOLEAN NOT NULL DEFAULT true,
    "fetchedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "robots_cache_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "domain_policies_organizationId_stance_idx" ON "domain_policies"("organizationId", "stance");

-- CreateIndex
CREATE UNIQUE INDEX "domain_policies_workspaceId_domain_key" ON "domain_policies"("workspaceId", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "robots_cache_entries_origin_key" ON "robots_cache_entries"("origin");

-- CreateIndex
CREATE INDEX "robots_cache_entries_expiresAt_idx" ON "robots_cache_entries"("expiresAt");

-- AddForeignKey
ALTER TABLE "domain_policies" ADD CONSTRAINT "domain_policies_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_policies" ADD CONSTRAINT "domain_policies_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_policies" ADD CONSTRAINT "domain_policies_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

