export {
  VoiceConsentError,
  assertVoiceUsable,
  effectiveConsentStatus,
  evaluateVoiceUsability,
} from './consent';
export type { ConsentCheckInput, VoiceUsability } from './consent';
export { capabilityFor, isAvailable, resolveAudioCapabilities } from './providers';
export type { AudioAdapterRegistry, AudioProviderEnv } from './providers';
export {
  AudioPlanError,
  audioRenderHash,
  buildAudioRenderPlan,
  buildScriptTranscript,
  totalDurationMs,
  withResolvedDurations,
} from './plan';
export type { AudioRenderPlan, PlannedSegment } from './plan';
export {
  AudioArgsError,
  buildAudioMixArgs,
  buildAudiogramArgs,
  buildWaveformArgs,
  escapeFilterPath,
} from './ffmpeg-audio-args';
export type { AudioMixResources } from './ffmpeg-audio-args';
