## 11. Evidence integrity **[P2]**

Claim verification (ADR-0032) protects against a specific failure: research evidence that looks
stronger than it is.

- **Syndication cannot manufacture corroboration.** Independent-source counts collapse copies of
  one story, so republication does not raise a claim's standing.
- **A claim with no supporting citation is BLOCKED.** Content can never cite evidence that does not
  exist.
- **Conflicting evidence is never auto-resolved.** Contradictions are stored, surfaced, and routed
  to a human; the system does not choose a winner.
- **Human decisions are append-only and attributed.** `claim_reviews` records the reviewer, action
  and note; rejections and more-research requests require a stated reason.
- **Ineligible sources cannot support claims.** A source that is not `evidenceEligible` (blocked
  domain, injection-quarantined, duplicate) is excluded from a claim's support, so a domain block
  cannot be bypassed one layer up.
- **Tenant isolation.** Claims, contradictions and reviews are all workspace-scoped; a foreign
  claim is indistinguishable from a missing one.
