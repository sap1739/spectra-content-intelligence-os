# ADR-0043: Research-backed campaign orchestration, with an evidence gate that blocks

**Status:** Accepted · **Date:** 2026-10-04 · **Relates to:** ADR-0017, ADR-0026, ADR-0029,
ADR-0030, ADR-0032, ADR-0039

## Context

Every earlier phase built one capability well and left the seams to the operator: research produced
findings, trend scoring ranked topics, evidence packs collected sources, content generation wrote a
draft when pointed at a pack, and the calendar scheduled what a human approved. Nothing connected
them.

Connecting them is where a content tool usually starts lying. The pattern is familiar: ask a model
for "a content strategy", get back five plausible personas, four pillars and twenty topic ideas, and
present it as insight. None of it traces to anything. The audience is invented, the topics are
whatever the model associates with the industry, and the research the operator paid for is
decoration.

The second failure mode is subtler: generate content for every topic, whether or not the evidence
supports it. A post about a trend with one snippet behind it reads exactly like a post about a trend
with six independent sources — unless something refuses to write the first one.

## Decision

### 1. The strategy engine is deterministic, and derived from rows

`buildStrategy` is a pure function. Objectives come from the funnel stages the campaign will
actually cover; pillars from the vertical's own keywords, with any trend matching none of them
becoming its own pillar rather than being dropped; personas from what the operator configured, and
only failing that from the vertical's named audiences; topic ideas from the selected trends; platform
strategy from the declared capability matrix; CTAs from a fixed library keyed by funnel stage.

A model would write more fluent prose. It would also be fiction, and nothing downstream could trace
it. Every element here points back at a row, and the engine is versioned (`spectra-strategy@1.0.0`)
so a later change is visible.

What the engine cannot do, it says. A derived persona is labelled `DERIVED` and described as a
placeholder. A platform with no connected account is marked `publishingAvailable: false` with the
consequence spelled out.

### 2. The evidence gate decides what gets written

`assessEvidence` is the single place that judges one topic, and it is the heart of the phase. Six
verdicts map to three actions, and the mapping is fixed rather than advisory:

| Verdict        | Action             | When                                                      |
| -------------- | ------------------ | --------------------------------------------------------- |
| `SUPPORTED`    | ALLOW              | Corroborated by independent publishers, retrieved in full |
| `LIMITED`      | ALLOW_WITH_CAUTION | Too few independent sources, or no verified claim         |
| `SNIPPET_ONLY` | ALLOW_WITH_CAUTION | Every source is a search snippet, never a page read       |
| `STALE`        | ALLOW_WITH_CAUTION | The newest supporting source is past tolerance            |
| `CONTRADICTED` | ALLOW_WITH_CAUTION | Sources disagree                                          |
| `UNSUPPORTED`  | **BLOCK**          | Nothing usable backs it                                   |

Four decisions inside it are deliberate:

- **Independence is counted by publisher, not by article.** Six pieces from one outlet are one
  source. This is what ADR-0032 already meant by corroboration.
- **Ineligible sources are not weak evidence, they are none.** A blocked domain or an
  injection-quarantined page (ADR-0030) is excluded before anything else is judged.
- **Disagreement outranks everything.** A contradicted topic may still be worth writing, but only as
  a disagreement, and the caution guidance says so.
- **Unverified is weaker than low-confidence.** A topic whose claims were never verified is
  `LIMITED`, never `SUPPORTED`, and the reason distinguishes "too few sources" from "no claim has
  been verified" rather than blaming the wrong thing.

A cautioned item does not simply get a flag. `cautionGuidance` produces trusted operator-side
instruction that reaches the prompt through `additionalGuidance` — "state findings as preliminary
and attribute them", "date every claim explicitly", "present the disagreement" — so the hedge is in
the writing, not only in the metadata.

### 3. A blocked topic stays visible

Blocked items are kept in the plan under `blocked`, recorded in the run's results with outcome
`BLOCKED` and the reason, and shown in the UI. Dropping them silently would hide the most useful
signal the system produces: _the research does not yet support this_.

When every topic is blocked, the run fails with `ALL_ITEMS_BLOCKED` rather than creating an empty
campaign.

### 4. Partial is a first-class outcome

`CampaignOrchestrationRun` walks eight stages and records each one's status, note and timings. The
run ends `SUCCEEDED` only when everything it set out to do happened. If some topics were blocked, or
some drafts failed, or no generator was configured, it ends **`PARTIAL`** — and the row says exactly
which items exist, which do not and why.

This matters most for the unconfigured case. With no `ANTHROPIC_API_KEY`, the run still produces a
real strategy, a real plan, a real calendar and real evidence-linked content items; only the prose is
missing. Reporting that as `FAILED` would be wrong, and reporting it as `SUCCEEDED` would be worse.

A single failed draft never discards the campaign: the item is recorded with the provider's reason
and the run continues.

### 5. Nothing is published, and nothing is scheduled, by a run

Drafted items move to `REVIEW`. A person approves them and schedules them through the existing
calendar, which already refuses targets Spectra cannot publish to. `GET capabilities` returns
`publishesAutomatically: false`, and the wizard says so before a run starts.

### 6. Budget and idempotency

A `CONTENT_DRAFT` pre-flight runs **before the run row exists**, sized by the number of drafts the
run would actually write, so a campaign the workspace cannot afford is refused rather than
half-built. `orchestrationRunKey` hashes the inputs that decide the output — trend ids and platforms
order-independently — so a retry adopts the existing run, and a completed run is skipped rather than
rebuilt.

## Consequences

- An operator can go from a scored vertical to a reviewable, evidence-linked campaign in one action,
  and every item answers "what is this based on?" with finding ids, citation ids and a pack.
- **Thin research produces a thin campaign, visibly.** A workspace with one snippet per topic gets
  cautioned items and blocked ones, not a confident-looking calendar.
- The strategy is less fluent than a generated one. That is the trade: it is checkable.
- Personas are the weakest artifact — with nothing configured, the engine emits a labelled
  placeholder rather than inventing a profile. Real persona support is a strategy-record feature,
  not an orchestration one.
- Claim verification is used where it exists (confidence and contradiction counts feed the gate), but
  a workspace that has not run verification gets `LIMITED` across the board. That is correct, and it
  makes the value of verification visible.
- The gate's thresholds (2 independent publishers, 180 days) are constants today. They belong in
  workspace policy once operators disagree about them.
