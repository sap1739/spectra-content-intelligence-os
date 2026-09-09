-- CreateEnum
CREATE TYPE "UnpricedReason" AS ENUM ('NO_RATE_FOR_MODEL', 'FREE_LOCAL', 'NOT_VENDOR_BILLED', 'NO_MEASURED_QUANTITY', 'COUNTER_ONLY');

-- CreateEnum
CREATE TYPE "RateSource" AS ENUM ('EXACT', 'FAMILY_FALLBACK_CONSERVATIVE');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'RECONCILED', 'RELEASED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UsageKind" ADD VALUE 'RESEARCH_RUN';
ALTER TYPE "UsageKind" ADD VALUE 'CONTENT_DRAFT';
ALTER TYPE "UsageKind" ADD VALUE 'DOCUMENT_EXTRACTION';
ALTER TYPE "UsageKind" ADD VALUE 'MEDIA_RENDER';
ALTER TYPE "UsageKind" ADD VALUE 'PUBLISH_ATTEMPT';

-- CreateTable
CREATE TABLE "organization_budgets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "enforcement" "BudgetEnforcement" NOT NULL DEFAULT 'WARN',
    "monthlyLimitMicros" INTEGER,
    "warnAtPercent" INTEGER NOT NULL DEFAULT 80,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organization_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_operation_limits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID,
    "kind" "UsageKind" NOT NULL,
    "maxRequests" INTEGER,
    "maxTokens" INTEGER,
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "budget_operation_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_reservations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "kind" "UsageKind" NOT NULL,
    "estimatedCostMicros" INTEGER NOT NULL DEFAULT 0,
    "requests" INTEGER NOT NULL DEFAULT 1,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "idempotencyKey" TEXT NOT NULL,
    "resourceType" TEXT,
    "resourceId" UUID,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "releasedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "budget_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_budgets_organizationId_key" ON "organization_budgets"("organizationId");

-- CreateIndex
CREATE INDEX "budget_operation_limits_organizationId_kind_idx" ON "budget_operation_limits"("organizationId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "budget_operation_limits_organizationId_workspaceId_kind_key" ON "budget_operation_limits"("organizationId", "workspaceId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "budget_reservations_idempotencyKey_key" ON "budget_reservations"("idempotencyKey");

-- CreateIndex
CREATE INDEX "budget_reservations_organizationId_workspaceId_status_expir_idx" ON "budget_reservations"("organizationId", "workspaceId", "status", "expiresAt");

-- AddForeignKey
ALTER TABLE "organization_budgets" ADD CONSTRAINT "organization_budgets_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_budgets" ADD CONSTRAINT "organization_budgets_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_operation_limits" ADD CONSTRAINT "budget_operation_limits_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_operation_limits" ADD CONSTRAINT "budget_operation_limits_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_operation_limits" ADD CONSTRAINT "budget_operation_limits_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

