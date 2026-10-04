import type { AudioProviderCapability, AudioProviderKind } from '@spectra/contracts';

/**
 * What this deployment can actually do with audio.
 *
 * No speech-synthesis, speech-recognition, audio-generation or music-generation
 * provider is implemented in this codebase (ADR-0042). Rather than leave that
 * implicit, every capability reports a status and a sentence: `NOT_IMPLEMENTED`
 * means no adapter exists, `NOT_CONFIGURED` would mean one exists but this
 * deployment has no credentials for it. The distinction matters to an operator
 * deciding whether to go looking for an API key.
 */

export interface AudioProviderEnv {
  /**
   * Set when an operator has deliberately disabled synthesis, e.g. by policy.
   * Reported as DISABLED rather than as a missing adapter.
   */
  AUDIO_SYNTHESIS_DISABLED?: boolean;
}

/** Registered adapters, by kind. Empty today — the ports exist, the adapters do not. */
export type AudioAdapterRegistry = Partial<
  Record<AudioProviderKind, { providerId: string; configured: boolean; requiredEnv: string[] }>
>;

const NOT_IMPLEMENTED_REASONS: Record<AudioProviderKind, string> = {
  TEXT_TO_SPEECH:
    'No speech-synthesis provider is implemented. Spoken segments must be uploaded as audio until one is added and configured.',
  SPEECH_TO_TEXT:
    'No speech-recognition provider is implemented. Transcripts are derived from the script, never from listening to the audio.',
  AUDIO_GENERATION:
    'No audio-generation provider is implemented. Sound effects and beds must be uploaded.',
  MUSIC_GENERATION:
    'No music-generation provider is implemented. Music beds must be uploaded, and must be licensed for the use.',
};

/**
 * Builds the honest capability list. Adding a real adapter means registering it
 * here; until then every answer is a documented "no", never silence.
 */
export function resolveAudioCapabilities(
  registry: AudioAdapterRegistry = {},
  env: AudioProviderEnv = {},
): AudioProviderCapability[] {
  const kinds: AudioProviderKind[] = [
    'TEXT_TO_SPEECH',
    'SPEECH_TO_TEXT',
    'AUDIO_GENERATION',
    'MUSIC_GENERATION',
  ];

  return kinds.map((kind) => {
    const adapter = registry[kind];
    if (!adapter) {
      return {
        kind,
        status: 'NOT_IMPLEMENTED' as const,
        providerId: null,
        reason: NOT_IMPLEMENTED_REASONS[kind],
        requiredEnv: [],
      };
    }
    if (env.AUDIO_SYNTHESIS_DISABLED) {
      return {
        kind,
        status: 'DISABLED' as const,
        providerId: adapter.providerId,
        reason:
          'Audio synthesis is switched off in this deployment (AUDIO_SYNTHESIS_DISABLED). No request is sent to any provider.',
        requiredEnv: [],
      };
    }
    if (!adapter.configured) {
      return {
        kind,
        status: 'NOT_CONFIGURED' as const,
        providerId: adapter.providerId,
        reason: `The ${adapter.providerId} adapter exists but this deployment has no credentials for it. Set ${adapter.requiredEnv.join(', ')}.`,
        requiredEnv: adapter.requiredEnv,
      };
    }
    return {
      kind,
      status: 'AVAILABLE' as const,
      providerId: adapter.providerId,
      reason: `${adapter.providerId} is configured and will serve ${kind.toLowerCase().replace(/_/g, ' ')} requests.`,
      requiredEnv: adapter.requiredEnv,
    };
  });
}

export function capabilityFor(
  capabilities: readonly AudioProviderCapability[],
  kind: AudioProviderKind,
): AudioProviderCapability {
  const found = capabilities.find((capability) => capability.kind === kind);
  if (!found) {
    // Unreachable through resolveAudioCapabilities, but a caller passing a
    // hand-made list should still get a refusal rather than `undefined`.
    return {
      kind,
      status: 'NOT_IMPLEMENTED',
      providerId: null,
      reason: NOT_IMPLEMENTED_REASONS[kind],
      requiredEnv: [],
    };
  }
  return found;
}

export function isAvailable(
  capabilities: readonly AudioProviderCapability[],
  kind: AudioProviderKind,
): boolean {
  return capabilityFor(capabilities, kind).status === 'AVAILABLE';
}
