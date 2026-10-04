import { z } from 'zod';

import { isoDateTimeSchema, uuidSchema } from './common';

/**
 * Audio, voiceover and podcast contracts (Phase 7C, ADR-0042).
 *
 * Two rules shape this file:
 *
 *  1. **No voice is cloned without consent.** A voice profile that imitates a
 *     real person is unusable until a consent record is GRANTED and unexpired —
 *     expressed in the types, enforced in `assertVoiceUsable`, and checked again
 *     before any synthesis request is built.
 *  2. **Unavailable is a state, not a silence.** No speech-synthesis provider is
 *     wired in this codebase. Every capability therefore reports a status and a
 *     reason; nothing here describes audio that was not actually produced.
 */

// ---------------------------------------------------------------------------
// Provider vocabulary
// ---------------------------------------------------------------------------

export const AUDIO_PROVIDER_KINDS = [
  'TEXT_TO_SPEECH',
  'SPEECH_TO_TEXT',
  'AUDIO_GENERATION',
  'MUSIC_GENERATION',
] as const;
export const audioProviderKindSchema = z.enum(AUDIO_PROVIDER_KINDS);
export type AudioProviderKind = z.infer<typeof audioProviderKindSchema>;

/**
 * Why a capability can or cannot be used. `NOT_IMPLEMENTED` and
 * `NOT_CONFIGURED` are deliberately different: one says no adapter exists, the
 * other says one exists but this deployment has not been given credentials.
 */
export const AUDIO_PROVIDER_STATUSES = [
  'AVAILABLE',
  'NOT_CONFIGURED',
  'NOT_IMPLEMENTED',
  'DISABLED',
] as const;
export const audioProviderStatusSchema = z.enum(AUDIO_PROVIDER_STATUSES);
export type AudioProviderStatus = z.infer<typeof audioProviderStatusSchema>;

export const audioProviderCapabilitySchema = z.object({
  kind: audioProviderKindSchema,
  status: audioProviderStatusSchema,
  /** The adapter that would serve this, when one exists. */
  providerId: z.string().nullable(),
  /** Always a sentence an operator can act on. */
  reason: z.string().min(1),
  /** The environment variables that would turn this on, when that is the gap. */
  requiredEnv: z.array(z.string()).default([]),
});
export type AudioProviderCapability = z.infer<typeof audioProviderCapabilitySchema>;

// ---------------------------------------------------------------------------
// Voices and consent
// ---------------------------------------------------------------------------

/**
 * STOCK — a voice the provider owns and licenses; no personal likeness.
 * CLONED — built from a real person's recordings. Consent is mandatory.
 * CUSTOM_SYNTHETIC — commissioned and wholly synthetic, tied to no person.
 */
export const VOICE_KINDS = ['STOCK', 'CLONED', 'CUSTOM_SYNTHETIC'] as const;
export const voiceKindSchema = z.enum(VOICE_KINDS);
export type VoiceKind = z.infer<typeof voiceKindSchema>;

/** Only GRANTED permits use, and only until `expiresAt`. */
export const VOICE_CONSENT_STATUSES = ['PENDING', 'GRANTED', 'REVOKED', 'EXPIRED'] as const;
export const voiceConsentStatusSchema = z.enum(VOICE_CONSENT_STATUSES);
export type VoiceConsentStatus = z.infer<typeof voiceConsentStatusSchema>;

/** What the subject agreed their voice may be used for. Narrow by default. */
export const VOICE_CONSENT_SCOPES = [
  'INTERNAL_ONLY',
  'ORGANIC_SOCIAL',
  'PODCAST',
  'MARKETING',
  'PAID_ADVERTISING',
] as const;
export const voiceConsentScopeSchema = z.enum(VOICE_CONSENT_SCOPES);
export type VoiceConsentScope = z.infer<typeof voiceConsentScopeSchema>;

