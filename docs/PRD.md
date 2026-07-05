# Product Requirements — SpectraContent Intelligence OS

## 1. Problem

Teams that publish content professionally (B2B/B2C companies, agencies, creators, consultants,
regulated enterprises) struggle to (a) keep up with what is actually happening in their niche,
(b) separate durable trends from noise, and (c) turn validated insight into multi-platform
content quickly — with provenance they can defend. Generic AI writing tools generate fluent but
unverified content; social schedulers publish but do not think.

## 2. Product thesis

**Research first.** Content is only generated from validated, cited findings scoped to a
user-defined vertical. Every claim in every asset can be traced to its sources, and every trend
score can be explained.

## 3. Target users

| Segment               | Primary needs                                                           |
| --------------------- | ----------------------------------------------------------------------- |
| B2B marketing teams   | Thought leadership grounded in real developments; approvals; compliance |
| Agencies              | Multi-client workspaces, client review roles, white-glove reporting     |
| Creators/consultants  | Fast research-to-post loops in their niche and languages                |
| Product companies     | Launch/competitor intelligence feeding campaigns                        |
| Regulated enterprises | Claim verification, audit trails, retention, restricted review flows    |
| Multilingual markets  | Vertical-defined languages/geographies (e.g. Bengali music releases)    |

## 4. Core capabilities (target platform)

1. Business & brand understanding (brand voice, guidelines, do-nots).
2. Custom verticals — fully user-defined; no hard-coded industry list.
3. Research pipeline: query planning → discovery → retrieval → extraction → normalization →
   dedup → clustering → claim extraction → verification → credibility/freshness scoring.
4. Trend intelligence: explainable, configurable, versioned scoring; lifecycle states;
   watchlists and alerts.
5. Strategy & campaigns: objectives, personas, pillars, angles, briefs, calendars.
6. Multimedia generation: text, image, video, audio via provider-neutral ports; platform
   variants with capability-aware constraints.
7. Human review & approval with full history.
8. Scheduling & publishing via official platform APIs; idempotent, capability-gated.
9. Analytics retrieval feeding back into scoring (continuous optimization).

## 5. Example user request (north star)

> “Research the latest developments in AI-powered quality engineering in India and globally.
> Identify the strongest trends, validate them using multiple sources, and create a seven-day
> campaign for LinkedIn, Instagram and YouTube targeting QA managers and technology leaders.”

The system must: create a research project against the relevant vertical, run the pipeline,
produce scored/explained trends and evidence packs, propose a campaign strategy and calendar,
generate platform variants for review, and (after approval) schedule via connected accounts.

## 6. Non-goals (permanent)

- Fabricated analytics, trends or engagement numbers.
- Publishing without human approval (unless a tenant explicitly enables it later).
- Scraping in violation of source or platform terms.
- Voice cloning or likeness generation without verified consent.

## 7. Phase 1 scope (this repository, today)

**In:** monorepo, all domain contracts, database schema for 12 foundational entities,
API/worker/web foundations with health + heartbeat, tenant isolation and security standards,
testing foundations, CI, documentation and ADRs.

**Out (explicitly not implemented):** authentication, research providers, AI generation,
media rendering, social publishing, analytics, billing.

## 8. Success criteria for Phase 1

- `pnpm install && pnpm build && pnpm test` pass cleanly on Node 22.
- Local stack boots via Docker Compose; migrations and seed apply.
- API `/health` and `/health/ready` respond truthfully; worker heartbeat visible in readiness.
- Web shell renders all 17 navigation areas with honest empty states, light/dark, keyboard
  accessible.
- Every future integration has a typed port and an ADR documenting its direction.

## 9. Roadmap

See [ROADMAP.md](ROADMAP.md) for Phases 2–5.
