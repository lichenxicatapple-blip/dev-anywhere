---
phase: 10-pages-components-migration
plan: 04b
type: execute
wave: 5
depends_on:
  - 10-04a
  - 10-05
files_modified:
  - apps/web/src/components/chat/input-bar.tsx
  - apps/web/src/components/chat/input-bar-utils.ts
  - apps/web/src/components/chat/slash-command-picker.tsx
  - apps/web/src/components/chat/file-path-picker.tsx
  - apps/web/src/components/chat/quote-preview-bar.tsx
  - apps/web/src/components/chat/semantic-action-panel.tsx
  - apps/web/src/components/chat/chat-header.tsx
  - apps/web/src/components/chat/chat-json-view.tsx
  - apps/web/src/components/session/create-session-dialog.tsx
  - apps/web/src/components/shell/app-shell.tsx
  - apps/web/src/components/shell/sidebar.tsx
  - apps/web/src/pages/chat.tsx
  - apps/web/src/hooks/use-input-history.ts
  - apps/web/src/hooks/use-textarea-autosize.ts
  - apps/web/src/hooks/use-visual-viewport.ts
  - apps/web/e2e/input-bar.spec.ts
  - apps/web/e2e/file-picker.spec.ts
  - apps/web/e2e/chat-chrome.spec.ts
autonomous: false
requirements:
  - FRONT-06
  - FRONT-08
tags:
  - input-bar
  - pickers
  - semantic-panel
  - chat-header
user_setup: []

must_haves:
  truths:
    - "InputBar supports multi-line 1-8 rows, Enter sends, Shift+Enter newline, ↑ recalls history on empty, / opens SlashCommandPicker, @ opens FilePathPicker"
    - "SlashCommandPicker subscribes to command-store (dynamic, not hardcoded) with CSS absolute positioning above InputBar"
    - "FilePathPicker subscribes to file-store and dispatches dir_list_request on cache miss; shared as refactored reusable component"
    - "QuotePreviewBar appears above InputBar when chat-store.quotedMessage is set; dismiss clears it"
    - "SemanticActionPanel (5 buttons: 打断输出/切换审批模式/历史上一条/历史下一条/取消) routes JSON actions (worker_abort / permission_mode_change / history / cancel) via CustomEvent bridge (Plan 10-06 Task 1 will migrate to store-backed selectors and remove the bridge)"
    - "ChatHeader (per D-51) 三件套：返回按钮（全视口显示）/ 会话标题（flex-1 truncate）+ mode badge / overflow 菜单。Overflow 内容：Permission mode 子菜单（默认 / 自动允许 / 规划模式）、Rename、Duplicate、Terminate（destructive）。**删除** 独立 permission-mode 顶栏按钮和独立 sidebar-toggle 按钮。"
    - "AppShell (per D-51) 在 /chat/* 路由下隐藏 header（useLocation 条件渲染）。非 chat 路由继续显示。"
    - "Sidebar 底部添加 Settings 齿轮图标占位（per D-53）——点击打开空 Dialog 或 toast “Settings coming soon”，真正的 Settings feature 另起独立 phase。"
    - "chat.tsx now composes ChatHeader + ChatJsonView + InputBar region — full JSON mode operational"
    - "CreateSessionDialog (from Plan 10-03) is refactored to reuse FilePathPicker subset for CWD field (inline inline FilePathPicker subset -> shared component)"
  artifacts:
    - path: "apps/web/src/components/chat/input-bar.tsx"
      provides: "Unified mode=json|pty InputBar — PTY raw keys deferred to Plan 10-05"
    - path: "apps/web/src/components/chat/slash-command-picker.tsx"
      provides: "Slash command picker driven by command-store"
    - path: "apps/web/src/components/chat/file-path-picker.tsx"
      provides: "File/dir picker driven by file-store; shared with CreateSessionDialog"
    - path: "apps/web/src/components/chat/semantic-action-panel.tsx"
      provides: "5 function buttons replacing per-key raw binding"
    - path: "apps/web/src/components/chat/chat-header.tsx"
      provides: "Chat page chrome (session title, mode badge, permission-mode, terminate)"
  key_links:
    - from: "apps/web/src/components/chat/input-bar.tsx"
      to: "useCommandStore.commands"
      via: "dynamic slash command source"
      pattern: "useCommandStore"
    - from: "apps/web/src/components/chat/file-path-picker.tsx"
      to: "useFileStore.tree + relayClient.sendControl dir_list_request"
      via: "cache-miss triggered request"
      pattern: "dir_list_request"
    - from: "apps/web/src/components/session/create-session-dialog.tsx"
      to: "FilePathPicker (refactored shared)"
      via: "CWD field uses shared picker component"
      pattern: "FilePathPicker"
---

<objective>
Deliver the input half of Chat JSON mode (FRONT-06 half 2): InputBar with all behaviors (autosize textarea, slash/@/history, Escape, iOS visualViewport adapter), SlashCommandPicker, FilePathPicker, QuotePreviewBar, SemanticActionPanel (5 semantic buttons — D-21 Addendum), ChatHeader, and full chat.tsx integration that composes everything.

**Addendum item — refactor CreateSessionDialog:** Plan 10-03 shipped CreateSessionDialog with a plain Textarea for CWD. Plan 10-04b, which builds the full FilePathPicker, MUST refactor CreateSessionDialog to reuse FilePathPicker (as a picker subset — CWD field uses the shared `<FilePathPicker>` component in directory-only mode). This closes the Addendum Warning 3 compromise where Plan 10-03 had "inline inline FilePathPicker subset" as a temporary stub.

**CustomEvent bridge is temporary:** SemanticActionPanel ↔ InputBar cross-component history control uses `window.dispatchEvent(new CustomEvent("cc:input-history-prev"))` etc. as a pragmatic stand-in while chat-store is flat. Plan 10-06 Task 1 rewrites chat-store per-session and moves this state into the store; the CustomEvent bridge MUST be fully removed at that point (enforced by Plan 10-06 acceptance criterion: `grep "cc:input-history-prev" in apps/web/src` returns 0 matches).

Purpose: Ship the full Chat UX (JSON + PTY) so the user can read + write from the web client end-to-end. Plan 10-04b consumes Plan 10-05 deliverables: `sendSemanticAction` from `@/lib/ansi-keys` (used in SemanticActionPanel PTY branch) and `ChatPtyView` (composed in chat.tsx for mode=pty).

Output: 6 new chat components, 3 new hooks, 1 modified CreateSessionDialog (shared picker refactor), rewritten chat.tsx (full composition of both JSON and PTY modes), 2 e2e specs (input-bar, file-picker).
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/phases/10-pages-components-migration/10-CONTEXT.md
@.planning/phases/10-pages-components-migration/10-UI-SPEC.md
@.planning/phases/10-pages-components-migration/10-RESEARCH.md
@.planning/phases/10-pages-components-migration/10-PATTERNS.md
@apps/web/src/pages/chat.tsx
@apps/web/src/stores/chat-store.ts
@apps/web/src/stores/command-store.ts
@apps/web/src/stores/file-store.ts
@apps/web/src/components/chat/chat-json-view.tsx
@apps/web/src/components/session/create-session-dialog.tsx
@apps/feishu/src/components/input-bar/index.tsx
@apps/feishu/src/components/slash-command-picker/index.tsx
@apps/feishu/src/components/file-path-picker/index.tsx

<interfaces>
<!-- Component API contracts -->

```tsx
interface InputBarProps { sessionId: string; mode: "json" | "pty"; }
interface SlashCommandPickerProps { filter: string; onSelect: (cmdName: string) => void; }
interface FilePathPickerProps {
  filter: string;             // 当 mode === "insert" 时, 从 InputBar 传入 "@query"
  mode?: "insert" | "select"; // "insert" 用于 InputBar (默认); "select" 用于 CreateSessionDialog
  onSelect: (path: string) => void;
  dirsOnly?: boolean;         // CreateSessionDialog 仅需目录
}
interface QuotePreviewBarProps { sessionId: string; }
interface SemanticActionPanelProps { sessionId: string; mode: "json" | "pty"; }
interface ChatHeaderProps { sessionId: string; }
```

<!-- SemanticActionPanel JSON routes (CONTEXT Addendum D-21) -->

```ts
// mode=json routes:
打断输出 → relayClient.sendControl({ type: "worker_abort", sessionId })
切换审批模式 → relayClient.sendControl({ type: "permission_mode_change", mode: next })
历史上一条 → window.dispatchEvent(new CustomEvent("cc:input-history-prev", { detail: { sessionId } }))
历史下一条 → window.dispatchEvent(new CustomEvent("cc:input-history-next", { detail: { sessionId } }))
取消 → setQuotedMessage(null) + CustomEvent("cc:input-cancel")

// mode=pty routes (Plan 10-05 fills these — Plan 10-04b scaffolds the JSON branch only):
打断输出 → remote_input_raw \x03
切换审批模式 → remote_input_raw \t
历史上一条 → remote_input_raw \x1b[A
历史下一条 → remote_input_raw \x1b[B
取消 → remote_input_raw \x1b
```

SemanticActionPanel lives in a collapsible strip adjacent to InputBar (above it on mobile, right side on desktop).

<!-- CreateSessionDialog refactor contract -->

Before (Plan 10-03):
```tsx
<Textarea value={cwd} onChange={...} placeholder="输入绝对路径..." />
```

