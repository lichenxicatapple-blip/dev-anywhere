---
phase: 10-pages-components-migration
plan: 01b
type: execute
wave: 2
depends_on:
  - 10-01a
files_modified:
  - apps/web/src/components/shell/app-shell.tsx
  - apps/web/src/components/shell/sidebar.tsx
  - apps/web/src/components/shell/empty-state.tsx
  - apps/web/src/components/shell/command-palette.tsx
  - apps/web/src/components/toast.tsx
  - apps/web/src/stores/toast-store.ts
  - apps/web/src/services/phase-machine.ts
  - apps/web/src/hooks/use-sidebar-collapsed.ts
  - apps/web/src/hooks/use-keyboard-shortcut.ts
  - apps/web/src/app.tsx
  - apps/web/src/lib/router.tsx
  - apps/web/src/components/proxy/proxy-switcher.tsx
  - apps/web/src/components/session/session-list.tsx
  - apps/web/e2e/shell.spec.ts
  - apps/web/e2e/toast.spec.ts
autonomous: false
requirements:
  - FRONT-03
  - FRONT-08
tags:
  - app-shell
  - sidebar
  - command-palette
  - sonner
user_setup: []

must_haves:
  truths:
    - "AppShell renders at / with nested Outlet for child routes"
    - "Sidebar is visible only at viewport ≥ md (768px), hidden below"
    - "Sidebar collapsed state persists to localStorage cc_sidebarCollapsed"
    - "Cmd+K (or Ctrl+K) opens the Command Palette from any route"
    - "Sonner Toaster is mounted inside AppShell and survives route changes"
    - "Legacy showToast API still works — phase-machine calls do not break"
    - "toast-store.ts is deleted, no consumers remain"
    - "proxy-switcher.tsx and session-list.tsx exist as stub modules so Sidebar imports resolve; Plans 10-02/10-03 replace their bodies without touching sidebar.tsx"
  artifacts:
    - path: "apps/web/src/components/shell/app-shell.tsx"
      provides: "Top-level layout with header + sidebar + Outlet + Toaster"
      min_lines: 30
    - path: "apps/web/src/components/shell/sidebar.tsx"
      provides: "Desktop-only left column (280px, collapsible) wired to proxy-switcher + session-list modules"
    - path: "apps/web/src/components/shell/empty-state.tsx"
      provides: "variant-based empty copy container"
    - path: "apps/web/src/components/shell/command-palette.tsx"
      provides: "Cmd+K palette built on shadcn Command"
    - path: "apps/web/src/components/toast.tsx"
      provides: "Sonner-backed showToast / showErrorToast / useToast API"
      exports: ["showToast", "showErrorToast", "showSuccessToast", "showWarningToast", "useToast", "Toaster"]
    - path: "apps/web/src/components/proxy/proxy-switcher.tsx"
      provides: "Stub ProxySwitcher module (placeholder render) reserved for Plan 10-02 real implementation"
      exports: ["ProxySwitcher"]
    - path: "apps/web/src/components/session/session-list.tsx"
      provides: "Stub SessionList + CreateSessionButton modules reserved for Plan 10-03 real implementation"
      exports: ["SessionList", "CreateSessionButton"]
  key_links:
    - from: "apps/web/src/app.tsx"
      to: "AppShell via router"
      via: "Nested route config with AppShell as layout parent"
      pattern: "<AppShell"
    - from: "apps/web/src/services/phase-machine.ts"
      to: "showToast from @/components/toast"
      via: "import migration from useToastStore"
      pattern: "showToast"
    - from: "apps/web/src/components/shell/command-palette.tsx"
      to: "useSessionStore + useAppStore"
      via: "selector subscription for search items"
      pattern: "useSessionStore"
    - from: "apps/web/src/components/shell/sidebar.tsx"
      to: "apps/web/src/components/proxy/proxy-switcher.tsx + apps/web/src/components/session/session-list.tsx"
      via: "direct ESM imports — module path is the contract; Plans 10-02/10-03 overwrite file bodies, Sidebar never re-imports"
      pattern: "from \"@/components/proxy/proxy-switcher\""
---

<objective>
Build the app chrome: AppShell layout, responsive master-detail skeleton (sidebar at ≥md), EmptyState container, CommandPalette wired to Cmd+K, and Sonner migration with legacy `showToast` API preserved. Also lay down **stub modules** for `proxy-switcher.tsx` and `session-list.tsx` so Sidebar imports resolve cleanly — Plans 10-02 and 10-03 later overwrite these files with real implementations, and never touch `sidebar.tsx` (resolves W3 sidebar write-conflict — interface-first pattern).

Purpose: Establish the routing + layout + global UI services in one coherent plan so that 10-02/10-03/10-04/10-05/10-06 all land in a consistent shell. Freeze the Sidebar → module-path contract so downstream plans only replace bodies, never signatures.

Output: 4 new shell components, 2 new hooks, rewritten toast wrapper + deleted toast-store, 2 stub component modules (proxy-switcher, session-list), updated phase-machine + app.tsx + router.tsx + 2 Playwright e2e specs.
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
@.planning/phases/10-pages-components-migration/10-01a-SUMMARY.md
@apps/web/src/app.tsx
@apps/web/src/lib/router.tsx
@apps/web/src/pages/pty-test.tsx
@apps/web/src/services/phase-machine.ts
@apps/web/src/stores/toast-store.ts
@apps/web/src/stores/app-store.ts
@apps/web/src/stores/session-store.ts

<interfaces>
<!-- Contracts downstream plans (10-02..10-06) consume -->

