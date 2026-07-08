import type { TextGenerationProvider } from '@spectra/ai-core';

import { PROMPT_TEMPLATE_ID, PROMPT_VERSION, buildDraftPrompt } from './prompt';
import type { DraftGenerationInput, DraftGenerationResult } from './types';

/**
 * Generates an evidence-grounded draft via the given text-generation provider.
 *
 * The returned draft records the EXACT citation and finding ids that were
 * supplied to the model as grounding — never a fabricated set. Persistence and
 * tenant checks are the caller's responsibility; this stays pure domain logic.
 */
export async function generateDraft(
  provider: TextGenerationProvider,
  input: DraftGenerationInput,
): Promise<DraftGenerationResult> {
  const prompt = buildDraftPrompt(input);

  const result = await provider.generateText({
    tenant: input.tenant,
    instructions: prompt.instructions,
    dataSections: prompt.dataSections,
    promptTemplate: { templateId: PROMPT_TEMPLATE_ID, version: PROMPT_VERSION },
    ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
  });

  return {
    body: result.text,
    modelRef: result.modelRef,
    ...(result.usage ? { usage: result.usage } : {}),
    finishReason: result.finishReason,
    promptTemplateId: PROMPT_TEMPLATE_ID,
    promptVersion: PROMPT_VERSION,
    groundedCitationIds: input.evidence.citations.map((c) => c.id),
    groundedFindingIds: input.evidence.findings.map((f) => f.id),
  };
}
