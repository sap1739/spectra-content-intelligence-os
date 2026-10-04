import { podcastScriptSchema } from '@spectra/contracts';
import { describe, expect, it } from 'vitest';

import {
  VoiceConsentError,
  assertVoiceUsable,
  effectiveConsentStatus,
  evaluateVoiceUsability,
} from './consent';
import { buildAudioMixArgs, buildAudiogramArgs, buildWaveformArgs } from './ffmpeg-audio-args';
import {
  AudioPlanError,
  audioRenderHash,
  buildAudioRenderPlan,
  buildScriptTranscript,
  totalDurationMs,
  withResolvedDurations,
} from './plan';
import { capabilityFor, isAvailable, resolveAudioCapabilities } from './providers';

const VOICE = '33333333-3333-4333-8333-333333333333';
const AUDIO_A = '11111111-1111-4111-8111-111111111111';
const AUDIO_B = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-04T12:00:00.000Z');

function granted(overrides: Record<string, unknown> = {}) {
  return {
    status: 'GRANTED' as const,
    scopes: ['PODCAST'] as const,
    expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    revokedAt: null,
    ...overrides,
  };
}

describe('voice consent', () => {
  it('lets a stock voice speak — it imitates nobody, so there is nobody to ask', () => {
    const verdict = evaluateVoiceUsability({
      voiceProfileId: VOICE,
      kind: 'STOCK',
      consent: null,
      scope: 'PODCAST',
      now: NOW,
    });

    expect(verdict).toMatchObject({ usable: true, reason: null, requiresConsent: false });
  });

  it('refuses a cloned voice that has no consent record at all', () => {
    const verdict = evaluateVoiceUsability({
      voiceProfileId: VOICE,
      kind: 'CLONED',
      consent: null,
      scope: 'PODCAST',
      now: NOW,
    });

    expect(verdict.usable).toBe(false);
    expect(verdict.reason).toBe('CONSENT_MISSING');
    expect(verdict.requiresConsent).toBe(true);
    expect(verdict.message).toContain('written consent');
  });

  it('allows a cloned voice with granted, unexpired, in-scope consent', () => {
    const verdict = evaluateVoiceUsability({
      voiceProfileId: VOICE,
      kind: 'CLONED',
      consent: granted(),
      scope: 'PODCAST',
      now: NOW,
    });

    expect(verdict.usable).toBe(true);
    expect(verdict.requiresConsent).toBe(true);
  });

  it.each([
    ['PENDING', 'CONSENT_PENDING'],
    ['REVOKED', 'CONSENT_REVOKED'],
    ['EXPIRED', 'CONSENT_EXPIRED'],
  ] as const)('refuses a %s consent as %s', (status, reason) => {
    const verdict = evaluateVoiceUsability({
      voiceProfileId: VOICE,
      kind: 'CLONED',
      consent: granted({ status }),
      scope: 'PODCAST',
      now: NOW,
    });

    expect(verdict.usable).toBe(false);
    expect(verdict.reason).toBe(reason);
  });

  it('treats a grant that has run out as expired, whatever the stored status says', () => {
    // Storage goes stale; the clock decides, not a column somebody forgot.
    const verdict = evaluateVoiceUsability({
      voiceProfileId: VOICE,
      kind: 'CLONED',
      consent: granted({ expiresAt: new Date('2026-01-01T00:00:00.000Z') }),
      scope: 'PODCAST',
      now: NOW,
    });

    expect(verdict.usable).toBe(false);
    expect(verdict.reason).toBe('CONSENT_EXPIRED');
  });

  it('treats a revocation timestamp as a revocation even if the status lags', () => {
    const verdict = evaluateVoiceUsability({
      voiceProfileId: VOICE,
      kind: 'CLONED',
      consent: granted({ revokedAt: new Date('2026-09-01T00:00:00.000Z') }),
      scope: 'PODCAST',
      now: NOW,
    });

    expect(verdict.reason).toBe('CONSENT_REVOKED');
  });

  it('refuses a use the consent does not cover', () => {
    const verdict = evaluateVoiceUsability({
      voiceProfileId: VOICE,
      kind: 'CLONED',
      consent: granted({ scopes: ['PODCAST'] }),
      scope: 'PAID_ADVERTISING',
      now: NOW,
    });

    expect(verdict.usable).toBe(false);
    expect(verdict.reason).toBe('CONSENT_SCOPE_NOT_COVERED');
  });

  it('throws a typed error naming the voice, so a refusal is never anonymous', () => {
    const error = (() => {
      try {
        assertVoiceUsable({
          voiceProfileId: VOICE,
          kind: 'CLONED',
          consent: null,
          scope: 'PODCAST',
          now: NOW,
        });
        return null;
      } catch (caught) {
        return caught as VoiceConsentError;
      }
    })();

    expect(error).toBeInstanceOf(VoiceConsentError);
    expect(error!.reason).toBe('CONSENT_MISSING');
    expect(error!.voiceProfileId).toBe(VOICE);
  });

  it('computes the status storage should carry now', () => {
    const past = new Date('2026-01-01T00:00:00.000Z');
    expect(effectiveConsentStatus('GRANTED', past, null, NOW)).toBe('EXPIRED');
    expect(effectiveConsentStatus('GRANTED', null, past, NOW)).toBe('REVOKED');
    expect(effectiveConsentStatus('GRANTED', new Date('2027-01-01'), null, NOW)).toBe('GRANTED');
  });
});

