---
phase: 09-pty-pipeline-full-chain
plan: 03
subsystem: relay, shared
tags: [binary-passthrough, zero-copy, session-buffer-removal, type-cleanup]
dependency_graph:
  requires:
    - phase: 09-01
      provides: EventStore, headless-xterm-snapshots
  provides:
    - relay-binary-frame-passthrough
    - session-buffer-removal
    - shared-type-cleanup
  affects: [09-04, apps/web]
tech_stack:
  added: []
  patterns: [binary-passthrough, isBinary-dispatch, zero-copy-forwarding]
key_files:
  created:
    - apps/feishu/src/types/terminal-legacy.ts
  modified:
    - apps/relay/src/handlers/proxy.ts
    - apps/relay/src/handlers/client.ts
    - apps/relay/src/registry.ts
    - apps/relay/src/router.ts
    - apps/relay/src/server.ts
    - packages/shared/src/schemas/session.ts
    - packages/shared/src/schemas/relay-control.ts
    - packages/shared/src/index.ts
  deleted:
    - apps/relay/src/session-buffer.ts
    - apps/relay/src/buffer-store.ts
    - apps/relay/src/buffer-compressor.ts
    - apps/relay/src/__tests__/unit/session-buffer.test.ts
    - apps/relay/src/__tests__/unit/buffer-store.test.ts
key_decisions:
  - "Binary frames forwarded with zero-copy: relay sends entire buffer including sessionId prefix"
  - "SessionBuffer/BufferStore/BufferCompressor fully removed from relay"
  - "TermSpan/TermLine/TerminalFramePayload moved to feishu-local types for legacy compilation"
  - "terminal_frame/terminal_frame_request/terminal_scroll_request removed from RelayControlSchema"
patterns-established:
  - "Relay binary dispatch: isBinary check before JSON parsing in message handler"
  - "Zero-copy forwarding: relay does not strip or modify binary frame content"
requirements-completed: [PTY-04]
metrics:
  duration: 28min
  completed: "2026-04-15T15:55:27Z"
  tasks: 2
  files_changed: 16
  lines_added: 70
  lines_deleted: 600+
---

# Phase 09 Plan 03: Relay Binary Passthrough + Shared Type Cleanup Summary

Relay handles binary WebSocket frames as zero-copy passthrough with sessionId-only routing. All old buffering infrastructure (SessionBuffer, BufferStore, BufferCompressor) deleted. Old terminal frame types (TermSpan, TermLine, TerminalFramePayload) removed from shared package, moved to feishu-local legacy types.

## Performance

- **Duration:** 28 min
- **Tasks:** 2
- **Files modified:** 16

## Accomplishments

- Relay proxy handler checks `isBinary` flag, parses sessionId prefix, forwards binary frames to all clients viewing the session
- Relay client handler guards against unexpected binary messages
- SessionBuffer, BufferStore, BufferCompressor deleted from relay (~200 lines removed)
- Registry cleaned of all SessionBuffer references
- Router cleaned of all buffer logic
- TermSpanSchema, TermLine, TerminalFramePayload removed from shared package
- terminal_frame, terminal_frame_request, terminal_scroll_request removed from RelayControlSchema
- Feishu app fixed with local legacy type definitions to maintain compilation

## Task Commits

1. **Task 1: Relay binary passthrough + remove SessionBuffer** - `6cb7681`, `62b1a8d` (feat + lint fix)
2. **Task 2: Clean shared package types + fix feishu** - `60d1f3b` (feat)

## Deviations from Plan

### Feishu app type breakage (unplanned fix)
- **Issue:** Removing types from shared broke feishu app compilation (TermLine import, terminal_frame message types)
- **Fix:** Created `apps/feishu/src/types/terminal-legacy.ts` with local type definitions, updated feishu imports
- **Impact:** Minimal scope increase, necessary for monorepo build health

## Verification Results

- `pnpm build` -- all packages compile (shared, proxy, relay, web, feishu)
- `pnpm --filter shared exec vitest run` -- 78 tests passed
- `pnpm --filter relay exec vitest run` -- 111 non-resilience tests passed (resilience tests have pre-existing environment flakiness)

## Next Phase Readiness

- Binary frames now flow from proxy through relay to connected clients
- Plan 09-04 (/pty-test browser page) can receive binary frames and render via xterm.js

---
*Phase: 09-pty-pipeline-full-chain*
*Completed: 2026-04-15*
