import { storyboardSchema } from '@spectra/contracts';
import { describe, expect, it } from 'vitest';

import { buildSrt, buildVtt } from './captions';
import { buildFfmpegArgs, escapeFilterPath } from './ffmpeg-args';
import { VideoPlanError, buildVideoRenderPlan, videoRenderHash } from './plan';

const IMAGE_ID = '11111111-1111-4111-8111-111111111111';
const AUDIO_ID = '22222222-2222-4222-8222-222222222222';

function storyboard(overrides: Record<string, unknown> = {}) {
  return storyboardSchema.parse({
    scenes: [
      {
        id: 'a',
        durationMs: 3000,
        background: { kind: 'COLOR', color: '#0f766e' },
        heading: { text: 'First' },
        caption: 'First',
      },
      {
        id: 'b',
        durationMs: 2000,
        background: { kind: 'IMAGE', mediaAssetId: IMAGE_ID },
        caption: 'Second',
      },
    ],
    ...overrides,
  });
}

function resources(extra: Record<string, unknown> = {}) {
  return {
    imageFiles: { [IMAGE_ID]: '/work/pic.png' },
    textFiles: { 'a-heading': '/work/a-heading.txt' },
    fontFile: '/fonts/Sans.ttf',
    outputPath: '/work/out.mp4',
    ...extra,
  } as Parameters<typeof buildFfmpegArgs>[1];
}

describe('buildVideoRenderPlan', () => {
  it('lays scenes end to end and collects the assets the renderer must fetch', () => {
    const plan = buildVideoRenderPlan(storyboard(), 'SQUARE_1080x1080');

    expect(plan.totalDurationMs).toBe(5000);
    expect(plan.scenes.map((scene) => scene.startMs)).toEqual([0, 3000]);
    expect(plan.imageAssetIds).toEqual([IMAGE_ID]);
    expect(plan.format.width).toBe(1080);
  });

  it('subtracts each crossfade overlap from the timeline, so the plan matches the file', () => {
    const plan = buildVideoRenderPlan(storyboard({ transitionMs: 500 }), 'SQUARE_1080x1080');

    // 3000 + 2000 − one 500ms overlap.
    expect(plan.totalDurationMs).toBe(4500);
    expect(plan.scenes[1]!.startMs).toBe(2500);
  });

  it('places intro and outro around the body in render order', () => {
    const plan = buildVideoRenderPlan(
      storyboard({
        intro: { id: 'i', durationMs: 1000, background: { kind: 'COLOR', color: '#000000' } },
        outro: { id: 'o', durationMs: 1000, background: { kind: 'COLOR', color: '#000000' } },
      }),
      'SQUARE_1080x1080',
    );

    expect(plan.scenes.map((scene) => scene.id)).toEqual(['i', 'a', 'b', 'o']);
    expect(plan.totalDurationMs).toBe(7000);
  });

  it('refuses a transition that is not shorter than the scenes it joins', () => {
    const error = (() => {
      try {
        buildVideoRenderPlan(
          storyboardSchema.parse({
            transitionMs: 2000,
            scenes: [
              { id: 'a', durationMs: 2000, background: { kind: 'COLOR', color: '#000000' } },
              { id: 'b', durationMs: 1500, background: { kind: 'COLOR', color: '#000000' } },
            ],
          }),
          'SQUARE_1080x1080',
        );
        return null;
      } catch (caught) {
        return caught as VideoPlanError;
      }
    })();

    expect(error).toBeInstanceOf(VideoPlanError);
    // Every problem at once: a storyboard with two faults is fixed in one pass.
    expect(error!.problems).toHaveLength(2);
    expect(error!.problems[0]).toContain('"a"');
    expect(error!.problems[1]).toContain('"b"');
  });

  it('refuses a storyboard longer than the format allows, naming both numbers', () => {
    const scenes = Array.from({ length: 40 }, (_, index) => ({
      id: `s${index}`,
      durationMs: 6000,
      background: { kind: 'COLOR' as const, color: '#000000' },
    }));

    expect(() =>
      buildVideoRenderPlan(storyboardSchema.parse({ scenes }), 'VERTICAL_1080x1920'),
    ).toThrow(/240.0s, longer than the 180s limit/);
  });

  it('warns when captions cover only some scenes, instead of silently half-captioning', () => {
    const plan = buildVideoRenderPlan(
      storyboardSchema.parse({
        scenes: [
          {
            id: 'a',
            durationMs: 1000,
            background: { kind: 'COLOR', color: '#000000' },
            caption: 'Only this one',
          },
          { id: 'b', durationMs: 1000, background: { kind: 'COLOR', color: '#000000' } },
        ],
      }),
      'SQUARE_1080x1080',
    );

    expect(plan.warnings.join(' ')).toContain('1 of 2 scenes have no caption text');
  });

  it('rejects an unknown format rather than guessing one', () => {
    expect(() => buildVideoRenderPlan(storyboard(), 'NOT_A_FORMAT')).toThrow(
      /Unknown video format/,
    );
  });

  it('scales text with the frame, so one storyboard reads correctly at every size', () => {
    const square = buildVideoRenderPlan(storyboard(), 'SQUARE_1080x1080');
    const landscape = buildVideoRenderPlan(storyboard(), 'LANDSCAPE_1920x1080');
    const tall = buildVideoRenderPlan(storyboard(), 'VERTICAL_1080x1920');

    expect(square.scenes[0]!.texts[0]!.fontSizePx).toBe(Math.round(1080 * 0.06));
    expect(landscape.scenes[0]!.texts[0]!.fontSizePx).toBe(Math.round(1080 * 0.06));
    expect(tall.scenes[0]!.texts[0]!.fontSizePx).toBe(Math.round(1920 * 0.06));
  });
});

