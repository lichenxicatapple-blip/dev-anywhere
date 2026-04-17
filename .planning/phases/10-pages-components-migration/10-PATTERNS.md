# Phase 10: Pages + Components Migration — Pattern Map

**Mapped:** 2026-04-17
**Files analyzed:** ~60 new / 14 modified across 7 plans (10-01a, 10-01b, 10-02, 10-03, 10-04, 10-05, 10-06)
**Analogs found:** 55 / 60 (5 without close analog use RESEARCH.md + official shadcn patterns)

> **Downstream rule (planner):** Every plan action MUST reference the analog file + line range below. Executors copy concrete patterns, not prose. Feishu files listed are for `shape/props` reference only (per CONTEXT D-META-01) — never port Taro idioms (View/Text/ScrollView, safe-area-header, typewriter, modal).

---

## File Classification

### Plan 10-01a — shadcn + theme override (17 files)

| File | Role | Data Flow | Closest Analog | Match |
|------|------|-----------|----------------|-------|
| `apps/web/src/components/ui/dialog.tsx` | shadcn atom | declarative | shadcn registry (official) + `button.tsx` for CVA pattern | exact |
| `apps/web/src/components/ui/sheet.tsx` | shadcn atom | declarative | shadcn registry + `button.tsx` | exact |
| `apps/web/src/components/ui/tooltip.tsx` | shadcn atom | declarative | shadcn registry + `button.tsx` | exact |
| `apps/web/src/components/ui/popover.tsx` | shadcn atom | declarative | shadcn registry + `button.tsx` | exact |
| `apps/web/src/components/ui/scroll-area.tsx` | shadcn atom | declarative | shadcn registry + `button.tsx` | exact |
| `apps/web/src/components/ui/textarea.tsx` | shadcn atom | declarative | shadcn registry + `button.tsx` | exact |
| `apps/web/src/components/ui/badge.tsx` | shadcn atom | declarative | shadcn registry + `button.tsx` | exact |
| `apps/web/src/components/ui/avatar.tsx` | shadcn atom | declarative | shadcn registry + `button.tsx` | exact |
| `apps/web/src/components/ui/separator.tsx` | shadcn atom | declarative | shadcn registry + `button.tsx` | exact |
| `apps/web/src/components/ui/select.tsx` | shadcn atom | declarative | shadcn registry + `button.tsx` | exact |
| `apps/web/src/components/ui/dropdown-menu.tsx` | shadcn atom | declarative | shadcn registry + `button.tsx` | exact |
| `apps/web/src/components/ui/sonner.tsx` | shadcn atom | event-driven | shadcn registry (Sonner `<Toaster>` wrapper) | exact |
| `apps/web/src/components/ui/command.tsx` | shadcn atom | event-driven | shadcn registry (cmdk wrapper) + `button.tsx` | exact |
| `apps/web/src/app.css` (modify) | config | — | `apps/web/src/app.css` (current) | exact |
| `apps/web/src/components/ui/button.tsx` (modify) | shadcn atom | declarative | `apps/web/src/components/ui/button.tsx` (self) | exact |
| `apps/web/playwright.config.ts` | config | — | `apps/feishu/playwright.config.ts` | exact |
| `apps/web/e2e/helpers.ts` | test utility | request-response | `apps/feishu/e2e/cold-start-navigation.spec.ts` (helper block L8-L48) | role-match |

### Plan 10-01b — AppShell + master-detail + Cmd+K + Sonner (9 files)

| File | Role | Data Flow | Closest Analog | Match |
|------|------|-----------|----------------|-------|
| `apps/web/src/components/shell/app-shell.tsx` | component (layout) | declarative | `apps/web/src/pages/pty-test.tsx` L153-L205 (header + main shell) | role-match |
| `apps/web/src/components/shell/sidebar.tsx` | component (layout) | declarative | (no analog — RESEARCH §2.10 pattern) | none |
| `apps/web/src/components/shell/empty-state.tsx` | component | declarative | `apps/feishu/src/components/empty-state/index.tsx` (shape only) | shape-ref |
| `apps/web/src/components/shell/command-palette.tsx` | component | event-driven | (no analog — RESEARCH §2.4 pattern) | none |
| `apps/web/src/app.tsx` (modify) | config (entry) | — | `apps/web/src/app.tsx` (self) | exact |
| `apps/web/src/lib/router.tsx` (modify) | config (routes) | — | `apps/web/src/lib/router.tsx` (self) | exact |
| `apps/web/src/components/toast.tsx` (rewrite) | utility | event-driven | `apps/web/src/stores/toast-store.ts` (API surface to preserve) | exact |
| `apps/web/src/stores/toast-store.ts` (delete) | — | — | — | delete |
| `apps/web/src/hooks/use-keyboard-shortcut.ts` | hook | event-driven | `apps/web/src/hooks/use-relay-setup.ts` (hook shape) | role-match |

### Plan 10-02 — ProxySelect (4 files)

| File | Role | Data Flow | Closest Analog | Match |
|------|------|-----------|----------------|-------|
| `apps/web/src/components/proxy/proxy-switcher.tsx` | component | request-response | `apps/web/src/pages/proxy-select.tsx` L5-L52 (handleSelect + render) | role-match |
| `apps/web/src/components/proxy/proxy-status-dot.tsx` | component | declarative | `apps/feishu/src/components/proxy-list-item/index.tsx` (shape only) + `pty-test.tsx` L157 dot pattern | shape-ref |
| `apps/web/src/pages/proxy-select.tsx` (rewrite) | page | request-response | `apps/web/src/pages/proxy-select.tsx` (self) | exact |
| `apps/web/e2e/proxy-switcher.spec.ts` | test | request-response | `apps/feishu/e2e/cold-start-navigation.spec.ts` L50+ | role-match |

### Plan 10-03 — SessionList (6 files)

| File | Role | Data Flow | Closest Analog | Match |
|------|------|-----------|----------------|-------|
| `apps/web/src/components/session/session-list.tsx` | component | CRUD | `apps/web/src/pages/session-list.tsx` L4-L27 + `useSessionStore` | role-match |
| `apps/web/src/components/session/session-row.tsx` | component | declarative | `apps/feishu/src/components/session-list-item/index.tsx` L20-L60 (shape only) | shape-ref |
| `apps/web/src/components/session/create-session-dialog.tsx` | component | request-response | (no analog — RESEARCH §4 + shadcn Dialog pattern) | none |
| `apps/web/src/pages/session-list.tsx` (rewrite) | page | CRUD | `apps/web/src/pages/session-list.tsx` (self) | exact |
| `apps/web/e2e/session-list.spec.ts` | test | CRUD | `apps/feishu/e2e/cold-start-navigation.spec.ts` | role-match |
| `apps/web/e2e/master-detail.spec.ts` | test | declarative | `apps/feishu/e2e/cold-start-navigation.spec.ts` | role-match |

### Plan 10-04 — Chat JSON mode (17 files)

