---
phase: 04-relay-server-core-transport
verified: 2026-04-06T16:45:00Z
status: human_needed
score: 3/4 must-haves verified
gaps:
  - truth: "Message loss is detected via sequence number gaps and reported (not silently dropped)"
    status: partial
    reason: "Seq fields pass through transparently (verified in integration tests), but no code detects gaps or reports missing seq numbers. The relay and proxy both forward raw messages without tracking seq continuity."
    artifacts:
      - path: "apps/relay/src/router.ts"
        issue: "Forwards messages but does not track or compare seq numbers"
      - path: "apps/proxy/src/relay-connection.ts"
        issue: "Receives messages but does not check for seq gaps"
    missing:
      - "Seq gap detection logic on the receiving side (either in relay, proxy, or client)"
      - "Reporting mechanism when a seq gap is detected (log warning or relay_error message)"
deferred:
  - truth: "Message loss is detected via sequence number gaps and reported (not silently dropped)"
    addressed_in: "Phase 5"
    evidence: "Phase 5 goal: 'The relay handles real-world network instability without losing messages or breaking sessions'. SC#2: 'Messages sent during a disconnection are queued and delivered after reconnection (no silent message loss)'. SC#4: 'After reconnection, both proxy and client receive only the messages they missed (no duplicates, no gaps)'."
human_verification:
  - test: "Start relay server locally, connect proxy with RELAY_URL, connect wscat client, verify bidirectional message routing"
    expected: "proxy_list_request returns proxy, proxy_select succeeds, messages route both directions"
    why_human: "Requires running multiple processes simultaneously (relay, proxy, wscat client)"
  - test: "Verify Taro Feishu/Lark spike in Feishu developer tools IDE simulator"
    expected: "Connect to echo server, send JSON, receive echoed JSON"
    why_human: "Requires Feishu IDE simulator which cannot be automated"
  - test: "Docker build on a machine with Docker installed"
    expected: "docker build -f apps/relay/Dockerfile -t cc-anywhere-relay . succeeds"
    why_human: "Docker was not available during build (Podman not running); build verified by file inspection only"
---

# Phase 4: Relay Server - Core Transport Verification Report

**Phase Goal:** Local proxy and remote clients can exchange messages through a public WebSocket relay with guaranteed ordering
**Verified:** 2026-04-06T16:45:00Z
**Status:** human_needed
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Local proxy connects to relay server via outbound WebSocket (no public IP needed) | VERIFIED | `apps/proxy/src/relay-connection.ts` connects to `relayUrl + "/proxy"`, sends `proxy_register` on open. Integrated in `serve.ts` via `RELAY_URL` env var. 6 tests passing in relay-connection.test.ts. |
| 2 | Messages from proxy arrive at connected clients with correct ordering verified by sequence numbers | VERIFIED | Router forwards raw JSON strings (no re-serialization). Integration test in server.test.ts line 99-141 proves proxy->client and client->proxy bidirectional forwarding with seq fields (seq:1, seq:2) preserved in transit. |
| 3 | A WebSocket test client can send a message through relay to proxy and receive Claude Code's response in real time | VERIFIED | Integration test proves: client connects to /client, sends proxy_select, sends user_input envelope, proxy receives it. Proxy sends assistant_message envelope, client receives it. All verified programmatically. |
| 4 | Message loss is detected via sequence number gaps and reported (not silently dropped) | PARTIAL | Seq fields are present in MessageEnvelope and pass through relay transparently (verified). However, no code anywhere detects seq gaps or reports missing messages. The relay is a stateless forwarder that does not track seq continuity. Deferred to Phase 5 resilience work. |

**Score:** 3/4 truths verified (1 partial, deferred to Phase 5)

### Deferred Items

