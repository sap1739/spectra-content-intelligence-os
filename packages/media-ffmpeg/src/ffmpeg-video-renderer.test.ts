import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import { storyboardSchema } from '@spectra/contracts';
import { buildVideoRenderPlan } from '@spectra/video-studio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VideoRenderError } from './errors';
import { FfmpegVideoRenderer } from './ffmpeg-video-renderer';
import { resolveFontFile } from './resolve';

/**
 * These tests encode real video with a real ffmpeg and then probe the bytes.
 * The binary comes from a dev-only installer package; production supplies its
 * own (ADR-0041). Nothing here asserts on a mock.
 */

const FFMPEG = ffmpegInstaller.path;
const FFPROBE = ffprobeInstaller.path;
const IMAGE_ID = '11111111-1111-4111-8111-111111111111';

let workRoot: string;

function renderer(overrides: Partial<{ fontFile: string | null; timeoutMs: number }> = {}) {
  return new FfmpegVideoRenderer({
    ffmpegPath: FFMPEG,
    ffprobePath: FFPROBE,
    fontFile: 'fontFile' in overrides ? overrides.fontFile! : resolveFontFile(),
    timeoutMs: overrides.timeoutMs ?? 120_000,
  });
}

function planFor(storyboard: unknown, formatKey = 'SQUARE_1080x1080') {
  return buildVideoRenderPlan(storyboardSchema.parse(storyboard), formatKey);
}

beforeAll(() => {
  workRoot = mkdtempSync(join(tmpdir(), 'spectra-video-'));
});

afterAll(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

describe('FfmpegVideoRenderer — capabilities', () => {
  it('reports the real engine, its version and the encoder it chose', async () => {
    const capability = await renderer().capabilities();

    expect(capability.available).toBe(true);
    expect(capability.engine).toBe('ffmpeg');
    expect(capability.engineVersion).toMatch(/^\d+\./);
    expect(capability.videoCodec).toBeTruthy();
    expect(capability.reason).toContain('ffmpeg');
  });

  it('says a missing binary is not configured, and names the setting that fixes it', async () => {
    const absent = new FfmpegVideoRenderer({
      ffmpegPath: join(workRoot, 'no-such-ffmpeg'),
      ffprobePath: FFPROBE,
      fontFile: null,
      timeoutMs: 1000,
    });

    const capability = await absent.capabilities();

    expect(capability.available).toBe(false);
    expect(capability.reason).toContain('FFMPEG_PATH');
    expect(capability.videoCodec).toBeNull();
    expect(capability.features.textOverlays).toBe(false);
    expect(capability.missing.length).toBeGreaterThan(0);
  });

  it('turns off text overlays, with a reason, when no font file is configured', async () => {
    const capability = await renderer({ fontFile: null }).capabilities();

    expect(capability.available).toBe(true);
    expect(capability.features.textOverlays).toBe(false);
    expect(capability.missing.join(' ')).toContain('VIDEO_FONT_FILE');
  });
});

describe('FfmpegVideoRenderer — real renders', () => {
  it('encodes a two-scene slideshow at the format’s exact size and duration', async () => {
    const workDir = join(workRoot, 'slideshow');
    const outputPath = join(workDir, 'out.mp4');
    const plan = planFor({
      scenes: [
        {
          id: 'a',
          durationMs: 1000,
          background: { kind: 'COLOR', color: '#0F766E' },
          heading: { text: 'Scene one' },
        },
        {
          id: 'b',
          durationMs: 1000,
          background: { kind: 'COLOR', color: '#1E293B' },
          body: { text: 'Scene two', position: 'BOTTOM' },
        },
      ],
    });

    const progress: number[] = [];
    const output = await renderer().render(
      plan,
      { imageFiles: {}, workDir, outputPath },
      { crf: 28, onProgress: (p) => progress.push(p.percent) },
    );

    expect(output.sizeBytes).toBeGreaterThan(0);
    expect(output.width).toBe(1080);
    expect(output.height).toBe(1080);
    expect(output.videoCodec).toBe('h264');
    expect(output.audioCodec).toBeNull();
    // The probe reads the file that was actually written, not the plan.
    expect(output.durationMs).toBeGreaterThanOrEqual(1900);
    expect(output.durationMs).toBeLessThanOrEqual(2100);
    expect(statSync(outputPath).size).toBe(output.sizeBytes);
    expect(progress.length).toBeGreaterThan(0);
    expect(Math.max(...progress)).toBeLessThanOrEqual(99);
  }, 120_000);

  it('renders an image scene at a vertical size and writes a caption sidecar', async () => {
    const workDir = join(workRoot, 'vertical');
    const outputPath = join(workDir, 'out.mp4');
    const image = join(workRoot, 'source.png');
    spawnSync(FFMPEG, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=1600x900:duration=1:rate=1',
      '-frames:v',
      '1',
      image,
    ]);

    const plan = planFor(
      {
        scenes: [
          {
            id: 'a',
            durationMs: 1200,
            background: { kind: 'IMAGE', mediaAssetId: IMAGE_ID, fit: 'COVER' },
            caption: 'A caption for the first scene',
          },
        ],
      },
      'VERTICAL_1080x1920',
    );

    const output = await renderer().render(
      plan,
      { imageFiles: { [IMAGE_ID]: image }, workDir, outputPath },
      { crf: 30 },
    );

    expect(output.width).toBe(1080);
    expect(output.height).toBe(1920);
    expect(output.captionPath).toBeTruthy();
    const srt = readFileSync(output.captionPath!, 'utf8');
    expect(srt).toContain('00:00:00,000 --> 00:00:01,200');
    expect(srt).toContain('A caption for the first scene');
  }, 120_000);

  it('extracts a real poster frame from the rendered video', async () => {
    const workDir = join(workRoot, 'thumb');
    const outputPath = join(workDir, 'out.mp4');
    const plan = planFor({
      scenes: [{ id: 'a', durationMs: 1000, background: { kind: 'COLOR', color: '#B91C1C' } }],
    });
    const engine = renderer();
    await engine.render(plan, { imageFiles: {}, workDir, outputPath }, { crf: 30 });

    const poster = join(workDir, 'poster.jpg');
    await engine.extractThumbnail(outputPath, 500, poster);

    const bytes = readFileSync(poster);
    expect(bytes.length).toBeGreaterThan(0);
    // JPEG SOI marker: the file really is an image, not an empty placeholder.
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  }, 120_000);
});

