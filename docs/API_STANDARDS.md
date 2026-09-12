# API Standards

NestJS 11 on Fastify. These standards bind every endpoint added from Phase 2 onward; the
Phase 1 surface (health, meta) already complies.

## 1. Shape

- REST over HTTPS; URI versioning: `/v1/...` (health endpoints are unversioned).
- Resource-oriented routes: `/v1/workspaces/{workspaceId}/research-projects/{id}`.
- JSON bodies; `application/problem+json` for all errors.
- OpenAPI generated via `@nestjs/swagger`, served at `/docs`.

## 2. Validation

Request bodies/queries validate against `@spectra/contracts` Zod schemas through
`ZodValidationPipe`. Validation failures → 422 with field-level `errors[]`. No endpoint
accepts unvalidated input.

## 3. Errors (RFC 9457 problem details)

```json
{
  "type": "https://spectra.dev/problems/validation",
  "title": "Request validation failed",
  "status": 422,
  "detail": "…",
  "correlationId": "…",
  "errors": [{ "path": "name", "message": "Required" }]
}
```

Mappings in `GlobalExceptionFilter`:

| Condition                                            | Status  | Notes                                                                                                                                          |
| ---------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Zod validation failure                               | 422     | field errors included                                                                                                                          |
| `TenantIsolationError` (missing OR foreign resource) | 404     | identical body — no existence leaks                                                                                                            |
| `ForbiddenError` (missing permission)                | 403     | names the permission                                                                                                                           |
| Unknown route/method                                 | 404/405 | Nest defaults, problem+json body                                                                                                               |
| Unexpected exception                                 | 500     | opaque; logged with correlationId                                                                                                              |
| `BudgetBlockedError` (ceiling or per-kind limit)     | 403     | `type: .../budget-exceeded`; decision attached. NOT 402 — nothing charges anyone, so "Payment Required" would imply a bill that does not exist |

Budget-bearing endpoints acquire their allowance **atomically** (ADR-0029): the decision and the
hold are one transaction, so concurrent requests against the last remaining allowance produce
exactly one `201` and truthful `403`s for the rest — never several successes that together
overspend. Refusals happen before any row is created, so a refused request leaves no artefact.

## 4. Correlation IDs

`x-correlation-id` accepted from callers (≤128 chars) or generated (UUIDv4); always echoed in
the response and stamped on logs, audit entries and enqueued jobs.

## 5. AuthN/AuthZ (from Phase 2)

Session-authenticated principal resolved per request; guards enforce **permissions**
(`research:run`, `content:approve`, …) — never role names. Tenant context comes from the
authenticated membership, **never** from client-supplied org/workspace ids alone; path ids
are verified against the principal's memberships.

## 6. Rate limiting

`@fastify/rate-limit` registered globally (300 req/min/IP in Phase 1). Phase 2 keys limits by
tenant + principal and exempts health probes. 429 responses use problem+json.

## 7. Pagination & filtering

Cursor-based (`cursor`, `limit` ≤ 100, `nextCursor`), matching `paginationRequestSchema`.
Sorting/filter params are whitelisted per endpoint.

## 8. Idempotency

Mutation endpoints that trigger jobs or publishing accept an `Idempotency-Key` header mapped
to queue idempotency keys; replays return the original result.

## 9. Headers & security

`@fastify/helmet` defaults, CORS restricted to the configured web origin, no `x-powered-by`,
JSON-only responses (no reflection of request HTML). See [SECURITY.md](SECURITY.md).

## 10. Deprecation

Breaking changes require a new URI version; previous versions receive `Deprecation` +
`Sunset` headers at least one minor release before removal.

## 11. Operational endpoints (Phase 6B, ADR-0033)

Three endpoints exist for operators rather than for the product, and they follow different rules
from the rest of the surface:

| Endpoint                                     | Auth                     | Versioned              |
| -------------------------------------------- | ------------------------ | ---------------------- |
| `GET /health`, `GET /health/ready`           | public                   | no (`VERSION_NEUTRAL`) |
| `GET /v1/meta/metrics`                       | public                   | yes                    |
| `GET/POST /v1/workspaces/:workspaceId/ops/*` | `ops:read` / `ops:retry` | yes                    |

