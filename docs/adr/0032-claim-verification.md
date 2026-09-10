# ADR-0032: Claim verification — corroboration, contradiction, staleness, eligibility

**Status:** Accepted · **Date:** 2026-09-09 · **Relates to:** ADR-0011, ADR-0016, ADR-0017, ADR-0030

## Context

The pipeline extracts claim-shaped sentences (ADR-0016) and counts how many sources mention each
one. Generation then grounds on whatever the evidence pack contains. Two problems follow.

First, `sourceCount` counted rows, not sources. Ten outlets republishing one wire story produced
`sourceCount: 10` — a single unverified report reading as overwhelming corroboration. ADR-0030
fixed exactly this for trend scoring and left claims untouched.

Second, nothing distinguished a claim three independent outlets agree on from one a single blog
asserted, from one that another source in the same project directly contradicts. All three
reached generation identically.

## Decision

Add a verification layer between claim extraction and evidence-pack assembly, in a dedicated
package (`@spectra/claim-verification`) that is pure, deterministic and independently testable.

1. **Corroboration counts INDEPENDENT sources.** Supports carry the pipeline's
   `duplicateClusterKey`/`duplicateOfSourceId` (ADR-0030); sources sharing one collapse to a single
   unit. `sourceCount` (all rows) and `independentSourceCount` (real sources) are both stored, so
   the difference between them is visible rather than hidden.

2. **Clustering by asserted content.** A claim's cluster key is its normalized numbers plus its
   salient terms, so the same fact phrased differently across outlets corroborates rather than
   creating a second claim — while different figures stay in different clusters.

3. **Contradictions are surfaced, never resolved automatically.** Numeric conflicts (beyond a 10%
   tolerance, so rounding is agreement), negation, and opposite directions are detected between
   claims about the same subject. A contradicted claim goes to `REQUIRES_REVIEW`. **Picking a
   winner automatically is how a tool launders a disagreement into a fact**, so the system refuses
   to and asks a human.

4. **Staleness applies only to time-sensitive claims.** Statistics and predictions decay from the
   NEWEST supporting source; factual and quote claims do not, because a historical fact does not
   become false with age. No dated support means `UNKNOWN` — uncertain, not assumed current.

5. **Eligibility is an explicit, reasoned decision.** `ELIGIBLE` / `WEAK` / `REQUIRES_REVIEW` /
   `BLOCKED`, each with a populated reason. Order: a human decision beats automation;
   **no supporting citation is fatal** (citing it would mean fabricating support); contradictions
   beat corroboration; staleness beats corroboration.

6. **Packs carry only usable claims.** Evidence packs include `ELIGIBLE` and `WEAK` claims only.
   Generation re-filters on load, so a pack that went stale cannot smuggle a since-blocked claim
   into a prompt.

7. **Weak evidence reaches the prompt as weak.** The prompt lists each claim with how well it is
   supported and instructs the model to attribute single-source claims explicitly. When every
   available claim is weak, an explicit evidence warning is added. The alternative — dropping weak
   claims entirely — would silently narrow the evidence rather than qualify it.

8. **Human review is append-only.** Approve / reject / request-more-research, each recorded in
   `claim_reviews` with a note (mandatory for reject and more-research). A reviewer's decision is
   authoritative and is never reset by a later automated re-run.

## Rationale

- **Deterministic, not model-judged.** No LLM is asked whether a claim is true. A confident-sounding
  verdict we cannot justify is worse than an honest "supported by one source".
- **Conservative detection.** The contradiction rules will miss subtle conflicts, but everything
  they report they can explain in one sentence, and neither side is ever discarded.
- **Two counts, both stored.** Keeping `sourceCount` alongside `independentSourceCount` makes
  syndication visible instead of silently corrected.

## Consequences

- Claims previously reading as well-corroborated will drop when their support is syndicated. That
  is the correction, not a regression — the earlier numbers overstated the evidence.
- Contradicted and stale claims leave the evidence pool until reviewed, so some topics will produce
  thinner packs and generation may report insufficient evidence more often.
- Clustering is lexical, so paraphrases sharing no salient terms will not cluster, and unrelated
  claims sharing a figure and vocabulary could. Both fail toward _less_ corroboration, which is the
  safer direction.
- The review queue is unbounded work: a project with many conflicting sources will generate many
  review items. Prioritisation and bulk actions are deferred.
- Claim extraction remains heuristic (ADR-0016). Verification makes weak evidence visible; it does
  not make the extraction smarter.
