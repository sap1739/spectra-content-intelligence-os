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

Permission-oriented: 30 permissions bundled into 13 roles (`ROLE_PERMISSIONS`), plus explicit
per-membership grants. Checks test permissions only. Client Reviewer/Read Only bundles are
minimal by construction (unit-tested).

## 3. Secrets & credentials

- **[P1]** No hard-coded secrets; env validated at boot; local dev credentials only in
  `.env.example`/compose. `.env*` gitignored.
- OAuth/social tokens: AES-256-GCM via `encryptSecret` with a **key ring** —
  `v1.<keyId>.<iv>.<tag>.<ct>`; rotation = new active key, old ciphertexts stay decryptable
  until re-encrypted **[P1 primitive]**. Keys come from a secret manager in production.
- `TokenVaultPort` ensures raw tokens never reach DB rows, logs or API responses.

## 4. Logging hygiene **[P1]**

pino redaction (`MANDATORY_REDACT_PATHS`) + `deepRedact` for manual serialization. Never
logged: passwords, access/refresh tokens, payment data, encryption keys, uploaded document
content, sensitive prompt content. Redaction is unit-tested.

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
