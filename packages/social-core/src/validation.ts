import type { PlatformCapability } from '@spectra/contracts';

/**
 * Deterministic validation of a would-be post against a platform's declared
 * capabilities. Real, useful logic that runs with no platform integration:
 * tells creators whether a variant fits X's 280 chars, Instagram's 30-hashtag
 * cap, a carousel's media count, and whether the media kinds are supported.
 */

export interface VariantValidationInput {
  text?: string | null;
  hashtagCount?: number;
  mediaCount?: number;
  mediaKinds?: Array<'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT'>;
}

export interface ValidationIssue {
  code: 'MAX_CHARACTERS' | 'MAX_HASHTAGS' | 'MAX_MEDIA' | 'UNSUPPORTED_MEDIA_KIND';
  message: string;
}

export interface VariantValidation {
  platform: PlatformCapability['platform'];
  capabilityVersion: string;
  ok: boolean;
  issues: ValidationIssue[];
}

export function validateVariant(
  capability: PlatformCapability,
  input: VariantValidationInput,
): VariantValidation {
  const issues: ValidationIssue[] = [];
  const { limits, mediaFormats } = capability;

  const textLength = input.text?.length ?? 0;
  if (limits.maxCharacters != null && textLength > limits.maxCharacters) {
    issues.push({
      code: 'MAX_CHARACTERS',
      message: `Text is ${textLength} characters; ${capability.platform} allows at most ${limits.maxCharacters}.`,
    });
  }

  if (
    limits.maxHashtags != null &&
    input.hashtagCount != null &&
    input.hashtagCount > limits.maxHashtags
  ) {
    issues.push({
      code: 'MAX_HASHTAGS',
      message: `${input.hashtagCount} hashtags; ${capability.platform} allows at most ${limits.maxHashtags}.`,
    });
  }

  if (
    limits.maxMediaPerPost != null &&
    input.mediaCount != null &&
    input.mediaCount > limits.maxMediaPerPost
  ) {
    issues.push({
      code: 'MAX_MEDIA',
      message: `${input.mediaCount} media items; ${capability.platform} allows at most ${limits.maxMediaPerPost}.`,
    });
  }

  if (input.mediaKinds && input.mediaKinds.length > 0) {
    const supported = new Set(mediaFormats.map((f) => f.kind));
    for (const kind of input.mediaKinds) {
      if (!supported.has(kind)) {
        issues.push({
          code: 'UNSUPPORTED_MEDIA_KIND',
          message: `${capability.platform} does not support ${kind} media.`,
        });
      }
    }
  }

  return {
    platform: capability.platform,
    capabilityVersion: capability.capabilityVersion,
    ok: issues.length === 0,
    issues,
  };
}