Items not yet met but addressed in later milestone phases.

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | Seq gap detection and loss reporting | Phase 5 | Phase 5 goal: "handles real-world network instability without losing messages." SC#2: "no silent message loss." SC#4: "no duplicates, no gaps." |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/shared/src/schemas/relay-control.ts` | Relay control message schemas | VERIFIED | 5 message types (proxy_register, proxy_list_request, proxy_list_response, proxy_select, relay_error) as zod discriminatedUnion. Exports RelayControlSchema and RelayControlMessage. 10 tests. |
| `apps/relay/src/server.ts` | Express + ws WebSocketServer with noServer routing | VERIFIED | Creates Express app, HTTP server, dual WebSocketServer (/proxy, /client), heartbeat setup, graceful close(). 107 lines. |
| `apps/relay/src/registry.ts` | Proxy registry and client binding maps | VERIFIED | RelayRegistry class with registerProxy, unregisterProxy, bindClient, unbindClient, getClientsForProxy, getBoundProxy, listProxies, countClients. 62 lines, 13 tests. |
| `apps/relay/src/router.ts` | Message validation and bidirectional forwarding | VERIFIED | parseMessage (control/envelope/invalid), routeProxyMessage, routeClientMessage. Uses MessageEnvelopeSchema.safeParse and RelayControlSchema.safeParse. Forwards raw strings. 107 lines, 12 tests. |
| `apps/relay/src/handlers/proxy.ts` | Proxy WebSocket lifecycle handler | VERIFIED | handleProxyConnection with proxy_register, envelope routing, heartbeat ping/pong. setupProxyHeartbeat exported. 87 lines. |
| `apps/relay/src/handlers/client.ts` | Client WebSocket lifecycle handler | VERIFIED | handleClientConnection with proxy_list_request, proxy_select, envelope routing, relay_error responses. setupClientHeartbeat exported. 96 lines. |
| `apps/relay/src/health.ts` | Express routes for /health and /status | VERIFIED | GET /health returns status+uptime. GET /status returns proxyCount+clientCount+uptime. 24 lines. |
| `apps/relay/src/index.ts` | Relay server entry point | VERIFIED | Creates pino logger, createRelayServer, listens on PORT, SIGTERM/SIGINT graceful shutdown. 24 lines. |
| `apps/proxy/src/relay-connection.ts` | Outbound WebSocket from proxy to relay | VERIFIED | RelayConnection class with connect(), send(), close(), getProxyId(). proxyId persistence via nanoid. 102 lines, 6 tests. |
| `apps/relay/Dockerfile` | Multi-stage Docker build | VERIFIED | node:22-alpine builder+runner, pnpm workspace-aware, HEALTHCHECK directive, copies packages/shared. 44 lines. |
| `apps/relay/docker-compose.yml` | Docker compose for relay + nginx | VERIFIED | relay service (context: ../.. for monorepo root), nginx service with nginx.conf volume mount and letsencrypt cert mount. 31 lines. |
| `apps/relay/nginx.conf` | Nginx WSS reverse proxy with TLS | VERIFIED | proxy_read_timeout 86400s, proxy_set_header Upgrade, ssl_certificate, HTTP->HTTPS redirect. 34 lines. |
| `apps/relay/deploy.sh` | SSH deployment script | VERIFIED | Executable. Contains docker compose, certbot, rsync, health check. 88 lines. |
| `apps/relay/.dockerignore` | Docker build exclusions | VERIFIED | Exists. Excludes node_modules, dist, .git, .planning, .claude, test files. |
| `apps/feishu/src/echo-server.ts` | Echo WebSocket server | VERIFIED | startEchoServer(port) function, JSON echo/error handling, standalone mode. 47 lines, 5 tests. |
| `apps/feishu/src/pages/index/index.tsx` | Taro page with connectSocket | VERIFIED | Uses Taro.connectSocket, onSocketOpen/Message/Close/Error, sendSocketMessage. Connect/Send buttons, message list, status display. 87 lines. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| handlers/proxy.ts | registry.ts | registry.registerProxy / unregisterProxy | WIRED | Lines 31 and 61: registerProxy on proxy_register, unregisterProxy on close |
| handlers/client.ts | registry.ts | registry.bindClient / unbindClient | WIRED | Lines 41 and 71: bindClient on proxy_select, unbindClient on close |
| handlers/proxy.ts | router.ts | routeProxyMessage | WIRED | Import line 4, usage line 46 |
| handlers/client.ts | router.ts | routeClientMessage | WIRED | Import line 4, usage line 63 |
| router.ts | schemas/envelope.ts | MessageEnvelopeSchema.safeParse | WIRED | Line 31: envelope validation |
| router.ts | schemas/relay-control.ts | RelayControlSchema.safeParse | WIRED | Line 26: control message detection |
| serve.ts | relay-connection.ts | RelayConnection instantiation | WIRED | Import line 18, instantiation line 429, close line 493 |
| relay-connection.ts | relay server /proxy | WebSocket connection | WIRED | Line 56: connects to relayUrl + "/proxy" |
| docker-compose.yml | nginx.conf | nginx volume mount | WIRED | Line 27: ./nginx.conf:/etc/nginx/conf.d/default.conf:ro |
| shared/index.ts | relay-control.ts | export re-export | WIRED | Lines 70-71: exports RelayControlSchema and RelayControlMessage |

