# ADR-0008: S3-compatible object storage with MinIO locally

**Status:** Accepted · **Date:** 2026-07-05

## Context

Snapshots, documents, media and renders need durable object storage with signed URLs, local
parity and tenant separation.

## Decision

Provider-neutral `ObjectStorageProvider` port with a single S3-compatible implementation
(`@aws-sdk/client-s3` + presigner). MinIO in Docker for local dev; any S3-compatible managed
store in production.

## Rationale

- The S3 API is the de-facto standard; one implementation covers MinIO/AWS/R2/GCS-interop,
  so "provider-neutral" is achieved by protocol rather than N adapters.
- Presigned PUT/GET URLs keep large payloads off the API; content-type and length are bound
  into upload signatures.
- MinIO is AGPL but consumed strictly as an unmodified external service in local dev
  (see OPEN_SOURCE_AND_LICENSE_POLICY.md).

## Consequences

- Keys are tenant-rooted (`org/<orgId>/ws/<wsId>/<domain>/<resourceId>/<file>`) and validated
  by `assertKeyWithinTenant`; per-domain MIME/size policies enforce upload hygiene.
- `MalwareScanProvider` is the integration point gating untrusted uploads before use;
  a real engine must be wired before production accepts public uploads.
