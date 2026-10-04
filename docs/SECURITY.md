# Security

Threat-informed standards for the platform. Items marked **[P1]** are implemented in this
foundation; others are designed and land with their features.

## 1. Tenant isolation **[P1]**

- Every tenant-owned row carries `organizationId`/`workspaceId`; services call
  `assertTenantOwnership` which throws the **same** error for missing and foreign resources —
  guessed UUIDs cannot probe existence.
- Prisma tenant-guard extension blocks unscoped multi-row queries (defence in depth).
- Object storage keys are tenant-rooted (`org/<id>/ws/<id>/…`) and validated by
  `assertKeyWithinTenant` before any read/write/signing.
- Vector retrieval requires tenant scope on every call (port-enforced).
- Worker jobs carry tenant scope in `JobEnvelope`; handlers re-assert before touching data.
- Caches (Phase 2+) must namespace keys by tenant; audit logs are tenant-scoped rows.
- Analytics queries always aggregate within a tenant scope.

## 2. Authentication & authorization **[P2]**

First-party session auth (ADR-0014): scrypt password hashing, opaque Redis sessions,
httpOnly SameSite=Lax cookies, per-request principal rebuild (instant revocation),
enumeration-safe login. Guard chain on every route: origin check → principal → tenant
context → permissions.

Permission-oriented: 33 permissions bundled into 13 roles (`ROLE_PERMISSIONS`), plus explicit
per-membership grants. Organization budget controls (`org:budget:read`, `org:budget:manage`,
`org:usage:read`) are deliberately absent from workspace-scoped bundles — a workspace admin can
see and set their own ceiling, but cannot read or raise the organization-wide one. Checks test permissions only. Client Reviewer/Read Only bundles are
minimal by construction (unit-tested).

Budget and metering tables (`UsageEvent`, `WorkspaceBudget`, `OrganizationBudget`,
`BudgetOperationLimit`, `BudgetReservation`) are tenant-guarded, so an un-scoped multi-row query
throws. Reservation settlement is addressed by tenant **and** idempotency key — a key alone never
identifies a hold, and a key resolving to another tenant's reservation is refused (ADR-0029). The
one cross-tenant statement is the expiry sweep, which is raw, documented, and reads no tenant
content.

## 3. Secrets & credentials

- **[P1]** No hard-coded secrets; env validated at boot; local dev credentials only in
  `.env.example`/compose. `.env*` gitignored.
- OAuth/social tokens: AES-256-GCM via `encryptSecret` with a **key ring** —
  `v1.<keyId>.<iv>.<tag>.<ct>`; rotation = new active key, old ciphertexts stay decryptable
  until re-encrypted **[P1]**. Keys come from a secret manager in production.
- The ring is configured, not hard-coded (Phase 6C): `SOCIAL_TOKEN_ENCRYPTION_KEY` +
  `SOCIAL_TOKEN_ENCRYPTION_KEY_ID` (active) and `SOCIAL_TOKEN_ENCRYPTION_RETIRED_KEYS`
  (decrypt-only). Boot rejects a key that is not 32 bytes, a malformed retired entry, or a retired
  id equal to the active one — naming the variable, never the value. See §14 for the runbook.
- Raw tokens never reach DB rows, logs or API responses: credentials are stored only sealed
  (`encryptedToken`, `encryptedCredential`, `encryptedCodeVerifier`), and those columns are never
  selected into a response.

## 4. Logging hygiene **[P1]**

pino redaction (`MANDATORY_REDACT_PATHS`) + `deepRedact` for manual serialization. Never
logged: passwords, access/refresh tokens, payment data, encryption keys, uploaded document
content, sensitive prompt content. Redaction is unit-tested (20 regression cases in
`packages/logging/src/redaction.test.ts`).

Phase 6B widened the path list to close gaps a real incident would have exposed:

- **Header casing.** `Authorization`, `X-Api-Key`, `Cookie` and `Set-Cookie` are redacted in every
  casing and at both `req.headers.*` and bare `headers.*` — a single unmatched casing is a token in
  a log line.