describe('provider capabilities', () => {
  it('reports every synthesis kind as not implemented, each with a reason', () => {
    const capabilities = resolveAudioCapabilities({});

    expect(capabilities).toHaveLength(4);
    for (const capability of capabilities) {
      expect(capability.status).toBe('NOT_IMPLEMENTED');
      expect(capability.providerId).toBeNull();
      expect(capability.reason.length).toBeGreaterThan(20);
    }
    expect(isAvailable(capabilities, 'TEXT_TO_SPEECH')).toBe(false);
    expect(capabilityFor(capabilities, 'TEXT_TO_SPEECH').reason).toContain('uploaded');
  });

  it('distinguishes a missing adapter from one that is merely unconfigured', () => {
    const capabilities = resolveAudioCapabilities({
      TEXT_TO_SPEECH: { providerId: 'acme-tts', configured: false, requiredEnv: ['ACME_TTS_KEY'] },
    });

    const tts = capabilityFor(capabilities, 'TEXT_TO_SPEECH');
    expect(tts.status).toBe('NOT_CONFIGURED');
    expect(tts.reason).toContain('ACME_TTS_KEY');
    expect(tts.requiredEnv).toEqual(['ACME_TTS_KEY']);
    // The others still say no adapter exists at all.
    expect(capabilityFor(capabilities, 'MUSIC_GENERATION').status).toBe('NOT_IMPLEMENTED');
  });

  it('reports a deliberately switched-off provider as disabled, not as missing', () => {
    const capabilities = resolveAudioCapabilities(
      { TEXT_TO_SPEECH: { providerId: 'acme-tts', configured: true, requiredEnv: [] } },
      { AUDIO_SYNTHESIS_DISABLED: true },
    );

    expect(capabilityFor(capabilities, 'TEXT_TO_SPEECH').status).toBe('DISABLED');
  });
});

function script(overrides: Record<string, unknown> = {}) {
  return podcastScriptSchema.parse({
    segments: [
      { id: 'intro', kind: 'INTRO', source: { kind: 'UPLOADED', mediaAssetId: AUDIO_A } },
      { id: 'gap', kind: 'TRANSITION', source: { kind: 'SILENCE', durationMs: 500 } },
      {
        id: 'host',
        kind: 'HOST',
        source: { kind: 'UPLOADED', mediaAssetId: AUDIO_B },
        gainDb: -2,
        hostNotes: 'Slow down here.',
      },
    ],
    ...overrides,
  });
}

