---
phase: 10-pages-components-migration
plan: 04a
type: execute
wave: 4
depends_on:
  - 10-01b
  - 10-03
files_modified:
  - apps/web/package.json
  - pnpm-lock.yaml
  - apps/web/src/utils/summarize-tool-input.ts
  - apps/web/src/hooks/use-follow-output.ts
  - apps/web/src/components/chat/markdown-view.tsx
  - apps/web/src/components/chat/message-bubble.tsx
  - apps/web/src/components/chat/tool-approval-card.tsx
  - apps/web/src/components/chat/chat-json-view.tsx
  - apps/web/src/components/chat/back-to-bottom.tsx
  - apps/web/src/components/chat/status-line.tsx
  - apps/web/src/services/chat-dispatcher.ts
  - apps/web/src/hooks/use-relay-setup.ts
  - apps/web/src/pages/chat.tsx
  - apps/web/src/components/chat/message-bubble.test.tsx
  - apps/web/src/components/chat/markdown-view.test.tsx
  - apps/web/e2e/tool-approval.spec.ts
  - apps/web/e2e/follow-output.spec.ts
autonomous: false
requirements:
  - FRONT-06
  - FRONT-08
tags:
  - chat-json-core
  - virtual-scroll
  - markdown
  - tool-approval
  - dispatcher
user_setup: []

must_haves:
  truths:
    - "User sees existing JSON chat messages in a virtualized scrollable list"
    - "New messages stream in with auto-scroll to bottom (follow-output), freezes if user scrolls up, unfreezes at bottom"
    - "Markdown renders with GFM + code highlight; script/iframe/object/embed tags are dropped"
    - "User sees a ToolApprovalCard (compact) when Claude requests a tool; three buttons 允许 / 总是允许此工具 / 拒绝; y/n/a shortcuts work when card focused"
    - "chat-dispatcher service registers with wsManager and routes JSON control messages to chat-store"
    - "chat.tsx dispatches to ChatJsonView for mode=json; InputBar area left as stub for Plan 10-04b"
    - "All chat components receive sessionId as prop and use scoped selectors (ready for Plan 10-06 per-session store)"
  artifacts:
    - path: "apps/web/src/components/chat/chat-json-view.tsx"
      provides: "Virtualized message list container, sessionId-scoped — InputBar slot deferred to 10-04b"
      min_lines: 60
    - path: "apps/web/src/components/chat/message-bubble.tsx"
      provides: "Role-based (user/assistant/tool/system) bubble"
    - path: "apps/web/src/components/chat/markdown-view.tsx"
      provides: "Safe markdown rendering with code highlight"
    - path: "apps/web/src/components/chat/tool-approval-card.tsx"
      provides: "Inline / floating tool approval with y/n/a keyboard"
    - path: "apps/web/src/services/chat-dispatcher.ts"
      provides: "JSON protocol dispatcher — forward compat with per-session chat-store"
  key_links:
    - from: "apps/web/src/components/chat/chat-json-view.tsx"
      to: "useChatStore(sessionId-scoped selector)"
      via: "per-session slice read"
      pattern: "useChatStore"
    - from: "apps/web/src/services/chat-dispatcher.ts"
      to: "wsManager.onMessage"
      via: "JSON dispatcher registration"
      pattern: "onMessage"
    - from: "apps/web/src/hooks/use-relay-setup.ts"
      to: "registerChatDispatcher"
      via: "setup effect registers + cleans up"
      pattern: "registerChatDispatcher"
---

<objective>
Deliver the core Chat JSON rendering surface (FRONT-06 half 1): dependency install, markdown view, message bubble, tool approval card, virtualized list container, status/BackToBottom helpers, and the WebSocket-to-chat-store dispatcher. **InputBar, pickers, quote preview, semantic action panel, chat header — all deferred to Plan 10-04b.** chat.tsx is stubbed for the InputBar region so the page can still render.

**CRITICAL: every Chat component receives `sessionId` as prop from the start.** Plan 10-06 rewrites chat-store to per-session map; by passing sessionId prop now, consumers only need to change their selector in 10-06, not their prop drilling.

Purpose: Ship the "view" half of JSON mode (read-only but fully rendered). Input half ships in 10-04b.

Output: 8 new chat components/utils/hooks, 1 rewritten page (chat.tsx stub for input), 1 new dispatcher service, 1 modified hook (use-relay-setup), 2 e2e specs (tool-approval, follow-output), 2 unit tests.
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
@apps/web/src/services/websocket.ts
@apps/web/src/stores/chat-store.ts
@apps/feishu/src/components/tool-approval-card/index.tsx
@apps/feishu/src/utils/summarize-tool-input.ts

<interfaces>
<!-- Per-session prop contract (designed for Plan 10-06 compatibility) -->

Every Chat-mode component accepts `sessionId: string` as a prop:
```tsx
interface ChatJsonViewProps { sessionId: string; }
interface MessageBubbleProps { message: ChatMessage; sessionId: string; }
interface ToolApprovalCardProps { approval: ToolApprovalRequest; sessionId: string; container: "inline" | "floating"; }
```

Selector pattern (Plan 10-06 compat — use same shape; initial flat store is treated as "session 0"):
```ts
// Plan 10-04a (current flat store):
const messages = useChatStore((s) => s.messages);

// Plan 10-06 (per-session; only selector changes):
const messages = useChatStore((s) => s.bySessionId[sessionId]?.messages ?? []);
```

**The difference is in the selector body only. The component prop shape stays identical.** Consumers MUST already receive sessionId even though today's flat store ignores it — this avoids a mass prop-drill refactor in 10-06.

