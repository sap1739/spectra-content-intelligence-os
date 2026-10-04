# Voice and Likeness Consent Policy

**Status:** Enforced in code since Phase 7C (ADR-0042).

This document states what Spectra will and will not do with a person's voice, and where each rule
is enforced. It is written to be read by an operator, a subject whose voice is involved, and an
auditor.

## 1. The rule

**Spectra will not synthesise a voice that imitates a real person without that person's recorded,
current, scope-appropriate consent.**

This is not a setting. It is a gate in `@spectra/audio-core/consent.ts`, applied every time a voice
is used, and there is no flag that bypasses it.

## 2. What counts as a voice needing consent

| Voice kind         | Consent required | Why                                                          |
| ------------------ | ---------------- | ------------------------------------------------------------ |
| `STOCK`            | No               | Licensed from a provider; imitates no identifiable person.   |
| `CUSTOM_SYNTHETIC` | No               | Commissioned and wholly synthetic; tied to no person.        |
| `CLONED`           | **Yes, always**  | Built from a real person's recordings. It is their likeness. |

Creating a `CLONED` voice **requires naming the person** — the schema refuses one that names nobody.
A voice whose subject is unknown cannot be created, and therefore cannot be used.

## 3. What a valid consent record is

All of the following must hold at the moment of use, or the voice is refused:

1. **Granted** — status is `GRANTED`. A `PENDING` request is not permission.
2. **Current** — `expiresAt` is in the future. **Consent is always time-boxed**; Spectra does not
   offer an open-ended grant, and a grant that has run out is treated as expired whatever the stored
   status column says.
3. **Not revoked** — no `revokedAt`. A revocation timestamp overrides the stored status.
4. **In scope** — the consent's `scopes` include the use the episode is for.

Scopes are narrow by default and must be chosen deliberately:
`INTERNAL_ONLY`, `ORGANIC_SOCIAL`, `PODCAST`, `MARKETING`, `PAID_ADVERTISING`. Consent for a podcast
is **not** consent for a paid advertisement; using a voice outside its scopes is refused with
`CONSENT_SCOPE_NOT_COVERED`.

A record also captures how consent was obtained (`SIGNED_RELEASE`, `WRITTEN_AGREEMENT`,
`RECORDED_STATEMENT`, `OTHER`), an optional stored evidence document, a contract reference so the
agreement can be audited outside Spectra, and who recorded it.

## 4. Where the gate is applied

Three times, deliberately:

1. **In the editor** — the episode page lists every voice it speaks with and why a blocked one is
   blocked, before anyone tries to render.
2. **When a render is queued** — the API refuses, naming the voice and the reason. No job is created.
3. **In the worker, against the database** — re-checked at render time. This is the one that matters:
   **a person can revoke consent after a render is queued, and that revocation stops it.**

A render blocked by consent fails with `VOICE_CONSENT_MISSING`, produces no asset, and synthesises
nothing — the refusal happens before any provider would be called.

## 5. Revocation

Revocation is immediate and permanent for that record. It takes effect on renders already queued,
is recorded with a reason, and is audit-logged. A subject who withdraws consent does not need
anyone to remember to cancel a job.

Previously rendered audio is **not** retroactively deleted by revocation — Spectra cannot recall a
file that has been published. Operators must handle existing material separately; the consent
history makes it clear what was permitted when.

## 6. Who may record consent

Recording or revoking consent requires the **`voice:consent`** permission, which is deliberately
separate from `audio:write`. Someone who assembles episodes cannot assert that a person agreed to
have their voice cloned. By default it belongs to organization owners and admins and to workspace
admins only.

Every grant and revocation is written to the audit log with the actor, the subject's name, the
scopes and the expiry.

## 7. What Spectra does not do

- **No voice cloning is performed by Spectra.** No speech-synthesis provider is implemented
  (ADR-0042); voice profiles describe voices for a provider that does not yet exist. When one is
  added, it inherits this gate — `TextToSpeechRequest.voiceConsentRef` has carried the requirement
  since Phase 1, and adapters must reject cloned-voice requests without a verified record.
- **No likeness is inferred.** Spectra never guesses that a voice belongs to someone; a cloned voice
  names its subject explicitly or it cannot exist.
- **No consent is assumed from silence.** A missing record blocks; it never passes.

## 8. For the person whose voice it is

If your voice is in this system:

- There is a record naming you, what you agreed to, how it was obtained, and when it expires.
- Your consent is time-boxed and will lapse on its own unless renewed.
- It can be revoked at any time, and revocation stops work already in progress.
- A revocation is logged, with a reason.

Ask the operator for the consent record and the audit entries; both are retrievable per voice.
