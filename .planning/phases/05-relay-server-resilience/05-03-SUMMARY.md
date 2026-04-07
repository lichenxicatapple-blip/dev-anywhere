---
phase: 05-relay-server-resilience
plan: 03
subsystem: relay, client-handler, router
tags: [client-register, replay-request, gap-detection, reconnect-protocol]

requires:
  - phase: 05-relay-server-resilience
    plan: 02
    provides: SessionBuffer with getAfterSeq/getRange, RelayRegistry with grace period/clientId binding, router buffer integration
provides:
  - client_register protocol handler with 3-way status response (restored/proxy_offline/new)
  - Incremental replay streaming after restored response
  - handleReplayRequest function for seq gap recovery with gap_unrecoverable fallback
  - Integration tests for client reconnection and replay protocols
affects: [relay-server-resilience, phase-6-feishu]

tech-stack:
  added: []
  patterns: [client-register-3way-status, incremental-replay-streaming, gap-unrecoverable-protocol]

key-files:
  created:
    - apps/relay/src/__tests__/client-register.test.ts
    - apps/relay/src/__tests__/replay.test.ts
  modified:
    - apps/relay/src/handlers/client.ts
    - apps/relay/src/router.ts
    - apps/relay/src/registry.ts
    - apps/relay/src/__tests__/registry.test.ts

key-decisions:
  - "unbindClientById preserves binding with ws=null instead of deleting, enabling reconnect restoration"
  - "getSessionsForProxy added to registry to support iterating proxy sessions during incremental replay"
  - "Messages streamed individually as raw frames, not batched in arrays, consistent with Pitfall 5"

patterns-established:
  - "3-way client_register: restored (binding + replay), proxy_offline (binding, no proxy), new (no prior state)"
  - "Incremental replay: getAfterSeq(lastSeq) per session, send each raw frame individually"
  - "Gap detection: getRange returns available, gap_unrecoverable for missing prefix"

requirements-completed: [RELAY-04]

duration: 4min
completed: 2026-04-07
---

# Phase 5 Plan 03: Client Reconnection & Gap Detection Summary

**client_register protocol with 3-way status response, incremental replay streaming, and replay_request/gap_unrecoverable for seq gap recovery**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-07T02:24:33Z
- **Completed:** 2026-04-07T02:28:44Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Implemented `client_register` handler in client.ts with three response statuses: `restored` (binding recovered, incremental replay), `proxy_offline` (binding recovered, proxy in grace period), `new` (no prior binding)
- After `restored` response, relay iterates all proxy sessions and streams missed messages (seq > lastSeq) individually as raw MessageEnvelope frames
- Added `handleReplayRequest` to router.ts for explicit seq range recovery: serves buffered messages, sends `gap_unrecoverable` for missing ranges, validates fromSeq <= toSeq
- Extended `ClientSocket` with `clientId` field; `proxy_select` syncs clientId binding when available
- Changed `unbindClientById` to preserve binding (ws=null) instead of deleting, enabling reconnect restoration
- Added `getSessionsForProxy` to registry for session iteration during replay
- 12 new integration tests (7 client_register + 5 replay) using real WebSocket connections

## Task Commits

1. **Task 1 RED: Failing tests for client_register** - `e07c839`
2. **Task 1 GREEN: client_register protocol implementation** - `27ed34c`
3. **Task 2: replay_request integration tests** - `bf09483`

## Files Created/Modified

- `apps/relay/src/handlers/client.ts` - client_register handler with 3-way status, replay_request routing, clientId tracking on ClientSocket, proxy_select clientId sync
- `apps/relay/src/router.ts` - handleReplayRequest with gap_unrecoverable for missing ranges, INVALID_RANGE validation
- `apps/relay/src/registry.ts` - getSessionsForProxy method, unbindClientById preserves binding with ws=null
- `apps/relay/src/__tests__/client-register.test.ts` - 7 integration tests: new/restored/restored-with-replay/proxy_offline/grace-period-error/proxy_select-backward-compat
- `apps/relay/src/__tests__/replay.test.ts` - 5 integration tests: successful replay/partial-with-gap/fully-missing/unknown-session/invalid-range
- `apps/relay/src/__tests__/registry.test.ts` - Updated unbindClientById test to match new preserve-binding behavior

## Decisions Made

- `unbindClientById` preserves binding with ws=null instead of deleting: reconnecting client can be recognized by clientId and have its proxy binding restored without re-sending proxy_select
- Added `getSessionsForProxy` to registry: client_register restored flow needs to iterate all sessions belonging to the bound proxy for incremental replay
- Replay messages sent individually as raw frames (not batched in arrays): consistent with Pitfall 5 streaming approach, client receives each MessageEnvelope as a separate WebSocket frame

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added getSessionsForProxy to registry**
- **Found during:** Task 1 implementation
- **Issue:** client_register restored flow needs to iterate proxy sessions for replay, but ProxyState.sessions was private with no getter
- **Fix:** Added `getSessionsForProxy(proxyId)` method returning `string[]` from the internal sessions Set
- **Files modified:** apps/relay/src/registry.ts
- **Committed in:** 27ed34c

**2. [Rule 1 - Bug] Updated registry test for new unbindClientById behavior**
- **Found during:** Task 1 GREEN phase
- **Issue:** Existing test expected unbindClientById to delete binding (getClientBinding returns undefined), but new behavior preserves binding with ws=null for reconnect support
- **Fix:** Updated test assertion to verify binding exists with ws=null
- **Files modified:** apps/relay/src/__tests__/registry.test.ts
- **Committed in:** 27ed34c

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 test adaptation)
**Impact on plan:** Registry API extended as needed. No scope creep.

## Issues Encountered
None.

## Threat Mitigations Applied

- **T-05-11 (DoS via large replay):** Buffer capped at 1000 messages per session. replay_request validates fromSeq <= toSeq, rejects INVALID_RANGE. Maximum replay bounded by buffer size.
- **T-05-13 (Information Disclosure):** Replay only streams buffers for sessions belonging to the bound proxy's session set. client_register only restores binding if prior binding exists.

## Next Phase Readiness

- Client reconnection protocol ready for Phase 6 Feishu mini program implementation
- Three-way status response gives mini program clear state to display: restored (resume), proxy_offline (waiting), new (select proxy)
- Replay protocol enables mini program to request specific seq ranges for gap recovery
- Full relay test suite at 79 tests, workspace at 355 tests, all green

---
*Phase: 05-relay-server-resilience*
*Completed: 2026-04-07*
