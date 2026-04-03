---
phase: 01-monorepo-shared-protocol
plan: 02
subsystem: infra
tags: [zod, typescript, protocol, schemas, discriminated-union, message-envelope]

requires:
  - phase: 01-monorepo-shared-protocol/01
    provides: pnpm monorepo with packages/shared skeleton, zod 4, nanoid, vitest, tsup
provides:
  - MessageEnvelope discriminated union schema with 16 message types
  - Zod payload schemas for chat (3), tool (4), session (5), system (5)
  - Message builder function with auto-incrementing sequence numbers
  - ErrorCode and SessionState constants
  - Barrel export with full type re-exports from packages/shared
  - Cross-package type propagation verified (proxy imports shared types)
affects: [02-local-proxy-pty, 03-agent-sdk-remote, 04-relay-server, 05-reconnection-sync, 06-feishu-mini-program]

tech-stack:
  added: []
  patterns: [Zod discriminatedUnion for protocol messages, z.infer for type derivation, tsup JS + tsc DTS split build, tsconfig.build.json for excluding tests from declarations]

key-files:
  created:
    - packages/shared/src/schemas/envelope.ts
    - packages/shared/src/schemas/chat.ts
    - packages/shared/src/schemas/tool.ts
    - packages/shared/src/schemas/session.ts
    - packages/shared/src/schemas/system.ts
    - packages/shared/src/types/index.ts
    - packages/shared/src/constants/errors.ts
    - packages/shared/src/constants/session.ts
    - packages/shared/src/builders/index.ts
    - packages/shared/tsconfig.build.json
    - packages/shared/src/schemas/__tests__/envelope.test.ts
    - packages/shared/src/schemas/__tests__/chat.test.ts
    - packages/shared/src/schemas/__tests__/tool.test.ts
    - packages/shared/src/schemas/__tests__/session.test.ts
    - packages/shared/src/schemas/__tests__/system.test.ts
    - packages/shared/src/builders/__tests__/builders.test.ts
  modified:
    - packages/shared/src/index.ts
    - packages/shared/package.json
    - packages/shared/tsup.config.ts
    - apps/proxy/src/index.ts
    - apps/proxy/tsup.config.ts
    - apps/relay/tsup.config.ts
    - apps/feishu/tsup.config.ts

key-decisions:
  - "Zod 4 uses .nonnegative() not .nonneg() for non-negative number constraints"
  - "SyncResponsePayload uses z.array(z.record(z.string(), z.unknown())) to avoid circular reference with MessageEnvelopeSchema -- will be tightened in Phase 5"
  - "DTS generation split: tsup for JS bundling, tsc for declarations -- tsup rollup-plugin-dts fails with composite projects that have multi-file exports"
  - "App packages (proxy, relay, feishu) disable DTS generation since they are deployable apps, not libraries"
  - "tsBuildInfoFile placed in dist/ so tsup clean removes it, forcing tsc to always re-emit declarations"

patterns-established:
  - "Pattern: tsconfig.build.json excludes test files from declaration output"
  - "Pattern: Payload schemas in category files (chat.ts, tool.ts, etc.) never import from envelope.ts -- strict unidirectional dependency"
  - "Pattern: All types derived from Zod schemas via z.infer, no manually written interfaces"
  - "Pattern: Message builders validate at runtime via schema.parse(), returning typed results"

requirements-completed: []

duration: 18min
completed: 2026-04-03
---

# Phase 01 Plan 02: Shared Protocol Schema Summary

**Zod 4 discriminated union MessageEnvelope with 16 message types, runtime-validated builders, and cross-package type propagation**

## Performance

- **Duration:** 18 min
- **Started:** 2026-04-03T10:50:37Z
- **Completed:** 2026-04-03T11:08:11Z
- **Tasks:** 2
- **Files modified:** 23

## Accomplishments
- 16 message types fully defined as Zod schemas across 4 categories (chat, tool, session, system) with runtime validation
- MessageEnvelope discriminated union validates type+payload combinations at parse time
- buildMessage() factory auto-generates sequence numbers and timestamps, validates against schema before returning
- 94 tests covering all schemas and builders pass, plus build/lint/typecheck all green
- Cross-package type propagation verified: apps/proxy imports types from @cc-anywhere/shared

## Task Commits

Each task was committed atomically (TDD: red then green):

1. **Task 1: Implement Zod schemas, types, and constants for all 16 message types**
   - `459f412` (test) - failing tests for all 16 message type schemas
   - `8c53709` (feat) - implement Zod schemas, types, and constants
2. **Task 2: Implement message builders, barrel export, and cross-package verification**
   - `7f16c0c` (test) - failing tests for message builders
   - `7986115` (feat) - implement message builders, barrel export, cross-package type verification
   - `411f7e3` (fix) - disable DTS generation for app packages