Chat-dispatcher shape (new `apps/web/src/services/chat-dispatcher.ts`):
```ts
export function registerChatDispatcher(): () => void;
// Registers a wsManager.onMessage handler that:
//   1. JSON.parse raw text
//   2. safeParse via RelayControlSchema
//   3. Switch by type:
//        assistant_message_delta → appendAssistantText
//        assistant_message_complete → markTurnComplete
//        tool_request → addApprovalRequest
//        tool_approved / tool_denied → updateApprovalStatus
// Returns a cleanup function that unregisters.
```

Wiring point — `apps/web/src/hooks/use-relay-setup.ts`:
Add `registerChatDispatcher()` call inside the setup effect; cleanup in return.

react-markdown + GFM + highlight security config (RESEARCH §2.7):
```tsx
<Markdown
  remarkPlugins={[remarkGfm]}
  rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
  skipHtml
  disallowedElements={["script", "iframe", "object", "embed"]}
  components={{
    a: ({ href, children, ...rest }) => (
      <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>{children}</a>
    ),
  }}
>{text}</Markdown>
```

scrollToIndex behavior policy (RESEARCH §14 Q9):
- Streaming delta → `behavior: "auto"` (no animation, immediate)
- User-initiated BackToBottom click → `behavior: "smooth"` (animated)

Virtual scroll pattern (RESEARCH §8.3): see chat-json-view.tsx implementation in Task 2.

