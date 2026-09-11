import { toPlainText, type PublishInput, type PublishValidationIssue } from '@spectra/social-core';

import {
  LINKEDIN_IMAGE_MIME_TYPES,
  LINKEDIN_MAX_COMMENTARY_CHARS,
  LINKEDIN_MAX_IMAGE_PIXELS,
  SPECTRA_MAX_IMAGE_BYTES,
} from './constants';

/**
 * LinkedIn `commentary` is "little" text: characters reserved for mentions and
 * templates must be backslash-escaped even where they are not used as markup,
 * or the post is rejected or mis-rendered. `#word` is itself a hashtag element,
 * so a hashtag is kept; every other reserved character is escaped.
 */
const RESERVED = new Set([
  '|',
  '{',
  '}',
  '@',
  '[',
  ']',
  '(',
  ')',
  '<',
  '>',
  '#',
  '\\',
  '*',
  '_',
  '~',
]);
const HASHTAG = /^#[\p{L}\p{N}]+/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

export { toPlainText };

export function toLittleText(text: string): string {
  const input = text.replace(/\r\n?/g, '\n');
  let out = '';
  let i = 0;
  while (i < input.length) {
    const char = input[i] as string;
    if (char === '#') {
      const previous = i > 0 ? (input[i - 1] as string) : '';
      const match = HASHTAG.exec(input.slice(i));
      // "C#" is text, "#launch" is a hashtag.
      if (match && !WORD_CHAR.test(previous)) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    out += RESERVED.has(char) ? `\\${char}` : char;
    i += 1;
  }
  return out;
}

/** The text LinkedIn will receive: the body, or the title when there is no body. */
export function linkedInPostText(input: Pick<PublishInput, 'title' | 'body'>): string {
  return toPlainText(input.body ?? '') || toPlainText(input.title ?? '');
}

/** Checks that need no network. Media KIND support is the executor's check, not this one. */
export function validateLinkedInPost(input: PublishInput): PublishValidationIssue[] {
  const issues: PublishValidationIssue[] = [];
  const text = linkedInPostText(input);
  const length = [...text].length;
  if (length === 0) {
    issues.push({ code: 'EMPTY_TEXT', message: 'A LinkedIn post needs text.' });
  } else if (length > LINKEDIN_MAX_COMMENTARY_CHARS) {
    issues.push({
      code: 'MAX_CHARACTERS',
      message: `LinkedIn allows ${LINKEDIN_MAX_COMMENTARY_CHARS.toLocaleString('en-US')} characters per post; this one has ${length.toLocaleString('en-US')}.`,
    });
  }

  const media = input.media ?? [];
  if (media.length > 1) {
    issues.push({
      code: 'TOO_MANY_MEDIA',
      message: 'One image per LinkedIn post is supported; multi-image posts are not implemented.',
    });
  }
  for (const item of media) {
    if (item.kind !== 'IMAGE') continue;
    if (!LINKEDIN_IMAGE_MIME_TYPES.includes(item.mimeType)) {
      issues.push({
        code: 'UNSUPPORTED_IMAGE_FORMAT',
        message: `LinkedIn accepts JPG, PNG and GIF images; this one is ${item.mimeType}.`,
      });
    }
    if (
      item.widthPx &&
      item.heightPx &&
      item.widthPx * item.heightPx >= LINKEDIN_MAX_IMAGE_PIXELS
    ) {
      issues.push({
        code: 'IMAGE_TOO_LARGE',
        message: `LinkedIn accepts images under ${LINKEDIN_MAX_IMAGE_PIXELS.toLocaleString('en-US')} pixels; this one is ${item.widthPx}×${item.heightPx}.`,
      });
    }
    if (item.sizeBytes > SPECTRA_MAX_IMAGE_BYTES) {
      issues.push({
        code: 'IMAGE_FILE_TOO_LARGE',
        message: 'Images over 20 MB are not uploaded (a Spectra limit, not a LinkedIn one).',
      });
    }
  }
  return issues;
}