describe('buildAudioRenderPlan', () => {
  it('collects the assets to fetch and the voices that must be consented', () => {
    const plan = buildAudioRenderPlan(
      script({
        segments: [
          { id: 'a', kind: 'HOST', source: { kind: 'UPLOADED', mediaAssetId: AUDIO_A } },
          {
            id: 'b',
            kind: 'HOST',
            source: { kind: 'TEXT_TO_SPEECH', voiceProfileId: VOICE, text: 'Hello' },
          },
        ],
      }),
    );

    expect(plan.audioAssetIds).toEqual([AUDIO_A]);
    expect(plan.voiceProfileIds).toEqual([VOICE]);
    expect(plan.requiresSynthesis).toBe(true);
  });

  it('refuses an episode that would have nothing to play', () => {
    expect(() =>
      buildAudioRenderPlan(
        podcastScriptSchema.parse({
          segments: [{ id: 'a', kind: 'HOST', source: { kind: 'SILENCE', durationMs: 1000 } }],
        }),
      ),
    ).toThrow(AudioPlanError);
  });

  it('says plainly that it does not check a music bed’s licensing', () => {
    const plan = buildAudioRenderPlan(script({ musicBed: { mediaAssetId: AUDIO_A, gainDb: -18 } }));

    expect(plan.warnings.join(' ')).toContain('licensing');
    expect(plan.audioAssetIds).toContain(AUDIO_A);
  });

  it('lays segments on a timeline once their measured durations are known', () => {
    const plan = withResolvedDurations(buildAudioRenderPlan(script()), {
      intro: 2000,
      host: 3000,
    });

    expect(plan.segments.map((segment) => segment.startMs)).toEqual([0, 2000, 2500]);
    expect(totalDurationMs(plan)).toBe(5500);
  });

  it('builds a transcript from the script and the measured timings, not from listening', () => {
    const plan = withResolvedDurations(
      buildAudioRenderPlan(
        podcastScriptSchema.parse({
          segments: [
            { id: 'a', kind: 'HOST', source: { kind: 'UPLOADED', mediaAssetId: AUDIO_A } },
            {
              id: 'b',
              kind: 'HOST',
              title: 'Ada',
              source: { kind: 'TEXT_TO_SPEECH', voiceProfileId: VOICE, text: 'Welcome back.' },
            },
          ],
        }),
      ),
      { a: 1000, b: 2000 },
    );

    const cues = buildScriptTranscript(plan);
    // Only spoken segments have words; an uploaded clip's contents are unknown
    // to Spectra, and it does not pretend otherwise.
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ startMs: 1000, endMs: 3000, speaker: 'Ada', segmentId: 'b' });
  });
});

describe('audioRenderHash', () => {
  const output = { kind: 'EPISODE_MIX', waveform: true };

  it('is stable for the same script, settings and assets', () => {
    expect(audioRenderHash(buildAudioRenderPlan(script()), output, { [AUDIO_A]: 'v1' })).toBe(
      audioRenderHash(buildAudioRenderPlan(script()), output, { [AUDIO_A]: 'v1' }),
    );
  });

  it('changes when an input asset changes, so a replaced clip re-renders', () => {
    const plan = buildAudioRenderPlan(script());
    expect(audioRenderHash(plan, output, { [AUDIO_A]: 'v1' })).not.toBe(
      audioRenderHash(plan, output, { [AUDIO_A]: 'v2' }),
    );
  });

  it('ignores host notes, which never reach the audio', () => {
    const withNotes = buildAudioRenderPlan(script());
    const withoutNotes = buildAudioRenderPlan(
      script({
        segments: [
          { id: 'intro', kind: 'INTRO', source: { kind: 'UPLOADED', mediaAssetId: AUDIO_A } },
          { id: 'gap', kind: 'TRANSITION', source: { kind: 'SILENCE', durationMs: 500 } },
          {
            id: 'host',
            kind: 'HOST',
            source: { kind: 'UPLOADED', mediaAssetId: AUDIO_B },
            gainDb: -2,
          },
        ],
      }),
    );

    expect(audioRenderHash(withNotes, output, {})).toBe(audioRenderHash(withoutNotes, output, {}));
  });
});

