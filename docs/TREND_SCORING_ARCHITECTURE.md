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
audienceRelevance, brandRelevance, geographicRelevance, engagementPotential, commercialIntent,
novelty, seasonality.
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

Configs are stored per tenant (fallback to the shipped `spectra-default@1.0.0`), versioned
immutably: editing creates a new version. Vertical `relevanceCriteria` weights feed the
`brandRelevance`/`audienceRelevance` component producers. Score recomputation is a queued job
that never mutates historical `TrendScoreResult`s — new results append.
