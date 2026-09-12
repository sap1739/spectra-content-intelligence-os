import { toPlainText, type PublishInput, type PublishValidationIssue } from '@spectra/social-core';

import { SPECTRA_MAX_POST_CHARS, X_MAX_IMAGES, X_MAX_IMAGE_BYTES } from './constants';

/** The text X receives: the body, or the title when there is no body. */
export function xPostText(input: Pick<PublishInput, 'title' | 'body'>): string {
  return toPlainText(input.body ?? '') || toPlainText(input.title ?? '');
}

const chars = (text: string) => [...text].length;

/**
 * What X would refuse, refused here first.
 *
 * The character cap is SPECTRA's, not a documented X limit: X's API reference
 * states none, and a verified account may be allowed more. Everything else
 * checked here is documented — one to four media ids per post, and 5 MB per
 * image upload.
 */
export function validateXPost(input: PublishInput): PublishValidationIssue[] {
  const issues: PublishValidationIssue[] = [];
  const text = xPostText(input);
  const media = input.media ?? [];

  if (!text && media.length === 0) {
    issues.push({ code: 'EMPTY_POST', message: 'An X post needs text or an image.' });
  }
  if (chars(text) > SPECTRA_MAX_POST_CHARS) {
    issues.push({
      code: 'MAX_CHARACTERS',
      message: `Spectra caps an X post at ${SPECTRA_MAX_POST_CHARS} characters (X's own limit is not stated in its API reference, and a verified account may post longer); this one has ${chars(text)}.`,
    });
  }
  if (media.length > X_MAX_IMAGES) {
    issues.push({
      code: 'TOO_MANY_MEDIA',
      message: `X allows ${X_MAX_IMAGES} images per post; this one has ${media.length}.`,
    });
  }

  for (const item of media) {
    if (item.kind !== 'IMAGE') {
      issues.push({
        code: 'UNSUPPORTED_MEDIA_KIND',
        message: `Spectra's X adapter posts images; this attachment is ${item.kind.toLowerCase()}.`,
      });
      continue;
    }
    if (item.sizeBytes > X_MAX_IMAGE_BYTES) {
      issues.push({
        code: 'IMAGE_FILE_TOO_LARGE',
        message: 'X image uploads must be 5 MB or smaller.',
      });
    }
    if (item.sizeBytes === 0) {
      issues.push({ code: 'IMAGE_EMPTY', message: 'The attached image file is empty.' });
    }
  }
  return issues;
}
