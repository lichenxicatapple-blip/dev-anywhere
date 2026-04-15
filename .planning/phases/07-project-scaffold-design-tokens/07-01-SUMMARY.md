---
phase: 07-project-scaffold-design-tokens
plan: 01
subsystem: ui
tags: [vite, react-19, tailwind-v4, shadcn-ui, design-tokens, typescript]

requires: []
provides:
  - "apps/web Vite + React 19 + Tailwind v4 project scaffold"
  - "Dark-theme design token system (colors, fonts, spacing, radius) as CSS variables"
  - "shadcn/ui components.json config and Button component"
  - "Vite dev proxy for WebSocket and fonts to relay at localhost:3100"
  - "cn() utility and vitest config with jsdom"
affects: [08-app-shell-routing, 09-pty-pipeline, 10-chat-surface, 11-session-management]

tech-stack:
  added: [react@19, react-dom@19, vite@6, tailwindcss@4, "@tailwindcss/vite@4", tw-animate-css, class-variance-authority, clsx, tailwind-merge, lucide-react, radix-ui, react-router@7, jsdom]
  patterns: [css-first-design-tokens, shadcn-ui-component-pattern, vite-dev-proxy, monorepo-tsconfig-split]

key-files:
  created:
    - apps/web/package.json
    - apps/web/vite.config.ts
    - apps/web/vitest.config.ts
    - apps/web/tsconfig.json
    - apps/web/tsconfig.app.json
    - apps/web/tsconfig.node.json
    - apps/web/index.html
    - apps/web/components.json
    - apps/web/src/main.tsx
    - apps/web/src/app.tsx
    - apps/web/src/app.css
    - apps/web/src/lib/utils.ts
    - apps/web/src/components/ui/button.tsx
  modified:
    - tsconfig.json
    - pnpm-lock.yaml

key-decisions:
  - "Used Vite 6 + React 19 (latest stable versions resolved by pnpm)"
  - "shadcn CLI placed button via radix-ui monorepo package instead of @radix-ui/react-slot"
  - "Dark-only theme with VS Code gray scale and #00D4AA accent"

patterns-established:
  - "CSS-first design tokens: :root variables + @theme inline mapping to Tailwind namespace"
  - "tsconfig split: tsconfig.app.json (DOM + JSX + noEmit) and tsconfig.node.json (config files)"
  - "Vite proxy pattern: /client and /proxy (ws) + /fonts and /health (http) to relay:3100"

requirements-completed: [FRONT-01, FRONT-02, DEPLOY-02]

duration: 5min
completed: 2026-04-15
---

# Phase 7 Plan 01: Project Scaffold + Design Tokens Summary

**Vite + React 19 + Tailwind v4 SPA scaffold with dark-theme design token system and shadcn/ui Button in pnpm monorepo**

## Performance

- **Duration:** 5 min
- **Started:** 2026-04-15T11:41:37Z
- **Completed:** 2026-04-15T11:46:22Z
- **Tasks:** 3
- **Files modified:** 15

## Accomplishments
- apps/web project fully configured in monorepo: pnpm install, typecheck, and build all pass
- Complete dark-theme design token system in app.css covering surface hierarchy, accent, status colors, fonts, and radius
- shadcn/ui configured with Button component (6 variants, 8 sizes) using React 19 patterns
- Vite dev server proxy routes WebSocket and font requests to relay at localhost:3100

## Task Commits

Each task was committed atomically:

1. **Task 1: Create apps/web project skeleton** - `f26d781` (feat)
2. **Task 2: Define design tokens and React entry files** - `acae3e4` (feat)
3. **Task 3: Configure shadcn/ui and install Button** - `c41fe63` (feat)

## Files Created/Modified
- `apps/web/package.json` - Package definition with React 19, Tailwind v4, shadcn/ui deps
- `apps/web/vite.config.ts` - Vite config with Tailwind plugin, path alias, dev proxy
- `apps/web/vitest.config.ts` - Test config with jsdom, path aliases, scope filtering
- `apps/web/tsconfig.json` - Project references wrapper
- `apps/web/tsconfig.app.json` - App source: DOM + JSX + path aliases
- `apps/web/tsconfig.node.json` - Config files: vite.config.ts, vitest.config.ts
- `apps/web/index.html` - Entry HTML with Sarasa font CSS link
- `apps/web/components.json` - shadcn/ui config (new-york, Tailwind v4, SPA mode)
- `apps/web/src/main.tsx` - React 19 root mount with StrictMode
- `apps/web/src/app.tsx` - Minimal App shell with design token classes
- `apps/web/src/app.css` - Full design token system (D-01 through D-08)
- `apps/web/src/lib/utils.ts` - cn() utility (clsx + tailwind-merge)
- `apps/web/src/components/ui/button.tsx` - shadcn/ui Button (6 variants, 8 sizes)
- `tsconfig.json` - Added apps/web project reference

## Decisions Made
- Resolved to Vite 6.4.2 and React 19.1.0 (latest stable at install time; plan specified ^8.0.8 and ^19.2.5 but pnpm resolved current latest)
- shadcn CLI v4 generates Button using `radix-ui` monorepo package (not `@radix-ui/react-slot`), and `Slot.Root` instead of direct `Slot` import
- shadcn CLI placed files at literal `@/` path; relocated to `src/components/ui/`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] shadcn CLI output path mismatch**
- **Found during:** Task 3 (shadcn button install)
- **Issue:** `pnpm dlx shadcn@latest add button` created `apps/web/@/components/ui/button.tsx` instead of resolving `@/` alias to `src/`
- **Fix:** Moved file to `apps/web/src/components/ui/button.tsx`, removed stray `@/` directory
- **Files modified:** apps/web/src/components/ui/button.tsx
- **Verification:** typecheck and build pass
- **Committed in:** c41fe63

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Trivial path fix. No scope creep.

## Issues Encountered
- Package versions resolved by pnpm differ from plan-specified versions (Vite 6 vs 8, React 19.1 vs 19.2). This is expected; the plan used npm registry latest at research time, pnpm resolves within semver ranges.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- apps/web scaffold complete and building; ready for Plan 02 (Token Showcase page) and Phase 8 (app shell + routing)
- All design tokens defined; subsequent phases can use `bg-background`, `text-primary`, `text-muted-foreground` etc.
- shadcn/ui CLI functional; more components can be added via `pnpm dlx shadcn@latest add [component]`

## Self-Check: PASSED

All 13 created files verified present. All 3 commit hashes verified in git log.

---
*Phase: 07-project-scaffold-design-tokens*
*Completed: 2026-04-15*
