---
phase: 10-pages-components-migration
plan: 01a
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/web/src/app.css
  - apps/web/src/components/ui/button.tsx
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
autonomous: false
requirements:
  - FRONT-08
  - FRONT-03
tags:
  - shadcn
  - theme
  - playwright
user_setup: []

must_haves:
  truths:
    - "13 shadcn atoms are installed and importable from @/components/ui/*"
    - "Primary color variable resolves to amber #D4A574 everywhere (not teal)"
    - "Border radius variable resolves to 0.375rem"
    - "Button label uses font-weight 400 not 500"
    - "Playwright can run a smoke test against the web dev server"
  artifacts:
    - path: "apps/web/src/components/ui/dialog.tsx"
      provides: "shadcn Dialog atom"
    - path: "apps/web/src/components/ui/sheet.tsx"
      provides: "shadcn Sheet atom"
    - path: "apps/web/src/components/ui/command.tsx"
      provides: "shadcn Command atom (cmdk wrapper)"
    - path: "apps/web/src/components/ui/sonner.tsx"
      provides: "Sonner Toaster wrapper"
    - path: "apps/web/src/app.css"
      provides: "Amber primary + 0.375rem radius + status tokens"
      contains: "#D4A574"
    - path: "apps/web/playwright.config.ts"
      provides: "Playwright baseURL + viewport projects (mobile 390x844 + desktop 1280x800)"
    - path: "apps/web/e2e/helpers.ts"
      provides: "resetLocalState + selectOnlineProxy helpers"
  key_links:
    - from: "apps/web/src/components/ui/button.tsx"
      to: "app.css --primary"
      via: "bg-primary class resolves via @theme inline block"
      pattern: "bg-primary"
    - from: "apps/web/src/components/ui/sonner.tsx"
      to: "--color-status-*"
      via: "toastOptions.classNames border-l CSS var reference"
      pattern: "color-status-"
---

<objective>
Install the full shadcn atom set (13 components), apply Phase 10 theme overrides (amber primary, 0.375rem radius, Button font-weight 400), and scaffold Playwright E2E infrastructure for apps/web. This plan is the foundation — all later plans consume these atoms and assume the theme tokens resolve correctly.

Purpose: Single source of truth for design atoms + tokens before any business component is built. Prevents "each component rolls its own style" drift (CONTEXT D-META-02).

Output: 13 new shadcn atom files, 1 modified Button, 1 modified app.css (tokens), playwright config + e2e helpers. Visual checkpoint verifies tokens against 10-UI-SPEC.md.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/10-pages-components-migration/10-CONTEXT.md
@.planning/phases/10-pages-components-migration/10-UI-SPEC.md
@.planning/phases/10-pages-components-migration/10-RESEARCH.md
@.planning/phases/10-pages-components-migration/10-PATTERNS.md
@apps/web/src/components/ui/button.tsx
@apps/web/src/app.css

<interfaces>
<!-- Key token contract executor needs -->

From apps/web/src/app.css (current state, executor modifies):
```css
:root {
  --primary: #00D4AA;          /* L11, becomes #D4A574 */
  --primary-foreground: #1E1E1E;
  --ring: #00D4AA;             /* L22, becomes #D4A574 */
  --radius: 0.25rem;           /* L23, becomes 0.375rem */
  --color-status-working: #4FC1FF;
  --color-status-success: #00D4AA;  /* stays teal - xterm cursor + success dot */
  --color-status-warning: #E8AB5A;
  --color-status-error: #F44747;
}
```

From apps/web/src/components/ui/button.tsx L8 (current):
```tsx
"inline-flex ... text-sm font-medium whitespace-nowrap ..."
//                 ^^^^^^^^^^^ becomes font-normal
```

Target shadcn atoms installed under `apps/web/src/components/ui/`:
- dialog.tsx, sheet.tsx, tooltip.tsx, popover.tsx, scroll-area.tsx
- textarea.tsx, badge.tsx, avatar.tsx, separator.tsx, select.tsx
- dropdown-menu.tsx, sonner.tsx, command.tsx

