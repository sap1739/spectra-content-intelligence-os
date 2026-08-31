# ADR-0023: Semantic embeddings — real retrieval behind the EmbeddingProvider port

**Status:** Accepted · **Date:** 2026-08-30 · **Relates to:** ADR-0005, ADR-0016, ADR-0010

## Context

Evidence-backed content is this platform's differentiator, and every piece of it — evidence
packs, grounded drafting, trend context, internal knowledge search — reads from one retrieval
path. That path was first-party **lexical hashing** (ADR-0016): feature-hashed words and
character trigrams, honest and dependency-free, but matching _words rather than meaning_.
"car" and "automobile" scored as unrelated. It existed to make the RAG plumbing real
(chunk → embed → pgvector → search) while no vendor was wired.

Two things blocked a real model:

1. **The column was pinned to `vector(256)`** — the lexical width. Every real model is wider
   (voyage-4 emits 256/512/1024/2048), so the schema itself refused semantic vectors.
2. **A collection holds exactly one model's vectors.** Turning on a semantic model points
   search at a _new, empty_ collection — every previously ingested finding would silently
   vanish from results. A quiet, total loss of recall is precisely the failure mode this
   codebase refuses.

## Decision

1. **`@spectra/ai-voyage` — the first real embedder.** Voyage AI behind the existing ai-core
   `EmbeddingProvider` port (`voyage-4`, 1024-d by default). Env-gated on `VOYAGE_API_KEY`;
   unconfigured means `isConfigured === false` and the caller falls back to lexical. Batched
   (128/request), order-preserving via the response `index`, and a wrong-width vector is a
   hard error — never zero-padded into a corrupt collection.

2. **Query/document asymmetry.** The port gained an optional
   `inputType?: 'query' | 'document'`. Modern models encode a search query differently from a
   stored passage, which measurably improves recall; providers that don't distinguish them
   ignore the hint. Ingestion and backfill embed as `document`, search as `query`.

3. **Unconstrained `vector` column.** `document_chunks.embedding` widened from `vector(256)`
   to `vector`, so collections of different widths coexist. `collection` (already indexed)
   isolates one model per collection and every query filters by it, so widths never mix inside
   a search. Existing lexical vectors are untouched.

4. **Provider and collection resolve as one value.** `resolveEmbedding()` in knowledge-core
   returns `{ provider, collection, semantic, note }`. Binding them makes the dangerous
   mismatch — embed with model A, query collection B, get meaningless scores —
   _unrepresentable_ rather than merely discouraged.

5. **A backfill makes the switch complete, not destructive.** `executeReembed` re-embeds a
   workspace's stored chunks into the active collection, driven by the `knowledge.reembed`
   worker job and a `POST knowledge/reembed` endpoint. It is idempotent (deterministic chunk
   id per source+collection), leaves the source collection intact so unsetting the key rolls
   back instantly, and `GET knowledge/status` reports real index coverage.

6. **The API states what retrieval did.** Search responses and the Intelligence UI carry the
   `retrieval` mode and a plain-English note; when lexical is active it says so, in those words.

## Rationale

- **Attacks the weakest link in the differentiator** — every downstream feature reads through
  this one path, so its quality is the ceiling on evidence quality generally.
- **Voyage fits the stack** — Anthropic's recommended embedding partner alongside the existing
  Claude adapter, with Matryoshka widths for a cost/quality dial.
- **Honest degradation, unchanged** — no key means lexical _and a statement that it is lexical_,
  never a silent downgrade dressed up as semantic search.
- **Unrepresentable beats documented** — pairing provider with collection removes a whole class
  of silent-corruption bug at the type level.

## Consequences

- Retrieval is semantic only when `VOYAGE_API_KEY` is set; otherwise lexical, and the UI says so.
- Changing model or width creates a new collection and **requires a re-embed**; until it runs,
  `knowledge/status` reports incomplete coverage rather than pretending.
- pgvector can only build ivfflat/hnsw indexes on fixed-width columns, so this table uses exact
  cosine scan — more accurate than ANN, and adequate at current scale. (The previous HNSW index
  was already dropped by a generated migration in phase-2 closeout, so nothing live was lost.)
  Revisit with per-width partitions or a dedicated vector store when scan time dominates.
- Embedding calls now cost money per ingested finding; usage metering is not yet built.