After (Plan 10-04b):
```tsx
<FilePathPicker
  mode="select"
  dirsOnly
  filter={cwd}
  onSelect={(path) => setCwd(path)}
/>
```
The dialog's CWD field now uses the shared picker. Inline inline implementation from Plan 10-03 is fully removed.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: input-bar-utils + hooks (use-input-history, use-textarea-autosize, use-visual-viewport)</name>
  <files>
    apps/web/src/components/chat/input-bar-utils.ts,
    apps/web/src/hooks/use-input-history.ts,
    apps/web/src/hooks/use-textarea-autosize.ts,
    apps/web/src/hooks/use-visual-viewport.ts
  </files>
  <read_first>
    - apps/feishu/src/components/input-bar/index.tsx L15-L69 (four pure helpers to port)
    - .planning/phases/10-pages-components-migration/10-RESEARCH.md §2.5 (visualViewport pattern), §2.11 (input history pattern)
    - .planning/phases/10-pages-components-migration/10-PATTERNS.md L656-L681 (input-bar pure helpers)
  </read_first>
  <action>
    **Edit A — apps/web/src/components/chat/input-bar-utils.ts (port Feishu helpers):**
    Port the four pure helper functions from `apps/feishu/src/components/input-bar/index.tsx` L15-L69 verbatim:
    - `computeSendDisabled(mode, isWorking, pendingApprovals): boolean`
    - `hasValidAt(val: string): boolean` (@ trigger detection)
    - `detectPickerMode(val: string): "none" | "slash" | "file"`
    - `cleanupDeletedToken(val, prev, insertedTokens): { cleaned, removedToken }`

    **Edit B — apps/web/src/hooks/use-input-history.ts (new):**
    ```ts
    // InputBar 历史栈 hook, per-session, localStorage 持久化 100 条 FIFO
    import { useCallback, useMemo, useState } from "react";

    const MAX_HISTORY = 100;

    function storageKey(sessionId: string): string {
      return `cc_inputHistory:${sessionId}`;
    }

    function loadHistory(sessionId: string): string[] {
      try {
        const raw = localStorage.getItem(storageKey(sessionId));
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((e) => typeof e === "string") : [];
      } catch {
        return [];
      }
    }

    function saveHistory(sessionId: string, history: string[]): void {
      try {
        localStorage.setItem(storageKey(sessionId), JSON.stringify(history));
      } catch {
        // 存储配额用尽时静默失败, 不阻止发送
      }
    }

    export function useInputHistory(sessionId: string) {
      const [history, setHistory] = useState<string[]>(() => loadHistory(sessionId));
      const [index, setIndex] = useState<number>(-1);

      const push = useCallback((entry: string) => {
        const trimmed = entry.trim();
        if (!trimmed) return;
        setHistory((prev) => {
          const next = [...prev, trimmed].slice(-MAX_HISTORY);
          saveHistory(sessionId, next);
          return next;
        });
        setIndex(-1);
      }, [sessionId]);

      const recallPrev = useCallback((): string | null => {
        if (history.length === 0) return null;
        const nextIdx = Math.min(index + 1, history.length - 1);
        setIndex(nextIdx);
        return history[history.length - 1 - nextIdx] ?? null;
      }, [history, index]);

      const recallNext = useCallback((): string | null => {
        if (index <= 0) {
          setIndex(-1);
          return "";
        }
        const nextIdx = index - 1;
        setIndex(nextIdx);
        return history[history.length - 1 - nextIdx] ?? null;
      }, [history, index]);

      const reset = useCallback(() => setIndex(-1), []);

      return useMemo(() => ({ push, recallPrev, recallNext, reset }), [push, recallPrev, recallNext, reset]);
    }
    ```

    **Edit C — apps/web/src/hooks/use-textarea-autosize.ts (new):**
    ```ts
    // textarea 自撑高: 仅依赖 value 变化, 不监听 viewport resize (RESEARCH Pitfall 4)
    import { useEffect, type RefObject } from "react";

    interface Options {
      minHeight?: number;
      maxHeight?: number;
    }

    export function useTextareaAutosize(
      ref: RefObject<HTMLTextAreaElement | null>,
      value: string,
      opts: Options = {},
    ): void {
      const min = opts.minHeight ?? 48;
      const max = opts.maxHeight ?? 240;
      useEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = "auto";
        const desired = Math.min(Math.max(el.scrollHeight, min), max);
        el.style.height = `${desired}px`;
        el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
      }, [ref, value, min, max]);
    }
    ```

    **Edit D — apps/web/src/hooks/use-visual-viewport.ts (new):**
    ```ts
    // iOS Safari 键盘适配: 用 visualViewport 计算 InputBar 应平移多少以贴紧键盘上方
    import { useEffect, useState } from "react";

    export function useVisualViewportBottomOffset(): number {
      const [offset, setOffset] = useState(0);

      useEffect(() => {
        const vv = window.visualViewport;
        if (!vv) return;  // 降级: 桌面或老浏览器使用默认 0 (配合 env(safe-area-inset-bottom))

        const update = () => {
          const bottomOffset = window.innerHeight - vv.height - vv.offsetTop;
          setOffset(Math.max(bottomOffset, 0));
        };

        update();
        vv.addEventListener("resize", update);
        vv.addEventListener("scroll", update);

        const onBlur = () => {
          setTimeout(update, 300);
        };
        window.addEventListener("focusout", onBlur);

        return () => {
          vv.removeEventListener("resize", update);
          vv.removeEventListener("scroll", update);
          window.removeEventListener("focusout", onBlur);
        };
      }, []);

      return offset;
    }
    ```

    Commit message: `feat(10-04b): input-bar utils + history/autosize/viewport hooks`
  </action>
  <verify>
    <automated>pnpm --filter web typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `apps/web/src/components/chat/input-bar-utils.ts` exports `computeSendDisabled`, `hasValidAt`, `detectPickerMode`, `cleanupDeletedToken`
    - `apps/web/src/hooks/use-input-history.ts` uses localStorage key `cc_inputHistory:${sessionId}` and caps at 100 entries
    - `apps/web/src/hooks/use-textarea-autosize.ts` only listens to value change in its effect (RESEARCH Pitfall 4)
    - `apps/web/src/hooks/use-visual-viewport.ts` listens to `visualViewport.resize` + `scroll` + window `focusout` with 300ms delay
    - `pnpm --filter web typecheck` exits 0
  </acceptance_criteria>
  <done>All input-side hooks + pure helpers in place.</done>
</task>

