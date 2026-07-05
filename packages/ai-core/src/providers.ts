import type { TenantScope } from '@spectra/contracts';
import type { z } from 'zod';

/**
 * Provider-neutral AI provider contracts — INTERFACES ONLY in Phase 1.
 * No paid API is called anywhere in this codebase yet. Adapters arrive in
 * later phases behind these ports. See docs/AI_PROVIDER_STRATEGY.md.
 */

export interface ModelRef {
  provider: string;
  model: string;
  version?: string;
}

export interface GenerationUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalCostMicroUsd?: number;
}

/** Versioned prompt reference — content items record which prompt built them. */
export interface PromptTemplateRef {
  templateId: string;
  version: string;
}

export interface AiProviderIdentity {
  readonly id: string;
  readonly displayName: string;
  readonly modelRef: ModelRef;
}

export interface TextGenerationRequest {
  tenant: TenantScope;
  /** Trusted application instructions — NEVER mixed with retrieved content. */
  instructions: string;
  /** Untrusted data sections, pre-wrapped by knowledge-core isolation. */
  dataSections?: string[];
  promptTemplate?: PromptTemplateRef;
  maxOutputTokens?: number;
  temperature?: number;
  stopSequences?: string[];
}

export interface TextGenerationResult {
  text: string;
  modelRef: ModelRef;
  usage?: GenerationUsage;
  finishReason: 'stop' | 'length' | 'content_filter' | 'error';
}

export interface TextGenerationProvider extends AiProviderIdentity {
  generateText(request: TextGenerationRequest): Promise<TextGenerationResult>;
}

export interface StructuredGenerationProvider extends AiProviderIdentity {
  /** Generates output conforming to the given Zod schema (validated). */
  generateStructured<TSchema extends z.ZodTypeAny>(
    request: TextGenerationRequest,
    schema: TSchema,
  ): Promise<{ data: z.infer<TSchema>; modelRef: ModelRef; usage?: GenerationUsage }>;
}

export interface EmbeddingProvider extends AiProviderIdentity {
  readonly dimensions: number;
  embed(texts: readonly string[], tenant: TenantScope): Promise<number[][]>;
}

export interface ImageGenerationRequest {
  tenant: TenantScope;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  count?: number;
}

export interface GeneratedMediaResult {
  /** Tenant-scoped object storage keys of generated assets. */
  storageKeys: string[];
  modelRef: ModelRef;
  usage?: GenerationUsage;
}

export interface ImageGenerationProvider extends AiProviderIdentity {
  generateImage(request: ImageGenerationRequest): Promise<GeneratedMediaResult>;
}

export interface ImageEditingRequest {
  tenant: TenantScope;
  sourceStorageKey: string;
  instruction: string;
  maskStorageKey?: string;
}

export interface ImageEditingProvider extends AiProviderIdentity {
  editImage(request: ImageEditingRequest): Promise<GeneratedMediaResult>;
}

export interface VideoGenerationRequest {
  tenant: TenantScope;
  prompt: string;
  durationSeconds: number;
  width: number;
  height: number;
  referenceImageStorageKey?: string;
}

export interface VideoGenerationProvider extends AiProviderIdentity {
  generateVideo(request: VideoGenerationRequest): Promise<GeneratedMediaResult>;
}

export interface TextToSpeechRequest {
  tenant: TenantScope;
  text: string;
  voiceId: string;
  language?: string;
  /**
   * Mandatory consent reference for cloned/likeness voices.
   * Adapters MUST reject cloned-voice requests without a verified consent record.
   */
  voiceConsentRef?: string;
}

export interface TextToSpeechProvider extends AiProviderIdentity {
  synthesize(request: TextToSpeechRequest): Promise<GeneratedMediaResult>;
}

export interface SpeechToTextRequest {
  tenant: TenantScope;
  audioStorageKey: string;
  language?: string;
}

export interface TranscriptionResult {
  text: string;
  segments?: Array<{ startMs: number; endMs: number; text: string }>;
  language?: string;
  modelRef: ModelRef;
}

export interface SpeechToTextProvider extends AiProviderIdentity {
  transcribe(request: SpeechToTextRequest): Promise<TranscriptionResult>;
}

export interface AudioGenerationRequest {
  tenant: TenantScope;
  prompt: string;
  durationSeconds: number;
}

export interface AudioGenerationProvider extends AiProviderIdentity {
  generateAudio(request: AudioGenerationRequest): Promise<GeneratedMediaResult>;
}

export interface MusicGenerationRequest extends AudioGenerationRequest {
  genre?: string;
  instrumental?: boolean;
}

export interface MusicGenerationProvider extends AiProviderIdentity {
  generateMusic(request: MusicGenerationRequest): Promise<GeneratedMediaResult>;
}

export interface ModerationRequest {
  tenant: TenantScope;
  text?: string;
  mediaStorageKey?: string;
}

export interface ModerationResult {
  flagged: boolean;
  categories: Array<{ category: string; score: number }>;
  modelRef: ModelRef;
}

export interface ModerationProvider extends AiProviderIdentity {
  moderate(request: ModerationRequest): Promise<ModerationResult>;
}

export interface TranslationRequest {
  tenant: TenantScope;
  text: string;
  sourceLanguage?: string;
  targetLanguage: string;
}

export interface TranslationResult {
  text: string;
  detectedSourceLanguage?: string;
  modelRef: ModelRef;
}

export interface TranslationProvider extends AiProviderIdentity {
  translate(request: TranslationRequest): Promise<TranslationResult>;
}