| File | Role | Data Flow | Closest Analog | Match |
|------|------|-----------|----------------|-------|
| `apps/web/src/components/chat/chat-json-view.tsx` | component | streaming | RESEARCH §8.3 code example + `useChatStore` subscription | pattern-ref |
| `apps/web/src/components/chat/chat-header.tsx` | component | declarative | `apps/web/src/pages/pty-test.tsx` L156-L195 | role-match |
| `apps/web/src/components/chat/message-bubble.tsx` | component | declarative | `apps/feishu/src/components/assistant-bubble/` + `user-bubble/` (shapes) | shape-ref |
| `apps/web/src/components/chat/markdown-view.tsx` | component | transform | RESEARCH §2.7 config (safer than Feishu's marked) | pattern-ref |
| `apps/web/src/components/chat/tool-approval-card.tsx` | component | request-response | `apps/feishu/src/components/tool-approval-card/index.tsx` L1-L100 (shape + summarize logic) | role-match |
| `apps/web/src/components/chat/input-bar.tsx` | component | event-driven | `apps/feishu/src/components/input-bar/index.tsx` L1-L80 (pure helpers `detectPickerMode` / `hasValidAt` / `cleanupDeletedToken` verbatim-portable) | role-match |
| `apps/web/src/components/chat/slash-command-picker.tsx` | component | declarative | `apps/feishu/src/components/slash-command-picker/index.tsx` L1-L50 (filter logic) + RESEARCH §8.1 shadcn Command | role-match |
| `apps/web/src/components/chat/quote-preview-bar.tsx` | component | declarative | `apps/feishu/src/components/quote-preview-bar/index.tsx` (verbatim shape) | shape-ref |
| `apps/web/src/components/chat/file-path-picker.tsx` | component | request-response | `apps/feishu/src/components/file-path-picker/index.tsx` L1-L80 (filter + tree navigation) | role-match |
| `apps/web/src/components/chat/back-to-bottom.tsx` | component | declarative | `apps/feishu/src/components/back-to-bottom/index.tsx` (verbatim shape) | shape-ref |
| `apps/web/src/components/chat/status-line.tsx` | component | declarative | `apps/feishu/src/components/status-line/index.tsx` (verbatim shape) | shape-ref |
| `apps/web/src/pages/chat.tsx` (rewrite) | page | event-driven | `apps/web/src/pages/chat.tsx` (self) | exact |
| `apps/web/src/services/websocket.ts` (modify) | service | event-driven | `apps/web/src/services/websocket.ts` (self) L96-L103 dispatch point | exact |
| `apps/web/e2e/input-bar.spec.ts` | test | event-driven | `apps/feishu/e2e/cold-start-navigation.spec.ts` | role-match |
| `apps/web/e2e/file-picker.spec.ts` | test | request-response | `apps/feishu/e2e/cold-start-navigation.spec.ts` | role-match |
| `apps/web/e2e/tool-approval.spec.ts` | test | event-driven | `apps/feishu/e2e/cold-start-navigation.spec.ts` | role-match |
| `apps/web/e2e/follow-output.spec.ts` | test | streaming | `apps/feishu/e2e/terminal-scrollback.spec.ts` | role-match |

### Plan 10-05 — Chat PTY mode + raw-key (cross-package, 8 files)

| File | Role | Data Flow | Closest Analog | Match |
|------|------|-----------|----------------|-------|
| `apps/web/src/components/chat/chat-pty-view.tsx` | component | streaming | `apps/web/src/pages/pty-test.tsx` L13-L205 (verbatim xterm + subscription) | exact |
| `apps/web/src/lib/create-xterm.ts` | utility | — | `apps/web/src/pages/pty-test.tsx` L27-L68 (init block to extract) | exact |
| `apps/web/src/lib/ansi-keys.ts` | utility | transform | RESEARCH §8.2 code example | pattern-ref |
| `apps/web/src/lib/ansi-keys.test.ts` | test (unit) | transform | `apps/proxy/src/__tests__/unit/control-messages.test.ts` L19-L50 (vitest describe/it shape) | role-match |
| `apps/proxy/src/ipc-protocol.ts` (modify, option B only) | schema | — | `apps/proxy/src/ipc-protocol.ts` L92-L98 (`pty_input` schema) | exact |
| `apps/proxy/src/terminal.ts` (modify, option B only) | controller | request-response | `apps/proxy/src/terminal.ts` L131-L149 (IPC reader dispatch) | exact |
| `apps/proxy/src/serve.ts` (modify) | controller | request-response | `apps/proxy/src/serve.ts` L750-L777 (`user_input` PTY branch) | exact |
| `packages/shared/src/schemas/relay-control.ts` (modify) | schema | — | `packages/shared/src/schemas/relay-control.ts` L175-L176 (`session_terminate` pattern) | exact |
| `apps/proxy/src/__tests__/unit/remote-input-raw.test.ts` | test (unit) | request-response | `apps/proxy/src/__tests__/unit/control-messages.test.ts` L1-L100 | exact |

### Plan 10-06 — Split-pane + chat-store per-session (4 modified + 2 new)

| File | Role | Data Flow | Closest Analog | Match |
|------|------|-----------|----------------|-------|
| `apps/web/src/stores/chat-store.ts` (rewrite) | store | CRUD | `apps/web/src/stores/session-store.ts` (Map-like collection pattern) + `apps/web/src/stores/chat-store.ts` (self, per-session entries) | role-match |
| `apps/web/src/components/shell/split-pane.tsx` | component (layout) | declarative | (no analog — RESEARCH §2.12 + CSS grid) | none |
| `apps/web/src/components/chat/*` (modify consumers) | component | declarative | Existing `useChatStore` selectors → sessionId-scoped selector | exact |
| `apps/web/src/pages/chat.tsx` (modify) | page | event-driven | `apps/web/src/pages/chat.tsx` (self, URL query parsing) | exact |
| `apps/web/src/lib/router.tsx` (modify) | config | — | `apps/web/src/lib/router.tsx` (self) | exact |
| `apps/web/e2e/split-pane.spec.ts` | test | declarative | `apps/feishu/e2e/cold-start-navigation.spec.ts` | role-match |

---

## Pattern Assignments

### Plan 10-01a: shadcn atoms + theme override

#### All shadcn atoms (13 new files in `components/ui/`)

**Analog:** `apps/web/src/components/ui/button.tsx` (only existing shadcn atom)

**Pattern — CVA variants + `cn()` className merge** (button.tsx L7-L39):
```tsx
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 ...",
  {
    variants: {
      variant: { default: "bg-primary text-primary-foreground hover:bg-primary/90", ... },
      size: { default: "h-9 px-4 py-2 has-[>svg]:px-3", xs: "h-6 gap-1 rounded-md px-2 text-xs ...", ... },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
)
```

**Reuse requirements (executor MUST):**
- Use `npx shadcn@latest add <name>` to scaffold — do **not** handwrite; CLI produces correct Radix + styling glue
- After CLI scaffold, audit the class string for any `focus-visible:ring-*` literal and ensure it resolves to `var(--ring)` (amber after D-02 override); CLI output should already use `ring-ring` tokens
- Preserve `data-slot="<name>"` and `data-variant` attributes (Radix A11y relies on these)
- Export both the component and the `*Variants` cva function (executor may need `Variants` in tests or composition)
- Import `cn` from `@/lib/utils` (already exists — do not re-create)

**Anti-pattern warnings:**
- Do NOT handwrite these from scratch; shadcn CLI output is the contract
- Do NOT wrap Radix primitives with your own `forwardRef` layer unless the CLI output requires it (React 19's `React.ComponentProps` is the current idiom — see button.tsx L47)
- Do NOT import from `@radix-ui/react-<name>` namespace directly in business code; go through the shadcn atom

#### `sonner.tsx` — Toaster wrapper

**Analog:** shadcn registry Sonner + current `apps/web/src/components/toast.tsx` L3-L19 (fixed-position shell pattern)

**Pattern — status color mapping** (from RESEARCH §2.6):
```tsx
<Toaster
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
```

**Reuse requirements:**
- Theme = `dark` (hardcoded, Phase 10 has no light toggle per D-04)
- Status colors must reference CSS vars, not hex literals

---

#### `app.css` (modify) — D-02 amber + D-03 0.375rem + status tokens

**Analog:** `apps/web/src/app.css` (self, current state lines 4-29)

**Current values to change:**
```css
/* apps/web/src/app.css L11, L22, L23 — CURRENT */
--primary: #00D4AA;     /* line 11 */
--ring: #00D4AA;        /* line 22 */
--radius: 0.25rem;      /* line 23 */
```

**Target (CONTEXT D-02/D-03):**
```css
--primary: #D4A574;         /* amber — overrides Phase 7 teal */
--primary-foreground: #1E1E1E;
--ring: #D4A574;            /* focus ring matches primary */
--radius: 0.375rem;         /* tentative; finalize in visual polish */
```

**Reuse requirements:**
- Preserve the `:root` / `@theme inline` / `@theme` three-block structure (L4-L59); only swap values
- `--color-status-success` at L26 (currently `#00D4AA`) **stays teal** — UI-SPEC reserves teal for status-success and xterm cursor
- `--font-mono` at L54 already matches UI-SPEC — do not touch
- Do NOT introduce new token names (e.g. `--accent-amber`); override existing ones so shadcn atoms inherit automatically

**Anti-pattern warning:**
- Do not hard-code `#D4A574` inside any component's Tailwind class (`bg-[#D4A574]`). Always use `bg-primary` / `ring-ring` so future theme swaps propagate.

---

#### `button.tsx` (modify) — font-weight 400 override

**Analog:** `apps/web/src/components/ui/button.tsx` (self, L8)

**Current** (line 8): `font-medium` (= `500`)
**Target** (UI-SPEC typography contract): `font-normal` (= `400`)

**Pattern:** single-word replacement in the cva base string at L8.

**Reuse requirements:**
- Keep `text-sm` (14px per UI-SPEC typography body)
- Keep `rounded-md` — `--radius-md` resolves to `0.375rem` via the `@theme` block at `app.css` L56
- Do not introduce a `weight` variant — the contract allows only 400 or 600, and Button is always 400

---

#### `playwright.config.ts` (new)

**Analog:** `apps/feishu/playwright.config.ts` (full file — 10 lines)

**Pattern — minimal E2E config:**
```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  use: {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  },
});
```

**Reuse requirements:**
- `testDir: "./e2e"` matches `apps/web/e2e/*.spec.ts` pattern
- Add viewport matrix for desktop (1280x800) since Plan 10-01b master-detail and Plan 10-06 split-pane need ≥ md and ≥ lg breakpoints — extend `projects` array to include `mobile` (390x844) and `desktop` (1280x800)
- Do NOT set `webServer` — web is served via `pnpm --filter web dev` or `pnpm --filter web preview`; executor runs server manually (memory: `feedback_h5_testing.md`)

---

#### `e2e/helpers.ts` (new)

**Analog:** `apps/feishu/e2e/cold-start-navigation.spec.ts` L8-L48 (inline `getOnlineProxyId` helper)

**Pattern — localStorage reset + proxy selection helper:**
```ts
// From cold-start-navigation.spec.ts L11-L17 — reusable bootstrap pattern
async function resetLocalState(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem("cc_proxyId");
    localStorage.removeItem("cc_sessionId");
    localStorage.removeItem("cc_sessionMode");
  });
  await page.reload();
}
```

**Reuse requirements:**
- Extract the in-spec helpers from Feishu E2E into `helpers.ts` so 10-02/10-03/10-04/10-05/10-06 specs can import `resetLocalState`, `selectOnlineProxy`, `createSession` etc.
- Web hash-routing URL pattern: `http://localhost:<port>/#/` (not Taro's `/pages/proxy-select/index`) — update hash paths in helpers to match web's router definitions in `lib/router.tsx`
- Feishu ran on `localhost:5175`; web uses Vite default `5173` — make BASE_URL configurable via env

---

### Plan 10-01b: AppShell + master-detail + Cmd+K + Sonner

#### `shell/app-shell.tsx` (new)

**Analog:** `apps/web/src/pages/pty-test.tsx` L153-L205 (the only existing full-screen layout in web)

**Pattern — sticky header + flex-1 main** (pty-test.tsx L153-L163):
```tsx
<div className="flex flex-col h-screen bg-[var(--background)]">
  <div className="sticky top-0 z-10 flex items-center gap-2 px-4 h-12 bg-[var(--card)] border-b border-[var(--border)]">
    {/* status dot + text + actions */}
  </div>
  <div className="flex-1 overflow-auto">
    {/* content */}
  </div>
</div>
```

**Reuse requirements:**
- Replace `h-screen` with `h-dvh` (UI-SPEC viewport rule D-34)
- Header height `h-12` (48px) matches UI-SPEC spacing scale exactly — keep
- Sidebar is `md:` responsive-only (`<Sidebar className="hidden md:flex" />` from RESEARCH §2.10)
- Use CSS responsive classes, NOT `useMediaQuery`/JS width detection (RESEARCH §2.10 explicitly rejects JS approach)
- Wrap with `react-router` `<Outlet />` for nested routing (RESEARCH §2.10 code sample)
- Mount `<Toaster />` INSIDE `AppShell` root so route transitions don't unmount it (RESEARCH Risk 7)

**Anti-pattern warnings:**
- Do NOT use `use-screen-size` hook — CONTEXT D-35 explicitly drops it
- Do NOT write a `<SafeAreaHeader>` wrapper — use `env(safe-area-inset-*)` in CSS directly (CONTEXT D-31)

---

#### `shell/command-palette.tsx` (new)

**Analog:** none in repo — follow RESEARCH §2.4

**Pattern — shadcn Command + global Cmd+K capture** (RESEARCH §2.4):
```tsx
<CommandDialog open={open} onOpenChange={setOpen}>
  <CommandInput placeholder="搜索会话、proxy 或命令…" />
  <CommandList>
    <CommandGroup heading="会话">
      {sessions.map((s) => <CommandItem key={s.id}>{s.name}</CommandItem>)}
    </CommandGroup>
    <CommandGroup heading="动作">
      <CommandItem>新建会话</CommandItem>
    </CommandGroup>
  </CommandList>
</CommandDialog>
```

**Global keybind** (RESEARCH §2.4):
```tsx
useEffect(() => {
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      setCommandPaletteOpen(true);
    }
  };
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}, []);
```

**Reuse requirements:**
- Subscribe to `useAppStore` for proxies and `useSessionStore` for sessions (do not fetch — already in memory)
- Use placeholder text verbatim from UI-SPEC: `搜索会话、proxy 或命令…`

---

#### `app.tsx` (modify)

**Analog:** `apps/web/src/app.tsx` (self, full file L1-L14)

**Current:**
```tsx
export function App() {
  useRelaySetup();
  return (
    <>
      <RouterProvider router={router} />
      <Toast />
    </>
  );
}
```

**Target pattern:** wrap with AppShell route-level layout; Toast → Sonner `<Toaster />` already managed inside AppShell.

**Reuse requirements:**
- Keep `useRelaySetup()` at top (must run before any route renders)
- Remove `<Toast />` JSX — `<Toaster />` moves into `AppShell`
- Do not change the `<RouterProvider>` pattern; router config itself moves to use nested routes (see `router.tsx` below)

---

#### `lib/router.tsx` (modify)

**Analog:** `apps/web/src/lib/router.tsx` (self, full file)

**Current flat pattern** (L8-L14):
```tsx
export const router = createHashRouter([
  { path: "/", element: <ProxySelectPage /> },
  { path: "/sessions", element: <SessionListPage /> },
  { path: "/chat/:id", element: <ChatPage /> },
  { path: "/pty-test", element: <PtyTest /> },
  { path: "/tokens", element: <TokenShowcase /> },
]);
```

**Target — nested with AppShell parent** (RESEARCH §2.10):
```tsx
export const router = createHashRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <ProxySelectPage /> },
      { path: "sessions", element: <SessionListPage /> },
      { path: "chat/:id", element: <ChatPage /> },
    ],
  },
  { path: "/pty-test", element: <PtyTest /> },     // keep outside shell (debug page per D-41)
  { path: "/tokens", element: <TokenShowcase /> },  // keep outside shell
]);
```

**Reuse requirements:**
- `/pty-test` and `/tokens` stay OUTSIDE `AppShell` (CONTEXT D-41: `/pty-test` stays reachable standalone for PTY debugging)
- Use `createHashRouter` — do NOT switch to `createBrowserRouter` (Phase 8 D-04 locked hash routing for static hosting)

---

#### `components/toast.tsx` (rewrite) — Sonner wrapper with legacy API

**Analog — API surface to preserve:** `apps/web/src/stores/toast-store.ts` L12-L22 (`showToast` signature)
**Analog — Sonner wrapper pattern:** RESEARCH §2.6

**Pattern — preserve old API, replace backing store:**
```tsx
// apps/web/src/components/toast.tsx (new implementation)
import { Toaster, toast } from "sonner";
export { Toaster, toast };

// Legacy API used by phase-machine.ts and relay-client.ts — keep signatures identical
export function showToast(message: string) { toast(message); }
export function showErrorToast(message: string) { toast.error(message); }
export function showSuccessToast(message: string) { toast.success(message); }
export function showWarningToast(message: string) { toast.warning(message); }

export function useToast() {
  return { toast, dismiss: toast.dismiss };
}
```

**Reuse requirements:**
- Match the exported function names already in use: executor must `grep -r "useToastStore\|showToast" apps/web/src` and audit all call sites (RESEARCH Pitfall 5). Known call sites: `apps/web/src/services/phase-machine.ts` L77, L86.
- Delete `stores/toast-store.ts` entirely (do NOT leave a shim)
- phase-machine.ts must migrate from `useToastStore.getState().showToast(...)` to `showToast(...)` — Plan 10-01b required task, not "later"

---

### Plan 10-02: ProxySelect

#### `components/proxy/proxy-switcher.tsx` (new, layout="page"|"dropdown")

**Analog:** `apps/web/src/pages/proxy-select.tsx` L5-L52 (complete existing selection logic)

**Pattern — selectProxy call + localStorage + phase transition** (proxy-select.tsx L8-L18):
```tsx
async function handleSelect(proxyId: string, proxyName: string | undefined) {
  if (!relayClientRef) return;
  const result = await relayClientRef.selectProxy(proxyId);
  if (result.success) {
    localStorage.setItem("cc_proxyId", proxyId);
    useAppStore.getState().setProxy(proxyId, proxyName || null);
    useAppStore.getState().setProxyOnline(true);
    useAppStore.getState().transitionToPhase("session_browsing");
    router.navigate("/sessions");
  }
}
```

**Reuse requirements (D-10 dual layout):**
- Extract `handleSelect` verbatim into the new `ProxySwitcher` component; the existing page wires the data, both layouts just need different chromes
- `layout="page"` renders the mobile full-screen form (current proxy-select.tsx markup)
- `layout="dropdown"` renders a shadcn `Popover` + `Command` or `Select` (executor chooses per UI-SPEC Popover variant "bottom-start")
- Use proxies from `useAppStore` (already subscribed) — do NOT refetch
- Use `router.navigate("/sessions")` ONLY in `layout="page"`; in `layout="dropdown"`, selecting a proxy updates app-store but does not navigate (sidebar is already on sessions/chat page)

**Shape reference:** `apps/feishu/src/components/proxy-list-item/index.tsx` (19 lines) — row layout with name + online dot. Port visual structure, replace `<View>/<Text>` with `<div>/<span>`, keep CSS class naming hooks for e2e tests (`proxy-item`).

---

#### `components/proxy/proxy-status-dot.tsx` (new)

**Analog — dot visual pattern:** `apps/web/src/pages/pty-test.tsx` L157
```tsx
<div className={`w-2 h-2 rounded-full ${statusDotClass}`} />
// where statusDotClass = connected ? "bg-[var(--color-status-success)]" : "bg-[var(--muted-foreground)]";
```

**Reuse requirements:**
- 8px dot (UI-SPEC spacing: `w-2 h-2`)
- Status → color map:
  - `online` → `bg-[var(--color-status-success)]` (teal #00D4AA)
  - `offline` → `bg-[var(--muted-foreground)]`
  - `connecting` → `bg-[var(--color-status-working)]` (cyan #4FC1FF) + animate-pulse

---

#### `apps/web/e2e/proxy-switcher.spec.ts` (new)

**Analog:** `apps/feishu/e2e/cold-start-navigation.spec.ts` L50+ `test.describe` block
```ts
test.describe("proxy-switcher: page layout (mobile)", () => {
  test.beforeEach(async ({ page }) => {
    await resetLocalState(page);
    await page.goto(`${BASE_URL}/#/`);
  });
  test("selects online proxy and navigates to /sessions", async ({ page }) => { ... });
});
```

**Reuse requirements:**
- Viewport 390x844 for "page layout" test; 1280x800 for "dropdown layout" test
- Use helpers from `apps/web/e2e/helpers.ts` (Plan 10-01a scaffold)
- Assertion: `expect(page).toHaveURL(/sessions/)` + `localStorage.cc_proxyId` written

---

### Plan 10-03: SessionList

#### `components/session/session-list.tsx` (new, layout="page"|"sidebar")

**Analog:** `apps/web/src/pages/session-list.tsx` L4-L26 (current skeleton + store subscriptions)

**Pattern — store subscription shape:**
```tsx
const { sessions, currentSessionId } = useSessionStore();
```

**Reuse requirements (D-11 dual layout — mirrors D-10):**
- Extract list rendering into component; `page` layout = full-screen list (mobile), `sidebar` layout = compact 280px-wide left column (desktop)
- Click on a session row calls `useSessionStore.getState().setCurrentSession(id, mode)` AND `router.navigate(\`/chat/${id}?mode=${mode}\`, { replace: false })` (RESEARCH §2.10 D-15 pattern — URL updates without page transition under nested AppShell route)
- Selected state: amber 2px left bar + `amber/8` background (UI-SPEC component state table)
- Touch-target height: 44px mobile, 36px desktop (UI-SPEC spacing)

---

#### `components/session/session-row.tsx` (new)

**Analog — shape only:** `apps/feishu/src/components/session-list-item/index.tsx` L20-L60

**Reusable shape elements** (L22-L34):
```tsx
function StateDot({ state }: { state: SessionInfo["state"] }) {
  return <div className={`sli-state-dot sli-state-${state}`} />;
}
function ModeTag({ mode }: { mode: "pty" | "json" }) {
  return <div className={`sli-mode-tag sli-mode-${mode}`}>...</div>;
}
```

**Reuse requirements:**
- Port `StateDot` and `ModeTag` shapes but replace CSS with Tailwind + shadcn `Badge variant="secondary"` for mode tag (UI-SPEC component inventory)
- DO NOT port the swipe-to-terminate logic (L42-L60 touchStart/touchEnd handlers) — that's Taro-specific mobile interaction; web uses shadcn `DropdownMenu` "..." trigger (UI-SPEC)
- DO NOT use `<View>/<Text>` — use `<li>` inside `<nav>` for A11y (UI-SPEC accessibility baseline)
- Use `formatRelativeTime` utility — port the pure function from `apps/feishu/src/utils/relative-time.ts` (if Feishu has it) or RESEARCH §UI-SPEC for the time format contract (`<24h` relative, older absolute)

---

#### `components/session/create-session-dialog.tsx` (new)

**Analog:** no direct analog — combine shadcn `Dialog` pattern + `useSessionStore.addSession` + `relayClient.createSession`

**Reuse requirements (CONTEXT D-29):**
- 3 fields only: `name` (optional, placeholder: auto-generated), `mode` (radio: JSON | PTY), `cwd` (text input with FileWatcher path suggestions via `FilePathPicker`)
- Submit action: call `relayClientRef.createSession({ cwd, ... })` → on `session_create_response` → update session-store → close dialog → navigate to `/chat/:id`
- Do NOT include `permission mode` or `resume` fields — CONTEXT D-30 defers these to Chat settings menu
- Button label "创建" (UI-SPEC copywriting contract)

---

### Plan 10-04: Chat JSON mode

#### `components/chat/chat-json-view.tsx` (new) — virtualized message list + follow-output

**Analog:** RESEARCH §8.3 (complete reference implementation)

**Core pattern — `useVirtualizer` + scroll-based follow-output** (RESEARCH §8.3):
```tsx
const virtualizer = useVirtualizer({
  count: messages.length,
  getScrollElement: () => parentRef.current,
  estimateSize: () => 120,
  overscan: 5,
});

// Scroll tracking for follow-output freeze
useEffect(() => {
  const el = parentRef.current;
  if (!el) return;
  const onScroll = () => {
    const threshold = 50;
    setIsAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - threshold);
  };
  el.addEventListener("scroll", onScroll, { passive: true });
  return () => el.removeEventListener("scroll", onScroll);
}, []);

// Auto-scroll on new message or streaming growth
useEffect(() => {
  if (isAtBottom && messages.length > 0) {
    virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
  }
}, [messages.length, messages[messages.length - 1]?.text, isAtBottom]);
```

**Reuse requirements:**
- `overscan: 5` (RESEARCH §2.3 — default 1 causes streaming flicker)
- Use `passive: true` on scroll listener (RESEARCH §2.3)
- `measureElement` ref callback: `ref={virtualizer.measureElement}` NOT a prop (RESEARCH §2.3 highlights this common mistake)
- Guard against null parentRef on first render (RESEARCH Pitfall 1): use state `scrollElementReady` + render children conditionally
- Wrap `MessageBubble` with `React.memo` (RESEARCH Risk 6 — 1000+ messages perf)

**Anti-pattern warnings:**
- Do NOT use `IntersectionObserver` for isAtBottom — RESEARCH §2.3 explicitly rejects it
- Do NOT call `virtualizer.scrollToIndex` on every render — only when `isAtBottom && length change || last.text change`

---

#### `components/chat/markdown-view.tsx` (new)

**Analog — project's current approach:** `apps/feishu/src/components/markdown-view/index.tsx` L1-L47 (Feishu uses `marked` + inline-style hljs due to Taro RichText constraints — **do NOT port this approach to web**)

**Target pattern** (RESEARCH §2.7, CONTEXT D-25):
```tsx
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

<Markdown
  remarkPlugins={[remarkGfm]}
  rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
  skipHtml
  disallowedElements={["script", "iframe", "object", "embed"]}
  components={{
    a: ({ href, children, ...rest }) => (
      <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>{children}</a>
    ),
    code: ({ className, children, ...rest }) => {
      const isBlock = className?.includes("language-");
      if (isBlock) return <CodeBlock {...rest}>{children}</CodeBlock>;
      return <code {...rest}>{children}</code>;
    },
  }}
>{text}</Markdown>
```

**Reuse requirements:**
- `skipHtml` + `disallowedElements` both required (RESEARCH Pitfall 3 — XSS)
- Target language set: a subset of what Feishu registered (L5-L40) — for web with `rehype-highlight`, all languages are detected automatically (no per-language registration needed), but bundle size grows. Executor picks: limit via highlight.js custom bundle OR accept 50KB default.

**Anti-pattern warnings:**
- Do NOT use Feishu's `marked` + inline-style pattern (apps/feishu/src/components/markdown-view/index.tsx L48+ HLJS_STYLES) — that's a Taro RichText workaround
- Do NOT override default sanitization by removing `skipHtml` "for convenience" — XSS risk

---

#### `components/chat/input-bar.tsx` (new) — unified JSON + PTY InputBar

**Analog — pure helper functions directly portable:** `apps/feishu/src/components/input-bar/index.tsx` L15-L69

**Verbatim-portable helpers (no Taro deps):**
```ts
// L15-L25
export function computeSendDisabled(mode, isWorking, pendingApprovals) { ... }

// L28-L34: @-trigger detection
export function hasValidAt(val: string): boolean { ... }

// L38-L43: picker mode dispatch
export function detectPickerMode(val: string): PickerMode { ... }

// L46-L69: backspace-deletes-token cleanup
export function cleanupDeletedToken(val, prev, insertedTokens): { cleaned, removedToken } { ... }
```

**Reuse requirements:**
- Copy these four functions verbatim into `input-bar.tsx` or a sibling `input-bar-utils.ts` — they are pure and Taro-independent
- Replace the Taro `<Input>` with a shadcn `Textarea` + RESEARCH §2.11 auto-grow pattern (1-8 rows)
- Key handling (RESEARCH §2.11 key matrix): JSON mode ↑-empty = history recall; PTY mode ↑ always = raw ANSI `\x1b[A` via Plan 10-05's `ansi-keys.ts`
- History storage: localStorage key `cc_inputHistory:${sessionId}`, 100 entries FIFO (RESEARCH §2.11)
- Slash picker subscribes to `useCommandStore.commands` (Phase 8 already wires dynamic command source — RESEARCH §2.4 corrects memory's "hardcoded infeasible" concern; list is already dynamic)

**Anti-pattern warnings:**
- Do NOT hardcode the command list — subscribe to `useCommandStore`
- Do NOT wire textarea height recalc to `visualViewport` resize — RESEARCH Pitfall 4 (infinite resize loop); recalc only on `value` change

---

#### `components/chat/slash-command-picker.tsx` (new)

**Analog — filter logic:** `apps/feishu/src/components/slash-command-picker/index.tsx` L20-L24
**Analog — shadcn Command integration:** RESEARCH §8.1

**Pattern** (RESEARCH §8.1):
```tsx
<div className="absolute bottom-full left-0 right-0 mb-2 bg-popover border border-border rounded-md shadow-lg">
  <Command shouldFilter={false}>
    <CommandList>
      {commands.length === 0 && <CommandEmpty>没有匹配的命令</CommandEmpty>}
      {commands
        .filter((c) => c.name.toLowerCase().includes(filter.toLowerCase().replace(/^\//, "")))
        .map((cmd) => (
          <CommandItem key={cmd.name} value={cmd.name} onSelect={() => onSelect(cmd)}>
            <span className="font-mono">{cmd.name}</span>
            <span className="ml-auto text-xs text-muted-foreground">{cmd.description}</span>
          </CommandItem>
        ))}
    </CommandList>
  </Command>
</div>
```

**Reuse requirements:**
- `shouldFilter={false}` — external filter state driven from InputBar
- Popover positioning `absolute bottom-full` above InputBar
- Subscribe to `useCommandStore.commands` (dynamic source, Phase 8 wired)

---

#### `components/chat/file-path-picker.tsx` (new)

**Analog:** `apps/feishu/src/components/file-path-picker/index.tsx` L1-L80 (filter + tree navigation logic)

**Pattern — filter state + tree fetch** (L25-L41):
```tsx
const allEntries = tree.get(currentPath) || [];
const fileFilter = useMemo(() => {
  const afterAt = filter.split("@").pop() || "";
  const lastSlash = afterAt.lastIndexOf("/");
  return lastSlash >= 0 ? afterAt.slice(lastSlash + 1).toLowerCase() : afterAt.toLowerCase();
}, [filter]);
const entries = useMemo(() => {
  if (!fileFilter) return allEntries;
  return allEntries.filter((e) => e.name.toLowerCase().includes(fileFilter));
}, [allEntries, fileFilter]);
```

**Reuse requirements:**
- Filter computation verbatim (lines 27-33)
- Use `useFileStore().tree` + send `relayClient.sendControl({ type: "dir_list_request", path })` when path not in cache (RESEARCH §2.11)
- Replace `<View>/<ScrollView>` with `<div>/<ScrollArea>` (shadcn atom)
- Breadcrumb helper: port `buildBreadcrumbSegments` / `joinPath` from `apps/feishu/src/components/directory-picker/path-utils.ts` (pure functions) — D-27 integrates FileWatcher into this picker

---

#### `components/chat/tool-approval-card.tsx` (new)

**Analog:** `apps/feishu/src/components/tool-approval-card/index.tsx` L1-L100

**Pattern — resolved-state branching + summary** (L22-L55):
```tsx
const summary = summarizeToolInput(approval.toolName, approval.input);
const isResolved = approval.status !== "pending";

const handleAction = (action: () => void) => {
  if (acted || isResolved) return;
  setActed(true);
  action();
};

if (isResolved && approval.status === "denied") { return <DeniedMarker />; }
if (isResolved) { return <ApprovedCollapsedRow />; }
// else pending: show full card with 3 buttons
```

**Reuse requirements (CONTEXT D-22/D-23):**
- Port `summarizeToolInput` utility verbatim from `apps/feishu/src/utils/summarize-tool-input.ts` (pure function, no Taro)
- Three-button layout: `允许` (Allow) / `总是允许此工具` (Always Allow) / `拒绝` (Deny) — copy from UI-SPEC copywriting
- Keyboard shortcuts `y`/`a`/`n` active ONLY when card has focus (UI-SPEC A11y item 5 — don't hijack global typing)
- Session whitelist: `localStorage.setItem("cc_toolWhitelist:${sessionId}", JSON.stringify([...toolNames]))`
- `container="inline"` for JSON mode (embedded in virtualized message list), `container="floating"` for PTY mode (bottom-right offset 16px per UI-SPEC spacing)

**Anti-pattern warnings:**
- Do NOT port the `EditPreview/BashPreview/WritePreview/GenericPreview` sub-components verbatim — they use Taro `<View>/<Text>`; rewrite with Tailwind divs. Logic in `summarizeToolInput` stays.
- Do NOT use unified bottom Sheet — CONTEXT D-23 explicitly rejects this

---

#### `components/chat/quote-preview-bar.tsx` + `back-to-bottom.tsx` + `status-line.tsx` (new)

**Analogs (shape only, one-to-one):**
- `apps/feishu/src/components/quote-preview-bar/index.tsx` (26 lines verbatim shape)
- `apps/feishu/src/components/back-to-bottom/index.tsx` (19 lines verbatim shape)
- `apps/feishu/src/components/status-line/index.tsx` (15 lines verbatim shape)

**Reuse requirements:**
- Shapes are minimal; re-implement with Tailwind + shadcn rather than port
- `QuotePreviewBar`: source label `Claude:` / `You:` (L12) → UI-SPEC Chinese copy adaptation — executor should follow UI-SPEC copywriting; leave English for now if no Chinese contract
- `BackToBottom`: RESEARCH §2.3 ties this to `isAtBottom === false`; amber accent dot if new messages arrived while scrolled away (UI-SPEC "reserved accent use" item 5)
- `StatusLine`: UI-SPEC component inventory defines states `idle|working|reconnecting|error` — map to `--color-status-*` tokens

---

#### `services/websocket.ts` (modify)

**Analog:** `apps/web/src/services/websocket.ts` (self, L96-L103)

**Current dispatch point** (L96-L103):
```ts
ws.addEventListener("message", (event) => {
  if (event.data instanceof ArrayBuffer) {
    this.dispatchBinary(new Uint8Array(event.data));
  } else {
    const data = event.data as string;
    this.messageHandlers.forEach((h) => h(data));
  }
});
```

**Reuse requirements:**
- Chat-store wiring lives OUTSIDE `websocket.ts` — register a handler via `wsManager.onMessage(handler)` in a new `services/chat-dispatcher.ts` (or inside `use-relay-setup`). Handler does `JSON.parse` → zod `safeParse` → switch-on-type → call specific `chatStore.getSession(sessionId).appendAssistantText(...)` etc.
- Per-session dispatch (Plan 10-06 precondition): handler must extract `sessionId` from message envelope and call the sessionId-scoped slice of chat-store
- Do NOT modify `websocket.ts` core (text/binary split is already correct) — only register a new JSON handler

**Anti-pattern warning:**
- Do NOT add chat-specific logic inside `websocket.ts` — it's the transport layer; keep it generic. Dispatch lives in a dedicated module.

---

### Plan 10-05: Chat PTY mode + raw-key (cross-package)

#### `components/chat/chat-pty-view.tsx` (new)

**Analog:** `apps/web/src/pages/pty-test.tsx` L13-L205 (complete reference — CONTEXT D-41 keeps /pty-test alive)

**Pattern — xterm init + binary subscription** (pty-test.tsx L27-L79):
```tsx
const terminalRef = useRef<Terminal | null>(null);
const containerRef = useRef<HTMLDivElement>(null);
const unsubBinaryRef = useRef<(() => void) | null>(null);

useEffect(() => {
  let terminal: Terminal | null = null;
  const init = async () => {
    await document.fonts.ready;
    terminal = new Terminal({
      scrollback: 5000,
      fontFamily: '"Sarasa Fixed SC", "Noto Sans Mono CJK SC", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
      fontSize: 14,
      cursorBlink: false,
      cursorInactiveStyle: "none",
      disableStdin: true,
      theme: xtermTheme,
      allowProposedApi: true,
    });
    // ...addons, open, WebGL...
    terminalRef.current = terminal;
  };
  init();
  return () => { terminal?.dispose(); terminalRef.current = null; };
}, []);
```

**Subscription pattern** (pty-test.tsx L100-L135):
```tsx
const unsub = wsManagerRef.subscribeBinary(sessionId, (data) => {
  if (snapshotApplied) terminalRef.current?.write(data);
});
// ...after session_snapshot JSON received, terminal.reset() + resize() + write(snapshot.data), then snapshotApplied = true
```

**Reuse requirements (RESEARCH §2.8 — Phase 9 locked):**
- Extract lines 27-68 (`init` block) into `apps/web/src/lib/create-xterm.ts` — both `/pty-test.tsx` and `chat-pty-view.tsx` call it
- `disableStdin: true` stays (Plan 10-05 InputBar provides input via D-21 raw-key channel)
- `cursorAccent` in `xterm-theme.ts` stays `#00D4AA` teal — UI-SPEC Deviation Log explicitly preserves
- Copy subscription logic L88-L136 verbatim (session_subscribe send → session_snapshot wait → binary subscribe)

**Anti-pattern warnings:**
- Do NOT change any xterm option values (font, scrollback, theme) — Phase 9 D-40~D-44 locked
- Do NOT enable `disableStdin: false` — PTY input goes through D-21 raw channel, not xterm's native handling (CONTEXT D-28 and RESEARCH §2.8)

---

#### `lib/create-xterm.ts` (new)

**Analog:** `apps/web/src/pages/pty-test.tsx` L27-L68 (verbatim extract target)

**Pattern — factory returning terminal + addons + dispose:**
```ts
export async function createXtermTerminal(container: HTMLDivElement) {
  await document.fonts.ready;
  const terminal = new Terminal({ /* pty-test.tsx L33-L42 verbatim */ });
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(serializeAddon);
  terminal.loadAddon(new WebLinksAddon());
  terminal.loadAddon(new UnicodeGraphemesAddon());
  container.replaceChildren();
  terminal.open(container);
  try {
    terminal.loadAddon(new WebglAddon());
  } catch (err) {
    console.warn("WebGL addon failed, fallback to DOM renderer", err);
  }
  return { terminal, serializeAddon, dispose: () => terminal.dispose() };
}
```

**Reuse requirements:**
- After extraction, `pty-test.tsx` must be rewritten to call `createXtermTerminal(container)` — RESEARCH §2.8 reuse target
- WebGL load MUST be after `terminal.open()` (pty-test.tsx L58-L64 comment explains why)
- `allowProposedApi: true` required for `UnicodeGraphemesAddon` (pty-test.tsx L41)

---

#### `lib/ansi-keys.ts` (new)

**Analog:** RESEARCH §8.2 (complete reference implementation — 50 lines)

**Pattern — KeyboardEvent → ANSI sequence table** (RESEARCH §8.2):
```ts
export function mapKeyToAnsi(e: KeyboardEvent): string | null {
  const { key, ctrlKey, altKey, shiftKey } = e;

  if (ctrlKey && !altKey && key.length === 1) {
    const code = key.toUpperCase().charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCharCode(code - 64);
    if (key === " ") return "\x00";
  }
  if (altKey && !ctrlKey && key.length === 1) return "\x1b" + key;

  switch (key) {
    case "ArrowUp":    return "\x1b[A";
    case "ArrowDown":  return "\x1b[B";
    case "ArrowRight": return "\x1b[C";
    case "ArrowLeft":  return "\x1b[D";
    // ... full table in RESEARCH §8.2
    default: return null;
  }
}
```

**Reuse requirements:**
- Normal cursor key mode only (CONTEXT/RESEARCH §2.2 — DECCKM deferred)
- Return `null` for non-control keys (let textarea handle normal input)
- Full key table lives in RESEARCH §8.2 — port verbatim

---

#### `lib/ansi-keys.test.ts` (new, unit)

**Analog:** `apps/proxy/src/__tests__/unit/control-messages.test.ts` L1-L50 (vitest describe/it shape for pure functions)

**Pattern:**
```ts
import { describe, it, expect } from "vitest";
import { mapKeyToAnsi } from "./ansi-keys";

describe("mapKeyToAnsi", () => {
  it("maps ArrowUp to \\x1b[A", () => {
    const e = new KeyboardEvent("keydown", { key: "ArrowUp" });
    expect(mapKeyToAnsi(e)).toBe("\x1b[A");
  });
  it("maps Ctrl+C to \\x03", () => {
    const e = new KeyboardEvent("keydown", { key: "c", ctrlKey: true });
    expect(mapKeyToAnsi(e)).toBe("\x03");
  });
  it("returns null for plain letters", () => {
    const e = new KeyboardEvent("keydown", { key: "a" });
    expect(mapKeyToAnsi(e)).toBeNull();
  });
});
```

**Reuse requirements:**
- Cover every row of the RESEARCH §2.2 ANSI table
- Test both modifier combinations (Ctrl+A..Z, Alt+key, Shift+Tab)
- Run via `pnpm --filter web test ansi-keys` (RESEARCH §11 Test Map D-21)

---

#### `packages/shared/src/schemas/relay-control.ts` (modify) — new `remote_input_raw`

**Analog — existing simple control message shape:** L175-L176
```ts
z.object({ type: z.literal("session_terminate"), sessionId: z.string() }),
```

**Target — add new discriminant case inside `RelayControlSchema`:**
```ts
// client -> proxy: raw ANSI sequence for PTY (no trailing \r)
z.object({
  type: z.literal("remote_input_raw"),
  sessionId: z.string().min(1),
  data: z.string(),
}),
```

**Reuse requirements (RESEARCH §2.2 recommended plan A):**
- Insert the new case within the existing `z.discriminatedUnion("type", [...])` array (alphabetical-free — append is fine; schema `safeParse` walks all branches)
- `data` field holds the raw ANSI sequence produced by `mapKeyToAnsi`
- Export nothing new at module level — `RelayControlMessage` type auto-derives

**Anti-pattern warning:**
- Do NOT overload existing `pty_input`/`user_input` with a `raw: boolean` flag — RESEARCH §2.2 explicitly rejects this (schema single-responsibility, executor stays in type-safe branch)

---

#### `apps/proxy/src/serve.ts` (modify)

**Analog:** `apps/proxy/src/serve.ts` L765-L777 (existing PTY branch for `user_input`)

**Current (L765-L777):**
```ts
} else {
  const ts = terminalSockets.get(parsed.sessionId);
  if (ts?.writable) {
    ts.write(serializeIpc({
      type: "pty_input",
      sessionId: parsed.sessionId,
      data: (parsed.payload?.text ?? "") + "\r",
    }));
    logger.info({ sessionId: parsed.sessionId }, "Remote input forwarded to PTY terminal");
  }
}
```

**Target — new branch handling `remote_input_raw`** (RESEARCH §2.2 plan A):
```ts
} else if (parsed.type === "remote_input_raw" && parsed.sessionId) {
  const ts = terminalSockets.get(parsed.sessionId);
  if (ts?.writable) {
    ts.write(serializeIpc({
      type: "pty_input",
      sessionId: parsed.sessionId,
      data: parsed.data,    // no "\r" append — raw bytes as-is
    }));
    logger.info({ sessionId: parsed.sessionId, bytes: parsed.data.length }, "Raw PTY input forwarded");
  } else {
    logger.warn({ sessionId: parsed.sessionId }, "Raw PTY input dropped: terminal socket unavailable");
  }
}
```

**Reuse requirements:**
- Reuse the existing `pty_input` IPC message type (terminal.ts L133-L135 already writes bytes to `ptyManager.write(msg.data)` without appending — VERIFIED in RESEARCH §2.2)
- Plan A: `packages/shared` + `serve.ts` + `input-bar.tsx` are the only three files that change — `ipc-protocol.ts` and `terminal.ts` stay untouched
- Preserve `logger.info` / `logger.warn` pattern from adjacent branches for observability
- Insert between the existing `user_input` and `tool_approve` branches (after L777)

**Anti-pattern warning:**
- Do NOT dispatch into the existing `user_input` branch — its Semantics is "chat text + Enter"; raw channel is distinct

---

#### `apps/proxy/src/__tests__/unit/remote-input-raw.test.ts` (new)

**Analog:** `apps/proxy/src/__tests__/unit/control-messages.test.ts` L1-L100 (full structure)

**Pattern — mock session manager + assert serialized output:**
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { RelayControlSchema } from "@cc-anywhere/shared";

describe("remote_input_raw: envelope → IPC forwarding", () => {
  it("validates remote_input_raw schema", () => {
    const msg = { type: "remote_input_raw", sessionId: "abc", data: "\x1b[A" };
    const result = RelayControlSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });
  it("forwards raw bytes to terminal socket without trailing \\r", () => {
    // mock serve.ts dispatch pattern; assert written IPC payload.data === "\x1b[A"
  });
});
```

**Reuse requirements:**
- Mirror control-messages.test.ts style (vitest + schema + sent[] capture)
- Assert: `sent[0]` decoded JSON has `type === "pty_input"` and `data === "\x1b[A"` (no `\r` append)
- Do NOT boot real SessionManager; mock via control-messages.test.ts L8-L17 pattern

---

### Plan 10-06: Split-pane + chat-store per-session

#### `stores/chat-store.ts` (rewrite) — per-session Map

**Analog — Map-like collection pattern:** `apps/web/src/stores/session-store.ts` (full file, 60 lines — closest match for indexed entries)

**Pattern — collection keyed by id + mutation signatures** (session-store.ts L32-L43):
```ts
interface SessionStoreState {
  sessions: SessionInfo[];
  currentSessionId: string | null;
  addSession: (session: SessionInfo) => void;
  updateSessionState: (sessionId: string, state: SessionInfo["state"]) => void;
  // ... all mutations take sessionId as first arg
}

export const useSessionStore = create<SessionStoreState>()(
  devtools(
    (set, get) => ({
      sessions: [],
      addSession: (session) => set((state) => ({ sessions: [...state.sessions, session] })),
      updateSessionState: (sessionId, newState) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.sessionId === sessionId ? { ...s, state: newState } : s,
          ),
        })),
    }),
    { name: "session-store" },
  ),
);
```

**Analog — current chat-store actions to slice by sessionId:** `apps/web/src/stores/chat-store.ts` (full file)

**Target — per-session slice map:**
```ts
interface ChatSessionSlice {
  messages: ChatMessage[];
  isWorking: boolean;
  workingToolName: string;
  pendingApprovals: ToolApprovalRequest[];
  quotedMessage: QuotedMessage | null;
}

