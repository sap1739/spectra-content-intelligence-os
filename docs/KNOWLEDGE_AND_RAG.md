# Knowledge & RAG Architecture

## 1. Separation of concerns (`@spectra/knowledge-core` + contracts)

| Artifact          | Contract                    | Notes                                                              |
| ----------------- | --------------------------- | ------------------------------------------------------------------ |
| Source document   | `SourceDocument`            | Canonical bytes in object storage; versioned, never mutated        |
| Source snapshot   | `SourceSnapshot`            | Immutable research capture, hash-addressed                         |
| Chunk             | `DocumentChunk`             | Deterministic chunking (`chunkText`), heading path + page metadata |
| Embedding         | `EmbeddingRef`              | Provider/model/dimensions/vectorId — provider-replaceable          |
| Entity            | `KnowledgeEntity`           | Typed entities with aliases and external ids                       |
| Claim             | `ExtractedClaim`            | Verification status + supporting/contradicting findings            |
| Citation          | `Citation`                  | Finding + source (+ snapshot) with locator                         |
| Evidence pack     | `EvidencePack`              | Curated bundle consumed by generation                              |
| Content reference | `GeneratedContentReference` | Which content used which evidence                                  |

## 2. Retrieval

`VectorStoreProvider` is the port; **pgvector is the first implementation target**
(ADR-0005; extension already enabled by migration). `VectorSearchRequest` mandates tenant
scope and supports:

- hybrid search — `keywordWeight` + `semanticWeight` (Postgres FTS + vector similarity fused
  in the pgvector adapter);
- metadata filtering (`filters` map: document origin, language, source category, date ranges);
- `topK`, `minScore`.

`InMemoryVectorStore` (real cosine math, tenant-filtered) exists for tests/offline dev only.

## 3. Tenant isolation

- Every chunk/document/vector row carries `organizationId` + `workspaceId`.
- The vector port takes tenant scope on **every** call; adapters must apply it as a WHERE
  clause/namespace, not post-filtering.
- Uploaded internal documents are workspace-scoped by default (`accessScope`), organization-
  wide only when explicitly widened, and **never** retrievable across tenants — enforced at
  the port and covered by isolation tests.

## 4. Freshness, versioning, lineage, deletion

- `SourceDocument.freshUntil` marks re-validation horizons; retrieval can filter stale
  content and findings can be marked `STALE`.
- Re-uploads create new versions (`version`, `previousVersionId`); re-indexing is a queued
  job that atomically swaps a document's chunks.
- Citation lineage: finding → citation → claim → evidence pack → `GeneratedContentReference`
  answers "which content used this claim?" and enables stale-content alerts.
- Deletion propagation: deleting a document deletes its chunks and vectors
  (`deleteByDocument`); tenant offboarding uses `deleteByTenant`; object storage prefixes
  (`org/<id>/…`) make bulk removal auditable.

## 5. Embedding provider replacement

`EmbeddingProvider` (ai-core) exposes `dimensions`; `EmbeddingRef` records provider/model per
chunk. Switching providers = new collection + background re-embedding job; searches pin to a
collection so mixed-dimension corruption is impossible.

## 6. Untrusted content

All retrieved/uploaded text passes the prompt-injection scanner and is wrapped via
`wrapUntrustedContent` before any LLM sees it — see
[PROMPT_INJECTION_DEFENCE.md](PROMPT_INJECTION_DEFENCE.md).
