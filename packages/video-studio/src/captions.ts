import type { CaptionCue } from './plan';

/**
 * SRT and WebVTT writers. Deterministic, dependency-free, and the only place
 * caption timing is formatted.
 */

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function timecode(ms: number, msSeparator: ',' | '.'): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${msSeparator}${pad(millis, 3)}`;
}

/**
 * Caption text is authored by a user, so it is normalized rather than trusted:
 * CR/LF become single newlines and a cue can never contain the blank line that
 * would end it early.
 */
function cueText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

export function buildSrt(cues: readonly CaptionCue[]): string {
  return (
    cues
      .map(
        (cue, index) =>
          `${index + 1}\n${timecode(cue.startMs, ',')} --> ${timecode(cue.endMs, ',')}\n${cueText(cue.text)}\n`,
      )
      .join('\n') + (cues.length > 0 ? '' : '')
  );
}

export function buildVtt(cues: readonly CaptionCue[]): string {
  const body = cues
    .map(
      (cue, index) =>
        `${index + 1}\n${timecode(cue.startMs, '.')} --> ${timecode(cue.endMs, '.')}\n${cueText(cue.text)}\n`,
    )
    .join('\n');
  return `WEBVTT\n\n${body}`;
}