## Files Created/Modified
- `packages/shared/src/schemas/envelope.ts` - MessageEnvelope discriminated union with 16 type variants
- `packages/shared/src/schemas/chat.ts` - UserInput, AssistantMessage, Thinking payload schemas
- `packages/shared/src/schemas/tool.ts` - ToolUseRequest, ToolApprove, ToolDeny, ToolResult payload schemas
- `packages/shared/src/schemas/session.ts` - SessionCreate, SessionList, SessionSwitch, SessionTerminate, SessionStatus payload schemas
- `packages/shared/src/schemas/system.ts` - Heartbeat, Error, Auth, SyncRequest, SyncResponse payload schemas
- `packages/shared/src/types/index.ts` - Re-exports all z.infer types from schema files
- `packages/shared/src/constants/errors.ts` - ErrorCode const enum (8 error codes)
- `packages/shared/src/constants/session.ts` - SessionState const enum (5 states)
- `packages/shared/src/builders/index.ts` - buildMessage, createSequenceId, resetSequenceCounter
- `packages/shared/src/index.ts` - Barrel export of all schemas, types, builders, constants
- `packages/shared/tsconfig.build.json` - Build-specific tsconfig excluding tests
- `apps/proxy/src/index.ts` - Type propagation verification importing from @cc-anywhere/shared

## Decisions Made
- Zod 4 API difference: `.nonnegative()` replaces Zod 3's `.nonneg()` for non-negative integer constraints
- SyncResponsePayload uses `z.array(z.record(z.string(), z.unknown()))` instead of `z.lazy(() => MessageEnvelopeSchema)` to avoid circular reference complexity. Will be tightened in Phase 5 when sync replay is implemented.
- Split DTS generation: tsup handles JS bundling, tsc handles declaration files. tsup's rollup-plugin-dts cannot resolve multi-file composite projects.
- App packages disable DTS output since they are deployable binaries, not consumable libraries.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Zod 4 API: nonneg() does not exist, use nonnegative()**
- **Found during:** Task 1 (schema implementation)
- **Issue:** Plan specified `.nonneg()` for non-negative integers but Zod 4 renamed it to `.nonnegative()`
- **Fix:** Changed `.nonneg()` to `.nonnegative()` in system.ts and envelope.ts
- **Files modified:** `packages/shared/src/schemas/system.ts`, `packages/shared/src/schemas/envelope.ts`
- **Verification:** All tests pass
- **Committed in:** 8c53709 (Task 1 green commit)

**2. [Rule 3 - Blocking] tsup DTS generation fails with composite multi-file projects**
- **Found during:** Task 2 (build verification)
- **Issue:** tsup's rollup-plugin-dts cannot resolve files in composite TypeScript projects with multiple source directories (schemas/, builders/, etc.), producing TS6307 errors
- **Fix:** Disabled tsup DTS, added `tsc -p tsconfig.build.json --emitDeclarationOnly` to build script. Created tsconfig.build.json excluding tests, with tsBuildInfoFile in dist/ so tsup clean forces re-emit.
- **Files modified:** `packages/shared/tsup.config.ts`, `packages/shared/package.json`, `packages/shared/tsconfig.build.json`
- **Verification:** `pnpm build` succeeds, `dist/index.d.ts` and all sub-directory `.d.ts` files generated
- **Committed in:** 7986115 (Task 2 green commit)

**3. [Rule 3 - Blocking] App packages fail DTS build when importing @cc-anywhere/shared types**
- **Found during:** Task 2 (build verification)
- **Issue:** proxy's tsup DTS generation failed because it couldn't find shared's declarations at build time, even though proxy only uses `import type`
- **Fix:** Disabled DTS generation for all app packages (proxy, relay, feishu) since apps are deployable binaries, not libraries
- **Files modified:** `apps/proxy/tsup.config.ts`, `apps/relay/tsup.config.ts`, `apps/feishu/tsup.config.ts`
- **Verification:** `pnpm build` succeeds across all packages
- **Committed in:** 411f7e3

---

**Total deviations:** 3 auto-fixed (1 bug, 2 blocking)
**Impact on plan:** All fixes necessary for the build pipeline to work with multi-file TypeScript projects. No scope creep.

## Issues Encountered
None beyond the deviations documented above.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. All schemas are fully defined with proper validation rules. SyncResponsePayload uses a relaxed type (`z.record(z.string(), z.unknown())[]`) rather than a stub -- this is intentional and documented for Phase 5 refinement.

## Next Phase Readiness
- Shared protocol library is complete with all 16 message types
- Any package can `import { MessageEnvelopeSchema, buildMessage, ErrorCode } from "@cc-anywhere/shared"` and get full type safety
- Phase 2 (local proxy PTY) can import message types for relay communication
- Phase 4 (relay server) can use schemas for message validation

## Self-Check: PASSED

All 16 created files verified present. All 5 task commits verified in git log.

---
*Phase: 01-monorepo-shared-protocol*
*Completed: 2026-04-03*
