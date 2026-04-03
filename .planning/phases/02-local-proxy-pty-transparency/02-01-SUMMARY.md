---
phase: 02-local-proxy-pty-transparency
plan: 01
subsystem: proxy
tags: [node-pty, pty, terminal, cli-wrapper, vitest]

requires:
  - phase: 01-shared-protocol-foundation
    provides: monorepo structure, proxy package scaffold, vitest workspace config
provides:
  - PtyManager class with full PTY lifecycle management
  - DataTap interface and noop tap for future relay integration
  - Unit test suite for PTY behaviors with mocked node-pty
affects: [02-02-PLAN, phase-03, phase-04]

tech-stack:
  added: [node-pty ^1.1.0, "@types/node"]
  patterns: [PTY transparent passthrough, debounced resize, signal-based exit codes, injectable stdin/stdout for testing]

key-files:
  created:
    - apps/proxy/src/pty-manager.ts
    - apps/proxy/src/tap.ts
    - apps/proxy/src/__tests__/pty-manager.test.ts
    - apps/proxy/vitest.config.ts
  modified:
    - apps/proxy/package.json
    - apps/proxy/tsup.config.ts
    - package.json

key-decisions:
  - "node-pty 1.1.0 ships prebuilt binaries for darwin-arm64/x64 and win32 -- native compilation not needed at install time"
  - "vitest project root must use __dirname for correct file resolution in workspace mode"
  - "@types/node added as devDependency for proxy since it directly uses Node.js APIs (process, Buffer, etc.)"

patterns-established:
  - "PTY passthrough: spawn via pty.spawn, raw mode stdin, direct stdout.write, 50ms debounced resize"
  - "DataTap injection: noop function passed to PtyManager constructor, Phase 3-4 replaces with relay logic"
  - "Mock node-pty testing: vi.mock with callback capture for onData/onExit, Object.assign for mock stdin/stdout"

requirements-completed: [PROXY-01]

duration: 17min
completed: 2026-04-03
---

# Phase 02 Plan 01: PTY Manager Core Summary

**PtyManager class wrapping node-pty with transparent I/O passthrough, 50ms resize debounce, signal-based exit codes (128+N), and noop data tap for future relay integration**

## Performance

- **Duration:** 17 min
- **Started:** 2026-04-03T12:22:07Z
- **Completed:** 2026-04-03T12:39:04Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- PtyManager class implements full PTY lifecycle: spawn claude in real PTY, raw mode stdin, byte-for-byte I/O piping, resize debouncing, signal exit codes, cleanup handlers
- DataTap interface provides clean extension point for Phase 3-4 relay without adding abstraction layers
- 8 unit tests covering all PTY behaviors with mocked node-pty, including edge cases (non-TTY stdin, signal-based exit)
- tsup config updated with shebang banner for CLI binary entry point

## Task Commits

Each task was committed atomically:

1. **Task 1: Install node-pty, create vitest config, implement tap module and PtyManager** - `8bbbf36` (feat)
2. **Task 2: Unit tests for PtyManager with mocked node-pty** - `bb55bc2` (test)

## Files Created/Modified
- `apps/proxy/src/pty-manager.ts` - PtyManager class: spawn, I/O piping, resize debounce, signal exit codes, cleanup
- `apps/proxy/src/tap.ts` - DataTap type and createNoopTap factory for relay integration hook
- `apps/proxy/src/__tests__/pty-manager.test.ts` - 8 unit tests with mocked node-pty covering all PTY behaviors
- `apps/proxy/vitest.config.ts` - Vitest project config with __dirname-based root for workspace resolution
- `apps/proxy/tsup.config.ts` - Added shebang banner for bin entry point
- `apps/proxy/package.json` - Added node-pty dependency and @types/node devDependency
- `package.json` - Added node-pty to pnpm onlyBuiltDependencies

## Decisions Made
- node-pty 1.1.0 ships prebuilt binaries -- no native compilation needed at install time, the pnpm "ignored build scripts" warning is harmless
- vitest workspace project config requires `__dirname` for root to correctly resolve test file paths from the workspace root
- @types/node added as proxy devDependency since the module directly uses process, Buffer, and Node.js stream types

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added @types/node devDependency**
- **Found during:** Task 1 (typecheck verification)
- **Issue:** TypeScript could not find `process`, `Buffer`, `NodeJS.ReadStream` types -- base tsconfig does not include Node.js types
- **Fix:** `pnpm --filter @cc-anywhere/proxy add -D @types/node`
- **Files modified:** apps/proxy/package.json, pnpm-lock.yaml
- **Verification:** `pnpm --filter @cc-anywhere/proxy typecheck` exits 0
- **Committed in:** 8bbbf36 (Task 1 commit)

**2. [Rule 3 - Blocking] Fixed vitest project root resolution**
- **Found during:** Task 2 (test execution)
- **Issue:** `pnpm vitest run --project proxy` could not find test files -- `root: "."` resolved to workspace root, not proxy directory
- **Fix:** Changed vitest config root to use `__dirname` via `fileURLToPath(import.meta.url)`
- **Files modified:** apps/proxy/vitest.config.ts
- **Verification:** `pnpm vitest run --project proxy` exits 0 with 8 passing tests
- **Committed in:** bb55bc2 (Task 2 commit)

**3. [Rule 1 - Bug] Fixed test file type assertions for mock stdin/stdout**
- **Found during:** Task 2 (typecheck verification)
- **Issue:** Direct `as` casts between `EventEmitter` and `NodeJS.ReadStream` with `vi.fn()` properties caused TS2352 type overlap errors
- **Fix:** Used `Object.assign` + `as unknown as NodeJS.ReadStream` pattern for mock factories
- **Files modified:** apps/proxy/src/__tests__/pty-manager.test.ts
- **Verification:** `pnpm --filter @cc-anywhere/proxy typecheck` exits 0
- **Committed in:** bb55bc2 (Task 2 amended commit)

**4. [Rule 3 - Blocking] Added node-pty to pnpm onlyBuiltDependencies**
- **Found during:** Task 1 (pnpm install)
- **Issue:** pnpm v10 blocks build scripts by default, node-pty install warning appeared
- **Fix:** Added `node-pty` to root package.json `pnpm.onlyBuiltDependencies` array (harmless since prebuilts are used)
- **Files modified:** package.json
- **Verification:** Module loads correctly via `node -e "require('node-pty')"`
- **Committed in:** 8bbbf36 (Task 1 commit)

---

**Total deviations:** 4 auto-fixed (1 bug, 3 blocking)
**Impact on plan:** All auto-fixes necessary for compilation and test execution. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- PtyManager is ready for Plan 02 to wire as CLI entry point in `apps/proxy/src/index.ts`
- DataTap provides the hook for Phase 3-4 relay integration
- All tests pass, TypeScript compiles, build succeeds with shebang banner

## Self-Check: PASSED

All 5 created files verified present. Both task commits (8bbbf36, bb55bc2) found in git log.

---
*Phase: 02-local-proxy-pty-transparency*
*Completed: 2026-04-03*
