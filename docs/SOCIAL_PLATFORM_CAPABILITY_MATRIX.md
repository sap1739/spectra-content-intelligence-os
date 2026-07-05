# Social Platform Capability Matrix

**Phase 1 status: no platform is integrated.** This matrix defines the _model_ for recording
capabilities and the current _planning-level_ understanding. Authoritative, versioned
`PlatformCapability` records are captured per adapter at integration time (Phase 4) directly
from official API documentation — platform rules change frequently, so **nothing below is
hard-coded into behaviour**; `null`/“verify” means unknown-until-verified and the code fails
closed (`assertCapability`).

## 1. The model

`platformCapabilitySchema` (contracts/social.ts): platform, `capabilityVersion`,
`recordedAt`, media formats (mime/size/duration/aspect ratios), limits (characters,
hashtags, media count), support flags (nativeScheduling, editAfterPublish, deletion,
analytics, comments, webhooks, stories, drafts — tri-state `true/false/null`), OAuth
(scopes, refresh, token lifetime), notes. Channel variants record the
`platformCapabilityVersion` they were validated against.

## 2. Planning-level expectations (to verify at integration)

| Platform        | Publishing surface              | Media                        | Scheduling                  | Edit after publish        | Analytics               | Comments      | Notes                                  |
| --------------- | ------------------------------- | ---------------------------- | --------------------------- | ------------------------- | ----------------------- | ------------- | -------------------------------------- |
| LinkedIn        | Posts (member/org)              | image, video, document       | verify                      | limited/verify            | org APIs, partner-gated | partner-gated | Partner program tiers gate many scopes |
| Instagram       | Business/creator via Graph API  | image, video, reels, stories | verify                      | no (typical)              | insights API            | Graph API     | Requires linked FB business assets     |
| Facebook        | Pages via Graph API             | image, video, link           | native scheduling (typical) | limited                   | insights                | yes           | Page tokens; app review                |
| YouTube         | Videos, shorts                  | video                        | publishAt (typical)         | metadata yes              | Analytics API           | yes           | Data API quotas are tight              |
| TikTok          | Content posting API             | video (+image modes)         | verify                      | no (typical)              | partial                 | partial       | Audited app access                     |
| Threads         | Threads API                     | text, image, video           | verify                      | verify                    | partial                 | partial       | Newer API; verify everything           |
| X               | v2 API                          | text, image, video           | no native (typical)         | edit windows vary by tier | tier-gated              | tier-gated    | Paid tiers dominate                    |
| Pinterest       | Pins API                        | image, video                 | verify                      | limited                   | analytics API           | limited       |                                        |
| WordPress       | REST API (self-hosted/.com)     | full HTML + media            | future-dated posts          | yes                       | site-dependent          | yes           | Closest to full control                |
| Email platforms | ESP APIs (e.g. Mailchimp-class) | HTML                         | yes                         | pre-send only             | delivery/open metrics   | n/a           | Per-ESP adapters                       |

## 3. Rules the architecture enforces

1. Optional operations (`deletePost`, `fetchAnalytics`, `fetchComments`) are capability-gated;
   unknown capability ⇒ operation refused (fail closed), covered by unit tests.
2. Scheduling degrades gracefully: platforms without native scheduling use Spectra-side
   scheduled jobs feeding immediate publish calls.
3. Character/media limits validate variants **before** queueing publish jobs, pinned to a
   capability version.
4. Webhooks verify signatures before parsing and dedupe by idempotency key.
5. OAuth tokens live in the encrypted vault; scopes requested are the minimum for granted
   features.