Chat.tsx stub contract: renders ChatHeader placeholder + ChatJsonView + a static div placeholder where Plan 10-04b will inject InputBar + SemanticActionPanel. The stub div must have `data-slot="input-bar-slot"` so 10-04b's visual checkpoint can spot the empty slot.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Install chat libs + build pure utils/hooks (summarize-tool-input, follow-output, markdown)</name>
  <files>
    apps/web/package.json,
    pnpm-lock.yaml,
    apps/web/src/utils/summarize-tool-input.ts,
    apps/web/src/hooks/use-follow-output.ts,
    apps/web/src/components/chat/markdown-view.tsx
  </files>
  <read_first>
    - apps/feishu/src/utils/summarize-tool-input.ts (pure function to port verbatim)
    - .planning/phases/10-pages-components-migration/10-RESEARCH.md §2.3 (virtual + follow-output), §2.7 (markdown security)
    - .planning/phases/10-pages-components-migration/10-PATTERNS.md L614-L649 (markdown-view pattern)
    - apps/web/package.json (confirm version targets: @tanstack/react-virtual@^3.13.23, react-markdown@^10.1.0, remark-gfm@^4.0.1, rehype-highlight@^7.0.2, highlight.js@^11.11.1)
  </read_first>
  <action>
    **Edit A — install new deps:**
    ```bash
    cd apps/web && pnpm add @tanstack/react-virtual@^3.13.23 react-markdown@^10.1.0 remark-gfm@^4.0.1 rehype-highlight@^7.0.2 highlight.js@^11.11.1
    ```
    Verify with `pnpm --filter web list @tanstack/react-virtual react-markdown remark-gfm rehype-highlight highlight.js`.

    **Edit B — apps/web/src/utils/summarize-tool-input.ts (port from Feishu):**
    Copy `apps/feishu/src/utils/summarize-tool-input.ts` verbatim — it's a pure TS function with no Taro deps. If the Feishu file imports types from `@cc-anywhere/shared`, keep those imports; if it imports from Taro, replace with equivalents.

    **Edit C — apps/web/src/hooks/use-follow-output.ts (new):**
    ```ts
    // 虚拟列表 follow-output 状态: 用户滚到底部时自动追随; 滚离底部后冻结
    import { useEffect, useRef, useState, type RefObject } from "react";

    interface Options {
      threshold?: number;  // default 50px
    }

    export function useFollowOutput(
      scrollRef: RefObject<HTMLElement | null>,
      opts: Options = {},
    ): { isAtBottom: boolean; scrollToBottom: () => void } {
      const [isAtBottom, setIsAtBottom] = useState(true);
      const thresholdRef = useRef(opts.threshold ?? 50);

      useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const onScroll = () => {
          const threshold = thresholdRef.current;
          const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
          setIsAtBottom(atBottom);
        };
        onScroll();
        el.addEventListener("scroll", onScroll, { passive: true });
        return () => el.removeEventListener("scroll", onScroll);
      }, [scrollRef]);

      const scrollToBottom = () => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
      };

      return { isAtBottom, scrollToBottom };
    }
    ```

    **Edit D — apps/web/src/components/chat/markdown-view.tsx (new):**
    ```tsx
    // Markdown 视图: react-markdown + GFM + rehype-highlight (github-dark)
    // 强制 skipHtml + disallowedElements 防御 XSS (RESEARCH §2.7 / Pitfall 3)
    import Markdown from "react-markdown";
    import remarkGfm from "remark-gfm";
    import rehypeHighlight from "rehype-highlight";
    import "highlight.js/styles/github-dark.css";
    import { memo, type ReactNode } from "react";

    interface MarkdownViewProps {
      text: string;
    }

    function CodeBlock({ children, ...rest }: { children?: ReactNode }) {
      return (
        <pre className="my-3 rounded-md bg-muted p-3 overflow-x-auto text-[13px]">
          <code {...rest}>{children}</code>
        </pre>
      );
    }

    export const MarkdownView = memo(function MarkdownView({ text }: MarkdownViewProps) {
      return (
        <div className="prose prose-invert prose-sm max-w-none">
          <Markdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
            skipHtml
            disallowedElements={["script", "iframe", "object", "embed"]}
            components={{
              a: ({ href, children, ...rest }) => (
                <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
                  {children}
                </a>
              ),
              code: ({ className, children, ...rest }) => {
                const isBlock = typeof className === "string" && className.includes("language-");
                if (isBlock) {
                  return (
                    <CodeBlock {...rest}>
                      <span className={className}>{children}</span>
                    </CodeBlock>
                  );
                }
                return <code className="rounded bg-muted px-1 py-0.5 text-[0.9em]" {...rest}>{children}</code>;
              },
            }}
          >
            {text}
          </Markdown>
        </div>
      );
    });
    ```

    Commit message: `feat(10-04a): chat deps + follow-output hook + markdown view`
  </action>
  <verify>
    <automated>pnpm --filter web typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `apps/web/package.json` lists `@tanstack/react-virtual`, `react-markdown`, `remark-gfm`, `rehype-highlight`, `highlight.js` at specified versions
    - `apps/web/src/utils/summarize-tool-input.ts` exists and exports `summarizeToolInput`
    - `apps/web/src/hooks/use-follow-output.ts` uses threshold 50px and `addEventListener("scroll", ..., { passive: true })`
    - `apps/web/src/components/chat/markdown-view.tsx` uses `skipHtml` + `disallowedElements={["script", "iframe", "object", "embed"]}` (grep exact strings)
    - `apps/web/src/components/chat/markdown-view.tsx` wraps component in `memo()`
    - `pnpm --filter web typecheck` exits 0
  </acceptance_criteria>
  <done>Markdown + follow-output foundations in place for rendering tasks.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: MessageBubble + ToolApprovalCard + ChatJsonView (virtualized) + small components</name>
  <files>
    apps/web/src/components/chat/message-bubble.tsx,
    apps/web/src/components/chat/tool-approval-card.tsx,
    apps/web/src/components/chat/chat-json-view.tsx,
    apps/web/src/components/chat/back-to-bottom.tsx,
    apps/web/src/components/chat/status-line.tsx,
    apps/web/src/components/chat/message-bubble.test.tsx,
    apps/web/src/components/chat/markdown-view.test.tsx
  </files>
  <read_first>
    - apps/feishu/src/components/tool-approval-card/index.tsx L1-L100 (resolved-state branching + summary pattern)
    - apps/feishu/src/components/back-to-bottom/index.tsx (19 lines — shape reference)
    - apps/feishu/src/components/status-line/index.tsx (15 lines — shape reference)
    - apps/web/src/stores/chat-store.ts (ChatMessage / ToolApprovalRequest / ToolCallInfo types)
    - .planning/phases/10-pages-components-migration/10-UI-SPEC.md Component Inventory (MessageBubble role variants; ToolApprovalCard container variants; BackToBottom amber accent on new msgs); Copywriting Contract (ToolApproval buttons)
    - .planning/phases/10-pages-components-migration/10-PATTERNS.md L570-L612 (virtualized list pattern); L742-L787 (ToolApprovalCard)
    - .planning/phases/10-pages-components-migration/10-RESEARCH.md §8.3 (virtualizer reference impl); §2.3 (isAtBottom pattern + Pitfall 1)
  </read_first>
  <behavior>
    - Test 1 (message-bubble): user role → right-aligned bubble; assistant → left-aligned; tool → left, muted; system → centered narrow
    - Test 2 (markdown-view): input `<script>alert(1)</script>hello` renders only "hello" (script dropped)
    - Test 3 (markdown-view): input `<iframe src="bad">` renders without iframe
    - Test 4 (chat-json-view): isAtBottom starts true; after simulated scrollUp, isAtBottom goes false, BackToBottom appears
  </behavior>
  <action>
    **Edit A — apps/web/src/components/chat/message-bubble.tsx (new):**
    ```tsx
    // 消息气泡, role 决定对齐与样式, 自研无 shadcn Card
    // user 右对齐 / assistant+tool 左对齐 / system 居中
    import { memo } from "react";
    import type { ChatMessage } from "@/stores/chat-store";
    import { MarkdownView } from "./markdown-view";
    import { cn } from "@/lib/utils";

    interface MessageBubbleProps {
      message: ChatMessage;
      sessionId: string;  // 为 Plan 10-06 预留; 当前 flat store 未使用
    }

    export const MessageBubble = memo(function MessageBubble({ message }: MessageBubbleProps) {
      const role = message.role;

      if (role === "user") {
        return (
          <article
            data-slot="message-bubble"
            data-role="user"
            className="flex justify-end px-4 py-2"
          >
            <div className="max-w-[80%] rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm">
              <MarkdownView text={message.text} />
            </div>
          </article>
        );
      }

      return (
        <article
          data-slot="message-bubble"
          data-role={role}
          className={cn(
            "flex justify-start px-4 py-2",
          )}
        >
          <div className="max-w-[80%] rounded-md bg-card text-foreground px-4 py-2 text-sm">
            <MarkdownView text={message.text} />
            {message.isPartial && (
              <span
                className="inline-block w-2 h-4 ml-1 bg-[var(--color-status-working)] animate-pulse align-middle"
                aria-label="streaming"
              />
            )}
          </div>
        </article>
      );
    });
    ```

    **Edit B — apps/web/src/components/chat/tool-approval-card.tsx (new):**
    Full implementation: three buttons (允许/总是允许此工具/拒绝), y/n/a shortcuts scoped to `card.contains(document.activeElement)` (NOT global), localStorage `cc_toolWhitelist:${sessionId}` for Always Allow.
    ```tsx
    // 工具审批卡, 紧凑态三按钮 + 详情展开 + 会话白名单记忆
    // y/n/a 快捷键仅在卡片聚焦时响应 (UI-SPEC A11y 第 5 条)
    import { useEffect, useRef, useState } from "react";
    import { ChevronDown, ChevronUp } from "lucide-react";
    import type { ToolApprovalRequest } from "@/stores/chat-store";
    import { relayClientRef } from "@/services/ensure-binding";
    import { Button } from "@/components/ui/button";
    import { summarizeToolInput } from "@/utils/summarize-tool-input";
    import { cn } from "@/lib/utils";

    interface ToolApprovalCardProps {
      approval: ToolApprovalRequest;
      sessionId: string;
      container: "inline" | "floating";
    }

    function whitelistKey(sessionId: string): string {
      return `cc_toolWhitelist:${sessionId}`;
    }

    function readWhitelist(sessionId: string): string[] {
      try {
        const raw = localStorage.getItem(whitelistKey(sessionId));
        return raw ? JSON.parse(raw) : [];
      } catch {
        return [];
      }
    }

    function addToWhitelist(sessionId: string, toolName: string): void {
      const current = readWhitelist(sessionId);
      if (current.includes(toolName)) return;
      localStorage.setItem(whitelistKey(sessionId), JSON.stringify([...current, toolName]));
    }

    export function ToolApprovalCard({ approval, sessionId, container }: ToolApprovalCardProps) {
      const [expanded, setExpanded] = useState(false);
      const [acted, setActed] = useState(false);
      const cardRef = useRef<HTMLDivElement>(null);

      const summary = summarizeToolInput(approval.toolName, approval.input);
      const isResolved = approval.status !== "pending";

      function send(decision: "allow" | "deny", whitelistTool = false) {
        if (acted || isResolved) return;
        setActed(true);
        const relay = relayClientRef.current;
        relay?.sendControl({
          type: "tool_approve",
          sessionId,
          payload: {
            toolId: approval.requestId,
            toolName: approval.toolName,
            decision,
            whitelistTool,
          },
        });
        if (whitelistTool) addToWhitelist(sessionId, approval.toolName);
      }

      // 键盘快捷键: y=allow, n=deny, a=always
      useEffect(() => {
        const card = cardRef.current;
        if (!card) return;
        const onKey = (e: KeyboardEvent) => {
          if (!card.contains(document.activeElement)) return;
          if (acted || isResolved) return;
          if (e.key.toLowerCase() === "y") { e.preventDefault(); send("allow"); }
          else if (e.key.toLowerCase() === "n") { e.preventDefault(); send("deny"); }
          else if (e.key.toLowerCase() === "a") { e.preventDefault(); send("allow", true); }
        };
        card.addEventListener("keydown", onKey);
        return () => card.removeEventListener("keydown", onKey);
      }, [acted, isResolved]);

      if (isResolved) {
        const color = approval.status === "approved" ? "text-[var(--color-status-success)]" : "text-destructive";
        return (
          <div
            data-slot="tool-approval-card"
            data-status={approval.status}
            className={cn(
              "rounded-md border border-border bg-card px-3 py-2 text-xs",
              container === "floating" && "fixed bottom-4 right-4 max-w-[360px] shadow-lg",
            )}
          >
            <span className={cn("font-mono", color)}>{approval.toolName}</span>
            <span className="text-muted-foreground ml-2">
              {approval.status === "approved" ? "已允许" : "已拒绝"}
            </span>
          </div>
        );
      }

      return (
        <div
          ref={cardRef}
          tabIndex={-1}
          data-slot="tool-approval-card"
          data-status="pending"
          className={cn(
            "rounded-md border border-border bg-card p-3 flex flex-col gap-2",
            container === "floating" && "fixed bottom-4 right-4 w-[360px] max-w-[90vw] shadow-lg z-20",
          )}
          role="region"
          aria-label={`工具审批: ${approval.toolName}`}
        >
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-[var(--color-status-warning)]">{approval.toolName}</span>
            <span className="text-xs text-muted-foreground flex-1 truncate">{summary}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setExpanded((v) => !v)}
              aria-label={expanded ? "收起详情" : "展开详情"}
            >
              {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
            </Button>
          </div>
          {expanded && (
            <pre className="text-xs bg-muted rounded p-2 overflow-x-auto font-mono max-h-48">
              {JSON.stringify(approval.input, null, 2)}
            </pre>
          )}
          <div className="flex gap-2 justify-end">
            <Button variant="destructive" size="sm" onClick={() => send("deny")} data-action="deny">
              拒绝
            </Button>
            <Button variant="outline" size="sm" onClick={() => send("allow", true)} data-action="always">
              总是允许此工具
            </Button>
            <Button size="sm" onClick={() => send("allow")} data-action="allow">
              允许
            </Button>
          </div>
          <div className="text-[10px] text-muted-foreground">
            快捷键: y=允许 / n=拒绝 / a=总是允许 (卡片聚焦时)
          </div>
        </div>
      );
    }
    ```

    **Edit C — small components:**

    `apps/web/src/components/chat/back-to-bottom.tsx` (new):
    ```tsx
    import { ArrowDown } from "lucide-react";
    import { Button } from "@/components/ui/button";
    import { cn } from "@/lib/utils";

    interface BackToBottomProps {
      visible: boolean;
      hasNewMessages?: boolean;
      onClick: () => void;
    }

    export function BackToBottom({ visible, hasNewMessages, onClick }: BackToBottomProps) {
      if (!visible) return null;
      return (
        <Button
          size="icon"
          variant="outline"
          onClick={onClick}
          className="absolute bottom-20 right-4 rounded-full shadow-md relative"
          aria-label="回到底部"
          data-slot="back-to-bottom"
        >
          <ArrowDown aria-hidden="true" />
          {hasNewMessages && (
            <span
              className={cn(
                "absolute top-0 right-0 -mt-1 -mr-1 w-2 h-2 rounded-full bg-primary",
              )}
              aria-label="有新消息"
            />
          )}
        </Button>
      );
    }
    ```

    `apps/web/src/components/chat/status-line.tsx` (new):
    ```tsx
    import { cn } from "@/lib/utils";

    interface StatusLineProps {
      state: "idle" | "working" | "reconnecting" | "error";
      message?: string;
    }

    const STATE_COLOR: Record<StatusLineProps["state"], string> = {
      idle: "text-muted-foreground",
      working: "text-[var(--color-status-working)]",
      reconnecting: "text-[var(--color-status-warning)]",
      error: "text-[var(--color-status-error)]",
    };

    export function StatusLine({ state, message }: StatusLineProps) {
      if (state === "idle" && !message) return null;
      return (
        <div
          className="h-6 px-4 flex items-center text-xs border-t border-border"
          data-slot="status-line"
          data-state={state}
        >
          <span className={cn("font-mono", STATE_COLOR[state])}>
            {message ?? state}
          </span>
        </div>
      );
    }
    ```

    **Edit D — apps/web/src/components/chat/chat-json-view.tsx (new, virtualized list — NO InputBar):**
    ```tsx
    // JSON 模式主视图: 虚拟滚动消息列表 + 内联 ToolApprovalCard + StatusLine
    // InputBar + SemanticActionPanel + QuotePreviewBar 在 Plan 10-04b 接入
    // 占位 slot `data-slot="input-bar-slot"` 保留给 10-04b
    import { useEffect, useRef, useState } from "react";
    import { useVirtualizer } from "@tanstack/react-virtual";
    import { useChatStore } from "@/stores/chat-store";
    import { MessageBubble } from "./message-bubble";
    import { ToolApprovalCard } from "./tool-approval-card";
    import { BackToBottom } from "./back-to-bottom";
    import { StatusLine } from "./status-line";
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

      // 自动追随: streaming delta -> auto (无动画, RESEARCH Q9)
      useEffect(() => {
        if (isAtBottom && messages.length > 0) {
          virtualizer.scrollToIndex(messages.length - 1, { align: "end", behavior: "auto" });
          setNewMsgsWhileAway(false);
        } else if (!isAtBottom && messages.length > 0) {
          setNewMsgsWhileAway(true);
        }
      }, [messages.length, lastMsg?.text, isAtBottom, virtualizer]);

      const pendingApproval = pendingApprovals.find((a) => a.status === "pending");

      if (messages.length === 0 && !pendingApproval) {
        return (
          <div className="flex flex-col h-full">
            <div className="flex-1">
              <EmptyState variant="no-messages" />
            </div>
            <StatusLine state={isWorking ? "working" : "idle"} message={isWorking ? "Claude 正在响应..." : undefined} />
            <div data-slot="input-bar-slot" className="border-t border-border p-2 text-xs text-muted-foreground">
              {/* Plan 10-04b injects InputBar + SemanticActionPanel + QuotePreviewBar here */}
              InputBar 待 Plan 10-04b 接入
            </div>
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
                // 用户点击 -> smooth (RESEARCH Q9)
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
          <div data-slot="input-bar-slot" className="border-t border-border p-2 text-xs text-muted-foreground">
            {/* Plan 10-04b injects InputBar + SemanticActionPanel + QuotePreviewBar here */}
            InputBar 待 Plan 10-04b 接入
          </div>
        </div>
      );
    }
    ```

    **Edit E — unit tests:**

    `apps/web/src/components/chat/message-bubble.test.tsx` (new):
    ```tsx
    import { describe, it, expect } from "vitest";
    import { render, screen } from "@testing-library/react";
    import { MessageBubble } from "./message-bubble";

    describe("MessageBubble", () => {
      it("renders user role with right alignment", () => {
        render(
          <MessageBubble
            message={{ id: "1", role: "user", text: "hello", isPartial: false, timestamp: 0, toolCalls: [] }}
            sessionId="s1"
          />,
        );
        const bubble = screen.getByRole("article");
        expect(bubble.getAttribute("data-role")).toBe("user");
      });

      it("renders assistant role with left alignment", () => {
        render(
          <MessageBubble
            message={{ id: "2", role: "assistant", text: "hi", isPartial: false, timestamp: 0, toolCalls: [] }}
            sessionId="s1"
          />,
        );
        const bubble = screen.getByRole("article");
        expect(bubble.getAttribute("data-role")).toBe("assistant");
      });

      it("shows streaming cursor when isPartial", () => {
        render(
          <MessageBubble
            message={{ id: "3", role: "assistant", text: "partial", isPartial: true, timestamp: 0, toolCalls: [] }}
            sessionId="s1"
          />,
        );
        expect(screen.getByLabelText("streaming")).toBeDefined();
      });
    });
    ```

    `apps/web/src/components/chat/markdown-view.test.tsx` (new):
    ```tsx
    import { describe, it, expect } from "vitest";
    import { render } from "@testing-library/react";
    import { MarkdownView } from "./markdown-view";

    describe("MarkdownView XSS防护", () => {
      it("drops script tags", () => {
        const { container } = render(<MarkdownView text={'<script>alert(1)</script>hello'} />);
        expect(container.querySelector("script")).toBeNull();
        expect(container.textContent).toContain("hello");
      });

      it("drops iframe tags", () => {
        const { container } = render(<MarkdownView text={'<iframe src="evil"></iframe>text'} />);
        expect(container.querySelector("iframe")).toBeNull();
      });

      it("drops object and embed", () => {
        const { container } = render(
          <MarkdownView text={'<object></object><embed></embed>text'} />,
        );
        expect(container.querySelector("object")).toBeNull();
        expect(container.querySelector("embed")).toBeNull();
      });

      it("renders fenced code block", () => {
        const { container } = render(
          <MarkdownView text={"```ts\nconst x = 1;\n```"} />,
        );
        expect(container.querySelector("pre")).not.toBeNull();
      });

      it("renders external links with rel=noopener", () => {
        const { container } = render(<MarkdownView text={"[click](https://example.com)"} />);
        const link = container.querySelector("a");
        expect(link?.getAttribute("target")).toBe("_blank");
        expect(link?.getAttribute("rel")).toContain("noopener");
      });
    });
    ```

    Commit message: `feat(10-04a): message bubble + tool approval + chat json view virtualized`
  </action>
  <verify>
    <automated>pnpm --filter web test message-bubble markdown-view 2>&1 | tail -15 && pnpm --filter web typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `apps/web/src/components/chat/message-bubble.tsx` uses `role === "user"` for right-align, others left; has `data-role` attribute
    - `apps/web/src/components/chat/tool-approval-card.tsx` has three buttons labeled `允许` / `总是允许此工具` / `拒绝` (exact copy)
    - `apps/web/src/components/chat/tool-approval-card.tsx` has keyboard handler scoped to `card.contains(document.activeElement)` (NOT global)
    - `apps/web/src/components/chat/tool-approval-card.tsx` writes `cc_toolWhitelist:${sessionId}` to localStorage on "always" action
    - `apps/web/src/components/chat/chat-json-view.tsx` uses `useVirtualizer` with `overscan: 5` and `ref={virtualizer.measureElement}` (ref callback, not prop)
    - `apps/web/src/components/chat/chat-json-view.tsx` has `scrollReady` state guarding virtualizer children render (RESEARCH Pitfall 1)
    - `apps/web/src/components/chat/chat-json-view.tsx` streaming-delta scrollToIndex uses `behavior: "auto"`; user-click BackToBottom scrollToIndex uses `behavior: "smooth"` (RESEARCH Q9)
    - `apps/web/src/components/chat/chat-json-view.tsx` has a `data-slot="input-bar-slot"` placeholder div (grep: 2 matches — empty state + main state)
    - All chat components accept `sessionId: string` prop (even if flat store ignores for now)
    - `pnpm --filter web test message-bubble markdown-view` passes
    - Markdown XSS tests assert `<script>`, `<iframe>`, `<object>`, `<embed>` all dropped
    - `pnpm --filter web typecheck` exits 0
  </acceptance_criteria>
  <done>Virtualized message list + approval card + markdown + small components all done; InputBar slot reserved.</done>