export const voiceConsentRecordSchema = z.object({
  id: uuidSchema,
  voiceProfileId: uuidSchema,
  /** The person whose voice this is. Never inferred. */
  subjectName: z.string().min(1).max(200),
  subjectEmail: z.string().email().nullish(),
  /** Who recorded the consent, and how it was obtained. */
  obtainedByUserId: uuidSchema.nullish(),
  method: z.enum(['WRITTEN_AGREEMENT', 'RECORDED_STATEMENT', 'SIGNED_RELEASE', 'OTHER']),
  /** A stored document or recording evidencing the agreement. */
  evidenceAssetId: uuidSchema.nullish(),
  /** A free-text reference to a contract, so consent can be audited offline. */
  reference: z.string().max(500).nullish(),
  scopes: z.array(voiceConsentScopeSchema).min(1),
  status: voiceConsentStatusSchema,
  grantedAt: isoDateTimeSchema.nullish(),
  /** Consent is time-boxed: an open-ended grant is not offered. */
  expiresAt: isoDateTimeSchema.nullish(),
  revokedAt: isoDateTimeSchema.nullish(),
  revokedReason: z.string().max(500).nullish(),
  createdAt: isoDateTimeSchema,
});
export type VoiceConsentRecord = z.infer<typeof voiceConsentRecordSchema>;

export const voiceProfileSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(120),
  kind: voiceKindSchema,
  /** The provider's identifier for this voice, once a provider exists. */
  providerId: z.string().max(100).nullish(),
  providerVoiceId: z.string().max(200).nullish(),
  language: z.string().min(2).max(35).default('en'),
  description: z.string().max(1000).nullish(),
  /** Set only for CLONED voices — the person being imitated. */
  subjectName: z.string().min(1).max(200).nullish(),
  consent: voiceConsentRecordSchema.nullish(),
  createdAt: isoDateTimeSchema,
});
export type VoiceProfile = z.infer<typeof voiceProfileSchema>;

/** Why a voice may not be used right now. `null` means it may. */
export const VOICE_BLOCK_REASONS = [
  'CONSENT_MISSING',
  'CONSENT_PENDING',
  'CONSENT_REVOKED',
  'CONSENT_EXPIRED',
  'CONSENT_SCOPE_NOT_COVERED',
] as const;
export const voiceBlockReasonSchema = z.enum(VOICE_BLOCK_REASONS);
export type VoiceBlockReason = z.infer<typeof voiceBlockReasonSchema>;

export const VOICE_BLOCK_REASON_TEXT: Record<VoiceBlockReason, string> = {
  CONSENT_MISSING:
    'This voice imitates a real person and has no consent record. Record written consent before using it.',
  CONSENT_PENDING: 'Consent for this voice has been requested but not yet granted.',
  CONSENT_REVOKED: 'The person whose voice this is has revoked their consent.',
  CONSENT_EXPIRED: 'Consent for this voice has expired and must be renewed.',
  CONSENT_SCOPE_NOT_COVERED: 'Consent for this voice does not cover the use this episode is for.',
};

// ---------------------------------------------------------------------------
// Podcast scripts and episodes
// ---------------------------------------------------------------------------

export const PODCAST_SEGMENT_KINDS = [
  'INTRO',
  'HOST',
  'GUEST',
  'INTERVIEW',
  'AD',
  'TRANSITION',
  'OUTRO',
] as const;
export const podcastSegmentKindSchema = z.enum(PODCAST_SEGMENT_KINDS);
export type PodcastSegmentKind = z.infer<typeof podcastSegmentKindSchema>;

/**
 * Where a segment's audio comes from. `UPLOADED` is the only source that works
 * with no provider configured, and the UI says so.
 */
export const segmentSourceSchema = z.discriminatedUnion('kind', [
  /** An audio file already in this workspace's media library. */
  z.object({ kind: z.literal('UPLOADED'), mediaAssetId: uuidSchema }),
  /** Spoken by a synthesis provider — requires one to be configured. */
  z.object({
    kind: z.literal('TEXT_TO_SPEECH'),
    voiceProfileId: uuidSchema,
    text: z.string().min(1).max(20_000),
  }),
  /** Deliberate silence, e.g. a beat before an ad. */
  z.object({ kind: z.literal('SILENCE'), durationMs: z.number().int().min(100).max(30_000) }),
]);
export type SegmentSource = z.infer<typeof segmentSourceSchema>;

