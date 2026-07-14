-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ScheduleEntryStatus" ADD VALUE 'QUEUED';
ALTER TYPE "ScheduleEntryStatus" ADD VALUE 'PUBLISHING';
ALTER TYPE "ScheduleEntryStatus" ADD VALUE 'UNSUPPORTED';

-- AlterTable
ALTER TABLE "content_schedule_entries" ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "externalPostId" TEXT,
ADD COLUMN     "externalUrl" TEXT,
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "lastAttemptAt" TIMESTAMPTZ(6),
ADD COLUMN     "publishedAt" TIMESTAMPTZ(6),
ADD COLUMN     "socialAccountId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "content_schedule_entries_idempotencyKey_key" ON "content_schedule_entries"("idempotencyKey");

-- CreateIndex
CREATE INDEX "content_schedule_entries_status_scheduledAt_idx" ON "content_schedule_entries"("status", "scheduledAt");

