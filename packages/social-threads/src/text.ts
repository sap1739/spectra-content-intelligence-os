import { toPlainText, type PublishInput, type PublishValidationIssue } from '@spectra/social-core';

import {
  THREADS_IMAGE_MIME_TYPES,
  THREADS_MAX_ALT_TEXT_CHARS,
  THREADS_MAX_ASPECT_RATIO,
  THREADS_MAX_IMAGE_BYTES,
  THREADS_MAX_IMAGE_WIDTH,
  THREADS_MAX_TEXT_CHARS,
  THREADS_MIN_IMAGE_WIDTH,
} from './constants';

/** The text Threads receives: the body, or the title when there is no body. */
export function threadsPostText(input: Pick<PublishInput, 'title' | 'body'>): string {
  return toPlainText(input.body ?? '') || toPlainText(input.title ?? '');
}

const chars = (text: string) => [...text].length;

/**
 * What Threads would refuse, refused here first. Everything checked is
 * something Meta documents: 500 characters, JPEG or PNG under 8 MB, a width
 * between 320 and 1,440, and an aspect ratio no wider than 10:1.
 */
export function validateThreadsPost(input: PublishInput): PublishValidationIssue[] {
  const issues: PublishValidationIssue[] = [];
  const text = threadsPostText(input);
  const media = input.media ?? [];

  if (!text && media.length === 0) {
    issues.push({ code: 'EMPTY_POST', message: 'A Threads post needs text or an image.' });
  }
  if (chars(text) > THREADS_MAX_TEXT_CHARS) {
    issues.push({
      code: 'MAX_CHARACTERS',
      message: `Threads allows ${THREADS_MAX_TEXT_CHARS} characters per post; this one has ${chars(text)}.`,
    });
  }
  if (media.length > 1) {
    issues.push({
      code: 'TOO_MANY_MEDIA',
      message: 'One image per Threads post is supported; carousels are not implemented.',
    });
  }

  for (const item of media) {
    if (item.kind !== 'IMAGE') {
      issues.push({
        code: 'UNSUPPORTED_MEDIA_KIND',
        message: `Threads posts here carry an image; this attachment is ${item.kind.toLowerCase()}.`,
      });
      continue;
    }
    if (!THREADS_IMAGE_MIME_TYPES.includes(item.mimeType)) {
      issues.push({
        code: 'UNSUPPORTED_IMAGE_FORMAT',
        message: `Threads accepts JPEG and PNG images; this one is ${item.mimeType}.`,
      });
    }
    if (item.sizeBytes > THREADS_MAX_IMAGE_BYTES) {
      issues.push({
        code: 'IMAGE_FILE_TOO_LARGE',
        message: 'Threads images must be 8 MB or smaller.',
      });
    }
    if (item.widthPx !== null && item.widthPx < THREADS_MIN_IMAGE_WIDTH) {
      issues.push({
        code: 'IMAGE_TOO_NARROW',
        message: `Threads images must be at least ${THREADS_MIN_IMAGE_WIDTH} pixels wide; this one is ${item.widthPx}.`,
      });
    }
    if (item.widthPx !== null && item.widthPx > THREADS_MAX_IMAGE_WIDTH) {
      // Meta documents 1440 as the maximum width, not a resize target.
      issues.push({
        code: 'IMAGE_TOO_WIDE',
        message: `Threads images must be at most ${THREADS_MAX_IMAGE_WIDTH} pixels wide; this one is ${item.widthPx}. Resize it on the Media page.`,
      });
    }
    if (item.widthPx && item.heightPx) {
      const ratio = Math.max(item.widthPx / item.heightPx, item.heightPx / item.widthPx);
      if (ratio > THREADS_MAX_ASPECT_RATIO + 1e-9) {
        issues.push({
          code: 'ASPECT_RATIO',
          message: `Threads allows an aspect ratio up to ${THREADS_MAX_ASPECT_RATIO}:1; this image is ${item.widthPx}×${item.heightPx}.`,
        });
      }
    }
    if (item.altText && chars(item.altText) > THREADS_MAX_ALT_TEXT_CHARS) {
      issues.push({
        code: 'ALT_TEXT_TOO_LONG',
        message: `Spectra caps Threads alt text at ${THREADS_MAX_ALT_TEXT_CHARS} characters.`,
      });
    }
  }
  return issues;
}
