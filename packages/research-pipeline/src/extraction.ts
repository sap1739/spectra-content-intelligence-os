import type { TenantScope } from '@spectra/contracts';
import { scanForPromptInjection } from '@spectra/knowledge-core';
import type {
  ContentExtractionProvider,
  ExtractedContent,
  ExtractionInput,
} from '@spectra/research-core';

import { htmlToText } from './html-text';

/**
 * First-party extraction: HTML/text → clean text + mandatory prompt-injection
 * assessment. Every piece of external content passes through here before any
 * downstream use.
 */
export class HtmlExtractionProvider implements ContentExtractionProvider {
  public readonly id = 'first-party-html-extraction';
  public readonly kind = 'content-extraction' as const;
  public readonly displayName = 'First-party HTML extraction';

  async extract(input: ExtractionInput, _tenant: TenantScope): Promise<ExtractedContent> {
    const raw = input.html ?? input.text ?? '';
    const extractedText = input.html ? htmlToText(raw) : raw.trim();

    const injectionRisk = scanForPromptInjection(extractedText, {
      kind: input.sourceUrl ? 'WEB_PAGE' : 'OTHER',
      ...(input.sourceUrl ? { refId: input.sourceUrl } : {}),
    });

    return {
      text: extractedText,
      injectionRisk,
    };
  }
}