interface ChatStoreState {
  bySessionId: Record<string, ChatSessionSlice>;
  appendAssistantText: (sessionId: string, text: string) => void;
  addUserMessage: (sessionId: string, message: ChatMessage) => void;
  markTurnComplete: (sessionId: string) => void;
  // ... every mutation takes sessionId as first arg
  getSlice: (sessionId: string) => ChatSessionSlice;    // with empty-slice default
}
```

**Reuse requirements:**
- Every action signature changes: first parameter is `sessionId: string`
- Every consumer in `components/chat/*` must now receive `sessionId` as prop and subscribe via a selector:
  ```ts
  const messages = useChatStore((s) => s.bySessionId[sessionId]?.messages ?? []);
  ```
- Use `Record<string, ...>` (plain object) rather than `Map` — zustand's structural equality works better with plain objects; also works across Map's non-serializable devtools issue
- Preserve all existing action semantics (appendAssistantText L66-L86 branching logic) — only the outer shape changes from flat to keyed
- `clearMessages` becomes `clearSession(sessionId)`; new `clearAllSessions()` for logout

**Anti-pattern warnings:**
- Do NOT use `Map` for the collection (zustand structural equality gotchas + devtools serialization issues)
- Do NOT maintain two parallel stores (flat + keyed) during migration — rewrite all consumers in one pass
- Do NOT invent a separate `per-session-chat-store` hook alongside the old one — replace in place (CONTEXT `/Users/admin/CLAUDE.md` project rule: "避免为了向后兼容而添加额外的适配层或包装器")

---

#### `components/shell/split-pane.tsx` (new)

**Analog:** none in repo — follow RESEARCH §2.12 and UI-SPEC layout (lg breakpoint activation, max 2 panes)

**Pattern sketch (RESEARCH §2.12 + UI-SPEC):**
```tsx
<div className="hidden lg:grid lg:grid-cols-2 h-full divide-x divide-border">
  <section aria-label="Pane 1"><ChatPage sessionId={pane1Id} /></section>
  <section aria-label="Pane 2"><ChatPage sessionId={pane2Id} /></section>
</div>
```

**Reuse requirements:**
- Activates only at `lg:` breakpoint (≥1024px) — UI-SPEC D-18 + D-33
- URL query pattern `?pane1=<id>:<mode>&pane2=<id>:<mode>` (RESEARCH §2.12)
- Each `ChatPage` consumes `sessionId` prop, subscribes to its own chat-store slice
- Separator uses shadcn `Separator variant="vertical"` or divide-x utility

---

#### `pages/chat.tsx` (modify)

**Analog:** `apps/web/src/pages/chat.tsx` (self, L1-L36 — current URL parsing)

**Current URL parsing** (L7-L9):
```tsx
const { id } = useParams();
const [searchParams] = useSearchParams();
const mode = searchParams.get("mode");
```

**Target — support dual pane IDs:**
```tsx
const { id } = useParams();
const [searchParams] = useSearchParams();
const pane1 = searchParams.get("pane1");   // optional split-pane mode
const pane2 = searchParams.get("pane2");
const mode = searchParams.get("mode");     // single-pane mode fallback
// Dispatch: if pane2 present -> <SplitPane />, else <ChatJsonView|ChatPtyView sessionId={id} />
```

**Reuse requirements:**
- Keep single-pane path (`mode=json|pty`) as default
- Split-pane activates via presence of `pane2` query param (not route path change)
- Pass `sessionId` prop to all child views — they no longer read from `useSessionStore.currentSessionId`

---

## Shared Patterns (cross-file)

### Zustand store shape — `create<T>()(devtools(..., { name }))`

**Source:** `apps/web/src/stores/session-store.ts` L21-L59 and `chat-store.ts` L57-L180

**Apply to:** every new or modified store (Plan 10-06 `chat-store` rewrite primarily)

```ts
export const useXxxStore = create<XxxStoreState>()(
  devtools(
    (set, get) => ({
      // state fields
      // actions: (args) => set((state) => ({ ... }))
    }),
    { name: "xxx-store" },
  ),
);
```

**Rules:**
- Every action that mutates state takes the primary ID as first arg when per-entity
- Use spread-based immutable updates (`...state.x`, `state.x.map((e) => ...)` etc.) — never mutate
- Wrap with `devtools` middleware + explicit `name` for Redux DevTools visibility

---

### shadcn atom composition — CVA + `cn()` + `data-slot`

**Source:** `apps/web/src/components/ui/button.tsx` L7-L62

**Apply to:** every new file in `apps/web/src/components/ui/` (Plan 10-01a 13 atoms)

```tsx
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const xxxVariants = cva("base-classes", { variants: {...}, defaultVariants: {...} })

function Xxx({ className, variant, size, ...props }: React.ComponentProps<"tag"> & VariantProps<typeof xxxVariants>) {
  return <tag data-slot="xxx" className={cn(xxxVariants({ variant, size, className }))} {...props} />
}
export { Xxx, xxxVariants }
```

**Rules:**
- Always include `className` in `cn()` to allow consumer override
- Always export both the component and its `*Variants` cva function
- Radix-based atoms use `forwardRef` pattern from the shadcn registry — preserve what CLI generates

---

### Layout shell — sticky header 48px + `flex-1` main

**Source:** `apps/web/src/pages/pty-test.tsx` L153-L163

**Apply to:** `app-shell.tsx`, and every page that lives outside `AppShell` (`pty-test`, `token-showcase`)

```tsx
<div className="flex flex-col h-dvh bg-[var(--background)]">
  <header className="sticky top-0 z-10 flex items-center gap-2 px-4 h-12 bg-[var(--card)] border-b border-[var(--border)]">
    {/* header content */}
  </header>
  <main className="flex-1 overflow-auto">
    {/* content */}
  </main>
