# ADR-0012: Versioned, configurable, explainable trend scoring

**Status:** Accepted · **Date:** 2026-07-05

## Context

Trend value differs by tenant/vertical; a hard-coded formula would be wrong for most users
and unauditable for all. Scores must be explainable to be trusted.

## Decision

- `TrendScoringEngine` interface with pluggable engines; the shipped reference is a
  **weighted linear model with penalty components** (`WeightedTrendScoringEngine`).
- Formulas are **data**: `TrendScoringConfig` (id, semver version, per-component weights,
  penalty list, minimum source count). Configs are immutable per version.
- Every `TrendScoreResult` embeds config id+version, per-component raw/normalized/weighted
  values, and a `TrendExplanation` (headline, reasoning, top contributors, risk flags).

## Rationale

- Weighted-linear is deterministic, cheap, and — critically — trivially explainable; ML
  ranking can arrive later as another engine behind the same interface without breaking the
  result contract.
- Version-stamping makes historical scores reproducible and A/B-able across config versions.
- Penalties as subtractive components (misinformation, compliance, saturation) express risk
  without hiding it: they surface as risk flags in the explanation.

## Consequences

- Score recomputation appends new results; history is never rewritten.
- Component producers (Phase 2) must normalize inputs to [0,1] and may attach rationales;
  out-of-range inputs are rejected, not clamped silently at ingest.
