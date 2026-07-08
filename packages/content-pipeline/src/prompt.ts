import { wrapUntrustedContent } from '@spectra/knowledge-core';

import type { DraftGenerationInput } from './types';

/**
 * Versioned prompt template. Bumped whenever the wording changes so drafts stay
 * attributable and regressions are bisectable (persisted on every ContentDraft).
 */
export const PROMPT_TEMPLATE_ID = 'evidence-grounded-draft';
export const PROMPT_VERSION = '1.0.0';

const CONTENT_TYPE_FORMAT: Record<string, string> = {
  POST: 'a single concise social media post (no headers, no markdown headings)',
  ARTICLE: 'a structured article with a headline and short sections',
  THREAD: 'a numbered social thread, one idea per line prefixed with its index',
  VIDEO_SCRIPT: 'a short video script with spoken lines and brief scene directions',
  SHORT_VIDEO: 'a short-form video script (under 60 seconds of spoken content)',
  LONG_VIDEO: 'a long-form video script with an intro, segments and an outro',
  IMAGE: 'a caption plus a concrete visual concept brief for a designer',
  CAROUSEL: 'a carousel outline, one slide per line with a heading and caption',
  AUDIO: 'an audio segment script written for the ear, not the eye',
  EMAIL: 'a marketing email with a subject line followed by the body',
  OTHER: 'a piece of marketing content',
};

export interface BuiltDraftPrompt {
  instructions: string;
  dataSections: string[];
  /** Ordered source ids the [n] markers map to (findings then citations). */
  sourceOrder: string[];
}

/**
 * Builds an evidence-grounded prompt. Trusted operator/brand guidance becomes
 * the `instructions` (system); the numbered evidence becomes a wrapped,
 * untrusted `dataSection`. The two are never concatenated — the model is told
 * the evidence is data to ground on, not instructions to obey.
 */
export function buildDraftPrompt(input: DraftGenerationInput): BuiltDraftPrompt {
  const format = CONTENT_TYPE_FORMAT[input.contentType] ?? CONTENT_TYPE_FORMAT.OTHER;

  const instructionLines: string[] = [
    'You are an expert brand content writer for a research-first marketing platform.',
    `Write ${format}.`,
    `Working title: ${input.title}.`,
  ];
  if (input.objective) instructionLines.push(`Objective: ${input.objective}.`);
  if (input.funnelStage) {
    instructionLines.push(`Funnel stage: ${input.funnelStage.toLowerCase()}.`);
  }
  if (input.targetPlatform) instructionLines.push(`Target platform: ${input.targetPlatform}.`);
  if (input.brandVoice) instructionLines.push(`Brand voice to follow: ${input.brandVoice}`);
  if (input.additionalGuidance) {
    instructionLines.push(`Additional guidance: ${input.additionalGuidance}`);
  }

  instructionLines.push(
    '',
    'GROUNDING RULES — these are absolute:',
    '- Base every factual claim, statistic and quote ONLY on the numbered sources',
    '  provided in the data block. Do not use outside knowledge for facts.',
    '- When you state a fact from a source, cite it inline with its number, e.g. [1].',
    '- Never invent statistics, quotes, source names or URLs. If the evidence does',
    '  not support a claim, do not make it.',
    '- If the provided evidence is too thin to write a credible piece, say so plainly',
    '  instead of padding with unsupported claims.',
    '- Output only the content itself — no preamble, no notes about these rules.',
  );

  // Build the numbered evidence block. Findings first, then standalone citations.
  const sourceOrder: string[] = [];
  const evidenceLines: string[] = [];
  if (input.evidence.packSummary) {
    evidenceLines.push(`Topic summary: ${input.evidence.packSummary}`, '');
  }
  evidenceLines.push('SOURCES:');

  let index = 0;
  for (const finding of input.evidence.findings) {
    index += 1;
    sourceOrder.push(finding.id);
    const publisher = finding.sourceTitle ?? 'Unknown source';
    evidenceLines.push(
      `[${index}] ${publisher} — ${finding.sourceUrl}`,
      `    Finding: ${finding.summary}`,
    );
    if (finding.excerpt) evidenceLines.push(`    Excerpt: ${finding.excerpt}`);
  }
  for (const citation of input.evidence.citations) {
    index += 1;
    sourceOrder.push(citation.id);
    const publisher = citation.sourceTitle ?? 'Unknown source';
    evidenceLines.push(
      `[${index}] ${publisher} — ${citation.sourceUrl}`,
      `    Quote: "${citation.quote}"`,
    );
  }

  if (index === 0) {
    evidenceLines.push('(No sources were supplied.)');
  }

  const { wrapped } = wrapUntrustedContent(
    evidenceLines.join('\n'),
    `evidence pack "${input.evidence.packTitle}"`,
  );

  return {
    instructions: instructionLines.join('\n'),
    dataSections: [wrapped],
    sourceOrder,
  };
}