- **Credential shapes**, not just the word "token": `applicationPassword`, `encryptedToken`,
  `sessionToken`, `passwordHash`, `privateKey`, `clientSecret`.
- **Model input and output**: `prompt`, `prompts`, `completion`, `messages`, `instructions`. Model
  I/O is customer content and third-party document text; it does not belong in a log.
- **Extracted content**: `extractedText`, `rawHtml`, `body.content`.
- **Payment fields**: `cvv`, `cardCvc`, `iban`.

## 5. Web application threats

| Threat        | Control                                                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSRF          | `SameSite=Lax` session cookies + Origin allow-list check on all mutations **[P2]**; double-submit tokens tracked as further hardening                                                                |
| XSS           | React escaping; no `dangerouslySetInnerHTML`; CSP on web app; API is JSON-only **[P1 partial]**                                                                                                      |
| SQL injection | Prisma parameterized queries; no string-built SQL **[P1]**                                                                                                                                           |
| SSRF          | Research fetchers (Phase 2): URL allow/deny evaluation, no private-IP ranges, no redirects to internal hosts; HTML-to-image renders only sandboxed templates, never arbitrary URLs **[P1 contract]** |
| Upload abuse  | MIME allow-lists + size caps per storage domain, filename sanitization, malware-scan port gating availability **[P1]**                                                                               |
| Signed URLs   | Short-lived (15 min default), content-type-bound uploads **[P1]**                                                                                                                                    |
| Webhooks      | Signature verification before parsing; idempotency keys; raw payloads quarantined to storage **[P1 contract]**                                                                                       |
| Rate limiting | Global per-IP + per-email+IP login throttle (429) **[P2]**; per-tenant keys at deployment                                                                                                            |

## 6. AI-specific risks

- **Prompt injection**: scanner + isolation wrapper + instruction/data separation — see
  [PROMPT_INJECTION_DEFENCE.md](PROMPT_INJECTION_DEFENCE.md) **[P1]**.
- **Malicious source content**: extraction runs injection scanning; HIGH/CRITICAL content is
  quarantined/blocked before any LLM contact **[P1 primitive]**.
- **Misinformation**: claim verification statuses, `misinformationRisk` scoring penalty,
  evidence floors, mandatory human review before approval.
- **Copyright**: per-source license/rights metadata retained; snapshots stored for
  verification, not republication; attribution requirements surfaced at generation time.
- **Impersonation / voice & likeness consent**: TTS contract requires `voiceConsentRef` for
  cloned voices; adapters must reject requests without verified consent **[P1 contract]**.
- **Regulated-industry claims**: vertical `regulatoryConsiderations` feed `complianceRisk`
  penalties and force review flags.
- **AI content labelling**: `PublishRequest.aiContentDisclosure` propagates platform
  disclosure flags; generation records (model/prompt versions) are retained for audit.
- **Platform policy compliance**: capability-gated publishing; official APIs only.

## 7. Data lifecycle

- **Audit trails [P1]**: append-only `audit_logs` with actor, action, resource, correlation
  id, redacted change sets.
- **Retention**: per-tenant retention windows for research snapshots and logs (Phase 3).
- **Deletion**: account/tenant deletion cascades DB rows, storage prefixes and vectors
  (`deleteByTenant` ports exist **[P1]**).
- **Export**: tenant data export job producing a signed archive (Phase 3).
- **Backup/recovery**: managed Postgres PITR + object-store versioning in production
  (documented in [DEPLOYMENT_STRATEGY.md](DEPLOYMENT_STRATEGY.md)).

## 8. Reporting

Security issues: open a private GitHub security advisory on the repository. Do not file
public issues for vulnerabilities.

## 9. Crawler conduct (Phase 5F, ADR-0030)

Discovered pages are fetched from sites we have no relationship with, so the pipeline asks before
it crawls:

- **robots.txt is checked before every discovered-page fetch**, and a disallowed page is never
  retrieved. There is no bypass or override path.
- Failure to retrieve robots.txt is recorded as `UNAVAILABLE`, not `ALLOWED` — proceeding under
  convention is not the same as having permission, and the record says which happened.
