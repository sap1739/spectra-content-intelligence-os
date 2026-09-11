-- CreateEnum
CREATE TYPE "SocialMediaUploadStatus" AS ENUM ('REGISTERED', 'UPLOADED', 'FAILED');

-- AlterEnum
ALTER TYPE "AccountDiscoveryStatus" ADD VALUE 'PARTIAL';

-- AlterTable
ALTER TABLE "content_schedule_entries" ADD COLUMN     "failureCode" TEXT,
ADD COLUMN     "mediaAltText" TEXT,
ADD COLUMN     "mediaAssetId" UUID;

-- AlterTable
ALTER TABLE "social_accounts" ADD COLUMN     "capabilities" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "capabilitiesCheckedAt" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "social_media_uploads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "socialAccountId" UUID NOT NULL,
    "mediaAssetId" UUID NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "externalMediaId" TEXT,
    "status" "SocialMediaUploadStatus" NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "uploadUrlExpiresAt" TIMESTAMPTZ(6),
    "lastError" TEXT,
    "uploadedAt" TIMESTAMPTZ(6),
    "lastPostId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "social_media_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "social_media_uploads_organizationId_createdAt_idx" ON "social_media_uploads"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "social_media_uploads_socialAccountId_mediaAssetId_key" ON "social_media_uploads"("socialAccountId", "mediaAssetId");

-- AddForeignKey
ALTER TABLE "content_schedule_entries" ADD CONSTRAINT "content_schedule_entries_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_media_uploads" ADD CONSTRAINT "social_media_uploads_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_media_uploads" ADD CONSTRAINT "social_media_uploads_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_media_uploads" ADD CONSTRAINT "social_media_uploads_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "social_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_media_uploads" ADD CONSTRAINT "social_media_uploads_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