Playwright config target (new `apps/web/playwright.config.ts`):
```ts
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  projects: [
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, hasTouch: true } },
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
  ],
});
```

e2e/helpers.ts exports (new `apps/web/e2e/helpers.ts`):
- `resetLocalState(page: Page): Promise<void>` — clears cc_* keys + reloads
- `selectOnlineProxy(page: Page): Promise<string>` — reads window.__APP_STATE for proxies (or mocks) and returns proxyId
- `BASE_URL` constant reading env var `WEB_BASE_URL` with default `http://localhost:5173`
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Install shadcn atoms + verify radix dep coexistence</name>
  <files>
    apps/web/package.json,
    apps/web/src/components/ui/dialog.tsx,
    apps/web/src/components/ui/sheet.tsx,
    apps/web/src/components/ui/tooltip.tsx,
    apps/web/src/components/ui/popover.tsx,
    apps/web/src/components/ui/scroll-area.tsx,
    apps/web/src/components/ui/textarea.tsx,
    apps/web/src/components/ui/badge.tsx,
    apps/web/src/components/ui/avatar.tsx,
    apps/web/src/components/ui/separator.tsx,
    apps/web/src/components/ui/select.tsx,
    apps/web/src/components/ui/dropdown-menu.tsx,
    apps/web/src/components/ui/sonner.tsx,
    apps/web/src/components/ui/command.tsx,
    pnpm-lock.yaml
  </files>
  <read_first>
    - apps/web/components.json (verify existing shadcn config: style=new-york, baseColor=neutral)
    - apps/web/src/components/ui/button.tsx (CVA pattern + data-slot convention)
    - apps/web/package.json (check if radix-ui umbrella 1.4.3 conflicts with new @radix-ui/react-* subpackages)
    - .planning/phases/10-pages-components-migration/10-RESEARCH.md §2.9 (shadcn install + radix peer deps verified 2026-04-17)
    - .planning/phases/10-pages-components-migration/10-PATTERNS.md L120-L156 (shadcn atom CVA pattern)
    - .planning/phases/10-pages-components-migration/10-UI-SPEC.md "Component Inventory" (allowed variants list)
  </read_first>
  <action>
    Run `cd apps/web && npx shadcn@latest add dialog sheet tooltip popover scroll-area textarea badge avatar separator select dropdown-menu sonner command` from repo root. The CLI reads `apps/web/components.json` (style=new-york, baseColor=neutral, cssVariables=true) and writes each component file to `apps/web/src/components/ui/`. Also installs @radix-ui/react-* subpackages + cmdk + sonner via pnpm.

    After install, verify:
    1. All 13 files exist under `apps/web/src/components/ui/`.
    2. Run `pnpm --filter web typecheck` — must exit 0. If umbrella `radix-ui@1.4.3` (already listed in package.json) conflicts with new subpackages, remove the umbrella import from button.tsx L3 (change `import { Slot } from "radix-ui"` to `import { Slot } from "@radix-ui/react-slot"`) and uninstall umbrella via `pnpm --filter web remove radix-ui`. Do NOT leave the umbrella if typecheck reports duplicate identifier errors.
    3. Each atom uses `data-slot="<name>"` attribute (Radix A11y contract).
    4. Each atom uses `cn()` from `@/lib/utils` and exports both the component and its `*Variants` cva function (where applicable).

    Do NOT handwrite any atom. Do NOT re-implement existing shadcn output. If the CLI produces `font-medium` in Button or other weights elsewhere, leave it for Task 2.

    Commit message: `feat(10-01a): install shadcn atom set`
  </action>
  <verify>
    <automated>pnpm --filter web typecheck 2>&1 | tail -20</automated>
  </verify>
  <acceptance_criteria>
    - All 13 files exist: `ls apps/web/src/components/ui/{dialog,sheet,tooltip,popover,scroll-area,textarea,badge,avatar,separator,select,dropdown-menu,sonner,command}.tsx` returns 13 matches
    - `pnpm --filter web typecheck` exits 0
    - grep `data-slot` in apps/web/src/components/ui/dialog.tsx returns at least 1 match (Radix contract preserved)
    - grep `from "@/lib/utils"` in apps/web/src/components/ui/dialog.tsx returns 1 match (uses cn)
    - `pnpm --filter web list sonner cmdk` shows both resolved (sonner ≥ 2.0, cmdk ≥ 1.0)
    - No duplicate-identifier TS error involving radix-ui or @radix-ui/react-*
  </acceptance_criteria>
  <done>13 shadcn atoms installed, typecheck passes, radix subpackage conflicts resolved.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Apply theme override — amber primary + 0.375rem radius + Button font-weight + Sonner status colors</name>
  <files>
    apps/web/src/app.css,
    apps/web/src/components/ui/button.tsx,
    apps/web/src/components/ui/sonner.tsx
  </files>
  <read_first>
    - apps/web/src/app.css (current tokens at L4-L29 and @theme block L52-L59)
    - apps/web/src/components/ui/button.tsx L8 (current font-medium on CVA base string)
    - apps/web/src/components/ui/sonner.tsx (freshly installed by Task 1; before customization)
    - .planning/phases/10-pages-components-migration/10-UI-SPEC.md §Color (reserved accent list), §Typography (weight contract: only 400 and 600), Deviation Log (table rows enumerating changes)
    - .planning/phases/10-pages-components-migration/10-PATTERNS.md L184-L230 (app.css + button + sonner override pattern)
    - .planning/phases/10-pages-components-migration/10-RESEARCH.md §2.6 (Sonner status color mapping)
  </read_first>
  <behavior>
    - Test 1: app.css contains `--primary: #D4A574;` and `--ring: #D4A574;` and `--radius: 0.375rem;`
    - Test 2: app.css still contains `--color-status-success: #00D4AA;` (teal preserved for status dots + xterm cursor, per UI-SPEC Deviation Log)
    - Test 3: Button base cva string contains `font-normal` (not `font-medium`)
    - Test 4: Sonner wrapper sets `theme="dark"`, `position="top-center"`, and `toastOptions.classNames` with `border-l-4 !border-l-[var(--color-status-error)]` for `error` variant
  </behavior>
  <action>
    Apply three concrete edits.

    **Edit A — apps/web/src/app.css:** Modify the `:root` block only. Change exactly these three lines:
    - L11 `--primary: #00D4AA;` → `--primary: #D4A574;`
    - L22 `--ring: #00D4AA;` → `--ring: #D4A574;`
    - L23 `--radius: 0.25rem;` → `--radius: 0.375rem;`

    Do NOT modify `--color-status-success: #00D4AA` (L26) — teal is reserved for status dot + xterm cursor per UI-SPEC Deviation Log. Do NOT touch `@theme inline` block (L31-L50), `@theme` block (L52-L59), or `body` block. Do NOT add new token names.

    **Edit B — apps/web/src/components/ui/button.tsx:** In the `buttonVariants` cva base string at L8, replace `font-medium` with `font-normal`. Single-word change. Preserve all other classes (text-sm, rounded-md, transition-all, etc.) exactly.

    **Edit C — apps/web/src/components/ui/sonner.tsx:** The shadcn CLI generates a minimal wrapper. Replace it with the UI-SPEC contract:
    ```tsx
    "use client";
    import { Toaster as SonnerToaster } from "sonner";

    export function Toaster() {
      return (
        <SonnerToaster
          theme="dark"
          position="top-center"
          toastOptions={{
            classNames: {
              toast: "bg-card text-foreground border border-border",
              success: "border-l-4 !border-l-[var(--color-status-success)]",
              error: "border-l-4 !border-l-[var(--color-status-error)]",
              warning: "border-l-4 !border-l-[var(--color-status-warning)]",
              info: "border-l-4 !border-l-[var(--color-status-working)]",
            },
          }}
        />
      );
    }
    ```
    Theme=dark is hardcoded (Phase 10 has no light toggle per D-04). Export only the `Toaster` component — actual `toast()` calls go through the legacy wrapper in Plan 10-01b.

    Per D-02 (overrides Phase 7 D-01) and D-03 (overrides Phase 7 radius).

    Commit message: `feat(10-01a): amber primary + 0.375rem radius + button/sonner theme override`
  </action>
  <verify>
    <automated>pnpm --filter web typecheck && grep -c "#D4A574" apps/web/src/app.css && grep -c "font-normal" apps/web/src/components/ui/button.tsx && grep -c "color-status-error" apps/web/src/components/ui/sonner.tsx</automated>
  </verify>
  <acceptance_criteria>
    - app.css line containing `--primary:` ends with `#D4A574;` (exact hex, no other value)
    - app.css line containing `--ring:` ends with `#D4A574;`
    - app.css line containing `--radius:` ends with `0.375rem;`
    - app.css still contains line `--color-status-success: #00D4AA;` (teal preserved)
    - button.tsx L8 contains `font-normal` (not `font-medium`)
    - button.tsx L8 does NOT contain `font-medium` anywhere in the cva base string
    - sonner.tsx contains `theme="dark"` and `position="top-center"` and all four border-l-4 classNames mapping to --color-status-* vars
    - `pnpm --filter web typecheck` exits 0
    - No `bg-[#D4A574]` or other hardcoded hex in any atom — all refs go through CSS vars
  </acceptance_criteria>
  <done>Theme tokens match UI-SPEC §Color + §Typography + Deviation Log exactly.</done>
