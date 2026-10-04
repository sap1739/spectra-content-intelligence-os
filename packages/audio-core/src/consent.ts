import {
  VOICE_BLOCK_REASON_TEXT,
  type VoiceBlockReason,
  type VoiceConsentScope,
  type VoiceConsentStatus,
  type VoiceKind,
} from '@spectra/contracts';

/**
 * The consent gate.
 *
 * This is the single place that decides whether a voice may be used, and it is
 * deliberately conservative: a cloned voice is unusable unless a consent record
 * is GRANTED, unexpired, and covers the use at hand. Absence of information is
 * never read as permission.
 */

export class VoiceConsentError extends Error {
  readonly reason: VoiceBlockReason;
  readonly voiceProfileId: string;

  constructor(reason: VoiceBlockReason, voiceProfileId: string, message?: string) {
    super(message ?? VOICE_BLOCK_REASON_TEXT[reason]);
    this.name = 'VoiceConsentError';
    this.reason = reason;
    this.voiceProfileId = voiceProfileId;
  }
}

/** The minimum a caller must know about a voice to ask whether it may be used. */
export interface ConsentCheckInput {
  voiceProfileId: string;
  kind: VoiceKind;
  consent: {
    status: VoiceConsentStatus;
    scopes: readonly VoiceConsentScope[];
    expiresAt: Date | null;
    revokedAt: Date | null;
  } | null;
  /** What the audio is for. Checked against the consent's scopes. */
  scope: VoiceConsentScope;
  now?: Date;
}

export interface VoiceUsability {
  usable: boolean;
  /** Null when usable; otherwise why not, with operator-facing text. */
  reason: VoiceBlockReason | null;
  message: string | null;
  /** True when this voice needs consent at all — i.e. it imitates a person. */
  requiresConsent: boolean;
}

/**
 * Decides whether a voice may be used. Pure, so the API, the worker and the UI
 * all answer the question the same way.
 */
export function evaluateVoiceUsability(input: ConsentCheckInput): VoiceUsability {
  const requiresConsent = input.kind === 'CLONED';
  if (!requiresConsent) {
    // STOCK and CUSTOM_SYNTHETIC voices imitate nobody, so there is no person
    // to obtain consent from.
    return { usable: true, reason: null, message: null, requiresConsent: false };
  }

  const now = input.now ?? new Date();
  const block = (reason: VoiceBlockReason): VoiceUsability => ({
    usable: false,
    reason,
    message: VOICE_BLOCK_REASON_TEXT[reason],
    requiresConsent: true,
  });

  if (!input.consent) return block('CONSENT_MISSING');
  if (input.consent.revokedAt || input.consent.status === 'REVOKED') {
    return block('CONSENT_REVOKED');
  }
  if (input.consent.status === 'PENDING') return block('CONSENT_PENDING');
  if (input.consent.status === 'EXPIRED') return block('CONSENT_EXPIRED');
  if (input.consent.status !== 'GRANTED') return block('CONSENT_MISSING');
  // A grant that has run out is expired whatever the stored status says: the
  // clock decides, not a column somebody forgot to update.
  if (input.consent.expiresAt && input.consent.expiresAt.getTime() <= now.getTime()) {
    return block('CONSENT_EXPIRED');
  }
  if (!input.consent.scopes.includes(input.scope)) {
    return block('CONSENT_SCOPE_NOT_COVERED');
  }

  return { usable: true, reason: null, message: null, requiresConsent: true };
}

/** Throws unless the voice may be used. Used before any synthesis is attempted. */
export function assertVoiceUsable(input: ConsentCheckInput): void {
  const verdict = evaluateVoiceUsability(input);
  if (!verdict.usable && verdict.reason) {
    throw new VoiceConsentError(verdict.reason, input.voiceProfileId, verdict.message ?? undefined);
  }
}

/**
 * The status a stored record should carry *now*. Storage can go stale — a grant
 * that has passed its expiry is EXPIRED whether or not anything updated it.
 */
export function effectiveConsentStatus(
  stored: VoiceConsentStatus,
  expiresAt: Date | null,
  revokedAt: Date | null,
  now: Date = new Date(),
): VoiceConsentStatus {
  if (revokedAt || stored === 'REVOKED') return 'REVOKED';
  if (stored === 'GRANTED' && expiresAt && expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return stored;
}
