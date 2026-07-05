# ADR-0010: Research provider abstraction — typed ports + runtime registry

**Status:** Accepted · **Date:** 2026-07-05

## Context

Research must aggregate many volatile external sources (search, news, RSS, communities,
video, documents, signals) without coupling pipelines to any vendor, and Phase 1 must ship
zero integrations without blocking Phase 2.

## Decision

Eleven kind-specific TypeScript interfaces in `@spectra/research-core`, each extending a
common `ProviderIdentity` (id, kind, displayName, `isFixture`), returning normalized
contract shapes (`DiscoveredSource`, `TrendSignal`, `ExtractedContent`,
`VerificationAssessment`). A `ResearchProviderRegistry` resolves adapters by kind
(optionally id) at runtime.

## Rationale

- Kind-specific interfaces (vs. one generic `search()`) keep signatures honest: signal
  providers return time-series values, extraction returns text+metadata+injection risk —
  a generic port would immediately degrade into `unknown` payloads.
- Registry over DI wiring: pipelines select providers per query plan (a vertical may prefer
  different vendors), and multi-provider fan-out per kind is a first-class need.
- `isFixture` flag lets tests/dev use deterministic providers while production wiring
  rejects them — no fake integrations can leak into real runs.

## Consequences

- Every adapter must normalize immediately; raw vendor payloads only exist as storage
  snapshots for reprocessing.
- Provenance (providerId/kind/requestRef) is stamped on all outputs, feeding citations.
