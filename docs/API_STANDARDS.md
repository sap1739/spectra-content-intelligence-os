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

| Condition                                            | Status  | Notes                               |
| ---------------------------------------------------- | ------- | ----------------------------------- |
| Zod validation failure                               | 422     | field errors included               |
| `TenantIsolationError` (missing OR foreign resource) | 404     | identical body — no existence leaks |
| `ForbiddenError` (missing permission)                | 403     | names the permission                |
| Unknown route/method                                 | 404/405 | Nest defaults, problem+json body    |
| Unexpected exception                                 | 500     | opaque; logged with correlationId   |

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
