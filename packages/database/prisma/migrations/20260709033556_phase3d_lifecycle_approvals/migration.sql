-- AlterTable
ALTER TABLE "content_items" ADD COLUMN     "approvals" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "humanEdits" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "moderation" JSONB;