- Fetching is bounded: total in-flight fetches are capped and requests to one host are spaced,
  honouring `Crawl-delay`. A run cannot hammer a single site.
- SSRF protection (`safeFetch`: DNS resolution checks, redirect caps, byte limits, timeouts)
  applies to robots.txt retrieval exactly as it does to page fetches.
- The robots cache stores only public crawl rules, keyed by origin, and holds no tenant data — it
  is deliberately shared across tenants because it describes the remote site, not any workspace.

## 10. Document handling **[P1]**

Document extraction (ADR-0031) accepts untrusted binary input, so its defences are layered:

- **Limits before parsers.** A MIME allow-list (PDF, DOCX, TXT, Markdown) and per-type size caps
  are enforced before any bytes reach a parser — the parser is the largest attack surface here.
  Legacy binary `.doc` is rejected explicitly rather than fed to the OOXML parser.
- **Path traversal.** Filenames are stripped of every directory component and of control
  characters before being used in labels or logs, so a crafted name such as `../../etc/passwd`
  can never become a path segment.
- **SSRF.** Documents are fetched through the same `safeFetch` as web pages (DNS resolution
  checks, redirect caps, byte limits, timeouts). Document links are not followed.
- **Prompt injection.** Extracted text is scanned and wrapped as untrusted content (see
  PROMPT_INJECTION_DEFENCE.md).
- **Logging.** Extracted document text is never logged. Parser error messages are replaced with
  generic ones because they can echo document content.
- **Tenancy.** Extraction is invoked with the run's tenant scope; extracted text and chunks are
  written under that workspace only and never cross tenants.

Remaining gap: the third-party parsers (`unpdf`, `mammoth`) are not sandboxed. Size and MIME
limits bound the exposure; process isolation would be the next hardening step if untrusted
document volume grows.

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

## 12. Telemetry egress **[P1]** (Phase 6B, ADR-0033)

Tracing is the one subsystem whose job is to copy internal state to a third party, so it is
governed more tightly than logging.

- **Off unless configured.** With no `OTEL_EXPORTER_OTLP_ENDPOINT` the OpenTelemetry SDK is never
  loaded and nothing is exported. A deployment cannot start leaking telemetry because a config
  template had a placeholder endpoint in it.
- **Span attributes are an ALLOW-LIST**, not a deny-list (`ALLOWED_SPAN_ATTRIBUTES` in
  `@spectra/telemetry`). A deny-list fails open: the first attribute nobody remembers to add ships
  to the vendor. `safeSpanAttributes()` drops anything not on the list, drops objects and arrays
  whole (payloads hide there), and truncates strings to 256 characters. Adding an attribute is a
  deliberate edit to that list, and that friction is intentional.
- **Identifiers, never content.** Organization and workspace ids may be exported so a trace can be
  correlated with a support request; prompts, documents, credentials and payloads cannot get on
  the list at all.
- **`OTEL_EXPORTER_OTLP_HEADERS` is a secret** (it usually carries collector auth). It is validated
  like any other env value and never echoed — `EnvValidationError` reports key names only.
- **Metrics carry no identifiers.** HTTP metrics are labelled by route PATTERN
  (`/v1/workspaces/:workspaceId/...`), never the resolved URL, so no id or query string reaches a
  metrics backend. `GET /v1/meta/metrics` is unauthenticated for scraping and is safe for that
  reason; a deployment that treats route names and traffic shape as sensitive should restrict it at
  the ingress.
- **Readiness bodies are credential-free.** `/health/ready` is typically unauthenticated, so
  component details carry counts and states only — no endpoint, bucket, key or connection string.

## 13. Operator actions **[P2]** (Phase 6B, ADR-0033)

The operations dashboard can re-run customer work, so it is permissioned and audited.

- **Two permissions, not one.** `ops:read` lists queue state and failures; `ops:retry` re-runs a
  job. Reading is not authorization to act.
- **Tenant scope fails closed.** A failed job whose envelope records no tenant is excluded from
  every tenant-scoped listing — showing an unattributed job to a tenant that may not own it is the
  worse error.
- **No existence leak.** Retrying another tenant's job and retrying a job id that never existed
  both return 404. Ownership is checked before the retry, not after.
