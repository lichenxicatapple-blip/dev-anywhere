---
phase: quick-260413-hm8
plan: 01
subsystem: shared, proxy, relay
tags: [logging, pino, refactor, observability]
dependency_graph:
  requires: []
  provides: [shared-createLogger-factory, terminal-structured-logging]
  affects: [proxy-logger, relay-logger, relay-tests, proxy-tests]
tech_stack:
  added: [pino-in-shared]
  patterns: [centralized-logger-factory]
key_files:
  created:
    - packages/shared/src/logger.ts
  modified:
    - packages/shared/src/index.ts
    - packages/shared/package.json
    - apps/proxy/src/logger.ts
    - apps/proxy/package.json
    - apps/proxy/src/terminal.ts
    - apps/proxy/src/__tests__/integration/relay-connection.test.ts
    - apps/proxy/src/__tests__/integration/terminal-e2e.test.ts
    - apps/relay/src/index.ts
    - apps/relay/package.json
    - apps/relay/src/server.ts
    - apps/relay/src/handlers/proxy.ts
    - apps/relay/src/handlers/client.ts
    - apps/relay/src/router.ts
    - apps/relay/src/__tests__/integration/server.test.ts
    - apps/relay/src/__tests__/integration/message-routing.test.ts
    - apps/relay/src/__tests__/integration/replay.test.ts
    - apps/relay/src/__tests__/integration/client-register.test.ts
    - apps/relay/src/__tests__/unit/router.test.ts
    - pnpm-lock.yaml
decisions:
  - Unified pino to ^10.3.1 across monorepo via shared package
  - Relay uses stdout+file in all modes (stdout true), simplifying production/dev split
metrics:
  duration: 7min
  completed: 2026-04-13
  tasks: 2
  files: 20
---

# Quick Task 260413-hm8: Logger Unification - Shared createLogger Factory

Centralized pino logger creation into shared createLogger factory, eliminated duplicate pino setup across proxy/relay, unified pino version to ^10.3.1, and instrumented terminal.ts with 21 structured log points.

## Task 1: Create shared createLogger factory and migrate proxy/relay

- Created `packages/shared/src/logger.ts` with `createLogger` factory supporting `name`, `level`, `logDir`, `stdout`, and `silent` options
- Re-exported `createLogger`, `Logger` type, and `CreateLoggerOptions` from shared index
- Added pino ^10.3.1 to shared package.json dependencies
- Refactored proxy `logger.ts` to use `createLogger` with `LOG_DIR` from paths.ts
- Refactored relay `index.ts` to use `createLogger` with `stdout: true`
- Updated all 5 relay source files importing `type { Logger } from "pino"` to import from `@cc-anywhere/shared`
- Updated 4 relay test files and 2 proxy test files replacing `pino({ level: "silent" })` with `createLogger({ name: "test", silent: true })`
- Removed pino from proxy package.json (was ^10.3.1) and relay package.json (was ^9.6.0)
- All typechecks pass, all 153 relay tests pass

**Commit:** 52be9a0

## Task 2: Instrument terminal.ts with structured logging

Added 19 new log points (21 total, was 2) covering all critical execution paths:

- **ensureService:** connect success (first try + retry), auto-start daemon, connect failure
- **startTerminal:** session creation with dimensions, PTY start
- **reconnectToServe:** entry, each attempt (debug), success, session re-registration, exhaustion
- **setupSocketHandlers:** socket close, remote input (debug), frame request (debug)
- **startFramePush/stopFramePush:** lifecycle (debug)
- **PTY exit:** exit code and cleanup
- **Title change:** forwarding (debug)
- **SIGTERM:** shutdown

All info for lifecycle events, debug for high-frequency events, error for failures.

**Commit:** 30b2a93

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed proxy test files also importing pino directly**
- **Found during:** Task 1 verification
- **Issue:** `relay-connection.test.ts` and `terminal-e2e.test.ts` in proxy also imported pino directly, causing typecheck failure after removing pino from proxy's dependencies
- **Fix:** Updated both files to use `createLogger` from `@cc-anywhere/shared`
- **Files modified:** `apps/proxy/src/__tests__/integration/relay-connection.test.ts`, `apps/proxy/src/__tests__/integration/terminal-e2e.test.ts`
- **Commit:** 52be9a0

## Verification

- pnpm install: OK
- shared build: OK
- proxy typecheck: OK
- relay typecheck: OK
- relay tests: 153/153 passed
- `grep -r 'from "pino"' apps/**/*.ts`: zero matches in source files

## Self-Check: PASSED
