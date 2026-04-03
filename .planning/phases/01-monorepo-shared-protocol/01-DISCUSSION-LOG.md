# Phase 1: Monorepo & Shared Protocol - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md -- this log preserves the alternatives considered.

**Date:** 2026-04-03
**Phase:** 01-monorepo-shared-protocol
**Areas discussed:** Message Protocol, Monorepo Structure, Build Tooling, Dependencies

---

## Message Protocol - Message Types

| Option | Description | Selected |
|--------|-------------|----------|
| By function | chat/tool/session/system categories | |
| By direction | upstream/downstream/control | |
| Claude decides | Design based on research and best practices | Y |

**User's choice:** Claude decides
**Notes:** N/A

## Message Protocol - Envelope Structure

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal | seq + sessionId + type + payload | |
| With metadata | Add timestamp, source(proxy/client), version | Y |
| Claude decides | Design as needed | |

**User's choice:** With metadata
**Notes:** N/A

## Message Protocol - Streaming Granularity

| Option | Description | Selected |
|--------|-------------|----------|
| Complete message | Wait for full response then send | |
| Token-level streaming | Send each token, typewriter-style rendering | |
| Chunked streaming | Accumulate then send (e.g., every 100ms or per line) | |
| Claude decides | Balance performance and experience | |

**User's initial choice:** Complete message
**Clarification:** User initially chose "complete message" but after discussion about conflict with FEISHU-01 (real-time streaming output), refined to Agent SDK event-level granularity -- each SDKMessage event sent as a complete message. Not token-level (too much UI burden), not waiting for entire response (too slow). The user's reasoning: "event granularity should be enough."

## Message Protocol - Authentication

| Option | Description | Selected |
|--------|-------------|----------|
| Shared secret | Generate token on first connection | |
| Pairing code | Relay generates short code, mini program inputs to pair | |
| Claude decides | Design appropriate auth | Y |

**User's choice:** Claude decides
**Notes:** N/A

## Message Protocol - Error Handling

| Option | Description | Selected |
|--------|-------------|----------|
| Unified error message type | All errors via unified error type with code + description | Y |
| Embedded in response | Each message carries success/failure status | |
| Claude decides | Design as needed | |

**User's choice:** Unified error message type
**Notes:** N/A

---

## Monorepo Structure - Directory Layout

| Option | Description | Selected |
|--------|-------------|----------|
| Flat packages/ | packages/{shared,proxy,relay,feishu} | |
| apps/ + packages/ | apps/{proxy,relay,feishu} + packages/shared | Y |
| Claude decides | Design based on project characteristics | |

**User's choice:** apps/ + packages/ separation
**Notes:** Deployable apps separated from shared libraries

## Monorepo Structure - npm Scope

| Option | Description | Selected |
|--------|-------------|----------|
| @anthropic/cc-* | e.g., @anthropic/cc-shared | |
| @cc-anywhere/* | e.g., @cc-anywhere/shared | Y |
| Claude decides | Choose an appropriate scope | |

**User's choice:** @cc-anywhere/*
**Notes:** N/A

---

## Build Tooling - Build & Test

| Option | Description | Selected |
|--------|-------------|----------|
| tsup + vitest | Fast bundling, zero-config TypeScript test integration | Y |
| tsc + jest | Traditional stable combination | |
| Claude decides | Choose based on project needs | |

**User's choice:** tsup + vitest
**Notes:** Research recommended this combination

## Build Tooling - Lint & Format

| Option | Description | Selected |
|--------|-------------|----------|
| ESLint + Prettier | Standard combination, widely used | Y |
| Biome | Next-gen all-in-one, faster performance | |
| Claude decides | Choose appropriate tools | |

**User's choice:** ESLint + Prettier
**Notes:** N/A

---

## Dependencies - Shared Package Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Protocol only | Only zod schemas, types, constants -- pure contract layer | |
| Protocol + utils | Also include serialization, message builders | |
| Claude decides | Determine boundary based on actual needs | Y |

**User's choice:** Claude decides
**Notes:** N/A

## Dependencies - Dependency Direction

| Option | Description | Selected |
|--------|-------------|----------|
| Strict unidirectional | shared depends on nothing; proxy/relay/feishu depend only on shared | |
| Allow layered deps | feishu can depend on relay type exports | |
| Claude decides | Design reasonable dependency graph | Y |

**User's choice:** Claude decides
**Notes:** N/A

---

## Claude's Discretion

- Message type taxonomy and naming
- Shared package content boundary
- Package dependency graph
- Authentication mechanism design
- Zod schema organization

## Deferred Ideas

- Feishu mini program notification capability (notify when task completes, auto-mute when user returns to computer) -- Phase 10 (UX-03)
