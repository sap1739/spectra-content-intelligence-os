# ADR-0011: Citations as first-class relational rows with immutable snapshots

**Status:** Accepted · **Date:** 2026-07-05

## Context

The product promise is defensible content: every claim traceable to sources, verifiable
after the fact, with staleness and duplication visible. Alternatives considered: citations
embedded in generated markdown; citations as JSON blobs on findings; link-only references
without content capture.

## Decision

- `Citation` is a dedicated contract/row referencing finding + source (+ snapshot), with
  publisher/author/dates and an excerpt locator (offsets/selector/page).
- Sources get **immutable, hash-addressed snapshots** (`SourceSnapshot`) in tenant-scoped
  object storage at retrieval time.
- Lineage flows forward: citations → evidence packs → `GeneratedContentReference` →
  content items.

## Rationale

- Embedded/markdown citations rot and cannot be queried ("which published posts cite this
  retracted source?"); rows make lineage a join.
- Snapshots make quotes byte-verifiable even after sources change or vanish — retrieval
  date + content hash is the audit anchor.
- Locators (not just URLs) let reviewers jump to the exact supporting passage.

## Consequences

- Storage cost for snapshots is accepted and bounded by retention policy per tenant.
- Snapshots are stored for verification, not republication (copyright metadata retained;
  see OPEN_SOURCE_AND_LICENSE_POLICY.md).
- Deleting a source cascades findings/citations logically via status flags rather than
  destroying audit history (soft-delete rules in DATABASE_DESIGN.md).