- **Retry re-runs the ORIGINAL job.** The job keeps its id, so its idempotency key holds and the
  executor's budget pre-flight (ADR-0029) runs again. An operator cannot use retry to bypass a
  budget or duplicate a publish.
- **Failure reasons are surfaced; payloads are not.** The listing carries a truncated error message
  and one identifying resource id, never the job payload.
- **Every retry is audited** as `ops.job.retried` with the actor, tenant and job id.

## 14. OAuth token brokering **[P1]** (Phase 6C, ADR-0034)

The OAuth callback is a URL anyone can craft and send a signed-in user to, and the token endpoint
is called with a client secret and a single-use code. Both are treated accordingly.

**State and CSRF**

- `state` is 32 random bytes; only its SHA-256 is stored.
- It is **single-use**: consumed by one atomic `UPDATE … WHERE consumedAt IS NULL`. A second
  callback with the same state is a replay — rejected with no token exchange and audited as
  `social.oauth.replay_rejected`.
- It **expires** after `SOCIAL_OAUTH_STATE_TTL_SECONDS` (default 600, bounded 60–1800).
- It is **bound to the user who started the flow**. The callback requires that user's session; a
  state presented by anyone else — including another member of the same organization — is
  rejected and audited (`user_mismatch`), and stays usable by its owner. This is the login-CSRF
  defence: an attacker cannot get their account attached to a victim's workspace.
- Starting a flow is a `POST` behind the Origin check (§5). The callback is a `GET` and relies on
  the state binding. It needs the `SameSite=Lax` session cookie to arrive on the platform's
  top-level redirect — **do not tighten that cookie to `Strict`**, or every callback fails.
- `social:connect` is re-checked at the callback; losing it mid-flow yields `forbidden`.

**PKCE** — S256 whenever the platform accepts it (required for X); `plain` is never used. The
verifier is sealed at rest.

**Redirect allow-list**

- The OAuth `redirect_uri` is computed from `SOCIAL_OAUTH_REDIRECT_BASE_URL` and a fixed path per
  platform. No endpoint accepts one from a caller.
- The browser is returned only to `WEB_APP_URL`, which boot validation requires to be one of
  `API_CORS_ORIGIN`, plus a path from `OAUTH_RETURN_PATHS`.
- The callback appends one outcome code from a fixed enum. The web app renders fixed copy for known
  codes and ignores anything else; provider `error_description` is never reflected.
- In production every OAuth URL — redirect base and any endpoint override — must be https.

**Token handling**

- Access and refresh tokens are stored as **one sealed bundle**; a flow is refused before consent
  when `SOCIAL_TOKEN_ENCRYPTION_KEY` is missing, so no token is ever held unsealed or discarded
  after a user approved it.
- The token client refuses redirects (a redirect would re-send the secret and code elsewhere),
  times out, and reports errors as platform + HTTP status + provider error code only.
- Log redaction covers `access_token`, `refresh_token`, `id_token`, `client_secret`,
  `code_verifier`, `codeVerifier`, `encryptedCredential`, `encryptedCodeVerifier`,
  `authorizationCode`, and the callback's `query.code`/`query.state` (regression-tested).
- Unexpected callback failures log the error **name** only — a database error message can quote
  the values it was given.
- Client secrets never appear in a response, a URL or a log. Missing configuration is reported by
  environment-variable **name**.

**Tenant isolation** — `SocialConnection`, `SocialOAuthAttempt` and (now) `SocialAccount` are in
the tenant guard. The callback's lookup is scoped to the caller's own organizations; every
connection route is workspace-scoped, and a foreign connection returns the same 404 as a missing
one.

**Audit** — `social.oauth.started`, `.denied`, `.failed`, `.state_rejected`, `.replay_rejected`,
`social.connection.created`, `.reconnected`, `.refreshed`, `.refresh_failed`, `.disconnected`.
Change sets carry platform, scopes, outcome and key id — never a token.

**Disconnect** asks the platform to revoke where it has a standard endpoint and reports the result
(`REVOKED`/`NOT_SUPPORTED`/`FAILED`/`SKIPPED`), then deletes the stored credential regardless.
Where revocation is unsupported (LinkedIn, the Meta family) the user is told to remove access in
the platform's own settings.