- **Health probes are version-neutral** — infrastructure should not have to track an API version to
  know whether a process is alive. They live at `/health`, not `/v1/health`.
- **`/health/ready` returns `200` when degraded.** Required dependencies down => `503`; optional
  ones down => `200` with `status: "degraded"` and per-component detail. Component details carry
  counts and states only, never configuration.
- **`GET /v1/meta/metrics` returns `text/plain; version=0.0.4`,** not problem+json or JSON — it is
  Prometheus exposition, the one non-JSON response in the API. It is unauthenticated for scraping
  and carries no tenant identifiers; HTTP series are labelled by route PATTERN, never resolved URL.
- **Ops endpoints are ordinary tenant-scoped `/v1` routes** and follow every normal rule: guard
  chain, problem+json errors, and a `404` for a foreign job that is indistinguishable from a `404`
  for one that never existed.

## 12. OAuth connection endpoints (Phase 6C, ADR-0034)

| Endpoint                                                              | Permission       | Success                                  |
| --------------------------------------------------------------------- | ---------------- | ---------------------------------------- |
| `GET /v1/workspaces/:workspaceId/social/oauth/platforms`              | `social:connect` | `200` configuration per platform         |
| `POST /v1/workspaces/:workspaceId/social/oauth/:platform/start`       | `social:connect` | `201` `{ authorizationUrl, expiresAt }`  |
| `GET /v1/social/oauth/:platform/callback`                             | session (public) | **`302`** to the web app — never JSON    |
| `GET /v1/workspaces/:workspaceId/social/connections`                  | `social:connect` | `200` connections (no credential fields) |
| `GET /v1/workspaces/:workspaceId/social/connections/:id/capabilities` | `social:connect` | `200` scopes × adapter wiring            |
| `POST /v1/workspaces/:workspaceId/social/connections/:id/refresh`     | `social:connect` | `200` `{ status, detail, … }`            |
| `POST /v1/workspaces/:workspaceId/social/connections/:id/reconnect`   | `social:connect` | `201` `{ authorizationUrl, expiresAt }`  |
| `DELETE /v1/workspaces/:workspaceId/social/connections/:id`           | `social:connect` | `200` `{ providerRevocation, note }`     |

Where these depart from the rest of the API, and why:

