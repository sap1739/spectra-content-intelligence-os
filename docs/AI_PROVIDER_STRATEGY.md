# AI Provider Strategy

**Phase 1 status: interfaces only. No AI API — paid or free — is called anywhere in this
codebase.** `@spectra/ai-core` defines twelve ports so later phases plug vendors in without
touching domain logic.

## 1. Ports

TextGenerationProvider · StructuredGenerationProvider · EmbeddingProvider ·
ImageGenerationProvider · ImageEditingProvider · VideoGenerationProvider ·
TextToSpeechProvider · SpeechToTextProvider · AudioGenerationProvider ·
MusicGenerationProvider · ModerationProvider · TranslationProvider.

Shared conventions: every provider exposes a `ModelRef` (provider/model/version); every
result carries the `ModelRef` and optional `GenerationUsage` (tokens, micro-USD cost);
requests carry tenant scope; generation requests separate **instructions** from
**dataSections** (prompt-injection defence is structural, see
[PROMPT_INJECTION_DEFENCE.md](PROMPT_INJECTION_DEFENCE.md)).

## 2. Selection principles (Phase 3 wiring)

1. **Model-agnostic domain** — pipelines depend on ports; adapters are swappable per tenant
   and per task (drafting vs. structuring vs. embedding may use different vendors).
2. **Versioned everything** — content items persist `promptVersion` + `modelVersion`
   (`GenerationRecord`), so outputs are attributable and regressions bisectable.
3. **Structured-first** — pipeline steps use `StructuredGenerationProvider` with Zod
   schemas; free text is reserved for human-facing drafts.
4. **Cost & quota governance** — usage records aggregate per tenant for metering; budgets
   enforced at the port wrapper (decorator), not inside adapters.
5. **Moderation before publish** — `ModerationProvider` gates outbound content in the
   approval flow.
6. **Consent enforcement** — TTS adapters must reject cloned-voice requests lacking a
   verified `voiceConsentRef`.

## 3. Candidate adapters (evaluation matrix maintained from Phase 3)

Text/structured: Anthropic Claude, OpenAI, open-weights via local serving for cost tiers.
Embeddings: provider-replaceable by design (`EmbeddingRef` records provider/model/dims; see
[KNOWLEDGE_AND_RAG.md](KNOWLEDGE_AND_RAG.md) §5). Image/video/audio/music: evaluated when
Phase 3 begins — capabilities move too fast to pre-commit here.

## 4. Testing approach

Adapters get contract tests (record/replay fixtures — no live calls in CI) plus a smoke
suite executed manually against real keys outside CI. Fixture providers are flagged
(`isFixture`) and rejected by production wiring.