**Key rotation runbook**

1. Generate a key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. In the API **and** the worker set `SOCIAL_TOKEN_ENCRYPTION_KEY=<new>`,
   `SOCIAL_TOKEN_ENCRYPTION_KEY_ID=social-v2`, and
   `SOCIAL_TOKEN_ENCRYPTION_RETIRED_KEYS=social-v1:<old>`. Deploy both.
3. New credentials seal under `social-v2`; old ones stay readable. Every refresh or reconnect
   re-seals a connection under the active key.
4. Track progress: `credentialKeyId = 'social-v1'` on `social_connections` and `social_accounts`.
5. When no row still uses the old id, remove it from `SOCIAL_TOKEN_ENCRYPTION_RETIRED_KEYS`.
   Removing it earlier makes those credentials unreadable — refresh reports `FAILED` and the
   connection needs reconnecting.

A bulk re-seal job for long-idle rows is not built yet; today rotation advances on write.

## 15. LinkedIn publishing **[P1]** (Phase 6D, ADR-0035)

- **Official APIs only.** No scraping, no browser automation, no credential that is not an OAuth
  grant the member approved.
- **The upload URL is checked before bytes or token go to it.** The Images API returns an upload
  URL and requires the bearer token on the PUT; the client sends nothing unless it is
  `https://*.linkedin.com` (or the configured API origin — how tests reach a local stand-in).
- **Tokens are opened in the worker, in memory, for one publish.** A refreshed token is re-sealed
  under the active key before it is stored. Failure reasons carry LinkedIn's status, error code and
  a trimmed message — never a token (regression-tested).
- **No cross-tenant publishing, even from a bad row.** The executor refuses an account whose
  organization or workspace differs from the entry's, and media is read only through a key checked
  against the entry's tenant (`assertKeyWithinTenant`).
- **Data minimisation.** OpenID Connect `userinfo` returns the member's email; it is not stored.
  Discovery metadata is allow-listed primitives only.
- **Honest outcomes.** A 401 marks the connection `REAUTH_REQUIRED` and stops further attempts
  before they reach LinkedIn. A timeout after a post request was sent is `AMBIGUOUS` — the reason
  says the post may exist, so an operator checks before publishing again rather than creating a
  duplicate.

## 16. Meta publishing **[P1]** (Phase 6E, ADR-0036)

- **Official Graph API only**, every call signed with `appsecret_proof` (HMAC-SHA256 of the token,
  keyed by the app secret). The token travels as the documented `access_token` parameter; request
  URLs are never logged, redirects are refused, and failure reasons carry Meta's status, code,
  subcode and a trimmed message with the token scrubbed out (regression-tested).
- **Token requests follow Meta's documented GET.** The client secret is in the query string of the
  token request only — sent straight to Meta over TLS and never logged. Everywhere else it stays
  out of URLs.
- **Page tokens never expire, so they are handled as the most sensitive credential here.** Each is
  sealed into its account's `encryptedToken` (with `credentialKeyId`, so key rotation finds it) the
  moment discovery returns it, is never selected into an API response, is cleared when Meta stops
  issuing it (a lost role), and is deleted when the account is retired or the connection
  disconnected.
- **Short-lived grants are refused, not stored.** If the long-lived exchange fails, the callback
  stores nothing.
- **Signed media links are narrow.** Instagram requires a public image URL: Spectra issues a
  15-minute presigned GET for one object whose key is checked against the entry's tenant, and only
  when storage is reachable from the internet. The image is about to be published publicly.
- **Discovery cannot plant accounts on other platforms.** A connection accepts destinations only on
  platforms declared for it (`FACEBOOK → FACEBOOK, INSTAGRAM`).
- **Data minimisation.** No email is requested. Discovery metadata is allow-listed primitives
  (Page category, tasks, linked Page id, Instagram username) — never a token or a raw payload.
- **Honest outcomes.** Error 190 marks the connection `REAUTH_REQUIRED` and later attempts stop
  before reaching Meta. A Facebook post whose request went unanswered is `AMBIGUOUS`; an Instagram
  container Meta reports `PUBLISHED` is never published again.

