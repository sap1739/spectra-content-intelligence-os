-- CreateEnum
CREATE TYPE "ExtractedDocumentType" AS ENUM ('PDF', 'DOCX', 'TXT', 'MARKDOWN');

-- CreateEnum
CREATE TYPE "DocumentAnchorKind" AS ENUM ('PAGE', 'SECTION', 'LINE', 'CHARACTER_RANGE');

-- CreateEnum
CREATE TYPE "DocumentExtractionFailureCode" AS ENUM ('UNSUPPORTED_MIME', 'FILE_TOO_LARGE', 'ENCRYPTED', 'CORRUPT', 'NO_TEXT_LAYER', 'PARSER_ERROR');

-- AlterTable
ALTER TABLE "citations" ADD COLUMN     "anchorKind" "DocumentAnchorKind",
ADD COLUMN     "anchorLabel" TEXT,
ADD COLUMN     "pageNumber" INTEGER,
ADD COLUMN     "sectionOrder" INTEGER;

