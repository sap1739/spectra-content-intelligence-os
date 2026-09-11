import { toPlainText, type PublishInput, type PublishValidationIssue } from '@spectra/social-core';

import {
  FACEBOOK_MAX_MESSAGE_CHARS,
  FACEBOOK_MAX_PHOTO_BYTES,
  FACEBOOK_PHOTO_MIME_TYPES,
  INSTAGRAM_IMAGE_MIME_TYPES,
  INSTAGRAM_MAX_ALT_TEXT_CHARS,
  INSTAGRAM_MAX_ASPECT_RATIO,
  INSTAGRAM_MAX_CAPTION_CHARS,
  INSTAGRAM_MAX_HASHTAGS,
  INSTAGRAM_MAX_IMAGE_BYTES,
  INSTAGRAM_MAX_MENTIONS,
  INSTAGRAM_MEDIA_REQUIRED,
  INSTAGRAM_MIN_ASPECT_RATIO,
} from './constants';

/** The text Meta receives: the body, or the title when there is no body. */
export function metaPostText(input: Pick<PublishInput, 'title' | 'body'>): string {
  return toPlainText(input.body ?? '') || toPlainText(input.title ?? '');
}

const HASHTAG = /(^|\s)#[\p{L}\p{N}_]+/gu;
const MENTION = /(^|\s)@[A-Za-z0-9._]+/g;
const chars = (text: string) => [...text].length;

export function validateFacebookPost(input: PublishInput): PublishValidationIssue[] {
  const issues: PublishValidationIssue[] = [];
  const text = metaPostText(input);
  const media = input.media ?? [];
  if (!text && media.length === 0) {
    issues.push({ code: 'EMPTY_POST', message: 'A Facebook post needs text or a photo.' });
  }
  if (chars(text) > FACEBOOK_MAX_MESSAGE_CHARS) {
    issues.push({
      code: 'MAX_CHARACTERS',
      message: `Facebook allows ${FACEBOOK_MAX_MESSAGE_CHARS.toLocaleString('en-US')} characters per post; this one has ${chars(text).toLocaleString('en-US')}.`,
    });
  }
  if (media.length > 1) {
    issues.push({
      code: 'TOO_MANY_MEDIA',
      message: 'One photo per Facebook post is supported; multi-photo posts are not implemented.',
    });
  }
  for (const item of media) {
    if (item.kind !== 'IMAGE') continue;
    if (!FACEBOOK_PHOTO_MIME_TYPES.includes(item.mimeType)) {
      issues.push({
        code: 'UNSUPPORTED_IMAGE_FORMAT',
        message: `Facebook Page photos must be JPEG, PNG, GIF, BMP or TIFF; this one is ${item.mimeType}.`,
      });
    }
    if (item.sizeBytes > FACEBOOK_MAX_PHOTO_BYTES) {
      issues.push({
        code: 'IMAGE_FILE_TOO_LARGE',
        message: 'Facebook Page photos must be under 10 MB.',
      });
    }
  }
  return issues;
}

export function validateInstagramPost(input: PublishInput): PublishValidationIssue[] {
  const issues: PublishValidationIssue[] = [];
  const media = input.media ?? [];
  if (media.length === 0) {
    issues.push({ code: 'MEDIA_REQUIRED', message: INSTAGRAM_MEDIA_REQUIRED });
  }
  if (media.length > 1) {
    issues.push({
      code: 'TOO_MANY_MEDIA',
      message: 'One image per Instagram post is supported; carousels are not implemented.',
    });
  }

  const caption = metaPostText(input);
  if (chars(caption) > INSTAGRAM_MAX_CAPTION_CHARS) {
    issues.push({
      code: 'MAX_CHARACTERS',
      message: `Instagram captions allow ${INSTAGRAM_MAX_CAPTION_CHARS.toLocaleString('en-US')} characters; this one has ${chars(caption).toLocaleString('en-US')}.`,
    });
  }
  const hashtags = caption.match(HASHTAG)?.length ?? 0;
  if (hashtags > INSTAGRAM_MAX_HASHTAGS) {
    issues.push({
      code: 'TOO_MANY_HASHTAGS',
      message: `Instagram allows ${INSTAGRAM_MAX_HASHTAGS} hashtags per caption; this one has ${hashtags}.`,
    });
  }
  const mentions = caption.match(MENTION)?.length ?? 0;
  if (mentions > INSTAGRAM_MAX_MENTIONS) {
    issues.push({
      code: 'TOO_MANY_MENTIONS',
      message: `Instagram allows ${INSTAGRAM_MAX_MENTIONS} @ tags per caption; this one has ${mentions}.`,
    });
  }

  for (const item of media) {
    if (item.kind !== 'IMAGE') continue;
    if (!INSTAGRAM_IMAGE_MIME_TYPES.includes(item.mimeType)) {
      issues.push({
        code: 'UNSUPPORTED_IMAGE_FORMAT',
        message: `Instagram accepts JPEG images only; this one is ${item.mimeType}.`,
      });
    }
    if (item.sizeBytes > INSTAGRAM_MAX_IMAGE_BYTES) {
      issues.push({
        code: 'IMAGE_FILE_TOO_LARGE',
        message: 'Instagram images must be 8 MB or smaller.',
      });
    }
    if (!item.widthPx || !item.heightPx) {
      issues.push({
        code: 'ASPECT_RATIO_UNKNOWN',
        message:
          "Instagram requires an aspect ratio between 4:5 and 1.91:1, and this image's dimensions are unknown.",
      });
    } else {
      const ratio = item.widthPx / item.heightPx;
      if (ratio < INSTAGRAM_MIN_ASPECT_RATIO - 1e-9 || ratio > INSTAGRAM_MAX_ASPECT_RATIO + 1e-9) {
        issues.push({
          code: 'ASPECT_RATIO',
          message: `Instagram requires an aspect ratio between 4:5 and 1.91:1; this image is ${item.widthPx}×${item.heightPx} (${ratio.toFixed(2)}:1).`,
        });
      }
    }
    if (item.altText && chars(item.altText) > INSTAGRAM_MAX_ALT_TEXT_CHARS) {
      issues.push({
        code: 'ALT_TEXT_TOO_LONG',
        message: `Instagram alt text allows ${INSTAGRAM_MAX_ALT_TEXT_CHARS} characters.`,
      });
    }
  }
  return issues;
}