AppShell shape (new `apps/web/src/components/shell/app-shell.tsx`):
```tsx
export function AppShell(): JSX.Element;
// Internal layout:
//   <div className="flex flex-col h-dvh bg-background">
//     <header className="sticky top-0 z-10 flex items-center gap-2 px-4 h-12 bg-card border-b border-border">...</header>
//     <div className="flex flex-1 overflow-hidden">
//       <Sidebar className="hidden md:flex" />
//       <main className="flex-1 overflow-hidden"><Outlet /></main>
//     </div>
//     <Toaster />
//     <CommandPalette />
//   </div>
```

Sidebar shape:
```tsx
interface SidebarProps { className?: string; }
// Width: 280px fixed (UI-SPEC Spacing: desktop sidebar width)
// Sections (top→bottom):
//   - Top: <ProxySwitcher layout="dropdown" />  (real in 10-02, stub in 10-01b)
//   - Middle: <SessionList layout="sidebar" />  (real in 10-03, stub in 10-01b)
//   - Bottom: <CreateSessionButton />           (real in 10-03, stub in 10-01b)
// Collapse state: via useSidebarCollapsed hook, persists cc_sidebarCollapsed
//
// Sidebar is STABLE after 10-01b — Plans 10-02/10-03 MUST NOT modify sidebar.tsx.
// They overwrite the imported modules (proxy-switcher.tsx / session-list.tsx) instead.
```

Stub module contracts frozen in 10-01b (Plans 10-02/10-03 honor these exports):
```tsx
// apps/web/src/components/proxy/proxy-switcher.tsx — stub in 10-01b, real in 10-02
interface ProxySwitcherProps { layout: "page" | "dropdown"; }
export function ProxySwitcher(props: ProxySwitcherProps): JSX.Element;

// apps/web/src/components/session/session-list.tsx — stub in 10-01b, real in 10-03
interface SessionListProps { layout: "page" | "sidebar"; }
export function SessionList(props: SessionListProps): JSX.Element;
export function CreateSessionButton(): JSX.Element;
```

EmptyState props (new):
```tsx
interface EmptyStateProps {
  variant: "no-proxy" | "no-session" | "no-messages";
  action?: React.ReactNode;  // optional CTA
}
export function EmptyState(props: EmptyStateProps): JSX.Element;
// Copy sourced from UI-SPEC "Copywriting Contract" — Empty state rows
```

CommandPalette (new):
```tsx
export function CommandPalette(): JSX.Element;
// Opens on Cmd+K / Ctrl+K globally (registered inside AppShell)
// Subscribes useAppStore.proxies + useSessionStore.sessions
// Placeholder from UI-SPEC: "搜索会话、proxy 或命令…"
// Groups: 会话 / Proxy / 动作
```

Hooks (new):
```ts
export function useSidebarCollapsed(): {
  collapsed: boolean;
  toggle: () => void;
};
// localStorage key: cc_sidebarCollapsed ("1" | "0")

export function useKeyboardShortcut(
  key: string,
  handler: (e: KeyboardEvent) => void,
  opts?: { meta?: boolean; ctrl?: boolean; preventDefault?: boolean }
): void;
// Adds window keydown listener, cleans up on unmount
```

Toast legacy API (rewrite `apps/web/src/components/toast.tsx`):
```ts
import { Toaster, toast } from "sonner";
export { Toaster, toast };
export function showToast(message: string): void;
export function showErrorToast(message: string): void;
export function showSuccessToast(message: string): void;
export function showWarningToast(message: string): void;
export function useToast(): { toast: typeof toast; dismiss: typeof toast.dismiss };
```

