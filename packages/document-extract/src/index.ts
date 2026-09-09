export { FirstPartyDocumentExtractor } from './extractor';
export {
  MAX_BYTES_BY_TYPE,
  MAX_DOCUMENT_BYTES,
  isLegacyWord,
  resolveDocumentType,
  safeFilename,
} from './limits';
export { buildDocx, buildImageOnlyPdf, buildPdf } from './fixtures';
export type { DocxBlock } from './fixtures';