<task type="auto">
  <name>Task 2: SlashCommandPicker + FilePathPicker + QuotePreviewBar (pickers + shared file picker)</name>
  <files>
    apps/web/src/components/chat/slash-command-picker.tsx,
    apps/web/src/components/chat/file-path-picker.tsx,
    apps/web/src/components/chat/quote-preview-bar.tsx
  </files>
  <read_first>
    - apps/feishu/src/components/slash-command-picker/index.tsx L1-L50 (filter logic)
    - apps/feishu/src/components/file-path-picker/index.tsx L1-L80 (tree navigation + filter)
    - apps/feishu/src/components/directory-picker/path-utils.ts (buildBreadcrumbSegments / joinPath — pure)
    - apps/feishu/src/components/quote-preview-bar/index.tsx (26 lines — shape reference)
    - apps/web/src/stores/command-store.ts
    - apps/web/src/stores/file-store.ts
    - .planning/phases/10-pages-components-migration/10-CONTEXT.md "Addendum" D-21 (semantic panel) + Warning 3 (CreateSessionDialog shared picker)
    - .planning/phases/10-pages-components-migration/10-PATTERNS.md L721-L732 (file-path-picker filter)
    - .planning/phases/10-pages-components-migration/10-RESEARCH.md §14 Q10 (CSS absolute positioning, not shadcn Popover)
  </read_first>
  <action>
    **Edit A — apps/web/src/components/chat/slash-command-picker.tsx (new):**
    ```tsx
    // SlashCommandPicker, 订阅 useCommandStore (动态源, 非硬编码)
    // CSS 绝对定位, 与 InputBar 同 stacking context (RESEARCH Q10)
    import { Command, CommandList, CommandItem, CommandEmpty } from "@/components/ui/command";
    import { useCommandStore } from "@/stores/command-store";

    interface SlashCommandPickerProps {
      filter: string;  // 从 InputBar 传入 ("/status" → "status")
      onSelect: (cmdName: string) => void;
    }

    export function SlashCommandPicker({ filter, onSelect }: SlashCommandPickerProps) {
      const commands = useCommandStore((s) => s.commands);
      const q = filter.toLowerCase().replace(/^\//, "");
      const filtered = commands.filter((c) => c.name.toLowerCase().includes(q));

      return (
        <div className="absolute bottom-full left-0 right-0 mb-2 bg-popover border border-border rounded-md shadow-lg max-h-60 overflow-hidden z-10"
          data-slot="slash-command-picker">
          <Command shouldFilter={false}>
            <CommandList>
              {filtered.length === 0 && <CommandEmpty>没有匹配的命令</CommandEmpty>}
              {filtered.map((cmd) => (
                <CommandItem
                  key={cmd.name}
                  value={cmd.name}
                  onSelect={() => onSelect(cmd.name)}
                >
                  <span className="font-mono text-sm">{cmd.name}</span>
                  {cmd.description && (
                    <span className="ml-auto text-xs text-muted-foreground truncate">
                      {cmd.description}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </div>
      );
    }
    ```

    **Edit B — apps/web/src/components/chat/file-path-picker.tsx (new, shared for InputBar + CreateSessionDialog):**
    ```tsx
    // FilePathPicker, 订阅 useFileStore.tree + dir_list_request, 共享给 InputBar 与 CreateSessionDialog
    // mode="insert": InputBar @ 触发, filter 从 "@..." 提取
    // mode="select": 直接用于字段 (CreateSessionDialog CWD), filter = 当前路径
    // dirsOnly: 仅显示目录 (CWD 选择用)
    import { useEffect, useMemo } from "react";
    import { useFileStore } from "@/stores/file-store";
    import { relayClientRef } from "@/services/ensure-binding";
    import { ScrollArea } from "@/components/ui/scroll-area";
    import { cn } from "@/lib/utils";

    interface FilePathPickerProps {
      filter: string;
      mode?: "insert" | "select";
      onSelect: (path: string) => void;
      dirsOnly?: boolean;
    }

    function extractQuery(filter: string, mode: "insert" | "select"): string {
      if (mode === "select") {
        const lastSlash = filter.lastIndexOf("/");
        return lastSlash >= 0 ? filter.slice(lastSlash + 1).toLowerCase() : filter.toLowerCase();
      }
      const afterAt = filter.split("@").pop() ?? "";
      const lastSlash = afterAt.lastIndexOf("/");
      return lastSlash >= 0 ? afterAt.slice(lastSlash + 1).toLowerCase() : afterAt.toLowerCase();
    }

    function extractPath(filter: string, mode: "insert" | "select"): string {
      if (mode === "select") {
        const lastSlash = filter.lastIndexOf("/");
        return lastSlash >= 0 ? filter.slice(0, lastSlash + 1) : "./";
      }
      const afterAt = filter.split("@").pop() ?? "";
      const lastSlash = afterAt.lastIndexOf("/");
      return lastSlash >= 0 ? afterAt.slice(0, lastSlash + 1) : "";
    }

    export function FilePathPicker({ filter, onSelect, mode = "insert", dirsOnly = false }: FilePathPickerProps) {
      const tree = useFileStore((s) => s.tree);
      const effectiveMode = mode;
      const currentPath = useMemo(() => extractPath(filter, effectiveMode) || "./", [filter, effectiveMode]);
      const query = useMemo(() => extractQuery(filter, effectiveMode), [filter, effectiveMode]);

      useEffect(() => {
        if (!tree.get(currentPath)) {
          const relay = relayClientRef.current;
          relay?.sendControl({ type: "dir_list_request", path: currentPath });
        }
      }, [currentPath, tree]);

      const allEntries = tree.get(currentPath) ?? [];
      const filteredEntries = useMemo(() => {
        let entries = allEntries;
        if (dirsOnly) entries = entries.filter((e) => e.type === "dir");
        if (query) entries = entries.filter((e) => e.name.toLowerCase().includes(query));
        return entries;
      }, [allEntries, query, dirsOnly]);

      const containerClass = effectiveMode === "insert"
        ? "absolute bottom-full left-0 right-0 mb-2 bg-popover border border-border rounded-md shadow-lg max-h-60 z-10"
        : "bg-popover border border-border rounded-md shadow-sm max-h-48 overflow-hidden";

      return (
        <div className={containerClass} data-slot="file-path-picker" data-mode={effectiveMode}>
          <div className="text-xs text-muted-foreground px-3 py-1 border-b border-border font-mono">
            {currentPath}
          </div>
          <ScrollArea className="max-h-48">
            {filteredEntries.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">没有匹配的路径</div>
            ) : (
              <ul role="list" className="flex flex-col">
                {filteredEntries.map((e) => (
                  <li key={e.name}>
                    <button
                      type="button"
                      onClick={() => onSelect(currentPath + e.name + (e.type === "dir" ? "/" : ""))}
                      className={cn(
                        "w-full flex items-center gap-2 px-3 h-9 text-sm hover:bg-accent text-left",
                        e.type === "dir" && "font-semibold",
                      )}
                      data-slot="file-entry"
                      data-entry-type={e.type}
                    >
                      <span className="font-mono text-[13px]">{e.name}{e.type === "dir" ? "/" : ""}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </div>
      );
    }
    ```

    **Edit C — apps/web/src/components/chat/quote-preview-bar.tsx (new):**
    ```tsx
    // 引用预览条, 出现在 InputBar 上方, 可单击 dismiss
    import { X } from "lucide-react";
    import { Button } from "@/components/ui/button";
    import { useChatStore } from "@/stores/chat-store";

    interface QuotePreviewBarProps {
      sessionId: string;  // Plan 10-06 scope
    }

    export function QuotePreviewBar({ sessionId }: QuotePreviewBarProps) {
      const quote = useChatStore((s) => s.quotedMessage);
      const setQuoted = useChatStore((s) => s.setQuotedMessage);

      if (!quote) return null;

      return (
        <div className="flex items-start gap-2 px-3 py-2 bg-muted border-t border-border" data-slot="quote-preview-bar">
          <div className="flex-1 min-w-0">
            <div className="text-xs text-muted-foreground mb-1">
              {quote.from === "assistant" ? "Claude:" : "You:"}
            </div>
            <div className="text-xs line-clamp-2">{quote.text}</div>
          </div>
          <Button variant="ghost" size="icon-xs" onClick={() => setQuoted(null)} aria-label="取消引用">
            <X aria-hidden="true" />
          </Button>
        </div>
      );
    }
    ```

    Commit message: `feat(10-04b): pickers + quote preview bar (shared file-path-picker)`
  </action>
  <verify>
    <automated>pnpm --filter web typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `apps/web/src/components/chat/slash-command-picker.tsx` subscribes to `useCommandStore` (dynamic, NOT hardcoded); uses CSS absolute positioning (`absolute bottom-full`)
    - `apps/web/src/components/chat/file-path-picker.tsx` accepts `mode` and `dirsOnly` props; `mode="insert"` uses @ extraction; `mode="select"` uses path-only extraction
    - `apps/web/src/components/chat/file-path-picker.tsx` dispatches `dir_list_request` on cache miss (grep: 1 match)
    - `apps/web/src/components/chat/quote-preview-bar.tsx` subscribes to `chat-store.quotedMessage`; dismiss calls `setQuoted(null)`
    - `pnpm --filter web typecheck` exits 0
  </acceptance_criteria>
  <done>All three pickers available. FilePathPicker is reusable across InputBar + CreateSessionDialog.</done>
</task>

