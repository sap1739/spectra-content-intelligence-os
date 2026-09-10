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

**Status (ADR-0016):** `PgVectorStore` is live — research findings are embedded with the
first-party lexical hashing provider into collection `lexical-hash-256-v1` and served via
`GET /v1/workspaces/:id/knowledge/search`. Neural embeddings arrive in Phase 3 as a new
collection behind the same ports.

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

## Extracted documents in the knowledge base (Phase 5G, ADR-0031)

Extracted document text flows into the existing chunking, embedding and `document_chunks` path —
no separate store. That means embedding-collection pairing (ADR-0023), tenant isolation and budget
pre-flight (ADR-0028) apply to document text exactly as they do to web content; embeddings are
generated only after a pre-flight allows them.

What documents add is **anchors**: each chunk can be traced to a page (PDF), a section
(DOCX/Markdown) or a line range (text), so retrieval can cite a location inside a long document
rather than the document as a whole.

Documents are never extracted across tenants: extraction is invoked with the run's tenant scope,
and chunks are written under that workspace only.

## Verified claims in generation (Phase 5H, ADR-0032)

Generation loads claims from the evidence pack and re-filters on eligibility, so a pack that went
stale cannot smuggle a since-blocked claim into a prompt.

The prompt states how well each claim is supported — corroborated by N independent sources, or
"ONE source only — limited evidence" — and instructs the model to attribute weakly supported claims
explicitly rather than asserting them as settled. When every available claim is weak, an explicit
evidence warning is added to the instructions.

Weak claims are **qualified, not dropped**: removing them would silently narrow the evidence base
rather than telling the reader how strong it is. Citation validation (ADR-0017) still runs
unchanged, so a marker pointing at evidence that was not supplied is still reported as dangling.
