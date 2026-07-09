-- CreateEnum
CREATE TYPE "ScheduleEntryStatus" AS ENUM ('SCHEDULED', 'CANCELLED', 'PUBLISHED', 'FAILED');

-- CreateTable
CREATE TABLE "content_schedule_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "contentItemId" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "scheduledAt" TIMESTAMPTZ(6) NOT NULL,
    "status" "ScheduleEntryStatus" NOT NULL DEFAULT 'SCHEDULED',
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "content_schedule_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_schedule_entries_workspaceId_scheduledAt_idx" ON "content_schedule_entries"("workspaceId", "scheduledAt");

-- CreateIndex
CREATE INDEX "content_schedule_entries_contentItemId_idx" ON "content_schedule_entries"("contentItemId");

-- AddForeignKey
ALTER TABLE "content_schedule_entries" ADD CONSTRAINT "content_schedule_entries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_schedule_entries" ADD CONSTRAINT "content_schedule_entries_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_schedule_entries" ADD CONSTRAINT "content_schedule_entries_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "content_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