export const MAX_SEGMENTS = 100;

export const podcastSegmentSchema = z.object({
  id: z.string().min(1).max(64),
  kind: podcastSegmentKindSchema,
  title: z.string().max(200).nullish(),
  source: segmentSourceSchema,
  /** Gain applied to this segment alone, in dB. */
  gainDb: z.number().min(-40).max(10).default(0),
  /** Host notes: never spoken, never rendered — production direction only. */
  hostNotes: z.string().max(5000).nullish(),
});
export type PodcastSegment = z.infer<typeof podcastSegmentSchema>;

export const podcastScriptSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    segments: z.array(podcastSegmentSchema).min(1).max(MAX_SEGMENTS),
    /** A music bed under the whole episode. */
    musicBed: z
      .object({
        mediaAssetId: uuidSchema,
        gainDb: z.number().min(-40).max(0).default(-18),
        fadeInMs: z.number().int().min(0).max(10_000).default(1000),
        fadeOutMs: z.number().int().min(0).max(10_000).default(2000),
      })
      .nullish(),
    /** Normalize the finished mix to a broadcast loudness target. */
    normalize: z.boolean().default(true),
    /** EBU R128 integrated loudness target. -16 LUFS is the podcast norm. */
    targetLufs: z.number().min(-30).max(-9).default(-16),
  })
  .superRefine((script, ctx) => {
    const ids = new Set<string>();
    for (const segment of script.segments) {
      if (ids.has(segment.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['segments'],
          message: `Duplicate segment id "${segment.id}".`,
        });
      }
      ids.add(segment.id);
    }
  });
export type PodcastScript = z.infer<typeof podcastScriptSchema>;

export const PODCAST_EPISODE_STATUSES = [
  'DRAFT',
  'READY_TO_RENDER',
  'RENDERING',
  'READY',
  'PUBLISHED',
  'ARCHIVED',
] as const;
export const podcastEpisodeStatusSchema = z.enum(PODCAST_EPISODE_STATUSES);
export type PodcastEpisodeStatus = z.infer<typeof podcastEpisodeStatusSchema>;

export const podcastEpisodeSchema = z.object({
  id: uuidSchema,
  title: z.string().min(1).max(200),
  summary: z.string().max(5000).nullish(),
  /** Show notes are published alongside the audio; host notes never are. */
  showNotes: z.string().max(20_000).nullish(),
  seasonNumber: z.number().int().min(0).max(1000).nullish(),
  episodeNumber: z.number().int().min(0).max(100_000).nullish(),
  status: podcastEpisodeStatusSchema,
  script: podcastScriptSchema,
  /** The finished mix, once one exists. Null until then — never a placeholder. */
  audioAssetId: uuidSchema.nullish(),
  durationMs: z.number().int().nonnegative().nullish(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type PodcastEpisode = z.infer<typeof podcastEpisodeSchema>;

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

/**
 * How a transcript came to exist. `AUTHORED` is the only honest source while no
 * speech-to-text provider is configured: the words come from the script, not
 * from listening to the audio.
 */
export const TRANSCRIPT_SOURCES = ['AUTHORED', 'SCRIPT_DERIVED', 'MACHINE_TRANSCRIBED'] as const;
export const transcriptSourceSchema = z.enum(TRANSCRIPT_SOURCES);
export type TranscriptSource = z.infer<typeof transcriptSourceSchema>;

export const transcriptCueSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  /** The segment this came from, so a cue can be traced to its script line. */
  segmentId: z.string().max(64).nullish(),
  speaker: z.string().max(120).nullish(),
  text: z.string().min(1).max(5000),
});
export type TranscriptCue = z.infer<typeof transcriptCueSchema>;

export const transcriptSchema = z.object({
  id: uuidSchema,
  episodeId: uuidSchema.nullish(),
  audioAssetId: uuidSchema.nullish(),
  source: transcriptSourceSchema,
  language: z.string().min(2).max(35).default('en'),
  cues: z.array(transcriptCueSchema).max(10_000),
  /** Set only for MACHINE_TRANSCRIBED: which model produced it. */
  modelRef: z.string().max(200).nullish(),
  createdAt: isoDateTimeSchema,
});
export type Transcript = z.infer<typeof transcriptSchema>;

// ---------------------------------------------------------------------------
// Render jobs
// ---------------------------------------------------------------------------

export const AUDIO_RENDER_KINDS = ['EPISODE_MIX', 'WAVEFORM', 'AUDIOGRAM'] as const;
export const audioRenderKindSchema = z.enum(AUDIO_RENDER_KINDS);
export type AudioRenderKind = z.infer<typeof audioRenderKindSchema>;

export const AUDIO_RENDER_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
] as const;
export const audioRenderStatusSchema = z.enum(AUDIO_RENDER_STATUSES);
export type AudioRenderStatus = z.infer<typeof audioRenderStatusSchema>;