- **The callback is not workspace-scoped and always redirects.** Its URL is registered with each
  platform, so it cannot carry a workspace id; the attempt row carries the tenant. It is `@Public`
  so an expired session gets a redirect with `oauth=session_required` rather than a JSON 401 in a
  browser tab. Every outcome — success, denial, replay, internal error — is a `302` to
  `WEB_APP_URL` + an allow-listed path with one `oauth=<code>` from `OAUTH_CALLBACK_RESULTS`. It
  sends `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- **`start` answers `503` when a flow cannot succeed** — the platform is not configured, or
  credential storage is not — naming the missing environment variables. It is refused before the
  user is sent to consent. A non-OAuth platform (`wordpress`) is a `400`.
- **Refresh reports its outcome in the body, not the status code.** `NOT_SUPPORTED`,
  `REAUTH_REQUIRED` and `FAILED` are answers about the platform, not failures of the request, so
  the response is `200` with a `status` and a human-readable `detail`.
- **Disconnect returns `200` with a body** rather than `204`: whether the platform confirmed
  revocation is information the caller needs. The local credential is deleted in every case.
- **No OAuth endpoint ever returns a token, a client id or a client secret.** Missing
  configuration is reported by variable name.

## 13. Publishing to connected accounts (Phase 6D, ADR-0035)

- `POST /v1/workspaces/:workspaceId/calendar` accepts `mediaAssetId` (one image, same workspace)
  and `mediaAltText`. With a target account it is checked **before** anything is queued: the
  account must be on the entry's platform, and a discovered account's capability snapshot and the
  platform's limits must allow the post. Refusals are `422` with the reason ("Needs
  w_member_social (Share on LinkedIn)…", "LinkedIn accepts JPG, PNG and GIF images…"). A foreign
  account or asset is the usual `404`.
- Calendar rows carry `failureCode` beside `failureReason`: `AUTH`, `REAUTH_REQUIRED`, `PERMISSION`,
  `VALIDATION`, `UNSUPPORTED_MEDIA`, `RATE_LIMIT`, `TRANSIENT`, `AMBIGUOUS`, `NOT_CONNECTED`,
  `BUDGET` or `UNKNOWN` — so a client can offer the right next step without parsing prose.
- `GET …/social/platforms` adds `publisherSummary` for wired platforms. `GET …/social/connections`
  adds `permissions` (each platform product: GRANTED / MISSING / UNKNOWN, missing scopes, whether
  the platform reviews it) and each discovered account's `capabilities`.

## 14. Meta publishing (Phase 6E, ADR-0036)

- Capability snapshots may carry `NOT_SUPPORTED` — the platform itself does not allow it (an
  Instagram text-only post, a personal Facebook profile) — distinct from `NOT_IMPLEMENTED` and
  `MISSING_PERMISSION`. Failure codes gained `UNSUPPORTED_ACCOUNT`.
- `GET …/social/oauth/platforms` and `GET …/social/connections` add `tokenNote` (how the platform's
  tokens live — for Meta, that Page tokens outlive the user token). Each account under a connection
  carries its `platform`, so an Instagram account found through a Facebook connection says so.
- `POST …/calendar` to an Instagram account requires `mediaAssetId` (one JPEG, 4:5 to 1.91:1,
  ≤ 8 MB); a personal profile or an Instagram account that is not professional is refused `422`
  with the reason, before anything is queued.
- The OAuth callback's `token_exchange_failed` also covers a refused long-lived exchange (audited
  as `long_lived_<code>`).

## 15. Video upload and YouTube (Phase 6F, ADR-0037)

- `POST …/media/uploads` returns `{uploadId, uploadUrl, method, headers, expiresAt}` — a 15-minute
  signed URL to PUT one file to object storage. `POST …/media/uploads/complete` takes `{uploadId}`
  and returns the created `MediaAsset`, or `422` when no object was uploaded. Completing the same
  ticket twice returns the same asset. Size and MIME come from storage, so a recorded asset can
  never overstate what is there.
- `POST …/calendar` accepts `thumbnailAssetId` and `publishMetadata` (`{youtube: {title,
description, tags, categoryId, privacyStatus, madeForKids, notifySubscribers}}`), both checked
  against the target's capabilities before anything is queued; bad video details are `422` naming
  the field.
- Calendar rows add `publishNote` (true of a SUCCESSFUL publish — what the platform did
  differently), `thumbnailAsset`, and `upload` (`{status, uploadedBytes, totalBytes}`) so a client
  can show real upload progress. `failureCode` gained `QUOTA`.
- `GET …/media/status` adds `upload: true`: files can be uploaded even where Spectra renders
  nothing of that kind.

## 16. The remaining platforms (Phase 6G, ADR-0038)

- `publishMetadata` gained two more slices, each validated by contracts: `tiktok` (caption, privacy
  level, comment/duet/stitch, cover timestamp, branded-content and AI-generated declarations) and
  `pinterest` (a destination `link`).
- Scheduling to a board or creator is checked before anything is queued, the same way as the
  earlier platforms: a text-only pin, a Threads video, a TikTok post without a video, or a post
  over a documented limit is `422` with the platform's reason.
- `GET …/social/oauth/platforms` reports all eight OAuth platforms as wired, each `limitation`
  naming what the adapter does NOT do, and each `approval.notes` naming the platform's gate
  (TikTok's audit, X's pay-per-usage access, Meta's advanced access for Threads, Pinterest's Trial
  access).
- `POST …/social/oauth/email/start` stays a `400` — email is not an OAuth platform and does not
  pretend to be one.
