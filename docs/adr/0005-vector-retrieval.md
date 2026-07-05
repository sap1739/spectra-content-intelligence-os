# ADR-0005: pgvector behind a provider-neutral vector port

**Status:** Accepted · **Date:** 2026-07-05

## Context

RAG needs hybrid keyword+semantic retrieval with strict tenant isolation, metadata filters,
deletion propagation and embedding-provider replacement. Options: pgvector, Qdrant, Weaviate,
Pinecone, OpenSearch.

## Decision

`VectorStoreProvider` port in knowledge-core; **pgvector is the first production adapter**
(extension already enabled by the initial migration). An in-memory implementation exists for
tests only.

## Rationale

- One database = tenant isolation, backups, transactions and deletion propagation in a
  single system; vectors live next to the rows they describe.
- Hybrid search composes Postgres FTS + vector similarity in one SQL statement.
- Dedicated vector DBs add operational surface before scale demands it; the port makes that
  migration a contained adapter swap (contracts already carry `EmbeddingRef` with
  provider/model/dimensions).

## Consequences

- Phase 2 adds `document_chunks` with a `vector` column + HNSW index and the pgvector
  adapter with tenant scope compiled into every query.
- Collection-per-embedding-model convention prevents mixed-dimension corruption.