</div>
```

**Rules:**
- `h-dvh` not `h-screen` (UI-SPEC D-34 viewport rule)
- Header is `h-12` (48px, UI-SPEC spacing)
- Use semantic `<header>`/`<main>`/`<nav>`/`<section>` (UI-SPEC A11y item 1)

---

### WebSocket dispatch — zod safeParse + discriminated switch

**Source:** `apps/web/src/services/websocket.ts` L96-L103 + `apps/proxy/src/ipc-protocol.ts` L325-L335 (`createIpcReader`)

**Apply to:** every new JSON message handler in Plan 10-04 (ChatJsonView dispatcher) and Plan 10-05 (InputBar → remote_input_raw sender)

```ts
// Registration (in hook or module init):
wsManager.onMessage((raw) => {
  try {
    const parsed = JSON.parse(raw);
    const result = RelayControlSchema.safeParse(parsed);
    if (!result.success) return;  // silently skip unknown types
    switch (result.data.type) {
      case "assistant_message": chatStore.appendAssistantText(result.data.sessionId, result.data.payload.text); break;
      // ... other cases
    }
  } catch {}
});
```

**Rules:**
- Always `safeParse` — never trust incoming protocol; unknown types drop silently (forward-compat)
- Use `discriminatedUnion` typing so TypeScript narrows the payload per case
- Sender side: build the message object, `JSON.stringify(obj)`, `wsManager.send(str)`

---

### Per-session action signature — first arg is sessionId

**Source (after Plan 10-06 refactor):** new `chat-store.ts` per-session slice map

**Apply to:** every consumer of chat-store in `components/chat/*`, and every dispatcher that processes session-scoped messages

```ts
// Store action signature
appendAssistantText: (sessionId: string, text: string) => void;

// Consumer selector
const messages = useChatStore((s) => s.bySessionId[sessionId]?.messages ?? []);

// Component prop contract
interface ChatJsonViewProps { sessionId: string; }   // every chat/* component receives this
```

**Rules:**
- Never read `useSessionStore.currentSessionId` inside `components/chat/*` — always pass `sessionId` prop (needed for split-pane where "current" is ambiguous)
- Empty-slice default (`?? []`, `?? { ... }`) on every selector to avoid `undefined`-access crashes on first subscribe

---

### Nested route with shared shell — `Layout → Outlet`

**Source:** RESEARCH §2.10 (no in-repo analog yet)

**Apply to:** `app.tsx`, `router.tsx`, `AppShell`

```tsx
// router.tsx
createHashRouter([
  { path: "/", element: <AppShell />, children: [
    { index: true, element: <ProxySelectPage /> },
    { path: "sessions", element: <SessionListPage /> },
    { path: "chat/:id", element: <ChatPage /> },
  ]},
  { path: "/pty-test", element: <PtyTest /> },   // outside shell
]);

// AppShell.tsx
<div className="flex h-dvh">
  <Sidebar className="hidden md:flex" />
  <main className="flex-1"><Outlet /></main>
</div>
```

**Rules:**
- Nested routes keep `AppShell` mounted across navigation — no page transition, no state loss (CONTEXT D-15)
- Debug/scaffold pages (`/pty-test`, `/tokens`) stay outside the shell

---

### localStorage keys follow `cc_*` namespace

**Source:** `apps/web/src/pages/proxy-select.tsx` L12, CONTEXT D-19/D-34, RESEARCH §6

**Apply to:** every new localStorage write in Plan 10-01b, 10-04, 10-05

```ts
localStorage.setItem("cc_proxyId", proxyId);
localStorage.setItem("cc_sidebarCollapsed", collapsed ? "1" : "0");
localStorage.setItem(`cc_inputHistory:${sessionId}`, JSON.stringify(history));
localStorage.setItem(`cc_toolWhitelist:${sessionId}`, JSON.stringify(names));
```

**Rules:**
- Always `cc_` prefix
- Per-session keys use colon separator: `cc_<concept>:${sessionId}` (to enable bulk cleanup via `Object.keys(localStorage).filter(k => k.startsWith("cc_x:"))`)
- Set on every mutation (not on unmount — RESEARCH §2.10 explains why)

---

## Anti-Patterns to Avoid (global, cross-plan)

Executors MUST NOT do any of the following (all backed by CONTEXT D-31 + project memory):

1. **No Taro components in web.** Never import `View`, `Text`, `Input`, `ScrollView` from `@tarojs/components`. Feishu components are **shape reference only** — port logic, rewrite markup with `<div>/<span>/<input>` + shadcn atoms. (CONTEXT D-META-01)

2. **No `use-screen-size` / JS viewport detection.** Responsive behavior uses Tailwind `sm:/md:/lg:` classes or CSS media queries exclusively. (CONTEXT D-35)

3. **No safe-area-header wrapper component.** Use CSS `env(safe-area-inset-*)` directly. (CONTEXT D-31)

4. **No self-written modal component.** Every dialog uses shadcn `Dialog` or `Sheet`. (CONTEXT D-31)

5. **No `typewriter` / streaming char-by-char animation.** Markdown renders whole blocks; xterm handles PTY streaming natively. (CONTEXT D-31)

6. **No hardcoded slash-command list.** Subscribe to `useCommandStore.commands` — Phase 8 already wires dynamic discovery. (RESEARCH §2.4 corrects memory's `project_slash_command_preset_infeasible.md`)

7. **No overloading `pty_input` / `user_input` for raw-key channel.** Add a new `remote_input_raw` message type. (RESEARCH §2.2)

8. **No bypass of production paths in tests.** Test only by substituting data source; all dispatchers/stores/handlers stay on production wiring. (memory: `feedback_test_production_path.md`)

9. **No commit without visual verification.** Every plan completion requires Playwright screenshot + user approval before commit. (CONTEXT D-39, memory `feedback_ui_approval.md` + `feedback_test_before_commit.md`)

10. **No "hardcoded teal" accent escaping D-02 override.** Every primary color reference uses `var(--primary)` / `bg-primary` / `ring-ring`. The only teal (`#00D4AA`) in Phase 10 is `xtermTheme.cursorAccent` and `--color-status-success`.

11. **No Chinese comments in English log strings** (`/Users/admin/CLAUDE.md`). Log messages use English; code comments + docstrings use Chinese.

12. **No `rm` command; use `rmtrash`.** (`/Users/admin/CLAUDE.md`)

---

## No Analog Found

Files with no sufficiently close match in the codebase — executor must rely on RESEARCH.md code examples + official shadcn docs:

| File | Plan | Reason | Reference |
|------|------|--------|-----------|
| `components/shell/sidebar.tsx` | 10-01b | First desktop sidebar in web; no prior sidebar pattern | RESEARCH §2.10 + UI-SPEC layout constants |
| `components/shell/command-palette.tsx` | 10-01b | First Cmd+K / cmdk usage in web | RESEARCH §2.4 + shadcn `command` docs |
| `components/session/create-session-dialog.tsx` | 10-03 | First shadcn Dialog consumer | shadcn `dialog` docs + CONTEXT D-29 field list |
| `components/shell/split-pane.tsx` | 10-06 | First multi-pane layout | RESEARCH §2.12 + UI-SPEC D-18 |
| `lib/ansi-keys.ts` | 10-05 | No prior ANSI mapping logic | RESEARCH §8.2 (full reference) |

---

## Metadata

**Analog search scope:**
- `apps/web/src/` (components, pages, stores, services, lib, hooks)
- `apps/web/src/components/ui/button.tsx` (only existing shadcn atom)
- `apps/proxy/src/` (ipc-protocol, terminal, serve, __tests__)
- `packages/shared/src/schemas/` (envelope, relay-control, chat, tool, session, system)
- `apps/feishu/src/components/` + `apps/feishu/src/pages/` (reference shapes only, per CONTEXT D-META-01)
- `apps/feishu/e2e/` (test helper pattern)

**Files scanned:** ~35 files read in full or targeted line ranges

**Pattern extraction date:** 2026-04-17
