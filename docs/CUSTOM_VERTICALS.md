# Custom Verticals

A **custom vertical** is a fully user-defined market niche that focuses every downstream
capability: research queries, source filtering, trend relevance, strategy and generation.
**No industry taxonomy is hard-coded anywhere** — `industry`/`subIndustry` are free text.

## 1. Shape (`customVerticalSchema`, `custom_verticals` table)

| Group          | Fields                                                                        |
| -------------- | ----------------------------------------------------------------------------- |
| Identity       | name, slug, description, industry, subIndustry, businessModel                 |
| Offering       | products[], services[]                                                        |
| Audience       | targetAudiences[] {name, description, roles, seniority}, customerPainPoints[] |
| Scope          | geographies[], languages[] (BCP-47)                                           |
| Landscape      | competitors[] {name, websiteUrl, notes}                                       |
| Query steering | keywords[], excludedKeywords[]                                                |
| Source policy  | trustedDomains[], blockedDomains[], preferredPublications[]                   |
| Compliance     | regulatoryConsiderations[]                                                    |
| Timing         | seasonalEvents[] {name, startMonth, endMonth, notes}                          |
| Goals          | commercialObjectives[], contentObjectives[]                                   |
| Channels       | preferredPlatforms[] (platform enum)                                          |
| Scoring        | relevanceCriteria[] {criterion, weight}                                       |

Structured collections persist as validated JSONB/text[]; the Zod schema is enforced at the
API boundary so the database never stores shapes the contract doesn't know.

## 2. How verticals steer the platform

| Consumer         | Usage                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------- |
| Query planning   | keywords/excludedKeywords/languages/geographies expand and constrain queries                |
| Source discovery | trustedDomains boost, blockedDomains exclude, preferredPublications prioritize              |
| Extraction       | languages guide language detection expectations                                             |
| Trend scoring    | relevanceCriteria feed brand/audience relevance components; seasonalEvents feed seasonality |
| Compliance       | regulatoryConsiderations flag claims needing review (complianceRisk penalty)                |
| Strategy         | audiences/painPoints/objectives seed personas, pillars and angles                           |
| Channels         | preferredPlatforms pre-select variant targets                                               |

## 3. Examples that must all work without code changes

AI-powered software testing · Indian luxury candles · Bengali music releases · banking data
migration · healthcare education · Hyderabad real estate · startup funding in India — and any
other user-defined niche. The seed ships one worked example ("AI-powered software testing")
demonstrating a fully populated vertical.

## 4. Lifecycle & tenancy

Verticals are workspace-scoped (`@@unique([workspaceId, slug])`), soft-deleted, and versioned
through audit logs. A research project may pin one vertical; multiple projects can share it.

## 5. Phase plan

Phase 1: entity + contracts + seed example (done). Phase 2: CRUD UI/API, guided vertical
builder, validation of domain lists. Phase 3+: vertical health insights (source coverage,
trend hit-rate) feeding recommendations.