describe('FfmpegVideoRenderer — honest failure', () => {
  it('refuses a storyboard that needs text overlays the build cannot draw', async () => {
    const workDir = join(workRoot, 'no-font');
    const plan = planFor({
      scenes: [
        {
          id: 'a',
          durationMs: 1000,
          background: { kind: 'COLOR', color: '#000000' },
          heading: { text: 'Needs a font' },
        },
      ],
    });

    await expect(
      renderer({ fontFile: null }).render(
        plan,
        { imageFiles: {}, workDir, outputPath: join(workDir, 'out.mp4') },
        { crf: 30 },
      ),
    ).rejects.toMatchObject({
      reason: 'ENGINE_MISSING_CAPABILITY',
      message: expect.stringContaining('text overlays'),
    });
  }, 60_000);

  it('reports a missing engine as ENGINE_NOT_CONFIGURED, not as a crash', async () => {
    const workDir = join(workRoot, 'absent');
    const plan = planFor({
      scenes: [{ id: 'a', durationMs: 1000, background: { kind: 'COLOR', color: '#000000' } }],
    });
    const absent = new FfmpegVideoRenderer({
      ffmpegPath: join(workRoot, 'missing-ffmpeg'),
      ffprobePath: FFPROBE,
      fontFile: null,
      timeoutMs: 5000,
    });

    const error = await absent
      .render(plan, { imageFiles: {}, workDir, outputPath: join(workDir, 'o.mp4') }, { crf: 30 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VideoRenderError);
    expect((error as VideoRenderError).reason).toBe('ENGINE_NOT_CONFIGURED');
  }, 60_000);

  it('fails fast with INPUT_UNSUPPORTED when an input image is not decodable', async () => {
    const workDir = join(workRoot, 'bad-input');
    const notAnImage = join(workRoot, 'broken.png');
    writeFileSync(notAnImage, 'this is not a PNG', 'utf8');
    const plan = planFor({
      scenes: [
        {
          id: 'a',
          durationMs: 1000,
          background: { kind: 'IMAGE', mediaAssetId: IMAGE_ID },
        },
      ],
    });

    const error = await renderer()
      .render(
        plan,
        { imageFiles: { [IMAGE_ID]: notAnImage }, workDir, outputPath: join(workDir, 'o.mp4') },
        { crf: 30 },
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VideoRenderError);
    // Not TIMEOUT: ffmpeg would wait forever on a corrupt looped image, so the
    // input is probed before the encode begins.
    expect((error as VideoRenderError).reason).toBe('INPUT_UNSUPPORTED');
    expect((error as VideoRenderError).message).toContain(IMAGE_ID);
  }, 60_000);

  it('names a missing input file rather than failing anonymously', async () => {
    const workDir = join(workRoot, 'missing-input');
    const plan = planFor({
      scenes: [
        { id: 'a', durationMs: 1000, background: { kind: 'IMAGE', mediaAssetId: IMAGE_ID } },
      ],
    });

    const error = await renderer()
      .render(plan, { imageFiles: {}, workDir, outputPath: join(workDir, 'o.mp4') }, { crf: 30 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VideoRenderError);
    expect((error as VideoRenderError).reason).toBe('INPUT_UNAVAILABLE');
  }, 60_000);

  it('stops the encoder and reports CANCELLED when the job is aborted', async () => {
    const workDir = join(workRoot, 'cancelled');
    // Long enough that the abort lands mid-encode.
    const plan = planFor(
      {
        scenes: Array.from({ length: 10 }, (_, index) => ({
          id: `s${index}`,
          durationMs: 6000,
          background: { kind: 'COLOR', color: '#123456' },
        })),
      },
      'LANDSCAPE_1920x1080',
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    const error = await renderer()
      .render(
        plan,
        { imageFiles: {}, workDir, outputPath: join(workDir, 'o.mp4') },
        { crf: 30, signal: controller.signal },
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VideoRenderError);
    expect((error as VideoRenderError).reason).toBe('CANCELLED');
  }, 120_000);

  it('stops the encoder and reports TIMEOUT when it outruns its limit', async () => {
    const workDir = join(workRoot, 'timeout');
    const plan = planFor(
      {
        scenes: Array.from({ length: 10 }, (_, index) => ({
          id: `s${index}`,
          durationMs: 6000,
          background: { kind: 'COLOR', color: '#654321' },
        })),
      },
      'LANDSCAPE_1920x1080',
    );

    const error = await renderer({ timeoutMs: 150 })
      .render(plan, { imageFiles: {}, workDir, outputPath: join(workDir, 'o.mp4') }, { crf: 30 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VideoRenderError);
    expect((error as VideoRenderError).reason).toBe('TIMEOUT');
  }, 120_000);
});