describe('videoRenderHash', () => {
  const output = { crf: 23, captions: 'SRT', thumbnail: true };

  it('is stable for the same plan, settings and asset versions', () => {
    const plan = buildVideoRenderPlan(storyboard(), 'SQUARE_1080x1080');
    const other = buildVideoRenderPlan(storyboard(), 'SQUARE_1080x1080');

    expect(videoRenderHash(plan, output, { [IMAGE_ID]: 'v1' })).toBe(
      videoRenderHash(other, output, { [IMAGE_ID]: 'v1' }),
    );
  });

  it('changes when an input asset changes, so a replaced image re-renders', () => {
    const plan = buildVideoRenderPlan(storyboard(), 'SQUARE_1080x1080');

    expect(videoRenderHash(plan, output, { [IMAGE_ID]: 'v1' })).not.toBe(
      videoRenderHash(plan, output, { [IMAGE_ID]: 'v2' }),
    );
  });

  it('changes when the output settings or the format change', () => {
    const plan = buildVideoRenderPlan(storyboard(), 'SQUARE_1080x1080');
    const wide = buildVideoRenderPlan(storyboard(), 'LANDSCAPE_1920x1080');
    const base = videoRenderHash(plan, output, {});

    expect(videoRenderHash(plan, { ...output, crf: 28 }, {})).not.toBe(base);
    expect(videoRenderHash(wide, output, {})).not.toBe(base);
  });
});

describe('captions', () => {
  it('writes SRT timecodes with a comma and VTT with a dot', () => {
    const cues = [{ index: 1, startMs: 0, endMs: 1500, text: 'Hello' }];

    expect(buildSrt(cues)).toContain('00:00:00,000 --> 00:00:01,500');
    expect(buildVtt(cues)).toContain('00:00:00.000 --> 00:00:01.500');
    expect(buildVtt(cues).startsWith('WEBVTT')).toBe(true);
  });

  it('formats hours, minutes and milliseconds without drift', () => {
    const cues = [{ index: 1, startMs: 3_661_234, endMs: 3_662_000, text: 'Later' }];

    expect(buildSrt(cues)).toContain('01:01:01,234 --> 01:01:02,000');
  });

  it('cannot be ended early by blank lines a user typed into a caption', () => {
    const cues = [{ index: 1, startMs: 0, endMs: 1000, text: 'One\r\n\r\n\r\nTwo' }];

    const srt = buildSrt(cues);
    expect(srt).toContain('One\nTwo');
    expect(srt).not.toContain('One\n\nTwo');
  });
});