/** Every non-SUCCEEDED render carries exactly one of these. */
export const AUDIO_FAILURE_REASONS = [
  'ENGINE_NOT_CONFIGURED',
  'ENGINE_MISSING_CAPABILITY',
  /** A segment asks for speech and no synthesis provider is configured. */
  'TTS_NOT_CONFIGURED',
  /** A cloned voice was used with no granted, unexpired consent. */
  'VOICE_CONSENT_MISSING',
  'INPUT_UNAVAILABLE',
  'INPUT_UNSUPPORTED',
  'INVALID_SCRIPT',
  'ENGINE_ERROR',
  'TIMEOUT',
  'CANCELLED',
  'STORAGE_ERROR',
  'BUDGET_REFUSED',
  'WORKER_LOST',
] as const;
export const audioFailureReasonSchema = z.enum(AUDIO_FAILURE_REASONS);
export type AudioFailureReason = z.infer<typeof audioFailureReasonSchema>;

export const AUDIO_FAILURE_REASON_TEXT: Record<AudioFailureReason, string> = {
  ENGINE_NOT_CONFIGURED:
    'No audio engine is configured in this deployment. Set FFMPEG_PATH, or install ffmpeg on the worker host.',
  ENGINE_MISSING_CAPABILITY:
    'The installed ffmpeg build is missing a filter or encoder this render needs.',
  TTS_NOT_CONFIGURED:
    'This script asks for spoken segments, but no speech-synthesis provider is configured. Upload audio for those segments, or configure a provider.',
  VOICE_CONSENT_MISSING:
    'A segment uses a cloned voice without granted, unexpired consent. Nothing was synthesised.',
  INPUT_UNAVAILABLE: 'An audio asset this script references could not be read.',
  INPUT_UNSUPPORTED: 'An asset this script references is not audio the engine can decode.',
  INVALID_SCRIPT: 'The script could not be turned into a render plan.',
  ENGINE_ERROR: 'ffmpeg ran and reported an error.',
  TIMEOUT: 'The render took longer than its time limit and was stopped.',
  CANCELLED: 'The render was cancelled.',
  STORAGE_ERROR: 'The rendered audio could not be stored.',
  BUDGET_REFUSED: 'The workspace budget refused this render before it started.',
  WORKER_LOST: 'The worker stopped before the render finished.',
};