## 17. YouTube publishing **[P1]** (Phase 6F, ADR-0037)

- **Official Data API v3 only.** The access token travels in the Authorization header and never in
  a URL; redirects are refused; every call times out; error messages carry Google's status and
  `reason` with the token scrubbed out (regression-tested).
- **The resumable session URI is a capability and is treated as one.** Whoever holds it can write
  to that upload, so it is sealed with the social key ring (`encryptedUploadUrl` +
  `credentialKeyId`), never logged, and deleted the moment the upload finishes or fails.
- **Bytes and token go only where Google said.** The session URI returned in the `Location` header
  is checked against the API origin (or `*.googleapis.com`) before anything is sent to it, and the
  same check runs again on a stored session before a resume.
- **Uploads stay inside the tenant.** The video and the thumbnail are read through
  `assertKeyWithinTenant`, and an entry pointing at another tenant's account or asset publishes
  nothing.
- **Signed upload links are narrow.** A media-upload ticket signs ONE key derived from the ticket
  id inside the caller's own tenant prefix, lasts 15 minutes, and registers an asset only after
  storage confirms the object — with the size and content type storage reports, never the client's
  claim.
- **Honest outcomes.** A 401 marks the connection `REAUTH_REQUIRED` and later attempts stop before
  reaching Google. A quota refusal is `QUOTA`, not a generic failure. A video YouTube forced
  private is reported as published AND private, quoting Google's restriction — never as the public
  post that was asked for.

## 18. TikTok, X, Threads and Pinterest **[P1]** (Phase 6G, ADR-0038)

- **Official APIs only**, each over TLS with the token in an Authorization header (TikTok, X,
  Pinterest) or the documented `access_token` parameter (Threads). Request URLs are never logged,
  redirects are refused, every call times out, and each error message carries the platform's own
  code with the token scrubbed out (regression-tested per adapter).
- **TikTok's signed upload URL is a capability**, so it is sealed with the social key ring, dropped
  when the publish ends, and checked against a TikTok host before any bytes go to it. The access
  token is deliberately NOT sent with the upload: the URL is the authorization.
- **One publish, once.** TikTok's `publish_id`, Threads' container id and X's media id are recorded
  before the irreversible step, so a retry asks the platform what happened rather than sending
  again.
- **Signed media links stay narrow.** Threads and Pinterest fetch images from a 15-minute presigned
  GET for one tenant-checked key, offered only when storage is internet-reachable.
- **Scope and audit gates are enforced before a request**, not after a refusal: a TikTok grant
  without `video.publish`, an X grant without `media.write` for an image, a Threads grant without
  `threads_content_publish`, a Pinterest grant without `pins:write`.
- **Email sends nothing.** Rather than ship an ESP adapter without consent records, unsubscribe
  handling, suppression lists and domain authentication, EMAIL stays unwired and says so — a
  capability that could send mail an operator is not allowed to send is worse than none.

## 19. External analytics **[P1]** (Phase 6H, ADR-0039)

- **Same credential boundary as publishing.** Analytics providers are built per account from the
  connection's sealed token (`openConnection`, shared with the publisher resolver), the Page token
  sealed on a Meta account, or the WordPress application password. Decrypted secrets never leave the
  resolver; a rejected token marks the connection `REAUTH_REQUIRED`, as publishing does.
- **Nothing sensitive is stored.** Snapshots keep normalized metrics and allow-listed provider
  metadata only: `sanitizeProviderMetadata` drops non-primitives, keys that look like tokens, URLs,
  emails or phone numbers, long opaque strings and anything containing `Bearer` or a URL — once in
  the adapter result and again at write. Run errors pass `sanitizeErrorMessage` (bounded, tokens and
  `access_token=` scrubbed). The integration suite searches every stored snapshot and run for the
  test token marker.
- **No personal content ingested.** Comment and reaction **counts** only; comment text, commenter
  identities and demographics are never requested.
- **Scopes decided before calls.** A metric whose scope was not granted is `MISSING_SCOPE` without a
  request; analytics scopes are not added to default scope lists.
