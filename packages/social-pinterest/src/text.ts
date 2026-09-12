import { toPlainText, type PublishInput, type PublishValidationIssue } from '@spectra/social-core';

/**
 * What a pin needs before Pinterest is called.
 *
 * Pinterest documents `board_id` and `media_source` as the required fields and
 * nothing about formats, file size or text length — so those are NOT invented
 * here. A pin with no image, or no board chosen, is refused locally; anything
 * about the image itself is left to Pinterest, whose refusal is reported in
 * its own words.
 */

export function pinTitle(input: Pick<PublishInput, 'title'>): string {
  return toPlainText(input.title ?? '').trim();
}

export function pinDescription(input: Pick<PublishInput, 'body'>): string {
  return toPlainText(input.body ?? '').trim();
}

export interface PinDetails {
  /** The board this pin goes to; discovery lists the boards available. */
  boardId: string | null;
  /** The destination link, if the operator set one. */
  link?: string | null;
}

/** The link the entry carries for this pin, if any. */
export function pinLink(input: Pick<PublishInput, 'metadata'>): string | null {
  const pinterest = (input.metadata as { pinterest?: { link?: unknown } } | undefined)?.pinterest;
  return typeof pinterest?.link === 'string' && pinterest.link ? pinterest.link : null;
}

export function validatePinterestPin(
  input: PublishInput,
  details: PinDetails = { boardId: null },
): PublishValidationIssue[] {
  const issues: PublishValidationIssue[] = [];
  const media = input.media ?? [];

  if (!details.boardId) {
    issues.push({
      code: 'BOARD_REQUIRED',
      message: 'A pin needs a Pinterest board. Pick the board on the target account.',
    });
  }
  if (media.length === 0) {
    issues.push({
      code: 'IMAGE_REQUIRED',
      message: 'A pin needs an image; Pinterest has no text-only pins.',
    });
  }
  if (media.length > 1) {
    issues.push({
      code: 'TOO_MANY_MEDIA',
      message: 'One image per pin is supported; carousels are not implemented.',
    });
  }
  for (const item of media) {
    if (item.kind !== 'IMAGE') {
      issues.push({
        code: 'UNSUPPORTED_MEDIA_KIND',
        message: `A pin carries an image; this attachment is ${item.kind.toLowerCase()}.`,
      });
    }
    if (item.sizeBytes === 0) {
      issues.push({ code: 'IMAGE_EMPTY', message: 'The attached image file is empty.' });
    }
  }
  if (details.link) {
    try {
      const url = new URL(details.link);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme');
    } catch {
      issues.push({
        code: 'INVALID_LINK',
        message: "The pin's destination link is not a valid http(s) URL.",
      });
    }
  }
  return issues;
}

/** The `PinCreate` body Pinterest's POST /v5/pins expects. */
export function pinCreateBody(input: {
  boardId: string;
  imageUrl: string;
  title: string;
  description: string;
  altText: string | null;
  link?: string | null;
}): Record<string, unknown> {
  return {
    board_id: input.boardId,
    media_source: { source_type: 'image_url', url: input.imageUrl },
    ...(input.title ? { title: input.title } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.altText ? { alt_text: input.altText } : {}),
    ...(input.link ? { link: input.link } : {}),
  };
}
