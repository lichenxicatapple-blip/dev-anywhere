---
phase: 01-monorepo-shared-protocol
plan: 01
subsystem: infra
tags: [pnpm, monorepo, typescript, tsup, eslint, vitest, prettier, zod, nanoid]

requires: []
provides:
  - pnpm monorepo with 4 workspace packages linked via workspace:*
  - TypeScript composite project references for incremental builds
  - ESLint 10 flat config with typescript-eslint
  - Vitest 4 projects config for monorepo testing
  - tsup build pipeline for all packages
  - packages/shared skeleton with zod 4 and nanoid
affects: [01-02-PLAN, all-future-phases]

tech-stack:
  added: [typescript ^5.8.2, tsup ^8.5.1, vitest ^4.1.2, eslint ^10.1.0, typescript-eslint ^8.58.0, prettier ^3.8.1, tsx ^4.21.0, zod ^4.3.6, nanoid ^5.1.7, globals ^17.4.0, "@eslint/js ^10.0.1", eslint-config-prettier ^10.1.8]
  patterns: [pnpm workspace:* cross-references, TypeScript composite project references, ESM-only packages, tsup bundling]

key-files:
  created:
    - package.json
    - pnpm-workspace.yaml
    - tsconfig.base.json
    - tsconfig.json
    - eslint.config.js
    - .prettierrc
    - vitest.config.ts
    - .gitignore
    - packages/shared/package.json
    - packages/shared/tsconfig.json
    - packages/shared/tsup.config.ts
    - packages/shared/vitest.config.ts
    - packages/shared/src/index.ts
    - apps/proxy/package.json
    - apps/proxy/tsconfig.json
    - apps/proxy/tsup.config.ts
    - apps/proxy/src/index.ts
    - apps/relay/package.json
    - apps/relay/tsconfig.json
    - apps/relay/tsup.config.ts
    - apps/relay/src/index.ts
    - apps/feishu/package.json
    - apps/feishu/tsconfig.json
    - apps/feishu/tsup.config.ts
    - apps/feishu/src/index.ts
  modified: []

key-decisions:
  - "ESLint config ignores *.config.ts/js files from type-checked linting to avoid projectService resolution issues in monorepo"
  - "Zod 4 (not 3) for greenfield project -- 14x faster parsing, 57% smaller bundle"
  - "TypeScript pinned to ^5.8 despite 6.0 being available -- ecosystem not ready"

patterns-established:
  - "Pattern: All packages use ESM-only (type: module), no CJS"
  - "Pattern: Apps depend on shared via workspace:*, shared has zero internal deps"
  - "Pattern: Each package has its own tsup.config.ts and tsconfig.json extending tsconfig.base.json"
  - "Pattern: Root scripts delegate to workspace packages (pnpm -r run build)"

requirements-completed: []

duration: 8min
completed: 2026-04-03
---

# Phase 01 Plan 01: Monorepo Scaffolding Summary

**pnpm monorepo with 4 workspace packages (shared, proxy, relay, feishu), TypeScript composite project references, ESLint 10 + Vitest 4 + tsup build pipeline**

## Performance

- **Duration:** 8 min
- **Started:** 2026-04-03T10:37:54Z
- **Completed:** 2026-04-03T10:45:25Z
- **Tasks:** 2
- **Files modified:** 25

## Accomplishments
- pnpm workspace with packages/* and apps/* globs, all 5 projects linked
- TypeScript composite project references enabling incremental builds and compile-time dependency enforcement
- ESLint 10 flat config + Prettier + Vitest 4 projects config fully operational
- All four commands pass cleanly: pnpm install, pnpm build, pnpm lint, pnpm typecheck

## Task Commits

Each task was committed atomically:

1. **Task 1: Create root configs and packages/shared skeleton** - `0678b10` (chore)
2. **Task 2: Create stub app packages and verify cross-references** - `b0eef31` (feat)

## Files Created/Modified
- `package.json` - Root workspace config with scripts and devDependencies
- `pnpm-workspace.yaml` - Workspace package discovery (packages/* + apps/*)
- `tsconfig.base.json` - Shared TypeScript compiler options with composite enabled
- `tsconfig.json` - Root project references for IDE support
- `eslint.config.js` - ESLint 10 flat config with typescript-eslint and prettier
- `.prettierrc` - Prettier formatting config
- `vitest.config.ts` - Vitest 4 projects config for monorepo
- `.gitignore` - Node/TypeScript ignores
- `packages/shared/` - Shared package skeleton with zod 4 + nanoid
- `apps/proxy/` - Proxy stub with workspace:* shared dependency
- `apps/relay/` - Relay stub with workspace:* shared dependency
- `apps/feishu/` - Feishu stub with workspace:* shared dependency

## Decisions Made
- ESLint config ignores `*.config.ts/js` files from type-checked linting -- `projectService` cannot resolve config files not included in any tsconfig, and `allowDefaultProject` does not support `**` globs for nested files. Config files are tooling, not business logic.
- Zod 4 chosen over Zod 3 per RESEARCH.md recommendation for greenfield project.
- TypeScript pinned to ^5.8 despite 6.0 being available -- ecosystem (ESLint plugins, tsup DTS generation) not ready.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] ESLint projectService cannot resolve config files in monorepo**
- **Found during:** Task 2 (lint verification)
- **Issue:** `tsup.config.ts`, `vitest.config.ts`, `eslint.config.js` across all packages not found by projectService because they're not included in any tsconfig
- **Fix:** Added `**/*.config.ts` and `**/*.config.js` to ESLint ignores since config files are tooling, not business logic
- **Files modified:** `eslint.config.js`
- **Verification:** `pnpm lint` passes cleanly
- **Committed in:** b0eef31 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary for lint to pass. Config files excluded from type-checked linting is standard practice in monorepos.

## Issues Encountered
- pnpm 10.12.4 warns about esbuild build scripts being ignored. Added `pnpm.onlyBuiltDependencies` to root package.json. Warning persists but does not affect functionality -- tsup uses esbuild's JavaScript API which works without the native binary postinstall.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Monorepo foundation is complete and all toolchain commands pass
- Plan 02 can immediately implement Zod schemas in packages/shared/src/
- All packages correctly reference shared via workspace:* and TypeScript project references

## Self-Check: PASSED

All 25 created files verified present. Both task commits (0678b10, b0eef31) verified in git log.

---
*Phase: 01-monorepo-shared-protocol*
*Completed: 2026-04-03*
