# Trend Scoring Architecture

## 1. Principles

1. **Configurable** — weights and penalties are data (`TrendScoringConfig`), not code.
2. **Versioned** — every score records `configId` + `configVersion`; historical scores stay
   reproducible after formula changes.
3. **Explainable** — every result carries per-component contributions, top contributors,
   reasoning lines and risk flags; the UI can always answer "why this score?".
4. **Evidence-floored** — candidates below `minimumSourceCount` distinct sources are flagged
   and should remain `UNVERIFIED`.

## 2. Components (`TREND_SCORE_COMPONENT_KEYS`)

Positive-capable: freshness, velocity, searchInterest, sourceDiversity, sourceCredibility,
audienceRelevance, brandRelevance, geographicRelevance, engagementPotential (estimated),
measuredEngagement (platform-measured, 6H), commercialIntent, novelty, seasonality.
Penalty-typical: saturation, misinformationRisk, complianceRisk.

Component inputs are normalized to [0,1] before weighting. Producers (Phase 2 pipeline) map
raw signals — e.g. `velocity = growth in mention rate over window` — into that range and may
attach a per-component rationale string.

## 3. Reference engine (`WeightedTrendScoringEngine`)

```
positive  = Σ (normalizedValue × weight)        over non-penalty components present
penalty   = Σ (normalizedValue × weight)        over penalty components present
score     = clamp01( positive / Σ positiveWeights − penalty )
display   = round(score × 100, 0.1)
```

Properties: deterministic; missing components simply don't participate (no fabricated
defaults); out-of-range inputs throw; scoring with zero positive components throws. The
`TrendScoringEngine` interface allows entirely different engines (learned models, per-vertical
ensembles) without changing consumers — the result contract is the invariant.

## 4. Explanation contract (`TrendExplanation`)

- `headline` — one-line summary with config id/version.
- `reasoning[]` — per-component contribution sentences, ordered by |impact|.
- `topContributors[]` — top 3 {component, contribution}.
- `riskFlags[]` — high penalty components; insufficient-evidence warnings.

## 5. Lifecycle

`UNVERIFIED → EMERGING → ACCELERATING → PEAKING → STABLE/DECLINING`, with `SEASONAL`,
`EVERGREEN` and terminal `REJECTED`. Transitions are whitelisted in
`TREND_STATE_TRANSITIONS`; state changes emit `TrendLifecycleEvent` records and can raise
`TrendAlert`s against `TrendWatchlist`s (contracts ready; production in Phase 2).

## 6. Configuration management (Phase 2+)

Configs are stored per tenant (fallback to the shipped `spectra-default@1.1.0`), versioned
immutably: editing creates a new version. Vertical `relevanceCriteria` weights feed the
`brandRelevance`/`audienceRelevance` component producers. Score recomputation is a queued job
that never mutates historical `TrendScoreResult`s — new results append.

## Evidence weighting (Phase 5F, ADR-0030)

Two corrections to how findings feed the scoring engine:

- **Snippet-only findings are down-weighted**, not dropped. Component averages
  (`freshness`, `sourceCredibility`) are weighted, with snippet-only findings at
  `SNIPPET_ONLY_CONFIDENCE_FACTOR` (0.4). The _effective source count_ used against
  `minimumSourceCount` is discounted the same way, so a trend supported only by search snippets
  cannot reach the verification threshold on volume alone.
- **Syndication no longer inflates `sourceDiversity`.** Diversity counts duplicate _clusters_
  rather than rows: one wire story republished by ten outlets is one corroboration, not ten.
  Combined with the broadened URL canonicalization, the same article arriving via newsletter,
  social share and search no longer reads as three independent publishers.

Only evidence-eligible findings are scored at all — blocked domains, injection-quarantined
sources and duplicates are excluded upstream, with this as the safety net.

Scores for snippet-heavy or syndicated topics are therefore lower than before 5F. That is the
correction; the previous numbers overstated the evidence.

## Measured engagement (Phase 6H, ADR-0039)

`engagementPotential` is an **estimate** and stays one. `measuredEngagement` is a separate component
fed by platform analytics:

- **Source labels.** Every `TrendScoreComponent` may carry `source`: `ESTIMATED`,
  `FIRST_PARTY_MEASURED` or `EXTERNAL_MEASURED`. The Trends page shows it beside the component
  ("platform measured", "estimated").
- **The signal.** `measuredEngagementForTopic` takes the latest snapshot of each published post whose
  content item carries the candidate's `topicKey`, and pools one engagement rate —
  Σ interactions / Σ impressions (or views) over the posts that reported both. It is scaled to
  [0, 1] against `DEFAULT_ENGAGEMENT_REFERENCE_RATE` (5%): a Spectra calibration constant, shown in
  the rationale, to be revisited once real distributions exist.
- **Missing is not zero.** With no measured posts, or none reporting a denominator, the signal is
  added to `unavailableSignals` (`source: UNAVAILABLE`, a reason and a detail) and does **not**
  participate: the score equals the research-only score exactly, and the explanation says "not
  counted, not treated as zero". Passing the same key as both a component and an unavailable signal
  throws.
- **Config.** `spectra-default` moved to **1.1.0**, adding `measuredEngagement: 0.1`. Because missing
  components do not participate, every score without measured engagement is unchanged.
