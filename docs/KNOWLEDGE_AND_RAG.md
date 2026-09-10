## Verified claims in generation (Phase 5H, ADR-0032)

Generation loads claims from the evidence pack and re-filters on eligibility, so a pack that went
stale cannot smuggle a since-blocked claim into a prompt.

The prompt states how well each claim is supported — corroborated by N independent sources, or
"ONE source only — limited evidence" — and instructs the model to attribute weakly supported claims
explicitly rather than asserting them as settled. When every available claim is weak, an explicit
evidence warning is added to the instructions.

Weak claims are **qualified, not dropped**: removing them would silently narrow the evidence base
rather than telling the reader how strong it is. Citation validation (ADR-0017) still runs
unchanged, so a marker pointing at evidence that was not supplied is still reported as dangling.