- **Tenant isolation.** All three analytics tables are tenant-guarded; every API read filters by
  organization and workspace; a foreign id is the same `404` as a missing one; the cross-tenant
  dispatcher scan is raw SQL returning ids only. Tested for runs, accounts, entries, campaigns and
  content items.
- **Permissions.** Reading is `analytics:read`; starting a sync (which spends platform quota, and
  could spend money on a paid provider) is the separate `analytics:sync`, and goes through the
  `ANALYTICS_SYNC` budget pre-flight before any provider is called.

## 20. Design studio **[P2]** (Phase 7A, ADR-0040)

- **No user markup reaches a renderer.** Templates are layout **data** (normalized boxes, colour
  roles, fields), validated by `templateLayoutSchema` + `validateTemplateLayout` before storage. The
  only SVG libvips parses is the rectangles Spectra generates itself, and every user string is
  escaped before Pango sees it. There is no HTML-to-image path here, so there is no browser to
  sandbox and no URL to fetch: the renderer reads bytes from tenant storage and nothing else.
- **Tenant isolation.** `DesignTemplate`, `Design` and `DesignRender` are tenant-guarded; every
  export is written under `org/<id>/ws/<id>/renders/…` and every read filters by organization and
  workspace. A foreign or missing template, design, render, brand or media asset returns the same
  `404`. A logo, font or image asset from another workspace is refused at kit-save time **and**
  again at render time — the render never trusts an id it was handed.
- **Upload policy unchanged.** Logos and images must be PNG/JPEG/WebP and fonts TTF/OTF, checked by
  the existing storage validation (MIME and size). **SVG is refused as a logo**: it is markup, and
  accepting it would reintroduce the parser this design avoids. Exports are validated on the way
  back in, like any other file.
- **Downloads are signed and short-lived.** An export is served by a 15-minute signed URL; the
  preview endpoint streams bytes with `cache-control: private, no-store` and is never cached.
- **Resource bounds.** A layout is capped at 40 layers per page, text fields carry length limits,
  and output sizes come from a fixed catalog — a request cannot ask for an arbitrary canvas. Every
  export takes a `MEDIA_RENDER` budget pre-flight for its page count before any pixels are drawn,
  so rendering work can be capped per workspace.
- **Permissions.** Reading is `design:read`, creating/editing/exporting is `design:write`, and
  approving reuses `content:approve` — the same permission that approves content, so approval
  authority is not quietly duplicated. The calendar refuses to schedule an export whose design is
  not approved, and a successful publish moves the design to PUBLISHED within that tenant only.
- **Nothing is generated.** No image-generation provider is wired, and the API's capability response
  says so. Brand `visualStyle` is guidance shown to an operator, never a prompt sent anywhere.

## 21. Video rendering **[P1]** (Phase 7B, ADR-0041)

Video rendering runs an **external binary on user-influenced input**, which is a sharper threat
model than anything before it in this codebase. Four properties contain it.

- **No user string ever reaches a shell.** ffmpeg is spawned with an argument **array** — never a
  shell string, never `shell: true`. There is no interpolation point for an injected command.
- **No user text ever reaches the filtergraph.** Scene text is written to files and referenced with
  `textfile=`; captions go to an SRT referenced by `subtitles=filename=`. The generated filtergraph
  contains only numbers, schema-validated hex colours, and paths Spectra itself created — and a
  unit test asserts that a storyboard whose text is `evil':drawtext=fontfile=/etc/passwd:…` produces
  a graph containing neither `/etc/passwd` nor the payload. Paths are escaped by one function.
- **The engine never fetches anything.** Inputs are read from object storage **by the job**, under
  the tenant scope, and handed to ffmpeg as local files in a per-render temp directory that is
  removed in a `finally`. ffmpeg is given no URL and needs no network access, so there is no SSRF
  surface in the encoder.
- **A render cannot run forever.** Every encode has a wall-clock timeout and an abort signal that
  **kills the process** (SIGKILL), rather than abandoning it. Inputs are probed before the encode
  because ffmpeg handed a corrupt looped image waits indefinitely — a denial-of-service shape that
  would otherwise consume a worker slot for the full timeout.

