# ADR-0003: NestJS on Fastify for the API

**Status:** Accepted · **Date:** 2026-07-05

## Context

The API needs domain-modular structure, OpenAPI, validation, guards/interceptors and a
long-lived team-scalable shape. Options: NestJS (Express/Fastify), plain Fastify, Hono,
tRPC-first.

## Decision

NestJS 11 with the Fastify adapter; REST + OpenAPI via @nestjs/swagger; Zod validation
through a custom `ZodValidationPipe`; problem+json via a global exception filter.

## Rationale

- Nest's module/DI system matches the domain-oriented package layering and keeps framework
  code out of domain packages.
- Fastify adapter for performance and its hook system (correlation ids, rate limiting,
  helmet) over Express.
- REST + OpenAPI chosen over tRPC because external/API-client consumers are a product goal;
  contracts already live in Zod and are reused for validation.
- Class-validator is deliberately NOT used — Zod contracts are the single validation source.

## Consequences

- Decorator metadata requires SWC transform in Vitest (unplugin-swc) — configured.
- `createApp()` is shared by main.ts and integration tests so tests exercise the real
  middleware stack via fastify inject.
