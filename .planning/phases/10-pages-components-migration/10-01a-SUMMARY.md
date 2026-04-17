---
phase: 10-pages-components-migration
plan: 01a
subsystem: ui
tags: [shadcn, radix, sonner, cmdk, tailwind-v4, amber-theme, playwright, vitest]

# Dependency graph
requires:
  - phase: 07-project-scaffold-design-tokens
    provides: initial app.css dark theme tokens + shadcn Button
  - phase: 08-business-logic-adaptation
    provides: @/lib/utils (cn) + path alias convention
provides:
  - 13 shadcn atoms importable from @/components/ui/*
  - amber primary (#D4A574) + 0.375rem radius + font-normal Button (UI-SPEC deviation log locked)
  - Sonner Toaster wrapper with --color-status-* border-l mapping (dark + top-center)
  - Playwright E2E config + helpers + Wave 0 smoke spec
  - pnpm override unifying @types/react@19 across workspace
affects:
  - 10-01b (AppShell consumes atoms + Sonner)
  - 10-02 (ProxySwitcher uses Popover + DropdownMenu)
  - 10-03 (SessionList uses Dialog + DropdownMenu + ScrollArea)
  - 10-04 (Chat JSON view uses Command + Avatar + Badge + Sheet + Separator + all downstream E2E)
  - 10-05 (Chat PTY reuses atoms + helpers)
  - 10-06 (Split-pane uses Separator + E2E helpers)

# Tech tracking
tech-stack:
  added:
    - sonner@2.0.7 (Toaster root)
    - cmdk@1.1.1 (Command palette + slash picker backbone)
    - @playwright/test@1.52.0 (E2E runner, devDep)
    - new @radix-ui/react-* peer deps pulled via shadcn atoms
  patterns:
    - "pnpm.overrides 锁定 @types/react@19 统一版本，避免 monorepo 中 Taro 带入的 @types/react@18 干扰 cmdk 类型解析"
    - "shadcn atom 主题走 CSS 变量而非 Tailwind hex literal，支持未来 light/dark 双轨"
    - "Sonner toastOptions.classNames 用 !border-l- 前缀强制覆盖默认样式，保持状态色语义唯一"

key-files:
  created:
    - apps/web/src/components/ui/dialog.tsx
    - apps/web/src/components/ui/sheet.tsx
    - apps/web/src/components/ui/tooltip.tsx
    - apps/web/src/components/ui/popover.tsx
    - apps/web/src/components/ui/scroll-area.tsx
    - apps/web/src/components/ui/textarea.tsx
    - apps/web/src/components/ui/badge.tsx
    - apps/web/src/components/ui/avatar.tsx
    - apps/web/src/components/ui/separator.tsx
    - apps/web/src/components/ui/select.tsx
    - apps/web/src/components/ui/dropdown-menu.tsx
    - apps/web/src/components/ui/sonner.tsx
    - apps/web/src/components/ui/command.tsx
    - apps/web/playwright.config.ts
    - apps/web/e2e/helpers.ts
    - apps/web/e2e/smoke.spec.ts
    - apps/web/src/__tests__/unit/theme-tokens.test.ts
  modified:
    - apps/web/src/app.css
    - apps/web/src/components/ui/button.tsx
    - apps/web/package.json
    - package.json
    - pnpm-lock.yaml

key-decisions:
  - "锁定 amber primary #D4A574 覆盖 Phase 7 teal (D-02)"
  - "radius 0.25rem -> 0.375rem (D-03)"
  - "Button label font-weight 500 -> 400 （typography 仅 400/600 契约）"
  - "Sonner 四状态走 --color-status-* CSS 变量 border-l-4 视觉锚"
  - "pnpm.overrides 统一 @types/react 到 19.x 消除 cmdk 类型冲突"
  - "shadcn 默认 sonner.tsx 模板（next-themes + 自引用循环）弃用，直接写 Phase 10 契约版"

patterns-established:
  - "Atom 即契约：shadcn CLI 输出为起点；任何主题偏离必须统一写回 atom 而非在消费者 className 内覆盖"
  - "E2E 禁用 webServer 字段，由执行者手动起 dev server（避免并发 port 抢占，见 memory feedback_h5_testing）"
  - "Theme token vitest：对 app.css + atom 源码做字符串断言，防止后续误改主题"

requirements-completed:
  - FRONT-08
  - FRONT-03

# Metrics
duration: 18min
completed: 2026-04-17
---

# Phase 10 Plan 01a: shadcn atom set + amber theme + Playwright scaffolding Summary

**13 shadcn atoms installed, amber #D4A574 primary + 0.375rem radius + font-normal Button override applied, Sonner wrapper with --color-status-\* border-l mapping ready, Playwright E2E (mobile 390x844 + desktop 1280x800) scaffolded with smoke spec passing typecheck.**

## Performance

- **Duration:** ~18 min
- **Started:** 2026-04-17T13:07Z (worktree agent start)
- **Completed:** 2026-04-17T13:14Z
- **Tasks:** 3 code tasks complete (Task 4 checkpoint deferred to orchestrator-managed human-verify)
- **Files modified:** 21 (17 created + 4 modified)

## Accomplishments

- 13 shadcn atoms installed via `npx shadcn@latest add`, scaffolded Radix-backed new-york variant set
- Theme override layer (UI-SPEC Deviation Log rows) landed: `--primary`/`--ring` → `#D4A574`, `--radius` → `0.375rem`, Button cva base `font-medium` → `font-normal`
- `--color-status-success` preserved as `#00D4AA` teal per UI-SPEC Deviation Log (status dots + xterm cursor)
- Sonner wrapper rewritten to UI-SPEC contract: dark theme locked, top-center position, four status variants mapped to `--color-status-*` CSS vars via `border-l-4 !border-l-[var(...)]`
- Playwright config with mobile + desktop project matrix; `e2e/helpers.ts` exporting `BASE_URL` / `resetLocalState` / `getOnlineProxyId`; Wave 0 `smoke.spec.ts` baseline test
- pnpm workspace-level `@types/react` override stops React 18/19 dual resolution error in cmdk's d.ts (hoisted `@types/react@18.3.28` from Taro was shadowing `@types/react@19.2.14`)

## Task Commits

Each task committed atomically (worktree branch, `--no-verify` per parallel-executor contract):

1. **Task 1: Install shadcn atom set** — `f4e2175` (feat) — 13 atoms + pnpm override + stub sonner
2. **Task 2 RED: Failing theme-token tests** — `8cb607d` (test) — 10 vitest assertions against app.css/button/sonner
3. **Task 2 GREEN: Theme override apply** — `82e6398` (feat) — app.css amber/radius + button font-normal + sonner UI-SPEC rewrite
4. **Task 3: Playwright E2E scaffold** — `218ba90` (feat) — config + helpers + smoke spec + drop unused next-themes

No REFACTOR commit: Task 2 edits were already minimal-shape.

## Files Created/Modified

### shadcn atoms (13 created)
All under `apps/web/src/components/ui/`:
- `dialog.tsx`, `sheet.tsx`, `tooltip.tsx`, `popover.tsx`, `scroll-area.tsx`, `textarea.tsx`, `badge.tsx`, `avatar.tsx`, `separator.tsx`, `select.tsx`, `dropdown-menu.tsx`, `command.tsx` — stock shadcn new-york output, `data-slot` preserved, `cn()` from `@/lib/utils`
- `sonner.tsx` — Phase 10 契约版（非 shadcn 原生模板）

### Theme sources
- `apps/web/src/app.css` — `:root` 内三行变更：`--primary` `#00D4AA → #D4A574`；`--ring` 同步；`--radius` `0.25rem → 0.375rem`。其他 token、`@theme inline` block、`@theme` block、body 保持不动。
- `apps/web/src/components/ui/button.tsx` L8 — cva base `font-medium → font-normal`，其它 class 原样保留。

### Testing infra
- `apps/web/playwright.config.ts` — 无 webServer，mobile/desktop 两 project
- `apps/web/e2e/helpers.ts` — `BASE_URL`、`resetLocalState`、`getOnlineProxyId`
- `apps/web/e2e/smoke.spec.ts` — body visible baseline
- `apps/web/src/__tests__/unit/theme-tokens.test.ts` — 10 个 theme token 断言（RED/GREEN 门证据）

### Infra / meta
- `package.json` — `pnpm.overrides` 注入 `@types/react@^19.1.6`、`@types/react-dom@^19.1.6`
- `apps/web/package.json` — 新增 sonner/cmdk/@playwright/test 依赖；新增 `test:e2e` script；移除未使用的 next-themes
- `pnpm-lock.yaml` — 锁文件同步

## Token Override Diffs

| Token | Before (Phase 7) | After (Plan 10-01a) |
|-------|------------------|---------------------|
| `--primary` | `#00D4AA` | `#D4A574` |
| `--ring` | `#00D4AA` | `#D4A574` |
| `--radius` | `0.25rem` | `0.375rem` |
| `--color-status-success` | `#00D4AA` | `#00D4AA` (preserved — Deviation Log) |
| Button cva base | `font-medium` | `font-normal` |
| Sonner `theme` | (CLI 默认 `system`) | `"dark"` (锁定) |
| Sonner `position` | (CLI 默认 `bottom-right`) | `"top-center"` |

## Radix Umbrella Conflict Resolution

**Outcome:** Kept `radix-ui@^1.4.3` umbrella. All shadcn atoms use `import { X as XPrimitive } from "radix-ui"` namespace (CLI default for new-york + radix-ui umbrella present in components.json deps). No duplicate-identifier TS errors surfaced after CLI install. `typecheck` clean after `@types/react` override.

**What we did NOT need:** Did not strip `Slot` import in button.tsx; did not uninstall umbrella. Task 1 `<action>` step 2's fallback path was not triggered.

## Decisions Made

- **@types/react override at workspace root** over per-package `typeRoots` — single source of truth, avoids per-package drift. Feishu (archived per PROJECT.md) tolerates React 19 types (its Taro runtime uses React 18 peer but TS consumes whatever hoists; archive status means type drift here is tolerable).
- **Discarded shadcn CLI's default sonner.tsx template** — circular self-import + next-themes runtime dependency contradict D-04 (dark-only). Rewrote as direct `sonner` re-export wrapping per UI-SPEC Sonner mapping rather than trying to patch incrementally.
- **Vitest content-assertion tests over CSS runtime render tests** for theme tokens — Tailwind v4's `@theme inline` block resolves at build time; runtime `getComputedStyle` in jsdom doesn't evaluate Tailwind macros. String-matching `:root` values is a higher-fidelity contract than a rendered-DOM check.

## Deviations from Plan

Three auto-fixes applied during execution. All necessary for acceptance criteria to hold.

### Auto-fixed Issues

**1. [Rule 3 - Blocking] shadcn CLI writing to literal `@/` directory instead of `src/`**
- **Found during:** Task 1 after running `npx shadcn@latest add`
- **Issue:** shadcn CLI resolves path aliases from the nearest `tsconfig.json`. The root `tsconfig.json` has no `paths` field (only references), so CLI fell back to treating `@/components/ui/*` as literal path, creating `apps/web/@/components/ui/*.tsx`.
- **Fix:** `mv apps/web/@/components/ui/*.tsx apps/web/src/components/ui/` then `rmtrash -r apps/web/@/`
- **Files affected:** all 13 atoms moved to intended location
- **Verification:** `ls apps/web/src/components/ui/ | wc -l` = 14
- **Committed in:** `f4e2175` (Task 1 commit)

**2. [Rule 3 - Blocking] worktree missing node_modules + shared dist**
- **Found during:** Task 1 pre-typecheck (fresh worktree had never run `pnpm install`)
- **Issue:** Shared package emits to `packages/shared/dist/`, and web's type import depends on it. `pnpm --filter web typecheck` errored on every `@cc-anywhere/shared` import.
- **Fix:** Ran `pnpm install --ignore-scripts` then `pnpm --filter @cc-anywhere/shared build`.
- **Verification:** typecheck passes after.
- **Committed in:** lockfile change folded into `f4e2175`.

**3. [Rule 3 - Blocking] @types/react 18/19 dual resolution in cmdk**
- **Found during:** Task 1 typecheck after shadcn install
- **Issue:** `src/components/ui/command.tsx(54,11): error TS2322: Type 'React.ReactNode' is not assignable to type 'import("...@types+react@18.3.28...").ReactNode'. Type 'bigint' is not assignable to type 'ReactNode'.` cmdk's dts imports `react`; pnpm-hoisted `@types/react@18.3.28` (brought in by feishu's Taro) was shadowing web's `@types/react@19.2.14` when TS walked from cmdk's node_modules location.
- **Fix:** Added `pnpm.overrides` at workspace root to force `@types/react: ^19.1.6` + `@types/react-dom: ^19.1.6`.
- **Verification:** `pnpm --filter web typecheck` exits 0; `cat node_modules/.pnpm/node_modules/@types/react/package.json` shows 19.2.14.
- **Committed in:** `f4e2175` (Task 1 commit).

**4. [Rule 3 - Blocking] shadcn CLI's sonner.tsx contains circular self-import + next-themes dep**
- **Found during:** Task 1 typecheck (after fixes 1-3)
- **Issue:** CLI-generated `sonner.tsx` has `import { Toaster as Sonner, type ToasterProps } from "@/components/ui/sonner"` — that's an import of itself. Also uses `useTheme` from `next-themes` which we don't want (D-04 dark-lock).
- **Fix:** Replaced with minimal `Toaster` passthrough stub in Task 1 to unblock typecheck, then Task 2 overwrote with UI-SPEC contract version (theme=dark, position=top-center, four color-status-* border-l mappings).
- **Verification:** `pnpm --filter web typecheck` clean; theme-token tests (10/10) pass.
- **Committed in:** `f4e2175` (stub) then `82e6398` (UI-SPEC rewrite).

**5. [Rule 1 - Cleanup] Removed unused next-themes dependency**
- **Found during:** Task 3 package.json review
- **Issue:** shadcn CLI had added `next-themes` to web deps for its default sonner.tsx. Our rewrite doesn't use it.
- **Fix:** `pnpm --filter web remove next-themes`.
- **Verification:** `grep -rn next-themes apps/web/src/` returns empty.
- **Committed in:** `218ba90` (Task 3 commit).

---

**Total deviations:** 5 auto-fixed (4 × Rule 3 blocking, 1 × Rule 1 cleanup)
**Impact on plan:** All fixes necessary to hit acceptance criteria. No scope creep — all changes within files the plan explicitly listed.

## Issues Encountered

- Typecheck error from cmdk's d.ts under dual `@types/react` — documented above as Deviation #3.

## Visual Checkpoint Status (Task 4)

Task 4 is a `checkpoint:human-verify` blocking gate. In parallel worktree execution mode, this worktree agent cannot directly interact with the user. The code state is ready for visual verification by the orchestrator / user:

**Ready for verification after orchestrator merges worktree:**
1. Start dev server: `pnpm --filter web dev` (http://localhost:5173)
2. Open Token Showcase: `http://localhost:5173/#/tokens`
3. Viewport matrix: mobile 390x844 + desktop 1280x800
4. Cross-reference against 10-UI-SPEC.md six dimensions (Color / Typography / Spacing / States / Copy / Responsive)
5. Confirm:
   - `--primary` swatch = amber `#D4A574` (not teal)
   - `--color-status-success` dot = teal `#00D4AA` (Deviation Log preserved)
   - Button label weight = 400
   - `rounded-md` = 6px (from `--radius: 0.375rem`)
6. Run smoke test: `pnpm --filter web exec playwright test smoke --project=desktop`

Plan frontmatter `autonomous: false` + Task 4's blocking gate mean the user's approval is still required before this plan is considered fully complete. The orchestrator is expected to schedule that verification once all Wave 1 worktrees merge.

## User Setup Required

None — no external service configuration.

## Next Phase Readiness

- **10-01b ready to consume:** All 14 atoms (13 new + existing Button) importable; theme tokens stable; Sonner `<Toaster/>` ready to mount in AppShell.
- **10-02 / 10-03 ready:** Popover / DropdownMenu / Dialog / Sheet / ScrollArea / Command available.
- **10-04 / 10-05 ready:** Command / Avatar / Badge / Separator / Textarea available; e2e helpers ready to import.
- **10-06 ready:** Separator atom + e2e/helpers.ts contract stable.

**Blockers:** None that block downstream plans. Visual verification (Task 4) is orthogonal to code consumption.

## Self-Check: PASSED

File existence (worktree absolute paths):
- `.planning/phases/10-pages-components-migration/10-01a-SUMMARY.md` — FOUND (this file)
- `apps/web/src/components/ui/dialog.tsx` — FOUND
- `apps/web/src/components/ui/sheet.tsx` — FOUND
- `apps/web/src/components/ui/tooltip.tsx` — FOUND
- `apps/web/src/components/ui/popover.tsx` — FOUND
- `apps/web/src/components/ui/scroll-area.tsx` — FOUND
- `apps/web/src/components/ui/textarea.tsx` — FOUND
- `apps/web/src/components/ui/badge.tsx` — FOUND
- `apps/web/src/components/ui/avatar.tsx` — FOUND
- `apps/web/src/components/ui/separator.tsx` — FOUND
- `apps/web/src/components/ui/select.tsx` — FOUND
- `apps/web/src/components/ui/dropdown-menu.tsx` — FOUND
- `apps/web/src/components/ui/sonner.tsx` — FOUND
- `apps/web/src/components/ui/command.tsx` — FOUND
- `apps/web/playwright.config.ts` — FOUND
- `apps/web/e2e/helpers.ts` — FOUND
- `apps/web/e2e/smoke.spec.ts` — FOUND

Commits:
- `f4e2175` (Task 1) — verified
- `8cb607d` (Task 2 RED) — verified
- `82e6398` (Task 2 GREEN) — verified
- `218ba90` (Task 3) — verified

---
*Phase: 10-pages-components-migration*
*Completed: 2026-04-17*
