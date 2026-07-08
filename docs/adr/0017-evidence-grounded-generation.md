# ADR-0017: Evidence-grounded content generation with the first paid AI adapter

**Status:** Accepted · **Date:** 2026-07-08 · **Relates to:** ADR-0011, ADR-0016, AI_PROVIDER_STRATEGY

## Context

Phase 3 begins content creation. The product promise is _defensible_ content: every draft
traceable to the research and citations behind it, never fabricated. Two things had to land
together — the first real AI provider (previously interfaces-only) and a drafting flow that
grounds output in the Phase 2 evidence layer (findings, citations, living evidence packs).
The hard constraints from `CLAUDE.md` remain in force: no hard-coded secrets, honest empty
states, provider-neutral domain logic, and structural prompt-injection defence.

## Decision

1. **First adapter behind the port — `@spectra/ai-anthropic`.** Implements the ai-core
   `TextGenerationProvider` using the Anthropic SDK (default model `claude-opus-4-8`). It is
   **env-gated**: with no `ANTHROPIC_API_KEY` the provider reports `isConfigured === false`
   and `generateText` throws `AiProviderUnavailableError`. The key lives only inside the SDK
   client — never logged, echoed in errors, or serialised. Sampling params are omitted for
   the Opus 4.x / Claude 5 families (which reject them). Domain code depends only on the
   ai-core port; the vendor is swappable.

2. **Grounded drafting — `@spectra/content-pipeline`.** A pure-domain generator builds a
   prompt that structurally separates **trusted instructions** (system: task, brand voice,
   grounding rules) from **untrusted evidence** (a numbered `SOURCES` block wrapped by
   knowledge-core `wrapUntrustedContent`, placed in the user turn). The model is instructed
   to cite `[n]` markers and never invent statistics, quotes or sources. The returned draft
   records the **exact** citation and finding ids it was grounded on — never a fabricated set.

3. **Honest unavailability over fake output.** When no provider is configured the API returns
   `503` from the draft endpoint and the Studio UI shows an explicit "AI generation is not
   configured" banner. Content items can still be created and organised; only generation is
   gated. No placeholder or sample text is ever produced.

4. **Full provenance persisted.** `ContentDraft` records the model provider/name/version, the
   versioned prompt template id + version, token usage, finish reason, and the grounded
   citation/finding ids — so outputs are attributable and regressions bisectable
   (`GenerationRecord` contract). `ContentItem` carries the evidence pack, project, topic and
   citation lineage; the evidence pack tracks `usedByContentItemIds` (forward lineage).

## Rationale

- **Structural, not prompt-based, injection defence** — trusted and untrusted text are never
  concatenated (extends ADR-0016 / PROMPT_INJECTION_DEFENCE to generation).
- **Env-gated honesty** keeps the platform truthful when unconfigured, satisfying the "no fake
  integrations / honest empty states" ground rule even now that a paid API exists.
- **Grounding ids recorded from the pack, not the model** means citations shown to users are
  the ones actually supplied as evidence — the model cannot manufacture a citation.
- **Provider-neutral** — a second vendor (or a local model) lands as another adapter with no
  change to `content-pipeline` or the API.

## Consequences

- Drafting requires a configured key; without one the feature is visibly disabled (by design).
- Synchronous generation in the API keeps the first slice simple; long-form output will move
  to a worker job with streaming in a later increment.
- Citation _placement_ inside the prose (the `[n]` markers) is model-produced and not yet
  verified against the source set; a validation pass (flagging markers with no backing source)
  is future work. The recorded grounded-id set is authoritative for provenance regardless.
- Moderation-before-publish (ADR / AI_PROVIDER_STRATEGY §2.5) is not part of this slice; it
  gates the approval flow in a later increment.