<task type="auto">
  <name>Task 3: InputBar + SemanticActionPanel + ChatHeader</name>
  <files>
    apps/web/src/components/chat/input-bar.tsx,
    apps/web/src/components/chat/semantic-action-panel.tsx,
    apps/web/src/components/chat/chat-header.tsx
  </files>
  <read_first>
    - apps/feishu/src/components/input-bar/index.tsx (full file — keyboard matrix + state transitions)
    - apps/web/src/components/chat/input-bar-utils.ts (Task 1 pure helpers)
    - apps/web/src/components/chat/slash-command-picker.tsx + file-path-picker.tsx (Task 2)
    - apps/web/src/services/relay-client.ts (sendControl method)
    - apps/web/src/stores/app-store.ts (permissionMode state)
    - apps/web/src/hooks/use-sidebar-collapsed.ts
    - .planning/phases/10-pages-components-migration/10-CONTEXT.md "Addendum" D-21 semantic panel 5 actions
    - .planning/phases/10-pages-components-migration/10-UI-SPEC.md Copywriting Contract (InputBar placeholders, permission-mode chips, terminate copy)
    - .planning/phases/10-pages-components-migration/10-RESEARCH.md §2.11 (InputBar full matrix) + §2.4 (SlashCommandPicker usage)
  </read_first>
  <action>
    **Edit A — apps/web/src/components/chat/input-bar.tsx (new):**
    ```tsx
    // InputBar unified JSON + PTY, 1-8 行自撑, 斜杠/@/历史/iOS 键盘适配
    // PTY raw-key capture 在 Plan 10-05 填充, 此处仅搭好钩子
    import { useCallback, useEffect, useRef, useState } from "react";
    import { Send } from "lucide-react";
    import { Button } from "@/components/ui/button";
    import { Textarea } from "@/components/ui/textarea";
    import { relayClientRef } from "@/services/ensure-binding";
    import { useChatStore } from "@/stores/chat-store";
    import { useInputHistory } from "@/hooks/use-input-history";
    import { useTextareaAutosize } from "@/hooks/use-textarea-autosize";
    import { useVisualViewportBottomOffset } from "@/hooks/use-visual-viewport";
    import { computeSendDisabled, detectPickerMode } from "./input-bar-utils";
    import { SlashCommandPicker } from "./slash-command-picker";
    import { FilePathPicker } from "./file-path-picker";

    interface InputBarProps {
      sessionId: string;
      mode: "json" | "pty";
    }

    export function InputBar({ sessionId, mode }: InputBarProps) {
      const [value, setValue] = useState("");
      const textareaRef = useRef<HTMLTextAreaElement>(null);
      const isWorking = useChatStore((s) => s.isWorking);
      const pendingApprovals = useChatStore((s) => s.pendingApprovals);
      const history = useInputHistory(sessionId);
      const bottomOffset = useVisualViewportBottomOffset();

      useTextareaAutosize(textareaRef, value);

      const pickerMode = detectPickerMode(value);
      const sendDisabled = computeSendDisabled(mode, isWorking, pendingApprovals);

      // SemanticActionPanel 通过 custom event 控制历史/取消
      // NOTE: 这个 CustomEvent 桥接是 Plan 10-04b 的临时措施; Plan 10-06 Task 1 会把
      //       history cursor state 搬到 per-session chat-store slice 并移除此处的事件监听
      useEffect(() => {
        const onPrev = (e: Event) => {
          const detail = (e as CustomEvent).detail as { sessionId: string };
          if (detail.sessionId !== sessionId) return;
          if (value !== "") return;
          const prev = history.recallPrev();
          if (prev != null) setValue(prev);
        };
        const onNext = (e: Event) => {
          const detail = (e as CustomEvent).detail as { sessionId: string };
          if (detail.sessionId !== sessionId) return;
          const nx = history.recallNext();
          if (nx != null) setValue(nx);
        };
        const onCancel = (e: Event) => {
          const detail = (e as CustomEvent).detail as { sessionId: string };
          if (detail.sessionId !== sessionId) return;
          setValue("");
          history.reset();
        };
        window.addEventListener("cc:input-history-prev", onPrev);
        window.addEventListener("cc:input-history-next", onNext);
        window.addEventListener("cc:input-cancel", onCancel);
        return () => {
          window.removeEventListener("cc:input-history-prev", onPrev);
          window.removeEventListener("cc:input-history-next", onNext);
          window.removeEventListener("cc:input-cancel", onCancel);
        };
      }, [sessionId, value, history]);

      const send = useCallback(() => {
        const trimmed = value.trim();
        if (!trimmed) return;
        const relay = relayClientRef.current;
        if (!relay) return;
        relay.sendControl({
          type: "user_input",
          sessionId,
          payload: { text: trimmed },
        });
        history.push(trimmed);
        setValue("");
      }, [value, sessionId, history]);

      const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
          if (pickerMode === "none") {
            e.preventDefault();
            send();
          }
        } else if (e.key === "ArrowUp" && value === "" && mode === "json") {
          e.preventDefault();
          const prev = history.recallPrev();
          if (prev != null) setValue(prev);
        } else if (e.key === "ArrowDown" && mode === "json") {
          const nx = history.recallNext();
          if (nx != null) {
            e.preventDefault();
            setValue(nx);
          }
        } else if (e.key === "Escape") {
          if (pickerMode !== "none") {
            e.preventDefault();
            setValue(value.replace(/\/\S*$/, "").replace(/@\S*$/, ""));
          }
        }
        // PTY 原始键位捕获在 Plan 10-05 填充
      };

      const placeholder =
        mode === "json"
          ? "输入消息... (Enter 发送，Shift+Enter 换行)"
          : "输入命令... (Enter 发送，↑↓ 方向键支持)";

      return (
        <div
          className="flex-1 relative"
          style={{ transform: `translateY(-${bottomOffset}px)` }}
          data-slot="input-bar"
          data-mode={mode}
        >
          {pickerMode === "slash" && (
            <SlashCommandPicker
              filter={value.slice(value.lastIndexOf("/"))}
              onSelect={(name) => {
                setValue(value.replace(/\/[^\s]*$/, `/${name} `));
                textareaRef.current?.focus();
              }}
            />
          )}
          {pickerMode === "file" && (
            <FilePathPicker
              mode="insert"
              filter={value.slice(value.lastIndexOf("@"))}
              onSelect={(path) => {
                setValue(value.replace(/@[^\s]*$/, `@${path} `));
                textareaRef.current?.focus();
              }}
            />
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
            className="flex items-end gap-2"
          >
            <Textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              className="flex-1 resize-none font-normal"
              rows={1}
              aria-label={mode === "json" ? "输入聊天消息" : "输入 PTY 命令"}
            />
            <Button
              type="submit"
              size="icon"
              disabled={sendDisabled || value.trim() === ""}
              aria-label="发送"
              data-slot="send-button"
            >
              <Send aria-hidden="true" />
            </Button>
          </form>
        </div>
      );
    }
    ```

    **Edit B — apps/web/src/components/chat/semantic-action-panel.tsx (new, BOTH JSON + PTY routes):**
    ```tsx
    // 语义功能面板 (CONTEXT Addendum D-21), 5 个按钮跨 JSON/PTY 统一呈现
    // PTY 模式通过 Plan 10-05 的 ansi-keys sendSemanticAction 发 remote_input_raw
    // NOTE: JSON 模式的 history / cancel 走 window CustomEvent -> InputBar 订阅;
    //       Plan 10-06 Task 1 重构为 per-session chat-store selector, 届时移除 CustomEvent
    //       与 InputBar 里的 listener
    import { Square, Settings2, ArrowUp, ArrowDown, X } from "lucide-react";
    import { Button } from "@/components/ui/button";
    import { relayClientRef } from "@/services/ensure-binding";
    import { useAppStore } from "@/stores/app-store";
    import { useChatStore } from "@/stores/chat-store";
    import { sendSemanticAction } from "@/lib/ansi-keys";

    interface SemanticActionPanelProps {
      sessionId: string;
      mode: "json" | "pty";
    }

    export function SemanticActionPanel({ sessionId, mode }: SemanticActionPanelProps) {
      const relay = () => relayClientRef.current;

      function interrupt() {
        if (mode === "pty") {
          sendSemanticAction(sessionId, "interrupt");
        } else {
          relay()?.sendControl({ type: "worker_abort", sessionId });
        }
      }

      function togglePermissionMode() {
        if (mode === "pty") {
          sendSemanticAction(sessionId, "toggle_permission");
        } else {
          const current = useAppStore.getState().permissionMode ?? "default";
          const next = current === "default" ? "auto_accept" : current === "auto_accept" ? "plan" : "default";
          relay()?.sendControl({ type: "permission_mode_change", mode: next });
        }
      }

      function historyPrev() {
        if (mode === "pty") {
          sendSemanticAction(sessionId, "history_prev");
        } else {
          window.dispatchEvent(new CustomEvent("cc:input-history-prev", { detail: { sessionId } }));
        }
      }

      function historyNext() {
        if (mode === "pty") {
          sendSemanticAction(sessionId, "history_next");
        } else {
          window.dispatchEvent(new CustomEvent("cc:input-history-next", { detail: { sessionId } }));
        }
      }

      function cancel() {
        if (mode === "pty") {
          sendSemanticAction(sessionId, "cancel");
        } else {
          useChatStore.getState().setQuotedMessage(null);
          window.dispatchEvent(new CustomEvent("cc:input-cancel", { detail: { sessionId } }));
        }
      }

      return (
        <div
          className="flex flex-col gap-1 shrink-0"
          data-slot="semantic-action-panel"
          role="toolbar"
          aria-label="会话控制"
        >
          <Button variant="ghost" size="icon-sm" onClick={interrupt} title="打断输出" aria-label="打断输出">
            <Square aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={togglePermissionMode} title="切换审批模式" aria-label="切换审批模式">
            <Settings2 aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={historyPrev} title="历史上一条" aria-label="历史上一条">
            <ArrowUp aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={historyNext} title="历史下一条" aria-label="历史下一条">
            <ArrowDown aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={cancel} title="取消" aria-label="取消">
            <X aria-hidden="true" />
          </Button>
        </div>
      );
    }
    ```
    Both JSON and PTY routes are wired in this plan. Plan 10-05 delivered `ansi-keys.ts` and `sendSemanticAction` in Wave 4; this Wave 5 plan consumes them directly. No further modifications to this file are expected (Plan 10-06 Task 1 will migrate the CustomEvent bridge when chat-store becomes per-session).

    **Edit C — apps/web/src/components/chat/chat-header.tsx (new) — per D-51 三件套：**
    ```tsx
    // Chat 页顶栏 (D-51 极简): 返回按钮 (全视口) | 会话标题 + mode badge (flex-1 truncate) | overflow 菜单
    // overflow 包含: Permission mode 子菜单 / Rename / Duplicate / Terminate (destructive)
    import { ArrowLeft, MoreVertical } from "lucide-react";
    import { useNavigate } from "react-router";
    import { Button } from "@/components/ui/button";
    import { Badge } from "@/components/ui/badge";
    import {
      DropdownMenu,
      DropdownMenuTrigger,
      DropdownMenuContent,
      DropdownMenuItem,
      DropdownMenuSub,
      DropdownMenuSubTrigger,
      DropdownMenuSubContent,
      DropdownMenuRadioGroup,
      DropdownMenuRadioItem,
      DropdownMenuSeparator,
    } from "@/components/ui/dropdown-menu";
    import { useSessionStore } from "@/stores/session-store";
    import { useAppStore } from "@/stores/app-store";
    import { relayClientRef } from "@/services/ensure-binding";

    interface ChatHeaderProps {
      sessionId: string;
    }

    export function ChatHeader({ sessionId }: ChatHeaderProps) {
      const navigate = useNavigate();
      const session = useSessionStore((s) => s.sessions.find((x) => x.sessionId === sessionId));
      const permissionMode = useAppStore((s) => s.permissionMode ?? "default");

      function changePermission(mode: "default" | "auto_accept" | "plan") {
        relayClientRef.current?.sendControl({ type: "permission_mode_change", mode });
      }

      function handleRename() {
        // 占位: 触发 Rename Dialog (另一个 Plan 接入); 本 Plan 发事件或调用 useSessionStore.renamePrompt()
        // 最小实现: 弹 prompt, 调用 sendControl session_rename (若 relay 已支持) 或 store-local rename
        // 如果当前 session_rename envelope 未定义, 占位为 toast: "Rename coming soon" + TODO 注释
      }

      function handleDuplicate() {
        // 占位: 复制当前 session 的 cwd + mode 作为新 session 创建种子; 发 session_create 走正常流程
        // 最小实现: sendControl({ type: "session_create", cwd: session?.cwd ?? ".", resumeSessionId: undefined })
      }

      function handleTerminate() {
        relayClientRef.current?.sendControl({ type: "session_terminate", sessionId });
        navigate("/sessions");
      }

      return (
        <div
          className="flex items-center gap-2 h-12 px-3 border-b border-border bg-card shrink-0"
          data-slot="chat-header"
        >
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => navigate("/sessions")}
            aria-label="返回会话列表"
            data-slot="chat-back-button"
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
          <div className="flex-1 min-w-0 flex items-center gap-2">
            <span className="text-sm font-semibold truncate" data-slot="chat-session-title">
              {session?.name ?? sessionId.slice(0, 8)}
            </span>
            {session && (
              <Badge variant="secondary" className="font-mono text-xs uppercase shrink-0">
                {session.mode}
              </Badge>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="会话操作"
                data-slot="chat-overflow-trigger"
              >
                <MoreVertical aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" data-slot="chat-overflow-menu">
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Permission mode</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={permissionMode}
                    onValueChange={(v) => changePermission(v as "default" | "auto_accept" | "plan")}
                  >
                    <DropdownMenuRadioItem value="default">默认</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="auto_accept">自动允许</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="plan">规划模式</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem onClick={handleRename}>Rename</DropdownMenuItem>
              <DropdownMenuItem onClick={handleDuplicate}>Duplicate</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                data-slot="chat-terminate-item"
                onClick={handleTerminate}
              >
                终止会话
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      );
    }
    ```

    **Edit D — apps/web/src/components/shell/app-shell.tsx (modify per D-51) — 条件隐藏 AppShell header：**
    ```tsx
    import { Outlet, useLocation } from "react-router";
    import { Sidebar } from "./sidebar";
    import { Toaster } from "@/components/toast";

    export function AppShell() {
      const location = useLocation();
      const isChatRoute = location.pathname.startsWith("/chat/");

      return (
        <div className="flex flex-col h-dvh bg-background text-foreground">
          {!isChatRoute && (
            <header
              className="sticky top-0 z-10 flex items-center gap-2 px-4 h-12 bg-card border-b border-border"
              role="banner"
              data-slot="app-shell-header"
            >
              <span className="text-sm font-semibold">CC Anywhere</span>
            </header>
          )}
          <div className="flex flex-1 overflow-hidden">
            <Sidebar className="hidden md:flex" />
            <main className="flex-1 overflow-hidden" role="main">
              <Outlet />
            </main>
          </div>
          <Toaster />
        </div>
      );
    }
    ```

    **Edit E — apps/web/src/components/shell/sidebar.tsx (modify per D-53) — 底部 Settings 齿轮占位：**
    ```tsx
    // 在 Sidebar 底部区域 (与 "+ 新建会话" 浮动按钮同区) 新增 Settings 齿轮 Button
    import { Settings } from "lucide-react";
    import { toast } from "@/components/toast";
    // ... existing imports ...

    export function Sidebar({ className }: { className?: string }) {
      // ... existing body ...
      return (
        <aside className={...} data-slot="sidebar">
          {/* existing: ProxySwitcher dropdown + session list */}
          <div className="mt-auto border-t border-border p-2 flex items-center justify-between">
            {/* existing: "+ 新建会话" button */}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="设置"
              data-slot="sidebar-settings-trigger"
              onClick={() => toast.info("Settings coming soon")}
            >
              <Settings aria-hidden="true" />
            </Button>
          </div>
        </aside>
      );
    }
    ```
    （真正的 Settings Dialog 另起独立 phase；本 plan 只放占位，点击弹 toast）

    Commit message: `feat(10-04b): input-bar + semantic panel + chat header (D-51 极简) + app-shell conditional header (D-51) + sidebar settings slot (D-53)`
  </action>
  <verify>
    <automated>pnpm --filter web typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `apps/web/src/components/chat/input-bar.tsx` uses `useInputHistory(sessionId)`, `useTextareaAutosize(textareaRef, value)`, `useVisualViewportBottomOffset()`
    - InputBar placeholder exactly `输入消息... (Enter 发送，Shift+Enter 换行)` for JSON and `输入命令... (Enter 发送，↑↓ 方向键支持)` for PTY
    - Send button has `aria-label="发送"` and `data-slot="send-button"`
    - `apps/web/src/components/chat/semantic-action-panel.tsx` has exactly 5 buttons with aria-labels: `打断输出`, `切换审批模式`, `历史上一条`, `历史下一条`, `取消`
    - `apps/web/src/components/chat/semantic-action-panel.tsx` JSON `interrupt` dispatches `worker_abort`; `togglePermissionMode` cycles default→auto_accept→plan→default
    - `apps/web/src/components/chat/semantic-action-panel.tsx` PTY branch calls `sendSemanticAction(sessionId, "interrupt" | "toggle_permission" | "history_prev" | "history_next" | "cancel")` (grep: 5 matches of sendSemanticAction inside semantic-action-panel.tsx)
    - `apps/web/src/components/chat/semantic-action-panel.tsx` imports `sendSemanticAction` from `@/lib/ansi-keys` (Plan 10-05 deliverable)
    - **D-51：ChatHeader 只有三件套**：root div 内恰好 3 个直接子元素 —— 返回按钮 + session 标题容器 (含 mode badge) + overflow DropdownMenu。`grep -c 'Button' apps/web/src/components/chat/chat-header.tsx` 计数应 ≤ 2（返回按钮 + overflow 触发按钮），不存在独立的 permission-mode 按钮。
    - **D-51：删除 sidebar-toggle**：`grep 'useSidebarCollapsed\|PanelLeftOpen\|PanelLeftClose' apps/web/src/components/chat/chat-header.tsx` 返回 0 匹配
    - **D-51：返回按钮全视口显示**：返回按钮的 className 不含 `md:hidden`；`data-slot="chat-back-button"` 存在
    - **D-51：overflow 菜单内容完整**：DropdownMenuContent 内依次包含：Permission mode 子菜单（DropdownMenuSub + DropdownMenuRadioGroup）/ Rename / Duplicate / DropdownMenuSeparator / Terminate(destructive)
    - `apps/web/src/components/chat/chat-header.tsx` terminate 动作使用 `text-destructive` 类和文字 `终止会话`；`data-slot="chat-terminate-item"`
    - `apps/web/src/components/chat/chat-header.tsx` root 有 `data-slot="chat-header"`；overflow 触发器有 `data-slot="chat-overflow-trigger"`；会话标题有 `data-slot="chat-session-title"`
    - **D-51：AppShell 条件隐藏 header**：`apps/web/src/components/shell/app-shell.tsx` 导入 `useLocation`；存在判断 `location.pathname.startsWith("/chat/")`；只有非 chat 路由渲染 `<header>`
    - **D-51：AppShell header 带 data-slot**：非 chat 路由的 header 有 `data-slot="app-shell-header"`（用于 e2e 断言存在/隐藏）
    - **D-53：Sidebar Settings 占位**：`apps/web/src/components/shell/sidebar.tsx` 底部区域含 `data-slot="sidebar-settings-trigger"` 的 Button，图标为 lucide `Settings`
    - `pnpm --filter web typecheck` exits 0
  </acceptance_criteria>
  <done>InputBar + SemanticActionPanel + ChatHeader (D-51 极简三件套) 构建完成；AppShell 条件隐藏 header；Sidebar 加 Settings 占位；跨组件 history 走临时 CustomEvent bridge（Plan 10-06 Task 1 会迁移到 store）。</done>
