## Claim verification (Phase 5H, ADR-0032)

A citation says where a statement came from. Verification says how much weight it can bear.

Each claim records **two** support counts: `sourceCount` (every supporting row) and
`independentSourceCount` (after collapsing syndicated copies via the pipeline's
`duplicateClusterKey`). Ten outlets republishing one wire story is one independent source; storing
both numbers keeps that visible rather than silently corrected.

`supportingCitationIds` lists the citations that actually back the claim. It is never populated
speculatively — a claim with no supporting citation is `BLOCKED`, because citing it would mean
fabricating support.

Contradictions between claims are stored as first-class `claim_contradictions` rows and surfaced in
the API and UI. They are never auto-resolved: a human decides which claim stands, and the decision
is appended to an immutable `claim_reviews` log.