</task>

<task type="auto">
  <name>Task 3: Scaffold Playwright config + e2e helpers</name>
  <files>
    apps/web/playwright.config.ts,
    apps/web/e2e/helpers.ts,
    apps/web/package.json
  </files>
  <read_first>
    - apps/feishu/playwright.config.ts (analog pattern, 10 lines)
    - apps/feishu/e2e/cold-start-navigation.spec.ts L8-L48 (helper shape: resetLocalState, getOnlineProxyId)
    - apps/web/package.json (to add playwright test script if missing)
    - .planning/phases/10-pages-components-migration/10-PATTERNS.md L230-L276 (playwright config + helpers pattern)
    - .planning/phases/10-pages-components-migration/10-RESEARCH.md §11 and §15 (test infrastructure + dev server port 5173)
    - .planning/phases/10-pages-components-migration/10-VALIDATION.md (Wave 0 Requirements list)
  </read_first>
  <action>
    **Edit A — apps/web/playwright.config.ts (new):**
    ```ts
    import { defineConfig } from "@playwright/test";

    const BASE_URL = process.env.WEB_BASE_URL ?? "http://localhost:5173";

    export default defineConfig({
      testDir: "./e2e",
      timeout: 30000,
      use: {
        baseURL: BASE_URL,
      },
      projects: [
        {
          name: "mobile",
          use: { viewport: { width: 390, height: 844 }, hasTouch: true },
        },
        {
          name: "desktop",
          use: { viewport: { width: 1280, height: 800 } },
        },
      ],
    });
    ```
    Rationale: mobile viewport for Plan 10-02 / 10-04 tests; desktop viewport for master-detail (10-01b, 10-03) and split-pane (10-06). Do NOT set `webServer` — executor starts `pnpm --filter web dev` manually (memory `feedback_h5_testing.md`; port is 5173, not 5175).

    **Edit B — apps/web/e2e/helpers.ts (new):**
    ```ts
    import type { Page } from "@playwright/test";

    export const BASE_URL = process.env.WEB_BASE_URL ?? "http://localhost:5173";

    // 清理 localStorage cc_* 命名空间并刷新
    export async function resetLocalState(page: Page): Promise<void> {
      await page.evaluate(() => {
        const keys = Object.keys(localStorage).filter((k) => k.startsWith("cc_"));
        keys.forEach((k) => localStorage.removeItem(k));
      });
      await page.reload();
    }

    // 读取当前 proxy 列表（通过 window 暴露的 store hook）找到第一个 online proxy 的 id
    export async function getOnlineProxyId(page: Page): Promise<string | null> {
      return page.evaluate(() => {
        const w = window as unknown as { __APP_STORE__?: { getState: () => { proxies: Array<{ proxyId: string; online: boolean }> } } };
        const proxies = w.__APP_STORE__?.getState().proxies ?? [];
        return proxies.find((p) => p.online)?.proxyId ?? null;
      });
    }
    ```
    Note: `__APP_STORE__` hook requires app-store to expose itself on `window` in dev — Plan 10-01b adds that exposure. For now the helper returns null; Plan 10-01b's smoke test works on an unauth empty page.

    **Edit C — apps/web/package.json scripts:** If not present, add:
    ```json
    "test:e2e": "playwright test"
    ```
    Also ensure `@playwright/test` is a devDependency. If missing, run `pnpm --filter web add -D @playwright/test` first.

    **Smoke test placeholder — apps/web/e2e/smoke.spec.ts (new):**
    ```ts
    import { test, expect } from "@playwright/test";
    import { BASE_URL } from "./helpers";

    test("web app boots", async ({ page }) => {
      await page.goto(BASE_URL);
      // Basic boot check — SPA rendered something
      await expect(page.locator("body")).toBeVisible();
    });
    ```
    This satisfies Wave 0's baseline — later plans replace with real tests.

    Commit message: `feat(10-01a): playwright e2e scaffolding`
  </action>
  <verify>
    <automated>test -f apps/web/playwright.config.ts && test -f apps/web/e2e/helpers.ts && test -f apps/web/e2e/smoke.spec.ts && pnpm --filter web exec playwright --version</automated>
  </verify>
  <acceptance_criteria>
    - `apps/web/playwright.config.ts` exists and contains `testDir: "./e2e"`, `baseURL`, two projects (mobile + desktop)
    - `apps/web/e2e/helpers.ts` exists and exports `BASE_URL`, `resetLocalState`, `getOnlineProxyId`
    - `apps/web/e2e/smoke.spec.ts` exists and imports from `./helpers`
    - `apps/web/package.json` contains `"test:e2e": "playwright test"` script
    - `pnpm --filter web exec playwright --version` prints a version string (Playwright installed)
    - No `webServer` field in playwright.config.ts (per memory feedback_h5_testing.md)
  </acceptance_criteria>
  <done>Playwright runnable against running dev server; Plan 10-01b smoke test will pass on desktop viewport.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 4: Visual verification checkpoint — tokens + shadcn atoms vs UI-SPEC</name>
  <what-built>
    - 13 shadcn atoms installed under apps/web/src/components/ui/
    - Amber primary (#D4A574), 0.375rem radius applied
    - Button font-weight 400
    - Sonner wrapper with status color border-left
    - Playwright config + helpers + smoke test
  </what-built>
  <how-to-verify>
    1. Start dev server: `pnpm --filter web dev` (http://localhost:5173)
    2. Open the Token Showcase page: `http://localhost:5173/#/tokens`
    3. Use Playwright MCP (or browser DevTools) to capture screenshots at:
       - viewport 390x844 (mobile)
       - viewport 1280x800 (desktop)
    4. Cross-reference against 10-UI-SPEC.md six dimensions:
       - **Color:** primary swatch displays amber #D4A574 (not teal); muted-foreground #808080; status-success dot still teal #00D4AA
       - **Typography:** Button label renders weight 400 (compare to regular body text weight, not bolder); mono font is Sarasa Fixed SC fallback chain
       - **Spacing:** Button h-9 (36px default), rounded-md resolves to 6px (0.375rem), token-showcase cards use p-4 (16px)
       - **States:** Hover on Button primary → amber/90 (slightly darker); focus-visible ring is amber 3px
       - **Copy:** No copy changes in 10-01a
       - **Responsive:** Token showcase renders usable at both viewports (no horizontal scroll at 390px)
    5. Open a Dialog / Popover / Tooltip preview manually (can spawn via DevTools) and verify:
       - Dialog overlay color matches --background semi-transparent
       - Tooltip arrow direction + delay 500ms open feels right
       - Popover z-index does not clash (radix default 50)
    6. Run smoke test: `pnpm --filter web exec playwright test smoke --project=desktop` (dev server running) — must pass

    Attach screenshots + UI-SPEC checklist tick to the chat window.
  </how-to-verify>
  <resume-signal>Type "approved" to commit, or describe issues to fix</resume-signal>
  <files>N/A — checkpoint task, human verifies outputs from prior tasks</files>
  <action>Human-verification task. See <how-to-verify> above. This checkpoint has no executor action.</action>
  <verify>
    <automated>echo "checkpoint task — manual verification required"</automated>
  </verify>
  <done>User replies "approved" in chat, or describes required fixes.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| build-time → runtime | shadcn CLI fetches registry component code; executor must trust official shadcn registry (ui.shadcn.com) — no third-party registries per UI-SPEC Registry Safety table |
| npm registry → local | New peer dependencies (@radix-ui/react-*, cmdk, sonner) enter the build — standard supply chain, pinned via pnpm-lock.yaml |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-10-01a-01 | Tampering | shadcn CLI output | accept | Only official shadcn registry used (UI-SPEC Registry Safety); no third-party registries declared |
| T-10-01a-02 | Tampering | CSS token substitution at runtime | mitigate | All colors go through CSS variables (`--primary`, `--ring`); no hardcoded hex in components (enforced by acceptance criteria grep) |
| T-10-01a-03 | Information Disclosure | Playwright helpers exposing app state | accept | `__APP_STORE__` window exposure is dev-only (NODE_ENV !== production gate added in Plan 10-01b); e2e runs locally, not on production builds |
| T-10-01a-04 | Denial of Service | radix-ui umbrella vs subpackage conflict breaking build | mitigate | Task 1 explicit verification step: typecheck gate + optional umbrella removal |
</threat_model>

<verification>
- `pnpm --filter web typecheck` exits 0 after all three tasks complete
- `ls apps/web/src/components/ui/ | wc -l` returns at least 14 (13 new + existing button.tsx)
- Token values in app.css match UI-SPEC Deviation Log row-for-row
- Smoke test passes: `pnpm --filter web exec playwright test smoke --project=desktop`
- User approval recorded in chat before final commit
</verification>

<success_criteria>
- 13 shadcn atoms importable from `@/components/ui/*`
- Amber primary `#D4A574` applied to `bg-primary`, `ring-ring` throughout app (verifiable by clicking existing Button on Token Showcase)
- Border radius `0.375rem` applied via `rounded-md`
- Button label weight is 400 (compare visually to sans body text)
- Sonner Toaster configured but not yet mounted (Plan 10-01b mounts in AppShell)
- Playwright config + helpers ready for all downstream plan E2E tests
- User explicitly approved visual match against 10-UI-SPEC.md six dimensions
</success_criteria>

<output>
After completion, create `.planning/phases/10-pages-components-migration/10-01a-SUMMARY.md` with:
- List of 13 shadcn atom files created
- Token override diffs (before/after for --primary, --ring, --radius)
- radix umbrella conflict resolution outcome (kept or removed)
- Visual checkpoint screenshot links (Playwright MCP captures)
- Any Deviation from UI-SPEC (should be zero; if nonzero, escalate to UI-SPEC update)
</output>