describe('buildFfmpegArgs', () => {
  it('builds one input per scene and concatenates them when there is no transition', () => {
    const plan = buildVideoRenderPlan(storyboard(), 'SQUARE_1080x1080');

    const { args } = buildFfmpegArgs(plan, resources(), { crf: 23, videoCodec: 'libx264' });

    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('concat=n=2:v=1:a=0');
    expect(graph).not.toContain('xfade');
    expect(args).toContain('/work/pic.png');
    expect(args.at(-1)).toBe('/work/out.mp4');
    expect(args).toContain('-progress');
  });

  it('chains crossfades at the offsets the plan computed', () => {
    const plan = buildVideoRenderPlan(storyboard({ transitionMs: 500 }), 'SQUARE_1080x1080');

    const { args } = buildFfmpegArgs(plan, resources(), { crf: 23, videoCodec: 'libx264' });

    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('xfade=transition=fade:duration=0.500:offset=2.500');
    expect(graph).not.toContain('concat=');
  });

  it('never puts user text in the filtergraph — only a file path Spectra wrote', () => {
    const nasty = storyboardSchema.parse({
      scenes: [
        {
          id: 'a',
          durationMs: 1000,
          background: { kind: 'COLOR', color: '#000000' },
          heading: { text: "evil':drawtext=fontfile=/etc/passwd:text=pwned" },
        },
      ],
    });
    const plan = buildVideoRenderPlan(nasty, 'SQUARE_1080x1080');

    const { args } = buildFfmpegArgs(
      plan,
      resources({ textFiles: { 'a-heading': '/work/a-heading.txt' } }),
      { crf: 23, videoCodec: 'libx264' },
    );

    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).not.toContain('pwned');
    expect(graph).not.toContain('/etc/passwd');
    expect(graph).toContain('textfile=/work/a-heading.txt');
  });

  it('escapes a path so a colon in it cannot end a filter argument', () => {
    expect(escapeFilterPath('/work/od:d.txt')).toBe('/work/od\\:d.txt');
    expect(escapeFilterPath("/work/qu'ote.txt")).toBe("/work/qu\\'ote.txt");
  });

  it('maps an audio bed with its gain, fade and trim, and mutes when there is none', () => {
    const withAudio = buildVideoRenderPlan(
      storyboard({ audio: { mediaAssetId: AUDIO_ID, gainDb: -6, fadeOutMs: 1000 } }),
      'SQUARE_1080x1080',
    );

    const { args } = buildFfmpegArgs(withAudio, resources({ audioFile: '/work/bed.m4a' }), {
      crf: 23,
      videoCodec: 'libx264',
    });
    const graph = args[args.indexOf('-filter_complex') + 1]!;

    expect(graph).toContain('volume=-6dB');
    expect(graph).toContain('afade=t=out:st=4.000:d=1.000');
    expect(args).toContain('-c:a');

    const silent = buildFfmpegArgs(
      buildVideoRenderPlan(storyboard(), 'SQUARE_1080x1080'),
      resources(),
      { crf: 23, videoCodec: 'libx264' },
    );
    expect(silent.args).toContain('-an');
  });

  it('uses the encoder it was given, and only adds the x264 preset for x264', () => {
    const plan = buildVideoRenderPlan(storyboard(), 'SQUARE_1080x1080');

    const x264 = buildFfmpegArgs(plan, resources(), { crf: 23, videoCodec: 'libx264' });
    const hardware = buildFfmpegArgs(plan, resources(), {
      crf: 23,
      videoCodec: 'h264_videotoolbox',
    });

    expect(x264.args).toContain('-preset');
    expect(hardware.args).not.toContain('-preset');
    expect(hardware.args[hardware.args.indexOf('-c:v') + 1]).toBe('h264_videotoolbox');
  });

  it('refuses to build a command when a file the plan needs was not prepared', () => {
    const plan = buildVideoRenderPlan(storyboard(), 'SQUARE_1080x1080');

    expect(() =>
      buildFfmpegArgs(plan, resources({ imageFiles: {} }), { crf: 23, videoCodec: 'libx264' }),
    ).toThrow(/No local file was prepared/);
    expect(() =>
      buildFfmpegArgs(plan, resources({ textFiles: {} }), { crf: 23, videoCodec: 'libx264' }),
    ).toThrow(/No text file was prepared/);
  });
});
