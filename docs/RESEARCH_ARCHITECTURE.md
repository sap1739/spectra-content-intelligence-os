## Claim verification stage (Phase 5H, ADR-0032)

Between `CLAIM_EXTRACTION` and `EVIDENCE_PACK_GENERATION` the pipeline runs `CLAIM_VERIFICATION`,
which clusters claims by asserted content, counts independent supporting sources, detects
contradictions, assesses staleness for time-sensitive claim types, and writes an explicit
eligibility decision with a reason.

Evidence packs then carry only `ELIGIBLE` and `WEAK` claims. `BLOCKED` (no support, or
reviewer-rejected) and `REQUIRES_REVIEW` (contradicted or stale) claims are excluded, because a
pack is the contract handed to generation and must not contain evidence the system has already
judged unusable.

Verification is deterministic and re-runnable: a later run that finds more independent sources
upgrades a claim, one that finds a conflict downgrades it, and a human decision is never reset.