/** An audiogram turns audio into video — it is rendered by the video engine. */
export const audiogramRenderJobSchema = z.object({
  audioAssetId: uuidSchema,
  /** A still image behind the waveform, e.g. episode art. */
  coverAssetId: uuidSchema.nullish(),
  formatKey: z.string().min(1),
  /** Clip a section of a long episode, for a social post. */
  startMs: z.number().int().nonnegative().default(0),
  durationMs: z.number().int().min(1000).max(180_000).default(30_000),
  waveformStyle: z.enum(['BARS', 'LINE', 'POINT']).default('BARS'),
  waveformColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#0F766E'),
  backgroundColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#0B1220'),
  /** Burn the transcript in as captions, when one exists. */
  burnCaptions: z.boolean().default(false),
  title: z.string().max(200).nullish(),
});
export type AudiogramRenderJob = z.infer<typeof audiogramRenderJobSchema>;

// ---------------------------------------------------------------------------
// API inputs
// ---------------------------------------------------------------------------

export const createVoiceProfileInputSchema = z
  .object({
    name: z.string().min(1).max(120),
    kind: voiceKindSchema,
    language: z.string().min(2).max(35).default('en'),
    description: z.string().max(1000).nullish(),
    providerId: z.string().max(100).nullish(),
    providerVoiceId: z.string().max(200).nullish(),
    /** Required for CLONED: a cloned voice always belongs to someone. */
    subjectName: z.string().min(1).max(200).nullish(),
  })
  .superRefine((input, ctx) => {
    if (input.kind === 'CLONED' && !input.subjectName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['subjectName'],
        message: 'A cloned voice must name the person whose voice it imitates.',
      });
    }
  });
export type CreateVoiceProfileInput = z.infer<typeof createVoiceProfileInputSchema>;

export const recordVoiceConsentInputSchema = z.object({
  subjectName: z.string().min(1).max(200),
  subjectEmail: z.string().email().nullish(),
  method: z.enum(['WRITTEN_AGREEMENT', 'RECORDED_STATEMENT', 'SIGNED_RELEASE', 'OTHER']),
  evidenceAssetId: uuidSchema.nullish(),
  reference: z.string().max(500).nullish(),
  scopes: z.array(voiceConsentScopeSchema).min(1),
  /** Consent is time-boxed; an open-ended grant is not offered. */
  expiresAt: isoDateTimeSchema,
});
export type RecordVoiceConsentInput = z.infer<typeof recordVoiceConsentInputSchema>;

export const revokeVoiceConsentInputSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type RevokeVoiceConsentInput = z.infer<typeof revokeVoiceConsentInputSchema>;

export const createPodcastEpisodeInputSchema = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().max(5000).nullish(),
  showNotes: z.string().max(20_000).nullish(),
  seasonNumber: z.number().int().min(0).max(1000).nullish(),
  episodeNumber: z.number().int().min(0).max(100_000).nullish(),
  script: podcastScriptSchema,
  /** The use this episode is for — checked against each voice's consent scopes. */
  consentScope: voiceConsentScopeSchema.default('PODCAST'),
  contentItemId: uuidSchema.nullish(),
  campaignId: uuidSchema.nullish(),
});
export type CreatePodcastEpisodeInput = z.infer<typeof createPodcastEpisodeInputSchema>;

export const updatePodcastEpisodeInputSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    summary: z.string().max(5000).nullish(),
    showNotes: z.string().max(20_000).nullish(),
    seasonNumber: z.number().int().min(0).max(1000).nullish(),
    episodeNumber: z.number().int().min(0).max(100_000).nullish(),
    script: podcastScriptSchema.optional(),
    consentScope: voiceConsentScopeSchema.optional(),
    status: podcastEpisodeStatusSchema.optional(),
    contentItemId: uuidSchema.nullish(),
    campaignId: uuidSchema.nullish(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update.');
export type UpdatePodcastEpisodeInput = z.infer<typeof updatePodcastEpisodeInputSchema>;

export const startAudioRenderInputSchema = z.object({
  kind: audioRenderKindSchema.default('EPISODE_MIX'),
  /** Emit a waveform PNG alongside the mix. */
  waveform: z.boolean().default(true),
  /** Required when `kind` is AUDIOGRAM. */
  audiogram: audiogramRenderJobSchema.partial().nullish(),
});
export type StartAudioRenderInput = z.infer<typeof startAudioRenderInputSchema>;
