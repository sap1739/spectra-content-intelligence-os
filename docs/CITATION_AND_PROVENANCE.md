# Citation & Provenance

Every statement the platform produces must be attributable. This document defines how the
data model answers the seven traceability questions.

## 1. The provenance chain

```
Provider request ─► ResearchSource ─► SourceSnapshot (immutable bytes, contentHash)
                         │
                         └─► ResearchFinding (excerpt + excerptLocation + scores)
                                   │
                     Citation ◄────┤            ExtractedClaim ◄─ supporting/contradicting findings
                         │         │
                         └───► EvidencePack ───► GeneratedContentReference ───► ContentItem
```

Every ingested artifact embeds a `Provenance` record: `providerId`, `providerKind`,
`requestRef`, `retrievedAt`, `pipelineVersion`. Copyright metadata (license, rights holder,
attribution requirement) rides alongside.

## 2. The seven questions

| Question                                  | Answered by                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| Which source supported this statement?    | `Citation.findingId → sourceId` (+ snapshot)                                         |
| When was it published?                    | `ResearchSource.publishedAt` (detected stage 10)                                     |
| When was it retrieved?                    | `ResearchSource.retrievedAt` / `SourceSnapshot.retrievedAt`                          |
| Has it become stale?                      | `freshnessScore`, `SourceDocument.freshUntil`, finding status `STALE`                |
| Was the source duplicated elsewhere?      | `duplicateOfSourceId` (exact) / `duplicateClusterKey` (near)                         |
| Was the claim verified by another source? | `ExtractedClaim.supportingFindingIds` across distinct sources + `verificationStatus` |
| Which generated content used this claim?  | `EvidencePack.usedByContentItemIds` + `GeneratedContentReference`                    |

## 3. Storage rules (ADR-0011)

- Citations are **first-class relational rows**, not markdown artifacts inside generated text.
- Snapshots are immutable and hash-addressed in tenant-scoped object storage; a citation can
  always be re-verified against the bytes that were actually read.
- Excerpt locators (`startOffset`/`endOffset`/`selector`/`page`) point into the extracted
  snapshot text, so quotes are byte-verifiable.
- Nothing downstream may "flatten" citations away: content variants carry their references
  through `researchReference`.

## 4. Staleness & recall workflow (Phase 2+)

A scheduled job re-scores freshness; findings crossing the staleness threshold flip to
`STALE`, which (via lineage) flags affected evidence packs (`status: STALE`) and lists
affected published content for editorial review.

## 5. Display requirements

Generated drafts render citation markers bound to `Citation` ids; the review UI shows
publisher, publication date, retrieval date and credibility per citation; exports include a
source list. AI-generated content labelling requirements are covered in
[SECURITY.md](SECURITY.md).
