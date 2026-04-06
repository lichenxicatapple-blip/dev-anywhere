---
phase: "04"
plan: "02"
subsystem: relay-server
tags: [websocket, relay, express, zod, bidirectional-forwarding]
dependency_graph:
  requires: [01-02]
  provides: [relay-server, relay-control-schema, proxy-registry]
  affects: [04-03]
tech_stack:
  added: [ws, express, pino, nanoid]
  patterns: [noServer-ws-upgrade, discriminatedUnion-control-schema, registry-pattern]
key_files:
  created:
    - packages/shared/src/schemas/relay-control.ts
    - packages/shared/src/schemas/__tests__/relay-control.test.ts
    - apps/relay/vitest.config.ts
    - apps/relay/src/registry.ts
    - apps/relay/src/router.ts
    - apps/relay/src/handlers/proxy.ts
    - apps/relay/src/handlers/client.ts
    - apps/relay/src/health.ts
    - apps/relay/src/server.ts
    - apps/relay/src/__tests__/registry.test.ts
    - apps/relay/src/__tests__/router.test.ts
    - apps/relay/src/__tests__/server.test.ts
  modified:
    - packages/shared/src/index.ts
    - apps/relay/package.json
    - apps/relay/src/index.ts
    - pnpm-lock.yaml
decisions:
  - "RelayControlSchema as separate discriminatedUnion from MessageEnvelope for transport-level control"
  - "ws noServer with URL pathname routing for dual /proxy and /client endpoints on single HTTP server"
  - "Registry pattern with Map-based proxy and client binding storage"
metrics:
  duration: 8min
  completed: "2026-04-06T07:28:32Z"
  tasks: 3
  files: 15
  tests_added: 34
---

# Phase 04 Plan 02: Relay Server Core Transport Summary

Relay server with dual WebSocket endpoints, zod-validated message forwarding, proxy registry, and heartbeat lifecycle.

## What Was Built

### Task 1: Relay control schemas and registry module (aa7c7eb)

Created `RelayControlSchema` in shared package with 5 control message types (proxy_register, proxy_list_request, proxy_list_response, proxy_select, relay_error) as a zod discriminatedUnion separate from MessageEnvelope. Implemented `RelayRegistry` class managing proxy WebSocket registration and client-to-proxy bindings with cascading cleanup on proxy disconnect. Added runtime dependencies (ws, express, pino, nanoid) and vitest config for relay package.

### Task 2: Router, handlers, server, entry point (6b17100)

Built the full relay server:
- **Router** (`parseMessage`, `routeProxyMessage`, `routeClientMessage`): Parses incoming WebSocket data trying RelayControlSchema first, then MessageEnvelopeSchema. Forwards raw strings without re-serialization for zero-overhead passthrough.
- **Proxy handler**: Manages proxy_register lifecycle, routes envelope messages to bound clients via router, heartbeat ping/pong tracking.
- **Client handler**: Handles proxy_list_request, proxy_select binding, routes envelope messages to bound proxy. Sends relay_error for unbound/offline cases.
- **Health routes**: GET /health (status + uptime), GET /status (proxy count, client count, uptime).
- **Server factory**: Express + ws noServer architecture with URL pathname routing (/proxy, /client). Single HTTP server, dual WebSocketServer instances. Graceful shutdown with interval cleanup.
- **Entry point**: Configurable PORT/LOG_LEVEL env vars, SIGTERM/SIGINT graceful shutdown.

### Task 3: Build verification (9b6aecb)

Verified tsup build produces working dist/index.js (10.12 KB). Server starts and logs on configured port. Fixed type assertions in server integration tests for strict typecheck compliance. Full workspace passes: 272 tests, 17 test files, typecheck clean.

## Deviations from Plan

None -- plan executed exactly as written.

## Verification Results

| Check | Result |
|-------|--------|
| `pnpm --filter @cc-anywhere/shared test` | 103 tests passing |
| `pnpm --filter @cc-anywhere/relay test` | 34 tests passing |
| `pnpm test` (full workspace) | 272 tests, 17 files passing |
| `pnpm --filter @cc-anywhere/relay build` | dist/index.js 10.12 KB |
| `pnpm --filter @cc-anywhere/relay typecheck` | Clean |
| `pnpm --filter @cc-anywhere/shared typecheck` | Clean |
| Server startup | Logs "Relay server started" on port 3100 |

## Key Technical Details

- Message forwarding passes raw JSON strings through without parsing/re-serializing for performance
- Heartbeat uses ws ping/pong frames (not application-level messages) with configurable interval (default 30s, tests use 100ms)
- No authentication per D-04 decision -- relay accepts all connections
- Seq fields passed through transparently -- relay does not modify or track sequence numbers
- Registry cascades client unbinding when proxy disconnects
- Duplicate proxy registration terminates the old connection

## Self-Check: PASSED