### Data-Flow Trace (Level 4)

Not applicable -- relay server is a stateless message router, not a data-rendering component.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| All workspace tests pass | `pnpm test` | 283 tests, 19 files, all passed | PASS |
| Relay typecheck clean | `pnpm --filter @cc-anywhere/relay typecheck` | Exit 0, no errors | PASS |
| Relay build produces dist | `pnpm --filter @cc-anywhere/relay build` | dist/index.js 10.12 KB | PASS |
| Built module loads | `node -e "import('./apps/relay/dist/index.js')"` | Module loaded (attempted server start on port 3100) | PASS |
| deploy.sh is executable | `test -x apps/relay/deploy.sh` | True | PASS |
| .dockerignore exists | `test -f apps/relay/.dockerignore` | True | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| RELAY-01 | 04-02, 04-03 | WebSocket bridge between proxy and client, proxy connects outbound | SATISFIED | Relay server with /proxy and /client endpoints, proxy RelayConnection class, bidirectional forwarding proven in integration tests |
| RELAY-03 | 04-02, 04-03 | Sequence-numbered message protocol, ordered delivery, loss detection | PARTIAL | Seq numbers present in MessageEnvelope, passed through transparently by relay. Ordering maintained by WebSocket protocol. But seq gap detection/reporting not implemented. Gap detection deferred to Phase 5 resilience. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none found) | - | - | - | No TODOs, FIXMEs, placeholders, or stub implementations in production code |

### Human Verification Required

### 1. End-to-end relay connectivity

**Test:** Start relay server (`pnpm --filter @cc-anywhere/relay dev`), start proxy with `RELAY_URL=ws://localhost:3100 pnpm --filter @cc-anywhere/proxy dev -- serve`, connect wscat client to ws://localhost:3100/client, send proxy_list_request, proxy_select, and verify bidirectional message routing.
**Expected:** proxy_list_response contains the proxy's proxyId, proxy_select succeeds, messages route both directions through relay.
**Why human:** Requires running multiple processes simultaneously (relay server, proxy service, WebSocket client).

### 2. Taro Feishu/Lark spike in Feishu developer tools

**Test:** Build Taro for Lark (`pnpm --filter @cc-anywhere/feishu build:lark`), open in Feishu IDE simulator, start echo server, tap Connect, send a message.
**Expected:** Status changes to "connected", sent message appears echoed back in received messages list.
**Why human:** Requires Feishu IDE simulator which is a desktop application that cannot be automated.

### 3. Docker build verification

**Test:** Run `docker build -f apps/relay/Dockerfile -t cc-anywhere-relay .` from monorepo root.
**Expected:** Multi-stage build completes successfully, produces a working container image.
**Why human:** Docker was not available during automated build verification (Podman not running). File structure is verified but actual Docker build needs manual confirmation.

### Gaps Summary

One partial gap identified: **Roadmap SC#4 (seq gap detection)** -- the relay passes sequence numbers through transparently and ordering is preserved by WebSocket's TCP guarantees, but there is no active detection or reporting when sequence numbers have gaps. This is classified as **deferred to Phase 5** because Phase 5 explicitly handles message loss, queuing, and reconnection resilience. The seq infrastructure (fields in MessageEnvelope, transparent passthrough) established in Phase 4 provides the foundation Phase 5 needs.

After filtering deferred items, no actionable gaps remain. Status is **human_needed** because 3 items require manual verification (multi-process end-to-end test, Feishu IDE simulator, Docker build).

---

_Verified: 2026-04-06T16:45:00Z_
_Verifier: Claude (gsd-verifier)_
