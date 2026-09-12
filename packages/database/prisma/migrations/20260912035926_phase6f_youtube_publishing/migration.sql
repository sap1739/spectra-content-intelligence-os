-- AlterTable
ALTER TABLE "content_schedule_entries" ADD COLUMN     "publishMetadata" JSONB,
ADD COLUMN     "publishNote" TEXT,
ADD COLUMN     "thumbnailAssetId" UUID;

-- AlterTable
ALTER TABLE "social_media_uploads" ADD COLUMN     "credentialKeyId" TEXT,
ADD COLUMN     "encryptedUploadUrl" TEXT,
ADD COLUMN     "uploadedBytes" INTEGER NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "content_schedule_entries" ADD CONSTRAINT "content_schedule_entries_thumbnailAssetId_fkey" FOREIGN KEY ("thumbnailAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
