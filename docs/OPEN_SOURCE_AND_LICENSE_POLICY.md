# Open Source & License Policy

## 1. Policy

1. All third-party code must carry a permissive license compatible with proprietary use:
   **MIT, Apache-2.0, BSD-2/3, ISC** are pre-approved.
2. **Copyleft (GPL/AGPL/SSPL) requires explicit review** before adoption; AGPL/SSPL network
   services may be used as _external services_ but their code is not vendored.
3. No copying code from restrictively licensed projects; all first-party code in this
   repository is original.
4. Every new dependency is justified: actively maintained, reasonable footprint, license
   verified at PR time (CI license-check job planned for Phase 2).
5. Generated assets must respect model/provider usage terms; per-source copyright metadata is
   retained through the research pipeline (see CITATION_AND_PROVENANCE.md).

## 2. Current dependency licenses (verified at adoption)

| Dependency                                                                                                     | License               |
| -------------------------------------------------------------------------------------------------------------- | --------------------- |
| next, react, react-dom                                                                                         | MIT                   |
| @nestjs/*                                                                                                      | MIT                   |
| fastify, @fastify/helmet, @fastify/rate-limit, @fastify/static                                                 | MIT                   |
| prisma, @prisma/client                                                                                         | Apache-2.0            |
| zod                                                                                                            | MIT                   |
| bullmq, ioredis                                                                                                | MIT                   |
| pino                                                                                                           | MIT                   |
| @aws-sdk/client-s3, s3-request-presigner                                                                       | Apache-2.0            |
| tailwindcss, @tailwindcss/postcss                                                                              | MIT                   |
| @tanstack/react-query                                                                                          | MIT                   |
| next-themes, clsx, tailwind-merge, class-variance-authority                                                    | MIT                   |
| lucide-react                                                                                                   | ISC                   |
| typescript, tsx, vitest, @playwright/test, turbo, eslint, prettier, typescript-eslint, unplugin-swc, @swc/core | MIT/Apache-2.0 family |
| sharp (libvips)                                                                                                | Apache-2.0            |
| @ffmpeg-installer/ffmpeg, @ffprobe-installer/ffprobe (**dev/test only**, see §3)                               | LGPL-2.1 (metadata)   |

Infrastructure images: postgres/pgvector (PostgreSQL License), redis:7 (BSD-3/RSAL — local
dev only; production uses a managed service), minio (AGPL-3.0 — **used as an unmodified
external service in local dev only**, never linked or vendored; production targets S3-
compatible managed storage).

## 3. Flagged future items

- **Remotion**: source-available with a company license requirement above a team-size
  threshold — commercial license review REQUIRED before Phase 3 adoption; the
  `CompositionRenderer` port keeps us swappable.
- **ffmpeg**: **adopted in Phase 7B as the video engine** (ADR-0041), on exactly the terms this
  entry set: invoked as a subprocess, and **no binary is vendored or shipped**. The worker resolves
  one from `FFMPEG_PATH` or `PATH`, so the build — and its licence — belongs to the deployment.
  Production should install an LGPL build or a system package.
  One discrepancy, recorded rather than hidden: the test suites use `@ffmpeg-installer/ffmpeg` and
  `@ffprobe-installer/ffprobe` so they can encode real video. Their npm metadata says LGPL-2.1, but
  the macOS binary the former carries reports `--enable-gpl --enable-nonfree`. They are
  **devDependencies only**, never bundled into any app, and nothing in `apps/*` depends on them at
  runtime. Review before any change that would ship them.
- Social platform SDKs: verify per-platform developer terms at Phase 4.

## 4. This repository

`license: UNLICENSED` (proprietary) — private product code. Contributions are internal;
Conventional Commits required.