</task>

<task type="auto">
  <name>Task 3: chat-dispatcher + use-relay-setup wiring + chat.tsx stub</name>
  <files>
    apps/web/src/services/chat-dispatcher.ts,
    apps/web/src/hooks/use-relay-setup.ts,
    apps/web/src/pages/chat.tsx
  </files>
  <read_first>
    - apps/web/src/services/websocket.ts L96-L103 (dispatch point — onMessage registration)
    - apps/web/src/services/relay-client.ts
    - apps/web/src/hooks/use-relay-setup.ts (dispatcher registration target)
    - apps/web/src/stores/chat-store.ts (action signatures)
    - packages/shared/src/schemas/relay-control.ts (message types to dispatch)
    - .planning/phases/10-pages-components-migration/10-PATTERNS.md L653-L738 (websocket dispatch)
  </read_first>
  <action>
    **Edit A — apps/web/src/services/chat-dispatcher.ts (new):**
    ```ts
    // JSON 模式消息 dispatcher, 订阅 wsManager.onMessage
    // 把 relay 发来的 control/envelope 消息分发给 chat-store
    // 每条消息都带 sessionId, 为 Plan 10-06 per-session store 预留
    import { RelayControlSchema } from "@cc-anywhere/shared";
    import { wsManager } from "@/services/websocket";
    import { useChatStore } from "@/stores/chat-store";

    export function registerChatDispatcher(): () => void {
      const handler = (raw: string) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }
        const result = RelayControlSchema.safeParse(parsed);
        if (!result.success) return;
        const msg = result.data;

        // 仅处理与 chat-store 相关的类型; 其他由 phase-machine 处理
        switch (msg.type) {
          case "assistant_message_delta": {
            useChatStore.getState().appendAssistantText(msg.payload.text);
            break;
          }
          case "assistant_message_complete": {
            useChatStore.getState().markTurnComplete();
            break;
          }
          case "tool_request": {
            useChatStore.getState().addApprovalRequest({
              requestId: msg.payload.requestId,
              toolName: msg.payload.toolName,
              input: msg.payload.input,
              status: "pending",
            });
            break;
          }
          case "tool_approved":
          case "tool_denied": {
            useChatStore.getState().updateApprovalStatus(
              msg.payload.requestId,
              msg.type === "tool_approved" ? "approved" : "denied",
            );
            break;
          }
        }
      };

      return wsManager.onMessage(handler);
    }
    ```
    Note: the exact message type names (`assistant_message_delta` etc.) may differ in `packages/shared/src/schemas/*`. Executor should inspect the actual schema and use correct names + extract fields accordingly. If types don't match exactly, consult packages/shared schemas and adapt — do NOT invent new message types.

    **Edit B — apps/web/src/hooks/use-relay-setup.ts (modify):**
    Add dispatcher registration inside the existing setup effect:
    ```ts
    import { registerChatDispatcher } from "@/services/chat-dispatcher";

    // inside the useEffect that sets up relay:
    const unregisterChat = registerChatDispatcher();

    // inside cleanup:
    unregisterChat();
    ```

    **Edit C — apps/web/src/pages/chat.tsx (rewrite — minimal stub, no ChatHeader / InputBar yet):**
    ```tsx
    // ChatPage: 根据 ?mode= 渲染 JSON 或 PTY 视图
    // PTY 视图由 Plan 10-05 填充; ChatHeader + InputBar + SemanticActionPanel 由 Plan 10-04b 填充
    import { useParams, useSearchParams } from "react-router";
    import { ChatJsonView } from "@/components/chat/chat-json-view";
    import { EmptyState } from "@/components/shell/empty-state";

    export function ChatPage() {
      const { id } = useParams<{ id: string }>();
      const [searchParams] = useSearchParams();
      const mode = searchParams.get("mode");

      if (!id) {
        return <EmptyState variant="no-session" />;
      }

      return (
        <div className="flex flex-col h-full">
          {/* ChatHeader 由 Plan 10-04b 接入 */}
          <div
            data-slot="chat-header-placeholder"
            className="h-12 px-3 flex items-center border-b border-border text-sm text-muted-foreground"
          >
            Chat: {id}
          </div>
          <div className="flex-1 min-h-0">
            {mode === "pty" ? (
              // Plan 10-05 replaces with <ChatPtyView sessionId={id} />
              <div className="flex items-center justify-center h-full text-muted-foreground">
                PTY 模式待 Plan 10-05 集成
              </div>
            ) : (
              <ChatJsonView sessionId={id} />
            )}
          </div>
        </div>
      );
    }
    ```

    Commit message: `feat(10-04a): chat dispatcher + use-relay-setup wiring + chat stub page`
  </action>
  <verify>
    <automated>pnpm --filter web typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `apps/web/src/services/chat-dispatcher.ts` uses `RelayControlSchema.safeParse` and returns an unregister function
    - `apps/web/src/hooks/use-relay-setup.ts` calls `registerChatDispatcher()` and cleans up
    - `apps/web/src/pages/chat.tsx` dispatches on `mode === "pty"` vs JSON, with PTY placeholder + chat-header placeholder
    - `apps/web/src/pages/chat.tsx` has `data-slot="chat-header-placeholder"` noting Plan 10-04b will replace it
    - `pnpm --filter web typecheck` exits 0
  </acceptance_criteria>
  <done>ChatJsonView reachable via chat.tsx, dispatcher piped, input region left as stub.</done>
