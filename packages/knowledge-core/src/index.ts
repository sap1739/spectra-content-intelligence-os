export { InMemoryVectorStore, cosineSimilarity } from './vector-store';
export type { UpsertChunksInput, VectorStoreProvider } from './vector-store';
export { DEFAULT_CHUNKING, chunkText } from './chunking';
export type { ChunkingOptions, TextChunk } from './chunking';
export { SCANNER_VERSION, scanForPromptInjection, wrapUntrustedContent } from './prompt-injection';
export {
  HashingEmbeddingProvider,
  LEXICAL_EMBEDDING_COLLECTION,
  LEXICAL_EMBEDDING_DIMENSIONS,
  lexicalEmbed,
} from './hashing-embedder';
export type { WrappedUntrustedContent } from './prompt-injection';