</task>

<task type="auto">
  <name>Task 4: Wire into chat.tsx + ChatJsonView + refactor CreateSessionDialog to shared FilePathPicker</name>
  <files>
    apps/web/src/pages/chat.tsx,
    apps/web/src/components/chat/chat-json-view.tsx,
    apps/web/src/components/session/create-session-dialog.tsx
  </files>
  <read_first>
    - apps/web/src/pages/chat.tsx (Plan 10-04a stub)
    - apps/web/src/components/chat/chat-json-view.tsx (Plan 10-04a — has input-bar-slot placeholder)
    - apps/web/src/components/session/create-session-dialog.tsx (Plan 10-03 — Textarea CWD)
    - apps/web/src/components/chat/file-path-picker.tsx (Task 2 shared component)
  </read_first>
  <action>
    **Edit A — apps/web/src/components/chat/chat-json-view.tsx (replace input-bar-slot placeholder with real InputBar + SemanticActionPanel + QuotePreviewBar):**
    ```tsx
    // 替换 Plan 10-04a 占位 input-bar-slot 为真实 InputBar + QuotePreviewBar + SemanticActionPanel
    import { useEffect, useRef, useState } from "react";
    import { useVirtualizer } from "@tanstack/react-virtual";
    import { useChatStore } from "@/stores/chat-store";
    import { MessageBubble } from "./message-bubble";
    import { ToolApprovalCard } from "./tool-approval-card";
    import { QuotePreviewBar } from "./quote-preview-bar";
    import { BackToBottom } from "./back-to-bottom";
    import { StatusLine } from "./status-line";
    import { InputBar } from "./input-bar";
    import { SemanticActionPanel } from "./semantic-action-panel";
    import { useFollowOutput } from "@/hooks/use-follow-output";
    import { EmptyState } from "@/components/shell/empty-state";

    interface ChatJsonViewProps {
      sessionId: string;
    }

    export function ChatJsonView({ sessionId }: ChatJsonViewProps) {
      // Plan 10-06 将此选择器改为 s.bySessionId[sessionId]?.messages ?? []
      const messages = useChatStore((s) => s.messages);
      const pendingApprovals = useChatStore((s) => s.pendingApprovals);
      const isWorking = useChatStore((s) => s.isWorking);

      const parentRef = useRef<HTMLDivElement>(null);
      const [scrollReady, setScrollReady] = useState(false);
      const { isAtBottom, scrollToBottom } = useFollowOutput(parentRef);
      const [newMsgsWhileAway, setNewMsgsWhileAway] = useState(false);

      const virtualizer = useVirtualizer({
        count: messages.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => 120,
        overscan: 5,
      });

      const lastMsg = messages[messages.length - 1];

      useEffect(() => {
        if (isAtBottom && messages.length > 0) {
          virtualizer.scrollToIndex(messages.length - 1, { align: "end", behavior: "auto" });
          setNewMsgsWhileAway(false);
        } else if (!isAtBottom && messages.length > 0) {
          setNewMsgsWhileAway(true);
        }
      }, [messages.length, lastMsg?.text, isAtBottom, virtualizer]);

      const pendingApproval = pendingApprovals.find((a) => a.status === "pending");

      function renderInputRegion() {
        return (
          <>
            <QuotePreviewBar sessionId={sessionId} />
            <div className="flex items-end gap-2 p-2 border-t border-border" data-slot="input-bar-region">
              <InputBar sessionId={sessionId} mode="json" />
              <SemanticActionPanel sessionId={sessionId} mode="json" />
            </div>
          </>
        );
      }

      if (messages.length === 0 && !pendingApproval) {
        return (
          <div className="flex flex-col h-full">
            <div className="flex-1">
              <EmptyState variant="no-messages" />
            </div>
            <StatusLine state={isWorking ? "working" : "idle"} message={isWorking ? "Claude 正在响应..." : undefined} />
            {renderInputRegion()}
          </div>
        );
      }

      return (
        <div className="flex flex-col h-full relative">
          <div
            ref={(el) => {
              parentRef.current = el;
              if (el && !scrollReady) setScrollReady(true);
            }}
            className="flex-1 overflow-auto"
            data-slot="message-list"
          >
            {scrollReady && (
              <div
                style={{
                  height: virtualizer.getTotalSize(),
                  position: "relative",
                  width: "100%",
                }}
              >
                {virtualizer.getVirtualItems().map((vi) => (
                  <div
                    key={vi.key}
                    data-index={vi.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${vi.start}px)`,
                    }}
                  >
                    <MessageBubble message={messages[vi.index]} sessionId={sessionId} />
                  </div>
                ))}
              </div>
            )}
            <BackToBottom
              visible={!isAtBottom}
              hasNewMessages={newMsgsWhileAway}
              onClick={() => {
                virtualizer.scrollToIndex(Math.max(messages.length - 1, 0), { align: "end", behavior: "smooth" });
                scrollToBottom();
                setNewMsgsWhileAway(false);
              }}
            />
          </div>
          {pendingApproval && (
            <div className="px-4 py-2" aria-live="polite">
              <ToolApprovalCard
                approval={pendingApproval}
                sessionId={sessionId}
                container="inline"
              />
            </div>
          )}
          <StatusLine
            state={isWorking ? "working" : "idle"}
            message={isWorking ? "Claude 正在响应..." : undefined}
          />
          {renderInputRegion()}
        </div>
      );
    }
    ```
    Verify: grep `input-bar-slot` in file returns 0 matches (placeholder fully removed).

    **Edit B — apps/web/src/pages/chat.tsx (full composition — ChatHeader + ChatJsonView or ChatPtyView + InputBar region):**

    ChatPtyView from Plan 10-05 is self-contained (xterm + StatusLine + floating ToolApprovalCard). chat.tsx composes it alongside InputBar + QuotePreviewBar + SemanticActionPanel as siblings for PTY mode.

    ```tsx
    // ChatPage: 根据 ?mode= 渲染 JSON 或 PTY 视图
    // PTY 视图 (ChatPtyView) 来自 Plan 10-05; InputBar/SemanticActionPanel 在此处作为 sibling 拼装
    import { useParams, useSearchParams } from "react-router";
    import { ChatHeader } from "@/components/chat/chat-header";
    import { ChatJsonView } from "@/components/chat/chat-json-view";
    import { ChatPtyView } from "@/components/chat/chat-pty-view";
    import { InputBar } from "@/components/chat/input-bar";
    import { SemanticActionPanel } from "@/components/chat/semantic-action-panel";
    import { QuotePreviewBar } from "@/components/chat/quote-preview-bar";
    import { EmptyState } from "@/components/shell/empty-state";

    export function ChatPage() {
      const { id } = useParams<{ id: string }>();
      const [searchParams] = useSearchParams();
      const mode = (searchParams.get("mode") ?? "json") as "json" | "pty";

      if (!id) {
        return <EmptyState variant="no-session" />;
      }

      if (mode === "pty") {
        // PTY 模式: ChatPtyView 自包含 xterm + StatusLine + floating ToolApproval
        // InputBar + SemanticActionPanel + QuotePreviewBar 作为 sibling 放在下方
        return (
          <div className="flex flex-col h-full">
            <ChatHeader sessionId={id} />
            <div className="flex-1 min-h-0">
              <ChatPtyView sessionId={id} />
            </div>
            <QuotePreviewBar sessionId={id} />
            <div className="flex items-end gap-2 p-2 border-t border-border" data-slot="input-bar-region">
              <InputBar sessionId={id} mode="pty" />
              <SemanticActionPanel sessionId={id} mode="pty" />
            </div>
          </div>
        );
      }

      // JSON 模式: ChatJsonView 已在 Task A 内部自带 InputBar 区域
      return (
        <div className="flex flex-col h-full">
          <ChatHeader sessionId={id} />
          <div className="flex-1 min-h-0">
            <ChatJsonView sessionId={id} />
          </div>
        </div>
      );
    }
    ```

    **Edit C — apps/web/src/components/session/create-session-dialog.tsx (refactor CWD field to use shared FilePathPicker):**
    ```tsx
    // CWD 字段改用共享 FilePathPicker (dirsOnly + mode="select")
    // Plan 10-03 使用的 Textarea 占位已彻底替换
    import { useState } from "react";
    import { useNavigate } from "react-router";
    import { relayClientRef } from "@/services/ensure-binding";
    import { useSessionStore } from "@/stores/session-store";
    import { showErrorToast } from "@/components/toast";
    import {
      Dialog,
      DialogContent,
      DialogHeader,
      DialogTitle,
      DialogFooter,
    } from "@/components/ui/dialog";
    import { Button } from "@/components/ui/button";
    import { FilePathPicker } from "@/components/chat/file-path-picker";

    interface CreateSessionDialogProps {
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }

    export function CreateSessionDialog({ open, onOpenChange }: CreateSessionDialogProps) {
      const [name, setName] = useState("");
      const [mode, setMode] = useState<"json" | "pty">("json");
      const [cwd, setCwd] = useState("");
      const [submitting, setSubmitting] = useState(false);
      const navigate = useNavigate();

      async function handleSubmit() {
        if (!cwd.trim()) {
          showErrorToast("请输入工作目录");
          return;
        }
        const relay = relayClientRef.current;
        if (!relay) {
          showErrorToast("Relay client not available");
          return;
        }
        setSubmitting(true);
        try {
          const result = await relay.createSession({ cwd: cwd.trim() });
          if (result.error || !result.sessionId) {
            showErrorToast(`创建失败: ${result.error ?? "unknown"}`);
            return;
          }
          useSessionStore.getState().addSession({
            sessionId: result.sessionId,
            name: name.trim() || `Session ${result.sessionId.slice(0, 6)}`,
            mode,
            state: "active",
            lastActive: Date.now(),
          });
          useSessionStore.getState().setCurrentSession(result.sessionId, mode);
          onOpenChange(false);
          setName("");
          setCwd("");
          navigate(`/chat/${result.sessionId}?mode=${mode}`);
        } finally {
          setSubmitting(false);
        }
      }

      return (
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>新建会话</DialogTitle>
            </DialogHeader>
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void handleSubmit();
              }}
            >
              <label className="flex flex-col gap-1">
                <span className="text-sm">名称 (可选)</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-9 px-3 rounded-md bg-input border border-border text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder="自动生成"
                />
              </label>
              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm">模式</legend>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 text-sm font-normal cursor-pointer">
                    <input
                      type="radio"
                      name="mode"
                      value="json"
                      checked={mode === "json"}
                      onChange={() => setMode("json")}
                    />
                    JSON
                  </label>
                  <label className="flex items-center gap-2 text-sm font-normal cursor-pointer">
                    <input
                      type="radio"
                      name="mode"
                      value="pty"
                      checked={mode === "pty"}
                      onChange={() => setMode("pty")}
                    />
                    PTY
                  </label>
                </div>
              </fieldset>
              <label className="flex flex-col gap-1">
                <span className="text-sm">工作目录</span>
                <input
                  type="text"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  placeholder="输入或选择绝对路径"
                  className="h-9 px-3 rounded-md bg-input border border-border text-sm font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <FilePathPicker
                  mode="select"
                  dirsOnly
                  filter={cwd}
                  onSelect={(path) => setCwd(path)}
                />
              </label>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                  disabled={submitting}
                >
                  取消
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? "创建中..." : "创建"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      );
    }
    ```
    Note: the text input is kept so users can type a path directly; FilePathPicker below offers live dir browsing and click-to-select. Both paths keep the `cwd` state in sync.

    Commit message: `feat(10-04b): wire input bar + refactor create-session-dialog to shared picker`
  </action>
  <verify>
    <automated>pnpm --filter web typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `apps/web/src/components/chat/chat-json-view.tsx` no longer contains `data-slot="input-bar-slot"` (grep 0 matches); has `data-slot="input-bar-region"` (grep 1 match) composed of QuotePreviewBar + InputBar + SemanticActionPanel
    - `apps/web/src/pages/chat.tsx` uses real `<ChatHeader sessionId={id} />` (no more `chat-header-placeholder`)
    - `apps/web/src/pages/chat.tsx` PTY branch renders `<ChatPtyView sessionId={id} />` (from Plan 10-05) + InputBar + SemanticActionPanel + QuotePreviewBar as siblings (no placeholder text remaining)
    - `apps/web/src/pages/chat.tsx` JSON branch renders `<ChatJsonView />` (which owns its input region)
    - `apps/web/src/components/session/create-session-dialog.tsx` imports `FilePathPicker` from `@/components/chat/file-path-picker` (grep 1 match)
    - `apps/web/src/components/session/create-session-dialog.tsx` uses `<FilePathPicker mode="select" dirsOnly />` for CWD field
    - `pnpm --filter web typecheck` exits 0
  </acceptance_criteria>
  <done>Full Chat JSON mode wired end-to-end; CreateSessionDialog now reuses shared picker per Addendum Warning 3.</done>
</task>

<task type="auto">
  <name>Task 5: Playwright e2e specs (input-bar / file-picker / chat-chrome)</name>
  <files>
    apps/web/e2e/input-bar.spec.ts,
    apps/web/e2e/file-picker.spec.ts,
    apps/web/e2e/chat-chrome.spec.ts
  </files>
  <read_first>
    - apps/web/e2e/helpers.ts
    - .planning/phases/10-pages-components-migration/10-VALIDATION.md FRONT-06 rows (input-bar, file-picker)
  </read_first>
  <action>
    **apps/web/e2e/input-bar.spec.ts (new):**
    ```ts
    import { test, expect } from "@playwright/test";
    import { BASE_URL, resetLocalState } from "./helpers";

    test.describe("InputBar — slash command picker", () => {
      test.use({ viewport: { width: 1280, height: 800 } });

      test.beforeEach(async ({ page }) => {
        await page.goto(`${BASE_URL}/#/chat/test-sess?mode=json`);
        await resetLocalState(page);
        await page.goto(`${BASE_URL}/#/chat/test-sess?mode=json`);
      });

      test("typing / opens SlashCommandPicker", async ({ page }) => {
        const input = page.locator('[data-slot="input-bar"] textarea');
        await input.click();
        await input.fill("/");
        const picker = page.locator('[data-slot="slash-command-picker"]');
        await expect(picker).toBeVisible();
      });

      test("Escape closes picker", async ({ page }) => {
        const input = page.locator('[data-slot="input-bar"] textarea');
        await input.click();
        await input.fill("/status");
        await page.keyboard.press("Escape");
        const picker = page.locator('[data-slot="slash-command-picker"]');
        await expect(picker).not.toBeVisible();
      });

      test("send button is disabled when empty", async ({ page }) => {
        const send = page.locator('[data-slot="send-button"]');
        await expect(send).toBeDisabled();
      });
    });

    test.describe("InputBar — history recall", () => {
      test.use({ viewport: { width: 1280, height: 800 } });

      test.beforeEach(async ({ page }) => {
        await page.goto(`${BASE_URL}/#/chat/hist-sess?mode=json`);
        await resetLocalState(page);
      });

      test("ArrowUp on empty recalls history entry", async ({ page }) => {
        await page.evaluate(() => {
          localStorage.setItem("cc_inputHistory:hist-sess", JSON.stringify(["first", "second", "third"]));
        });
        await page.goto(`${BASE_URL}/#/chat/hist-sess?mode=json`);
        const input = page.locator('[data-slot="input-bar"] textarea');
        await input.click();
        await page.keyboard.press("ArrowUp");
        await expect(input).toHaveValue("third");
      });
    });
    ```

    **apps/web/e2e/chat-chrome.spec.ts (new) — D-51 断言：**
    ```ts
    import { test, expect } from "@playwright/test";
    import { BASE_URL, resetLocalState } from "./helpers";

    test.describe("AppShell header — D-51 conditional hide on chat route", () => {
      test.use({ viewport: { width: 1280, height: 800 } });

      test.beforeEach(async ({ page }) => {
        await page.goto(BASE_URL);
        await resetLocalState(page);
      });

      test("AppShell header visible on /sessions", async ({ page }) => {
        await page.goto(`${BASE_URL}/#/sessions`);
        const header = page.locator('[data-slot="app-shell-header"]');
        await expect(header).toBeVisible();
      });

      test("AppShell header HIDDEN on /chat/*", async ({ page }) => {
        await page.goto(`${BASE_URL}/#/chat/d51-sess?mode=json`);
        const header = page.locator('[data-slot="app-shell-header"]');
        await expect(header).toHaveCount(0);
      });
    });

    test.describe("ChatHeader — D-51 三件套", () => {
      test.use({ viewport: { width: 1280, height: 800 } });

      test.beforeEach(async ({ page }) => {
        await page.goto(`${BASE_URL}/#/chat/d51-sess?mode=json`);
        await resetLocalState(page);
        await page.goto(`${BASE_URL}/#/chat/d51-sess?mode=json`);
      });

      test("has three direct children: back button + title + overflow", async ({ page }) => {
        const header = page.locator('[data-slot="chat-header"]');
        await expect(header).toBeVisible();
        await expect(page.locator('[data-slot="chat-back-button"]')).toBeVisible();
        await expect(page.locator('[data-slot="chat-session-title"]')).toBeVisible();
        await expect(page.locator('[data-slot="chat-overflow-trigger"]')).toBeVisible();
      });

      test("back button is visible at ALL viewports (no md:hidden)", async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.locator('[data-slot="chat-back-button"]')).toBeVisible();
        await page.setViewportSize({ width: 1280, height: 800 });
        await expect(page.locator('[data-slot="chat-back-button"]')).toBeVisible();
      });

      test("no standalone permission-mode button or sidebar-toggle", async ({ page }) => {
        const permissionBtn = page.locator('[data-slot="chat-header"] button:has-text("默认"), [data-slot="chat-header"] button:has-text("自动允许"), [data-slot="chat-header"] button:has-text("规划模式")');
        await expect(permissionBtn).toHaveCount(0);
        const sidebarToggle = page.locator('[data-slot="chat-header"] [aria-label*="侧栏"]');
        await expect(sidebarToggle).toHaveCount(0);
      });

      test("overflow menu contains Permission mode + Rename + Duplicate + Terminate(destructive)", async ({ page }) => {
        await page.locator('[data-slot="chat-overflow-trigger"]').click();
        const menu = page.locator('[data-slot="chat-overflow-menu"]');
        await expect(menu).toBeVisible();
        await expect(menu.getByText("Permission mode")).toBeVisible();
        await expect(menu.getByText("Rename")).toBeVisible();
        await expect(menu.getByText("Duplicate")).toBeVisible();
        const terminate = page.locator('[data-slot="chat-terminate-item"]');
        await expect(terminate).toBeVisible();
        await expect(terminate).toHaveClass(/text-destructive/);
      });
    });

    test.describe("Sidebar Settings slot — D-53", () => {
      test.use({ viewport: { width: 1280, height: 800 } });

      test("Sidebar has Settings gear at bottom", async ({ page }) => {
        await page.goto(`${BASE_URL}/#/sessions`);
        const settings = page.locator('[data-slot="sidebar-settings-trigger"]');
        await expect(settings).toBeVisible();
      });
    });
    ```

    **apps/web/e2e/file-picker.spec.ts (new):**
    ```ts
    import { test, expect } from "@playwright/test";
    import { BASE_URL, resetLocalState } from "./helpers";

    test.describe("FilePathPicker @ trigger (InputBar mode=insert)", () => {
      test.use({ viewport: { width: 1280, height: 800 } });

      test.beforeEach(async ({ page }) => {
        await page.goto(`${BASE_URL}/#/chat/f-sess?mode=json`);
        await resetLocalState(page);
        await page.goto(`${BASE_URL}/#/chat/f-sess?mode=json`);
      });

      test("typing @ opens FilePathPicker in insert mode", async ({ page }) => {
        const input = page.locator('[data-slot="input-bar"] textarea');
        await input.click();
        await input.fill("@");
        const picker = page.locator('[data-slot="file-path-picker"][data-mode="insert"]');
        await expect(picker).toBeVisible();
      });
    });

    test.describe("FilePathPicker in CreateSessionDialog (mode=select, dirsOnly)", () => {
      test.use({ viewport: { width: 1280, height: 800 } });

      test.beforeEach(async ({ page }) => {
        await page.goto(`${BASE_URL}/#/sessions`);
        await resetLocalState(page);
        await page.goto(`${BASE_URL}/#/sessions`);
      });

      test("CreateSessionDialog renders FilePathPicker (select mode)", async ({ page }) => {
        await page.getByRole("button", { name: /新建会话/ }).first().click();
        const picker = page.locator('[data-slot="file-path-picker"][data-mode="select"]');
        await expect(picker).toBeVisible();
      });
    });
    ```

    Commit message: `test(10-04b): input + file picker + chat chrome (D-51/D-53) e2e`
  </action>
  <verify>
    <automated>pnpm --filter web typecheck && pnpm --filter web exec playwright test --list 2>&1 | grep -E "input-bar|file-picker|chat-chrome" | wc -l</automated>
  </verify>
  <acceptance_criteria>
    - `apps/web/e2e/input-bar.spec.ts` exists; tests `/` trigger, Escape close, send button disabled state, ArrowUp history
    - `apps/web/e2e/file-picker.spec.ts` exists; tests `@` trigger (mode=insert) and CreateSessionDialog picker (mode=select)
    - `apps/web/e2e/chat-chrome.spec.ts` exists; covers D-51 (AppShell header conditional hide + ChatHeader 三件套 + back 全视口 + overflow 内容) 和 D-53 (Sidebar Settings 占位)
    - Playwright lists at least 3 new spec files
    - Typecheck passes
  </acceptance_criteria>
  <done>E2E coverage for FRONT-06 input-side + shared picker in CreateSessionDialog + D-51/D-53 chrome assertions.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 6: Visual verification — Chat JSON full end-to-end (input + chat header + shared picker)</name>
  <what-built>
    - InputBar (1-8 line textarea, Enter send, Shift+Enter newline, / slash, @ file, ↑ history, Escape)
    - SlashCommandPicker (subscribes command-store, CSS absolute positioning)
    - FilePathPicker (shared, insert + select modes, dirsOnly option)
    - QuotePreviewBar (reads chat-store.quotedMessage, dismiss clears)
    - SemanticActionPanel (5 icon buttons, JSON routes wired; CustomEvent bridge to InputBar for history/cancel)
    - **ChatHeader (D-51 极简三件套)**：返回按钮（全视口）+ 会话标题 + mode badge + overflow 菜单（Permission mode 子菜单 / Rename / Duplicate / Terminate destructive）。**无** 独立 permission-mode 按钮、**无** sidebar-toggle。
    - **AppShell header 条件隐藏（D-51）**：/chat/* 路由下 header 不渲染
    - **Sidebar Settings 齿轮占位（D-53）**：点击 toast "Settings coming soon"
    - chat.tsx composes ChatHeader + ChatJsonView with real InputBar region
    - CreateSessionDialog refactored to use shared FilePathPicker (mode=select, dirsOnly)
    - 3 Playwright e2e specs（input-bar / file-picker / chat-chrome）
  </what-built>
  <how-to-verify>
    1. Start relay + proxy + web dev
    2. 导航到 /sessions → AppShell header 有"CC Anywhere"字样显示（非 chat 路由）
    3. 点击"新建会话" → Dialog now shows a FilePathPicker below the CWD input; typing or clicking dirs updates the CWD field
    4. 创建 JSON session → 打开 Chat page → **验证 D-51**：AppShell header **不再显示**；ChatHeader 是唯一顶部 chrome；内容只有返回按钮 + 会话名 + overflow `⋯`
    5. Playwright MCP + 人工检查：
       - **Mobile 390x844:** ChatHeader 48px，返回按钮可见；messages 滚动；InputBar 在底部（1 行初高）；SemanticActionPanel 作为 icon 列在 InputBar 右侧
       - **Desktop 1280x800:** Sidebar 左侧；主区顶部仍是 ChatHeader（**没有 AppShell header**）；返回按钮依然可见（不再 md:hidden）
    6. 点击 ChatHeader 的 overflow `⋯` → 展开菜单依次看到：Permission mode(子菜单) / Rename / Duplicate / 分隔线 / Terminate(红色)。点 Permission mode → 子菜单列出 默认 / 自动允许 / 规划模式
    7. Send a message "hello" → User bubble right-aligned; assistant response streams
    8. Type `/` → SlashCommandPicker opens above InputBar with live commands from command-store
    9. Type `@` → FilePathPicker (mode=insert) opens with current directory listing (dir_list_request observable in WS traffic)
    10. Trigger a tool approval → card appears inline; focus card and press `y`/`n`/`a`
    11. ArrowUp history / ArrowDown / Escape 行为如前
    12. Semantic panel buttons → "打断输出" → worker_abort sent; "历史上一条" dispatches CustomEvent → InputBar recalls; "取消" clears quote
    13. Overflow → Permission mode → 选 "自动允许" → permission_mode_change 发出（radio group 勾选态生效）
    14. Textarea autosize: paste a 500-char block → grows up to 240px then scrolls internally
    15. On iOS Safari (if available): focus InputBar → keyboard pops up → InputBar stays above keyboard via visualViewport offset
    16. CreateSessionDialog end-to-end: 点 "新建会话" → FilePathPicker 仅显示目录 → 点目录 → CWD 填入绝对路径 → submit 创建会话
    17. **D-53 Sidebar Settings**：桌面端 Sidebar 底部可见齿轮图标；点击 → toast "Settings coming soon"
    18. Cross-reference 10-UI-SPEC.md 六维度：
       - **Color:** ChatHeader bg-card; InputBar textarea bg-input; picker shadows from popover
       - **Typography:** InputBar font-normal; picker entries font-mono 13px; header title text-sm font-semibold
       - **Spacing:** Header 48px; InputBar min 48 / max 240; picker max-h 60
       - **States:** Focus ring on textarea; hover on picker entries; disabled send button at empty
       - **Copy:** 文案匹配 Copywriting Contract——InputBar placeholders / permission 标签（默认/自动允许/规划模式）/ 终止会话 / picker 空态
       - **Responsive (D-51 更新):** 返回按钮全视口显示（不再 md:hidden）；AppShell header 仅非-chat 路由显示
    19. Run e2e: `pnpm --filter web exec playwright test input-bar.spec.ts file-picker.spec.ts chat-chrome.spec.ts`
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
| user text → proxy | user_input envelope sent as-is to proxy; proxy treats as user-intended command |
| file-picker entries → UI | File/dir names returned from proxy shown; inserted as plain text |
| custom events (cc:input-*) | Window-level custom events used by SemanticActionPanel → InputBar; all user-initiated clicks; temporary, removed in 10-06 |
| CreateSessionDialog CWD input | String path sent to proxy |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-10-04b-01 | Tampering | InputBar autosize vs visualViewport resize loop | mitigate | Autosize hook depends only on `value` (not viewport) — RESEARCH Pitfall 4 avoided by design |
| T-10-04b-02 | Information Disclosure | file-path-picker displays filesystem contents | mitigate | Only paths returned by proxy dir_list_response are shown; no direct filesystem access in browser |
| T-10-04b-03 | Tampering | SemanticActionPanel CustomEvent bridge can be forged by any script | accept | Window-scope; all same-origin; bridge is a temporary migration seam removed in Plan 10-06 Task 1 |
| T-10-04b-04 | Repudiation | History localStorage not encrypted | accept | User's own machine; no sync to server; content identical to what user types |
| T-10-04b-05 | Tampering | CreateSessionDialog CWD string sent raw to proxy | mitigate | Input trimmed; empty rejected client-side; proxy validates path existence server-side |
</threat_model>

<verification>
- `pnpm --filter web typecheck` exits 0
- `pnpm --filter web exec playwright test input-bar.spec.ts file-picker.spec.ts chat-chrome.spec.ts` passes
- Plan 10-04a tests (message-bubble, markdown-view, tool-approval, follow-output) still pass
- Manual: full user flow works end-to-end (send / receive / slash / @ / history / quote / terminate)
- Manual: CreateSessionDialog uses FilePathPicker (select, dirsOnly)
- **D-51/D-53 验证**：/chat/* 路由下无 AppShell header；ChatHeader 只有返回/标题/overflow 三件套；Sidebar 底部 Settings 齿轮占位存在
- User approved visual match
</verification>

<success_criteria>
- 6 new chat components (input-bar, slash-picker, file-picker, quote-preview, semantic-panel, chat-header) + 3 new hooks
- FilePathPicker is shared across InputBar (insert) and CreateSessionDialog (select, dirsOnly)
- CustomEvent bridge is documented as temporary; to be removed in Plan 10-06 Task 1
- chat.tsx composes full JSON mode
- **D-51**: AppShell header 在 /chat/* 下隐藏；ChatHeader 实现三件套（返回 / 标题+badge / overflow 含 permission-mode 子菜单 + Rename + Duplicate + Terminate），无独立 permission-mode 按钮和 sidebar-toggle；返回按钮全视口显示
- **D-53**: Sidebar 底部 Settings 齿轮占位（`data-slot="sidebar-settings-trigger"`），点击 toast "Settings coming soon"
- chat-chrome.spec.ts e2e 覆盖以上 D-51/D-53 断言
- User approved
</success_criteria>

<output>
Create `.planning/phases/10-pages-components-migration/10-04b-SUMMARY.md` with:
- Component APIs (each with props signature)
- FilePathPicker refactor: before (Plan 10-03 textarea) vs after (shared picker in CreateSessionDialog)
- SemanticActionPanel routes (JSON wired; PTY deferred to Plan 10-05)
- CustomEvent bridge documentation — Plan 10-06 Task 1 removes it
- E2E suite outcomes
- Visual checkpoint screenshots
- Open items for Plan 10-05 (PTY routes in SemanticActionPanel; ChatPtyView component)
</output>