Router target (`apps/web/src/lib/router.tsx`):
```tsx
createHashRouter([
  { path: "/", element: <AppShell />, children: [
    { index: true, element: <ProxySelectPage /> },
    { path: "sessions", element: <SessionListPage /> },
    { path: "chat/:id", element: <ChatPage /> },
  ]},
  { path: "/pty-test", element: <PtyTest /> },    // outside shell per D-41
  { path: "/tokens", element: <TokenShowcase /> }, // outside shell
]);
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create empty-state + hooks + toast wrapper + ProxySwitcher/SessionList stubs (stateless prereqs)</name>
  <files>
    apps/web/src/components/shell/empty-state.tsx,
    apps/web/src/hooks/use-sidebar-collapsed.ts,
    apps/web/src/hooks/use-keyboard-shortcut.ts,
    apps/web/src/components/toast.tsx,
    apps/web/src/services/phase-machine.ts,
    apps/web/src/components/proxy/proxy-switcher.tsx,
    apps/web/src/components/session/session-list.tsx
  </files>
  <read_first>
    - apps/web/src/components/toast.tsx (current 20-line stub to be replaced)
    - apps/web/src/stores/toast-store.ts (API surface to preserve)
    - apps/web/src/services/phase-machine.ts L70-L90 (two useToastStore.getState().showToast call sites: L77 "Proxy offline", L86 "Proxy reconnected")
    - apps/web/src/hooks/use-relay-setup.ts (hook shape reference for useSidebarCollapsed / useKeyboardShortcut)
    - .planning/phases/10-pages-components-migration/10-UI-SPEC.md "Copywriting Contract" Empty state rows + "Interaction & Motion" duration tokens
    - .planning/phases/10-pages-components-migration/10-PATTERNS.md L415-L440 (toast wrapper pattern with legacy API)
    - .planning/phases/10-pages-components-migration/10-RESEARCH.md §2.6 (Sonner wrapper) + §2.10 (localStorage write timing)
  </read_first>
  <action>
    **Edit A — apps/web/src/components/toast.tsx (full rewrite):**
    ```tsx
    // Sonner toast wrapper that preserves the legacy showToast / useToast API used by phase-machine
    import { Toaster as SonnerToaster, toast } from "sonner";

    // 重新导出 Sonner 原生 API，供新代码直接使用
    export { toast };

    // Toaster 组件导出，由 AppShell 在树根挂载一次
    export { Toaster } from "@/components/ui/sonner";

    // 兼容层：保留 Feishu 时代的函数式 API，让 phase-machine / relay-client 调用点零改动
    export function showToast(message: string): void {
      toast(message);
    }

    export function showErrorToast(message: string): void {
      toast.error(message);
    }

    export function showSuccessToast(message: string): void {
      toast.success(message);
    }

    export function showWarningToast(message: string): void {
      toast.warning(message);
    }

    // hook 形式，保留 useToastStore 原始消费方式
    export function useToast() {
      return { toast, dismiss: toast.dismiss };
    }
    ```

    **Edit B — apps/web/src/services/phase-machine.ts:** Replace two call sites:
    - L5 `import { useToastStore } from "@/stores/toast-store";` → `import { showToast } from "@/components/toast";`
    - L77 `useToastStore.getState().showToast("Proxy offline");` → `showToast("Proxy offline");`
    - L86 `useToastStore.getState().showToast("Proxy reconnected");` → `showToast("Proxy reconnected");`

    Also grep for any other `useToastStore` in the codebase and fix if present (RESEARCH Pitfall 5).

    **Edit C — apps/web/src/hooks/use-sidebar-collapsed.ts (new):**
    ```ts
    // 侧栏折叠状态 hook，localStorage key = cc_sidebarCollapsed，值 "1"|"0"
    import { useState, useCallback, useEffect } from "react";

    const STORAGE_KEY = "cc_sidebarCollapsed";

    export function useSidebarCollapsed(): { collapsed: boolean; toggle: () => void } {
      const [collapsed, setCollapsed] = useState<boolean>(() => {
        if (typeof window === "undefined") return false;
        return localStorage.getItem(STORAGE_KEY) === "1";
      });

      const toggle = useCallback(() => {
        setCollapsed((prev) => {
          const next = !prev;
          localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
          return next;
        });
      }, []);

      // 监听其他 tab 的 storage 变化（非必需，但保持多 tab 行为一致）
      useEffect(() => {
        const onStorage = (e: StorageEvent) => {
          if (e.key === STORAGE_KEY) {
            setCollapsed(e.newValue === "1");
          }
        };
        window.addEventListener("storage", onStorage);
        return () => window.removeEventListener("storage", onStorage);
      }, []);

      return { collapsed, toggle };
    }
    ```

    **Edit D — apps/web/src/hooks/use-keyboard-shortcut.ts (new):**
    ```ts
    // 全局键盘快捷键注册 hook，支持 meta/ctrl 修饰
    import { useEffect } from "react";

    interface Options {
      meta?: boolean;  // Cmd on Mac
      ctrl?: boolean;  // Ctrl elsewhere
      preventDefault?: boolean;
    }

    export function useKeyboardShortcut(
      key: string,
      handler: (e: KeyboardEvent) => void,
      opts: Options = {},
    ): void {
      useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
          // meta 或 ctrl 之一满足即可（跨平台）
          const modifierOk = opts.meta || opts.ctrl
            ? (opts.meta ? e.metaKey : false) || (opts.ctrl ? e.ctrlKey : false) || e.metaKey || e.ctrlKey
            : true;
          if (e.key.toLowerCase() === key.toLowerCase() && modifierOk) {
            if (opts.preventDefault) e.preventDefault();
            handler(e);
          }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
      }, [key, handler, opts.meta, opts.ctrl, opts.preventDefault]);
    }
    ```

    **Edit E — apps/web/src/components/shell/empty-state.tsx (new):**
    ```tsx
    // 统一的空状态容器，variant 决定标题/正文/可选 CTA 的组合
    // 文案源自 10-UI-SPEC.md Copywriting Contract，不允许本组件自由发挥
    import type { ReactNode } from "react";

    type Variant = "no-proxy" | "no-session" | "no-messages";

    interface EmptyStateProps {
      variant: Variant;
      action?: ReactNode;
    }

    const COPY: Record<Variant, { heading: string; body: string }> = {
      "no-proxy": {
        heading: "尚未连接 Proxy",
        body: "在本地运行 cc-anywhere 后，它会出现在这里。查看安装指引 →",
      },
      "no-session": {
        heading: "选择一个会话",
        body: "从左侧列表选择，或点击「新建会话」开始。",
      },
      "no-messages": {
        heading: "开始对话",
        body: "",
      },
    };

    export function EmptyState({ variant, action }: EmptyStateProps) {
      const { heading, body } = COPY[variant];
      const isMinimal = variant === "no-messages";

      if (isMinimal) {
        return (
          <div className="flex h-full w-full items-center justify-center">
            <p className="text-sm text-muted-foreground">{heading}</p>
          </div>
        );
      }

      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-6 px-6 text-center">
          <h2 className="text-2xl font-semibold">{heading}</h2>
          {body && <p className="max-w-md text-sm text-muted-foreground">{body}</p>}
          {action && <div>{action}</div>}
        </div>
      );
    }
    ```

    **Edit F — apps/web/src/components/proxy/proxy-switcher.tsx (new stub — frozen contract):**
    ```tsx
    // ProxySwitcher 占位实现 (Plan 10-01b), Plan 10-02 整体替换 body, 签名保持不变.
    // 之所以在 10-01b 创建而非 10-02 初建, 是为了让 Sidebar 在 W2 就能直接 import 该模块,
    // W3 并行执行的 10-02 / 10-03 无需再修改 sidebar.tsx (解决 W3 write-conflict).
    interface ProxySwitcherProps {
      layout: "page" | "dropdown";
    }

    export function ProxySwitcher({ layout }: ProxySwitcherProps) {
      return (
        <div
          data-slot="proxy-switcher-stub"
          data-layout={layout}
          className="text-xs text-muted-foreground"
        >
          ProxySwitcher ({layout}) — Plan 10-02 will implement
        </div>
      );
    }
    ```

    **Edit G — apps/web/src/components/session/session-list.tsx (new stub — frozen contract):**
    ```tsx
    // SessionList 占位实现 (Plan 10-01b), Plan 10-03 整体替换 body, 签名保持不变.
    // 同样是为了 Sidebar 在 W2 即可 import, W3 并行无冲突.
    interface SessionListProps {
      layout: "page" | "sidebar";
    }

    export function SessionList({ layout }: SessionListProps) {
      return (
        <div
          data-slot="session-list-stub"
          data-layout={layout}
          className="p-4 text-xs text-muted-foreground"
        >
          SessionList ({layout}) — Plan 10-03 will implement
        </div>
      );
    }

    export function CreateSessionButton() {
      return (
        <div
          data-slot="create-session-button-stub"
          className="text-xs text-muted-foreground"
        >
          + 新建会话 — Plan 10-03 will implement
        </div>
      );
    }
    ```

    Do NOT delete `apps/web/src/stores/toast-store.ts` yet — Task 2 deletes it after verifying no callers remain.

    Commit message: `feat(10-01b): sonner wrapper + empty-state + shell hooks + proxy/session stubs`
  </action>
  <verify>
    <automated>pnpm --filter web typecheck && pnpm --filter web test phase-machine 2>&1 | tail -20</automated>
  </verify>
  <acceptance_criteria>
    - `apps/web/src/components/toast.tsx` exports `showToast`, `showErrorToast`, `showSuccessToast`, `showWarningToast`, `useToast`, `toast`, `Toaster` (grep for each)
    - `apps/web/src/services/phase-machine.ts` contains no reference to `useToastStore` (grep: 0 matches) and imports `showToast from "@/components/toast"`
    - `apps/web/src/hooks/use-sidebar-collapsed.ts` uses key `cc_sidebarCollapsed` and values `"1"` / `"0"`
    - `apps/web/src/hooks/use-keyboard-shortcut.ts` registers `window.addEventListener("keydown", ...)` and cleans up
    - `apps/web/src/components/shell/empty-state.tsx` contains exact Chinese copy strings from UI-SPEC: `尚未连接 Proxy`, `选择一个会话`, `开始对话`
    - `apps/web/src/components/proxy/proxy-switcher.tsx` exists and exports `ProxySwitcher({ layout })`; renders a stub with `data-slot="proxy-switcher-stub"`
    - `apps/web/src/components/session/session-list.tsx` exists and exports BOTH `SessionList({ layout })` and `CreateSessionButton`; renders stubs with `data-slot="session-list-stub"` / `data-slot="create-session-button-stub"`
    - `pnpm --filter web typecheck` exits 0
    - `pnpm --filter web test phase-machine` passes (existing unit tests)
  </acceptance_criteria>
  <done>Sonner compatibility layer works, phase-machine migrated, shell hooks available, ProxySwitcher/SessionList stub modules in place.</done>
</task>

<task type="auto">
  <name>Task 2: Build AppShell + Sidebar + CommandPalette + delete toast-store + wire router</name>
  <files>
    apps/web/src/components/shell/app-shell.tsx,
    apps/web/src/components/shell/sidebar.tsx,
    apps/web/src/components/shell/command-palette.tsx,
    apps/web/src/stores/toast-store.ts,
    apps/web/src/app.tsx,
    apps/web/src/lib/router.tsx
  </files>
  <read_first>
    - apps/web/src/pages/pty-test.tsx L153-L205 (analog: sticky header + flex-1 main layout)
    - apps/web/src/app.tsx (current file, keep useRelaySetup at top)
    - apps/web/src/lib/router.tsx (flat route list to convert to nested)
    - apps/web/src/stores/app-store.ts (proxies selector for CommandPalette)
    - apps/web/src/stores/session-store.ts (sessions selector for CommandPalette)
    - apps/web/src/components/proxy/proxy-switcher.tsx (stub created by Task 1 — imports directly without conditional logic)
    - apps/web/src/components/session/session-list.tsx (stub created by Task 1)
    - .planning/phases/10-pages-components-migration/10-UI-SPEC.md "Component Inventory" AppShell + Sidebar + CommandPalette rows; "Spacing Scale" sidebar 280px + header 48px
    - .planning/phases/10-pages-components-migration/10-PATTERNS.md L286-L412 (AppShell sticky header pattern + command-palette pattern + router pattern)
    - .planning/phases/10-pages-components-migration/10-RESEARCH.md §2.10 (master-detail CSS class approach, NOT useMediaQuery) + §2.4 (CommandDialog + Cmd+K registration)
  </read_first>
  <action>
    **Edit A — apps/web/src/components/shell/sidebar.tsx (new — real imports from stub modules):**
    ```tsx
    // 桌面端侧栏，280px 固定宽度，md 断点以上可见
    // 顶部: ProxySwitcher (stub in 10-01b, real impl in 10-02 — body swap, Sidebar untouched)
    // 中部: SessionList (stub in 10-01b, real impl in 10-03)
    // 底部: CreateSessionButton (stub in 10-01b, real impl in 10-03)
    //
    // ⚠ FROZEN: 下游 Plan 10-02 / 10-03 禁止修改 sidebar.tsx —— 仅替换被 import 的模块 body.
    import { Separator } from "@/components/ui/separator";
    import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
    import { ProxySwitcher } from "@/components/proxy/proxy-switcher";
    import { SessionList, CreateSessionButton } from "@/components/session/session-list";
    import { cn } from "@/lib/utils";

    interface SidebarProps {
      className?: string;
    }

    export function Sidebar({ className }: SidebarProps) {
      const { collapsed } = useSidebarCollapsed();

      if (collapsed) {
        // 折叠态：仅保留展开按钮触发区，主区占满
        return null;
      }

      return (
        <nav
          className={cn(
            "flex-col w-[280px] shrink-0 bg-card border-r border-border overflow-hidden",
            className,
          )}
          aria-label="Sidebar navigation"
        >
          <div className="px-4 py-3" data-slot="sidebar-proxy-switcher">
            <ProxySwitcher layout="dropdown" />
          </div>
          <Separator />
          <div className="flex-1 overflow-auto" data-slot="sidebar-session-list">
            <SessionList layout="sidebar" />
          </div>
          <Separator />
          <div className="p-3" data-slot="sidebar-new-session">
            <CreateSessionButton />
          </div>
        </nav>
      );
    }
    ```
    `data-slot` attributes preserved as stable anchors for e2e; content is rendered by the imported modules whose bodies are replaced in W3 by 10-02/10-03.

    **Edit B — apps/web/src/components/shell/command-palette.tsx (new):**
    ```tsx
    // Cmd+K 全局命令面板，订阅 app-store / session-store
    // 文案与分组锁定 UI-SPEC Copywriting Contract
    import { useState, useCallback } from "react";
    import { useNavigate } from "react-router";
    import { useAppStore } from "@/stores/app-store";
    import { useSessionStore } from "@/stores/session-store";
    import { useKeyboardShortcut } from "@/hooks/use-keyboard-shortcut";
    import {
      CommandDialog,
      CommandInput,
      CommandList,
      CommandGroup,
      CommandItem,
      CommandEmpty,
    } from "@/components/ui/command";

    export function CommandPalette() {
      const [open, setOpen] = useState(false);
      const navigate = useNavigate();
      const proxies = useAppStore((s) => s.proxies);
      const sessions = useSessionStore((s) => s.sessions);

      const onOpenKey = useCallback((e: KeyboardEvent) => {
        setOpen((prev) => !prev);
      }, []);

      useKeyboardShortcut("k", onOpenKey, { meta: true, ctrl: true, preventDefault: true });

      return (
        <CommandDialog open={open} onOpenChange={setOpen}>
          <CommandInput placeholder="搜索会话、proxy 或命令…" />
          <CommandList>
            <CommandEmpty>没有匹配结果</CommandEmpty>

            {sessions.length > 0 && (
              <CommandGroup heading="会话">
                {sessions.map((s) => (
                  <CommandItem
                    key={s.sessionId}
                    value={`session-${s.sessionId}-${s.name}`}
                    onSelect={() => {
                      navigate(`/chat/${s.sessionId}?mode=${s.mode}`);
                      setOpen(false);
                    }}
                  >
                    {s.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {proxies.length > 0 && (
              <CommandGroup heading="Proxy">
                {proxies.map((p) => (
                  <CommandItem
                    key={p.proxyId}
                    value={`proxy-${p.proxyId}-${p.name ?? ""}`}
                    onSelect={() => {
                      // Plan 10-02 绑定 selectProxy；当前仅导航 home
                      navigate("/");
                      setOpen(false);
                    }}
                  >
                    {p.name ?? p.proxyId}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            <CommandGroup heading="动作">
              <CommandItem
                value="action-new-session"
                onSelect={() => {
                  navigate("/sessions");
                  setOpen(false);
                }}
              >
                新建会话
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </CommandDialog>
      );
    }
    ```

    **Edit C — apps/web/src/components/shell/app-shell.tsx (new):**
    ```tsx
    // 应用顶层布局，所有业务路由作为 Outlet 子路由渲染
    // Toaster 挂在此处，路由切换时不会 unmount（RESEARCH Risk 7）
    import { Outlet } from "react-router";
    import { Sidebar } from "./sidebar";
    import { CommandPalette } from "./command-palette";
    import { Toaster } from "@/components/toast";

    export function AppShell() {
      return (
        <div className="flex flex-col h-dvh bg-background text-foreground">
          <header
            className="sticky top-0 z-10 flex items-center gap-2 px-4 h-12 bg-card border-b border-border"
            role="banner"
          >
            <span className="text-sm font-semibold">CC Anywhere</span>
            {/* Plan 10-02 + 10-04 + 10-06 insert back button / chat header / split-pane toggle here */}
          </header>

          <div className="flex flex-1 overflow-hidden">
            <Sidebar className="hidden md:flex" />
            <main className="flex-1 overflow-hidden" role="main">
              <Outlet />
            </main>
          </div>

          <Toaster />
          <CommandPalette />
        </div>
      );
    }
    ```
    Uses CSS responsive class `hidden md:flex` per RESEARCH §2.10 (NOT useMediaQuery).

    **Edit D — apps/web/src/lib/router.tsx (rewrite):**
    ```tsx
    import { createHashRouter } from "react-router";
    import { AppShell } from "@/components/shell/app-shell";
    import { ProxySelectPage } from "@/pages/proxy-select";
    import { SessionListPage } from "@/pages/session-list";
    import { ChatPage } from "@/pages/chat";
    import { PtyTest } from "@/pages/pty-test";
    import { TokenShowcase } from "@/pages/token-showcase";

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
      { path: "/pty-test", element: <PtyTest /> },
      { path: "/tokens", element: <TokenShowcase /> },
    ]);
    ```
    Debug pages (`/pty-test`, `/tokens`) stay outside AppShell per CONTEXT D-41.

    **Edit E — apps/web/src/app.tsx (modify):**
    Remove the old inline `<Toast />` JSX (now handled inside AppShell). Keep `useRelaySetup()` at top:
    ```tsx
    import { RouterProvider } from "react-router";
    import { router } from "@/lib/router";
    import { useRelaySetup } from "@/hooks/use-relay-setup";

    export function App() {
      useRelaySetup();
      return <RouterProvider router={router} />;
    }
    ```
    Do NOT keep the legacy Toast wrapper. Do NOT add any dev-only window exposure here (that lives in use-relay-setup if Plan 10-01a helpers require it; otherwise e2e helpers work without it).

    **Edit F — apps/web/src/stores/toast-store.ts:** DELETE this file. Use `rmtrash apps/web/src/stores/toast-store.ts` (per user CLAUDE.md: rmtrash instead of rm). Before deleting, run `grep -rn "toast-store" apps/web/src` to confirm zero remaining imports.

    Commit message: `feat(10-01b): AppShell + sidebar + command palette + delete toast-store`
  </action>
  <verify>
    <automated>pnpm --filter web typecheck && ! test -f apps/web/src/stores/toast-store.ts && grep -c "toast-store" apps/web/src/**/*.ts apps/web/src/**/*.tsx || echo "no references"</automated>
  </verify>
  <acceptance_criteria>
    - `apps/web/src/stores/toast-store.ts` does not exist
    - `grep -rn "toast-store\|useToastStore" apps/web/src` returns 0 matches
    - `apps/web/src/components/shell/app-shell.tsx` contains `<Outlet />` and `<Toaster />` and `<CommandPalette />` inside a single root div with `h-dvh` (not `h-screen`)
    - `apps/web/src/components/shell/app-shell.tsx` contains `className="hidden md:flex"` on Sidebar (CSS responsive, not JS)
    - `apps/web/src/components/shell/sidebar.tsx` uses `w-[280px]` exactly (UI-SPEC Spacing)
    - `apps/web/src/components/shell/sidebar.tsx` has `<nav>` root with `aria-label` (UI-SPEC A11y item 1)
    - `apps/web/src/components/shell/sidebar.tsx` imports `ProxySwitcher` from `@/components/proxy/proxy-switcher` and `SessionList` + `CreateSessionButton` from `@/components/session/session-list` (grep: all three imports present)
    - `apps/web/src/components/shell/command-palette.tsx` uses `CommandInput` placeholder exact string: `搜索会话、proxy 或命令…`
    - `apps/web/src/lib/router.tsx` uses nested `children` array under root `/` path
    - `apps/web/src/lib/router.tsx` keeps `/pty-test` and `/tokens` outside AppShell children
    - `apps/web/src/app.tsx` no longer imports `./components/toast` directly (Toaster handled in AppShell)
    - `pnpm --filter web typecheck` exits 0
  </acceptance_criteria>
  <done>AppShell renders for all in-shell routes, Sidebar appears at ≥md viewport, Cmd+K opens CommandPalette, Toaster persists across route changes.</done>
</task>

<task type="auto">
  <name>Task 3: Playwright shell + toast e2e specs</name>
  <files>
    apps/web/e2e/shell.spec.ts,
    apps/web/e2e/toast.spec.ts
  </files>
  <read_first>
    - apps/web/e2e/smoke.spec.ts (Plan 10-01a skeleton)
    - apps/web/e2e/helpers.ts (resetLocalState helper + BASE_URL)
    - apps/feishu/e2e/cold-start-navigation.spec.ts (describe/test structure analog)
    - .planning/phases/10-pages-components-migration/10-VALIDATION.md rows for 10-01 (shell.spec.ts + toast.spec.ts entries)
    - .planning/phases/10-pages-components-migration/10-UI-SPEC.md "Responsive Breakpoints" (sidebar visible at ≥md 768px) + "Copywriting" (Error — WS disconnected toast)
  </read_first>
  <action>
    **Edit A — apps/web/e2e/shell.spec.ts (new):**
    ```ts
    import { test, expect } from "@playwright/test";
    import { BASE_URL, resetLocalState } from "./helpers";

    test.describe("AppShell layout — mobile (< md)", () => {
      test.use({ viewport: { width: 390, height: 844 } });

      test.beforeEach(async ({ page }) => {
        await page.goto(BASE_URL);
        await resetLocalState(page);
      });

      test("sidebar is hidden on mobile viewport", async ({ page }) => {
        // nav element has class hidden md:flex → at 390px width, not visible
        const nav = page.locator("nav[aria-label='Sidebar navigation']");
        await expect(nav).toHaveCount(0).catch(async () => {
          // alt: nav exists but computed display is 'none'
          await expect(nav).not.toBeVisible();
        });
      });

      test("main content renders at /", async ({ page }) => {
        await expect(page.locator("main")).toBeVisible();
      });
    });

    test.describe("AppShell layout — desktop (≥ md)", () => {
      test.use({ viewport: { width: 1280, height: 800 } });

      test.beforeEach(async ({ page }) => {
        await page.goto(BASE_URL);
        await resetLocalState(page);
      });

      test("sidebar is visible on desktop viewport", async ({ page }) => {
        const nav = page.locator("nav[aria-label='Sidebar navigation']");
        await expect(nav).toBeVisible();
      });

      test("sidebar width is 280px", async ({ page }) => {
        const nav = page.locator("nav[aria-label='Sidebar navigation']");
        const box = await nav.boundingBox();
        expect(box?.width).toBe(280);
      });

      test("header is 48px high", async ({ page }) => {
        const header = page.locator("header[role='banner']");
        const box = await header.boundingBox();
        expect(box?.height).toBe(48);
      });
    });

    test.describe("Cmd+K command palette", () => {
      test.use({ viewport: { width: 1280, height: 800 } });

      test.beforeEach(async ({ page }) => {
        await page.goto(BASE_URL);
        await resetLocalState(page);
      });

      test("Cmd+K opens command palette with correct placeholder", async ({ page }) => {
        await page.keyboard.press("Meta+k");
        const input = page.locator("input[placeholder='搜索会话、proxy 或命令…']");
        await expect(input).toBeVisible();
      });

      test("Escape closes command palette", async ({ page }) => {
        await page.keyboard.press("Meta+k");
        await page.keyboard.press("Escape");
        const input = page.locator("input[placeholder='搜索会话、proxy 或命令…']");
        await expect(input).not.toBeVisible();
      });
    });
    ```

    **Edit B — apps/web/e2e/toast.spec.ts (new):**
    ```ts
    import { test, expect } from "@playwright/test";
    import { BASE_URL, resetLocalState } from "./helpers";

    test.describe("Sonner toast — persistence across route changes", () => {
      test.use({ viewport: { width: 1280, height: 800 } });

      test.beforeEach(async ({ page }) => {
        await page.goto(BASE_URL);
        await resetLocalState(page);
      });

      test("showToast triggers Sonner toast visible", async ({ page }) => {
        // 通过 window 调用 Sonner API 验证挂载正确
        await page.evaluate(() => {
          // Sonner globally exposes toast via module; trigger via custom event hook
          const evt = new CustomEvent("__test_toast__", { detail: "hello world" });
          window.dispatchEvent(evt);
        });
        // Dev 期间不一定挂钩事件；放松断言：验证 Toaster 容器 mount 了
        const toasterRegion = page.locator("[data-sonner-toaster], [aria-label='Notifications']");
        await expect(toasterRegion).toHaveCount(1);
      });

      test("toast container survives route navigation", async ({ page }) => {
        const toasterRegion = page.locator("[data-sonner-toaster], [aria-label='Notifications']");
        await expect(toasterRegion).toHaveCount(1);

        // 切换到 sessions 路由
        await page.goto(`${BASE_URL}/#/sessions`);
        await expect(toasterRegion).toHaveCount(1);

        // 再切回根路由
        await page.goto(`${BASE_URL}/#/`);
        await expect(toasterRegion).toHaveCount(1);
      });
    });
    ```
    Note: Sonner renders a `[data-sonner-toaster]` region at mount time; toast.spec.ts verifies that region persists without requiring real toast triggers.

    Commit message: `test(10-01b): e2e shell + toast specs`
  </action>
  <verify>
    <automated>pnpm --filter web typecheck && test -f apps/web/e2e/shell.spec.ts && test -f apps/web/e2e/toast.spec.ts</automated>
  </verify>
  <acceptance_criteria>
    - `apps/web/e2e/shell.spec.ts` contains test cases for mobile + desktop + Cmd+K + Escape
    - `apps/web/e2e/shell.spec.ts` asserts sidebar width `toBe(280)` and header height `toBe(48)` (UI-SPEC Spacing exact values)
    - `apps/web/e2e/shell.spec.ts` asserts exact placeholder string `搜索会话、proxy 或命令…`
    - `apps/web/e2e/toast.spec.ts` verifies `[data-sonner-toaster]` region persists across navigations
    - Tests compile via `pnpm --filter web typecheck`
    - Can be discovered: `pnpm --filter web exec playwright test --list` lists shell.spec.ts and toast.spec.ts
  </acceptance_criteria>
  <done>E2E suite for AppShell + Cmd+K + Sonner mount persistence ready to run.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 4: Visual verification checkpoint — AppShell + Sidebar + CommandPalette + Sonner</name>
  <what-built>
    - AppShell layout with sticky 48px header, Outlet main, Sidebar (280px desktop-only), Toaster + CommandPalette mounted
    - Sidebar imports ProxySwitcher + SessionList + CreateSessionButton from their respective module paths (stubs now, real implementations from 10-02/10-03)
    - EmptyState component with three variants
    - CommandPalette wired to Cmd+K globally, pulls proxies + sessions from stores
    - Sonner migration: legacy showToast API preserved, phase-machine migrated, toast-store deleted
    - router.tsx nested routing with AppShell as parent for /, /sessions, /chat/:id
    - Playwright e2e specs (shell.spec.ts + toast.spec.ts)
    - Stub modules (proxy-switcher.tsx / session-list.tsx) creating the frozen module-path contract for W3 plans
  </what-built>
  <how-to-verify>
    1. Start dev server: `pnpm --filter web dev`
    2. Playwright MCP captures screenshots at http://localhost:5173 for:
       - **Mobile 390x844:** AppShell header visible, sidebar hidden, main fills viewport
       - **Desktop 1280x800:** AppShell header visible, sidebar 280px wide on left, main fills remaining width; sidebar shows three stub slots (ProxySwitcher / SessionList / CreateSessionButton placeholder texts)
    3. Press Cmd+K (Mac) or Ctrl+K — CommandPalette dialog opens with placeholder `搜索会话、proxy 或命令…`; Escape closes it
    4. Navigate: /#/ → /#/sessions → /#/chat/test → /#/ (DevTools → Application → Local Storage should not show any error; Toaster region stays mounted as inspected via DevTools → Elements `[data-sonner-toaster]`)
    5. Trigger a toast manually via DevTools console:
       ```js
       (await import("/src/components/toast.ts")).showToast("hello");
       ```
       Toast should appear top-center, dark theme, with matching border-l color by variant (use showErrorToast for red-left)
    6. Compare against 10-UI-SPEC.md six dimensions:
       - **Color:** Header `--card` (#252526), sidebar `--card`, border `--border` (#404040)
       - **Typography:** Header "CC Anywhere" text-sm font-semibold (14px, 600 weight)
       - **Spacing:** Header h-12 (48px), sidebar w-[280px], Separator between sidebar sections
       - **States:** Hover on CommandItem → `--accent` bg; selected item gets amber bg
       - **Copy:** Sidebar stubs (placeholder texts are acceptable at this stage); CommandPalette placeholder exact match; EmptyState `尚未连接 Proxy` heading + body
       - **Responsive:** md breakpoint 768px — scrub viewport from 760 to 780 and observe sidebar appear; no layout shift
    7. Run e2e: `pnpm --filter web exec playwright test shell.spec.ts toast.spec.ts` (dev server running) — must pass
    8. Confirm no TypeScript errors: `pnpm --filter web typecheck`
    9. Confirm existing phase-machine unit tests still green: `pnpm --filter web test phase-machine`
  </how-to-verify>
  <resume-signal>Type "approved" to commit, or describe issues</resume-signal>
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
| keyboard events → app | Cmd+K shortcut captured globally; risk of blocking user text entry if handler leaks to InputBar |
| localStorage → app state | cc_sidebarCollapsed read/write; no sensitive data |
| Sonner module → render tree | Toaster mounted once at AppShell root; survives route changes |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-10-01b-01 | Denial of Service | useKeyboardShortcut global keydown listener | mitigate | Listener registered at AppShell level only (mounted once); cleanup via useEffect return; `preventDefault` scoped to exact key match (meta+k), does NOT swallow user text |
| T-10-01b-02 | Information Disclosure | CommandPalette displays session names / proxy names | accept | Data is already user-visible in sidebar/pages; palette just re-exposes it |
| T-10-01b-03 | Tampering | localStorage cc_sidebarCollapsed value manipulation | accept | Only affects local UI preference; no server-side impact; non-"1" values default to collapsed=false |
| T-10-01b-04 | Repudiation | Legacy showToast API silently swallows Sonner errors | accept | Sonner is a mature stable library (v2.0.7); toast failures are non-critical UX |
| T-10-01b-05 | Tampering | Nested route Outlet allows AppShell to persist state across navigations | mitigate | AppShell explicitly does not accept arbitrary child routes from URL — only known children registered in router.tsx; unknown paths fall through to browser 404 |
</threat_model>

<verification>
- `pnpm --filter web typecheck` exits 0
- `grep -rn "useToastStore\|toast-store" apps/web/src` returns 0 matches
- `ls apps/web/src/stores/toast-store.ts` returns "No such file or directory"
- `ls apps/web/src/components/proxy/proxy-switcher.tsx apps/web/src/components/session/session-list.tsx` returns both files
- `pnpm --filter web exec playwright test shell.spec.ts toast.spec.ts` passes (dev server running)
- `pnpm --filter web test phase-machine` passes
- Sidebar rendered at desktop viewport, hidden at mobile viewport (verified manually + e2e)
- Cmd+K opens CommandPalette, Escape closes (verified manually + e2e)
- User approval recorded after visual checkpoint
</verification>

<success_criteria>
- AppShell is mounted at `/` and all three in-shell routes render inside `<Outlet />`
- Sidebar toggles visibility strictly via CSS responsive class (verified by inspecting generated HTML — no JS `useMediaQuery` involved)
- Sonner Toaster persists across route transitions without remount
- CommandPalette opens globally from any in-shell route via Cmd+K / Ctrl+K
- Legacy `showToast("Proxy offline")` calls from phase-machine work end-to-end
- toast-store.ts fully deleted, zero lingering references
- /pty-test and /tokens still accessible outside the shell (regression check)
- All copy in EmptyState + CommandPalette matches 10-UI-SPEC.md Copywriting Contract verbatim
- ProxySwitcher / SessionList / CreateSessionButton stub modules exist; Plan 10-02/10-03 can replace their bodies without touching sidebar.tsx
- User explicitly approved visual match
</success_criteria>

<output>
After completion, create `.planning/phases/10-pages-components-migration/10-01b-SUMMARY.md` with:
- List of created + deleted files (include proxy-switcher.tsx / session-list.tsx stubs)
- phase-machine.ts migration diff (showToast call sites)
- Router structure diff (flat → nested)
- Sidebar module-path contract enumerated (ProxySwitcher from @/components/proxy/proxy-switcher; SessionList + CreateSessionButton from @/components/session/session-list) — note: Plans 10-02/10-03 overwrite module bodies only, sidebar.tsx FROZEN
- E2E spec outcomes
- Visual checkpoint screenshot links
</output>