</task>

<task type="auto">
  <name>Task 4: Playwright e2e specs (tool-approval / follow-output)</name>
  <files>
    apps/web/e2e/tool-approval.spec.ts,
    apps/web/e2e/follow-output.spec.ts
  </files>
  <read_first>
    - apps/web/e2e/helpers.ts
    - .planning/phases/10-pages-components-migration/10-VALIDATION.md FRONT-06 rows (tool-approval, follow-output)
  </read_first>
  <action>
    Create two Playwright specs for rendering-side concerns. InputBar / file-picker specs ship in Plan 10-04b.

    **apps/web/e2e/tool-approval.spec.ts (new):**
    ```ts
    import { test, expect } from "@playwright/test";
    import { BASE_URL, resetLocalState } from "./helpers";

    test.describe("ToolApprovalCard — keyboard shortcuts", () => {
      test.use({ viewport: { width: 1280, height: 800 } });

      test.beforeEach(async ({ page }) => {
        await page.goto(`${BASE_URL}/#/chat/ta-sess?mode=json`);
        await resetLocalState(page);
      });

      test("card shows three buttons with exact copy", async ({ page }) => {
        // Seed a pending approval via window store (dev hook)
        await page.evaluate(() => {
          const w = window as unknown as {
            __CHAT_STORE__?: { getState: () => { addApprovalRequest: (r: unknown) => void } };
          };
          w.__CHAT_STORE__?.getState().addApprovalRequest({
            requestId: "r1",
            toolName: "Bash",
            input: { cmd: "ls" },
            status: "pending",
          });
        });
        await page.goto(`${BASE_URL}/#/chat/ta-sess?mode=json`);
        const card = page.locator('[data-slot="tool-approval-card"]').first();
        const cardExists = await card.count();
        if (cardExists === 0) {
          test.skip(true, "__CHAT_STORE__ dev hook not available; skip until added");
        }
        await expect(card.getByRole("button", { name: "允许" })).toBeVisible();
        await expect(card.getByRole("button", { name: "拒绝" })).toBeVisible();
        await expect(card.getByRole("button", { name: "总是允许此工具" })).toBeVisible();
      });
    });
    ```

    **apps/web/e2e/follow-output.spec.ts (new):**
    ```ts
    import { test, expect } from "@playwright/test";
    import { BASE_URL, resetLocalState } from "./helpers";

    test.describe("ChatJsonView — follow-output", () => {
      test.use({ viewport: { width: 1280, height: 800 } });

      test.beforeEach(async ({ page }) => {
        await page.goto(`${BASE_URL}/#/chat/fo-sess?mode=json`);
        await resetLocalState(page);
      });

      test("BackToBottom absent on empty state", async ({ page }) => {
        // 默认空状态 — 直接验证 BackToBottom 不可见
        const btb = page.locator('[data-slot="back-to-bottom"]');
        await expect(btb).toHaveCount(0);
      });

      test("input-bar-slot placeholder present (10-04b will replace)", async ({ page }) => {
        const slot = page.locator('[data-slot="input-bar-slot"]');
        await expect(slot).toBeVisible();
      });
    });
    ```

    These specs tolerate the absence of real stream data (mock store hooks gracefully skip). Full-flow verification happens in visual checkpoint.

    Commit message: `test(10-04a): chat render e2e specs`
  </action>
  <verify>
    <automated>pnpm --filter web typecheck && pnpm --filter web exec playwright test --list 2>&1 | grep -E "tool-approval|follow-output" | wc -l</automated>
  </verify>
  <acceptance_criteria>
    - `apps/web/e2e/tool-approval.spec.ts` exists and verifies three button copy (允许 / 总是允许此工具 / 拒绝)
    - `apps/web/e2e/follow-output.spec.ts` exists, verifies BackToBottom invisible initially and input-bar-slot placeholder visible
    - Playwright lists at least 2 new spec files
    - Typecheck passes
  </acceptance_criteria>
  <done>E2E coverage for FRONT-06 rendering flows in place.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 5: Visual verification — Chat JSON core rendering</name>
  <what-built>
    - ChatJsonView (virtualized) + follow-output + BackToBottom
    - MessageBubble role variants
    - MarkdownView with XSS protection, GFM, code highlight
    - ToolApprovalCard (compact + expandable, y/n/a shortcut)
    - StatusLine + BackToBottom helpers
    - chat-dispatcher.ts registered in use-relay-setup
    - chat.tsx minimally dispatches mode=json to ChatJsonView (InputBar slot placeholder)
    - 2 Playwright e2e specs (tool-approval, follow-output)
    - 2 unit tests (message-bubble, markdown-view)
  </what-built>
  <how-to-verify>
    1. Start relay + proxy + web dev
    2. Select proxy → create a JSON session → open Chat page
    3. Playwright MCP + manual checks:
       - **Mobile 390x844:** chat-header-placeholder at top; virtualized list fills mid; input-bar-slot placeholder at bottom (text: "InputBar 待 Plan 10-04b 接入")
       - **Desktop 1280x800:** same layout, sidebar from 10-01b intact
    4. Send a message via dev console (chat-store.addUserMessage + appendAssistantText) or wait for Claude stream → User bubble right-aligned amber bg; assistant bubble left-aligned card bg streams in
    5. Markdown test: inject `<script>alert(1)</script>` into a message → script dropped; markdown code block rendered with github-dark syntax colors
    6. Scroll up in message list → BackToBottom appears; click it → scrolls to bottom with smooth animation
    7. Trigger a tool approval (run a command that requires Bash) → ToolApprovalCard appears inline with 允许 / 总是允许此工具 / 拒绝
    8. Focus the card (Tab to it) → press `y` → allow sent; press `n` → deny sent; `a` → always allow (check localStorage cc_toolWhitelist:{sessionId})
    9. Cross-reference 10-UI-SPEC.md six dimensions:
       - **Color:** User bubble `bg-primary` amber; assistant bubble `bg-card`; destructive 拒绝 red; status working cyan; streaming cursor cyan
       - **Typography:** messages text-sm (14px); code blocks 13px mono
       - **Spacing:** placeholder 48px; bubble max-w 80%; message px-4 py-2
       - **States:** Hover on BackToBottom → outline; card focus → amber ring on buttons
       - **Copy:** All strings match Copywriting Contract — ToolApproval buttons, status messages
       - **Responsive:** Sidebar appears at md
    10. Run e2e: `pnpm --filter web exec playwright test tool-approval.spec.ts follow-output.spec.ts`
    11. Unit tests: `pnpm --filter web test message-bubble markdown-view`
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
| relay → chat-dispatcher | JSON messages from relay must be validated; untrusted text content enters Markdown renderer |
| markdown text → DOM | Claude's responses or user messages may contain HTML-like strings that must not execute |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-10-04a-01 | Tampering | Markdown XSS via `<script>`/`<iframe>` | mitigate | react-markdown `skipHtml: true` + `disallowedElements: ["script", "iframe", "object", "embed"]` — unit tested in markdown-view.test.tsx |
| T-10-04a-02 | Tampering | Markdown URL protocol `javascript:` | mitigate | react-markdown blocks javascript: URLs by default; external links forced to `rel="noopener noreferrer"` |
| T-10-04a-03 | Tampering | chat-dispatcher processes untrusted JSON | mitigate | All messages validated via `RelayControlSchema.safeParse` before dispatch; unknown types silently dropped (forward-compat) |
| T-10-04a-04 | Denial of Service | Large message list O(n) render | mitigate | Virtual scrolling with overscan 5 ensures only visible items render; MessageBubble wrapped in memo |
| T-10-04a-05 | Tampering | ToolApprovalCard keyboard shortcut hijacking | mitigate | Keyboard listener scoped to `card.contains(document.activeElement)` — does NOT swallow global typing |
| T-10-04a-06 | Repudiation | localStorage cc_toolWhitelist manipulation | accept | User-controlled local preference; no security boundary |
</threat_model>

<verification>
- `pnpm --filter web typecheck` exits 0
- `pnpm --filter web test message-bubble markdown-view` all pass
- Markdown XSS tests pass (script/iframe/object/embed dropped)
- Playwright suites run (may skip tests that need dev store hooks)
- Manual: JSON rendering flow works (view stream, approve tool)
- User approved visual match
</verification>

<success_criteria>
- 8 chat render components + 1 dispatcher exist and respect UI-SPEC token usage
- Every component receives `sessionId` prop (ready for Plan 10-06)
- Virtualized list handles 1000+ messages without jank (checkpoint perf trace review)
- XSS defense verified in unit tests
- Tool approval y/n/a shortcuts scoped correctly
- Dispatcher wired via use-relay-setup
- ChatJsonView has input-bar-slot placeholder ready for Plan 10-04b
- User approved
</success_criteria>

<output>
Create `.planning/phases/10-pages-components-migration/10-04a-SUMMARY.md` with:
- Dependencies installed with versions
- Component APIs (each with props signature)
- Dispatcher message types handled (list from chat-dispatcher switch)
- scrollToIndex behavior policy (auto for streaming, smooth for user click)
- E2E suite outcomes
- Visual checkpoint screenshots
- Open items for Plan 10-04b (InputBar, SlashCommandPicker, FilePathPicker, QuotePreviewBar, SemanticActionPanel, ChatHeader, full chat.tsx integration)
</output>