describe('buildAudioMixArgs', () => {
  const resources = {
    audioFiles: { [AUDIO_A]: '/w/a.mp3', [AUDIO_B]: '/w/b.mp3' },
    outputPath: '/w/out.mp3',
  };

  it('builds one input per segment and concatenates them', () => {
    const { args } = buildAudioMixArgs(buildAudioRenderPlan(script()), resources);

    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('concat=n=3:v=0:a=1');
    // Silence is generated, not a file somebody has to supply.
    expect(args.join(' ')).toContain('anullsrc');
    expect(args).toContain('/w/a.mp3');
    expect(args.at(-1)).toBe('/w/out.mp3');
  });

  it('applies each segment’s own gain and normalizes to the episode target', () => {
    const { args } = buildAudioMixArgs(buildAudioRenderPlan(script()), resources);
    const graph = args[args.indexOf('-filter_complex') + 1]!;

    expect(graph).toContain('volume=-2dB');
    expect(graph).toContain('loudnorm=I=-16:TP=-1.5:LRA=11');
  });

  it('omits normalization when the episode asked not to be normalized', () => {
    const { args } = buildAudioMixArgs(
      buildAudioRenderPlan(script({ normalize: false })),
      resources,
    );

    expect(args[args.indexOf('-filter_complex') + 1]!).not.toContain('loudnorm');
  });

  it('mixes a music bed under the speech, cut to the speech’s length', () => {
    const { args } = buildAudioMixArgs(
      buildAudioRenderPlan(script({ musicBed: { mediaAssetId: AUDIO_A, gainDb: -20 } })),
      resources,
    );
    const graph = args[args.indexOf('-filter_complex') + 1]!;

    expect(graph).toContain('volume=-20dB');
    expect(graph).toContain('amix=inputs=2:duration=first');
  });

  it('refuses to build a command when a segment’s file was not prepared', () => {
    expect(() =>
      buildAudioMixArgs(buildAudioRenderPlan(script()), { audioFiles: {}, outputPath: '/w/o.mp3' }),
    ).toThrow(/No local file was prepared/);
  });

  it('refuses a spoken segment with no synthesised audio, rather than skipping it', () => {
    const plan = buildAudioRenderPlan(
      podcastScriptSchema.parse({
        segments: [
          {
            id: 'a',
            kind: 'HOST',
            source: { kind: 'TEXT_TO_SPEECH', voiceProfileId: VOICE, text: 'Hi' },
          },
        ],
      }),
    );

    expect(() => buildAudioMixArgs(plan, { audioFiles: {}, outputPath: '/w/o.mp3' })).toThrow(
      /needs synthesised speech/,
    );
  });
});

describe('waveform and audiogram arguments', () => {
  it('draws a waveform picture over a solid background', () => {
    const { args } = buildWaveformArgs({ audioPath: '/w/a.mp3', outputPath: '/w/w.png' });

    expect(args.join(' ')).toContain('showwavespic');
    expect(args).toContain('-frames:v');
    expect(args.at(-1)).toBe('/w/w.png');
  });

  it('composes an audiogram with the waveform, the cover and the audio mapped through', () => {
    const { args } = buildAudiogramArgs(
      {
        startMs: 5000,
        durationMs: 30_000,
        waveformStyle: 'BARS',
        waveformColor: '#0F766E',
        backgroundColor: '#0B1220',
      },
      { audioPath: '/w/a.mp3', coverPath: '/w/cover.png', outputPath: '/w/out.mp4' },
      { width: 1080, height: 1080, fps: 30 },
      { videoCodec: 'libx264', crf: 23 },
    );
    const graph = args[args.indexOf('-filter_complex') + 1]!;

    expect(args).toContain('-ss');
    expect(args[args.indexOf('-ss') + 1]).toBe('5.000');
    expect(graph).toContain('showwaves');
    expect(graph).toContain('overlay');
    // The audiogram carries its audio: it is a video of the episode, not a
    // silent animation.
    expect(args.join(' ')).toContain('-map 0:a');
  });

  it('burns captions in only when a caption file was prepared', () => {
    const base = {
      startMs: 0,
      durationMs: 10_000,
      waveformStyle: 'LINE' as const,
      waveformColor: '#FFFFFF',
      backgroundColor: '#000000',
    };
    const without = buildAudiogramArgs(
      base,
      { audioPath: '/w/a.mp3', outputPath: '/w/o.mp4' },
      { width: 1080, height: 1920, fps: 30 },
      { videoCodec: 'libx264', crf: 23 },
    );
    const withCaptions = buildAudiogramArgs(
      base,
      { audioPath: '/w/a.mp3', captionPath: '/w/c.srt', outputPath: '/w/o.mp4' },
      { width: 1080, height: 1920, fps: 30 },
      { videoCodec: 'libx264', crf: 23 },
    );

    expect(without.args.join(' ')).not.toContain('subtitles');
    expect(withCaptions.args.join(' ')).toContain('subtitles=filename=/w/c.srt');
  });
});
