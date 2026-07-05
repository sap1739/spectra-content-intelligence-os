# Domain Model

## 1. Tenancy

```
User ──< Membership >── Organization ──< Workspace
                                            │
                        Brand ──────────────┤
                        CustomVertical ─────┤
                        ResearchProject ────┤
                        (all tenant data) ──┘
```

- **Organization** — billing/administrative boundary. Users join via **Membership**
  (role + explicit extra permissions + optional workspace restriction).
- **Workspace** — the primary isolation boundary for day-to-day data (a client, a brand
  portfolio, a team). All research/content data carries `organizationId` **and** `workspaceId`.
- **User** — global identity; `timezone` and `locale` are explicit; storage is UTC.

## 2. Intelligence domain

```
CustomVertical ──< ResearchProject ──< ResearchRun ──< ResearchSource ──< SourceSnapshot
                        │                                   │
                        │                                   └──< ResearchFinding ──< Citation
                        │                                              │
                        ├──< ExtractedClaim (◄ supporting/contradicting findings)
                        ├──< TopicCluster · CompetitorFinding · ResearchReport
                        ├──< EvidencePack (claims + citations + findings + trends)
                        └──< TrendCandidate (◄ TrendSignal · TrendScoreResult · TrendLifecycle)
```

Key invariants:

- A finding always references a source; a citation always references finding + source (and
  snapshot when captured). Provenance (provider, retrieval time, pipeline version) is embedded.
- Trend candidates start `UNVERIFIED`; scores embed the scoring config id/version and a
  component-level explanation.
- Evidence packs record `usedByContentItemIds` — the forward edge of citation lineage.

## 3. Strategy & content domain (contracts now, tables later)

```
ContentObjective ┐
AudiencePersona  ├─► CampaignStrategy ──► Campaign ──► CampaignBrief
ContentPillar    ┘                              │
TopicIdea ──< ContentAngle                      ▼
                              ContentItem ──< ChannelVariant ── PlatformCapability(version)
                                   │
                                   ├─ researchReference (project/findings/trends/citations/packs)
                                   ├─ generation (jobId · promptVersion · modelVersion)
                                   ├─ humanEdits[] · approvals[]
                                   └─ lifecycleState (enum below)
ContentCalendar ──< entries (UTC instants, display timezone explicit)
```

## 4. Content lifecycle (single source of truth: `@spectra/contracts` lifecycle.ts)

```
IDEA → RESEARCHING → RESEARCH_READY → BRIEF → STRATEGY → DRAFT → GENERATED → EDITING
   → REVIEW → (CHANGES_REQUESTED ⇄ EDITING) → APPROVED → SCHEDULED → PUBLISHING
   → PUBLISHED | PARTIALLY_PUBLISHED | FAILED → ARCHIVED
```

Transitions are whitelisted in `CONTENT_LIFECYCLE_TRANSITIONS`; anything else throws
`InvalidLifecycleTransitionError`. Trend states have their own transition map in
`@spectra/trend-core`.

## 5. Roles → permissions

Thirteen roles (ORG_OWNER … READ_ONLY) are labels over permission bundles defined in
`@spectra/security`. Authorization checks always test permissions (e.g. `content:approve`,
`research:run`), never role names; memberships can carry extra grants. See
[SECURITY.md](SECURITY.md).

## 6. Phase 1 persistence vs. contracts

| Persisted now (Prisma)                                        | Contract-only (tables in later phases)                                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| User, Organization, Membership, Workspace                     | ResearchQuestion/Query, SourceSnapshot, ExtractedClaim, Citation, EvidencePack, TopicCluster, CompetitorFinding, ResearchReport |
| Brand, CustomVertical                                         | TrendSignal, TrendCluster, TrendAlert, TrendWatchlist                                                                           |
| ResearchProject, ResearchRun, ResearchSource, ResearchFinding | All strategy/content entities, media assets, social accounts                                                                    |
| TrendCandidate, AuditLog                                      | Knowledge documents/chunks/entities                                                                                             |

Contract-first means later tables materialize already-agreed shapes.