Beyond those:

- **Tenant isolation.** `VideoProject` and `VideoRender` are tenant-guarded; every asset a storyboard
  references is re-read under the tenant scope at render time rather than trusted from the stored
  JSON, so a foreign id fails as unavailable and is never fetched. Outputs are written under
  `org/<id>/ws/<id>/renders/…`, and the download path re-checks the key against the tenant prefix
  before signing. A foreign or missing project, render or asset is the same `404`.
- **Resource bounds.** A storyboard is capped at 60 scenes, a scene at 60s, text at 280 characters,
  and output sizes come from a fixed catalog — a request cannot ask for an arbitrary canvas or an
  unbounded duration. Each format carries its own duration ceiling, and a `MEDIA_RENDER` budget
  pre-flight runs before a job is queued. Concurrency is capped at two renders per worker.
- **Bounded failure detail.** Engine output is reduced to its last meaningful line and truncated to
  500 characters, so a failure note never becomes a log dump or carries a path-rich stack.
- **Permissions.** Reading is `video:read`; creating, rendering and cancelling is `video:write`.
- **Nothing is generated, and nothing is sent anywhere.** No generative-video provider is wired, and
  no prompt, script or asset leaves the deployment — the whole pipeline is local.

## 22. Audio, voices and consent **[P1]** (Phase 7C, ADR-0042)

Audio introduces a category of harm the earlier media phases did not: a cloned voice is a **person's
likeness**, and a clip that should never have existed cannot be recalled once published. The
controls are correspondingly strict.

- **No voice is used without consent, and the gate cannot be bypassed.** A `CLONED` voice is
  unusable unless a consent record is `GRANTED`, unexpired, not revoked, and scoped to the use.
  Absence of information is never read as permission: a missing record blocks. The clock and the
  revocation timestamp override the stored status, so a stale row cannot become permission. The gate
  runs three times — in the editor, when a render is queued, and **again in the worker against the
  database**, so a revocation stops a render that was already queued. Full policy:
  `VOICE_CONSENT_POLICY.md`.
- **Consent is a separate permission.** Recording or revoking it needs `voice:consent`, not
  `audio:write`: someone who assembles episodes must not be able to assert that a person agreed to
  be cloned. Every grant and revocation is audit-logged with the actor, the subject, the scopes and
  the expiry. Consent is always time-boxed — an open-ended grant is not offered.
- **A cloned voice must name its subject**, at the schema level. A voice whose subject is unknown
  cannot be created, so it cannot be used.
- **Nothing is synthesised, and nothing leaves the deployment.** No speech, audio or music provider
  is implemented; a script needing one is refused with `TTS_NOT_CONFIGURED` before a job exists. No
  script text, no audio and no prompt is sent anywhere.
- **Host notes never reach the audio.** They are production direction: never spoken, never written
  into the file, never published. An integration test reads the finished MP3's bytes to confirm it.
- **Transcripts cannot overclaim.** `source` is `SCRIPT_DERIVED` at best — the words come from the
  script and the timings from the measured mix. Nothing listened to the audio, and an uploaded clip
  produces no cues rather than invented ones.
- **Same process containment as video.** ffmpeg is spawned with an argument array (never a shell
  string); no user text enters a filtergraph; inputs are read from object storage by the job, under
  the tenant scope, and handed over as local files, so the engine fetches nothing; every encode has
  a timeout and an abort signal that kill the process; engine output is bounded to 500 characters.
- **Tenant isolation.** `VoiceProfile`, `VoiceConsentRecord`, `PodcastEpisode`, `Transcript` and
  `AudioRender` are tenant-guarded. Every referenced asset is re-read under the tenant scope at
  render time rather than trusted from stored JSON. Outputs are written under
  `org/<id>/ws/<id>/renders/…` and the download path re-checks the key before signing. A foreign or
  missing voice, episode, render or asset is the same `404`.
- **Resource bounds.** 100 segments per script, 20 000 characters per spoken segment, 30s per
  silence, and a `MEDIA_RENDER` budget pre-flight before a job is queued.
