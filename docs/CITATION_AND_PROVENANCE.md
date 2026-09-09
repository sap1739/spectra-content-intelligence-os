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

## Source quality on the provenance record (Phase 5F, ADR-0030)

Every `ResearchSource` now records how well we actually retrieved it, alongside where it came
from:

| Field                                          | Meaning                                                                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `snippetOnly`                                  | The body is a search snippet, not the article. Always paired with a `fetchNote` saying why.                                                     |
| `robotsDecision`                               | `ALLOWED` / `DISALLOWED` / `UNAVAILABLE` / `NOT_CHECKED`. `UNAVAILABLE` means we did not verify permission — it is never recorded as `ALLOWED`. |
| `robotsCheckedAt`                              | When the check ran.                                                                                                                             |
| `stalenessStatus`                              | `FRESH` / `AGING` / `STALE` / `EVERGREEN` / `UNKNOWN`. `UNKNOWN` means no publication date was stated.                                          |
| `evidenceEligible` + `evidenceExclusionReason` | Whether it may be cited, and if not, precisely why.                                                                                             |
| `diversityWeight`                              | Below 1 for members of a syndication cluster.                                                                                                   |

Publication date and retrieval date are both preserved and distinct: `publishedAt` may be null
(and then `stalenessStatus` is `UNKNOWN`), while `retrievedAt` is always recorded.

A citation built from a snippet-only source is still a real citation to a real URL — but the
record says it is snippet-derived, and downstream weighting treats it accordingly.

## Document citation anchors (Phase 5G, ADR-0031)

A citation into a document carries a locator, not just a URL. `Citation` gained `anchorKind`
(PAGE / SECTION / LINE / CHARACTER_RANGE), `pageNumber`, `sectionOrder` and `anchorLabel`
(e.g. `p. 12`, `§ Methodology`).

Every anchor also carries a character range into the extracted text, so the exact passage can be
re-read and verified. Both are stored deliberately: the character range is precise but tied to a
parser version, while the page or section number stays meaningful if the text is ever re-extracted.

Web-page citations leave these fields NULL — they have no internal structure, and inventing one
would imply precision that does not exist.
