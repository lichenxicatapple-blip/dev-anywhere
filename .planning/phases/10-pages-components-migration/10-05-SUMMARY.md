---
phase: 10-pages-components-migration
plan: 05
subsystem: chat-pty
tags:
  - chat-pty
  - xterm
  - ansi-keys
  - remote-input-raw
requires:
  - 10-01b
  - 10-03
provides:
  - createXtermTerminal factory
  - ansi-keys 5-const library + sendSemanticAction
  - remote_input_raw envelope (shared schema + proxy serve.ts branch)
  - ChatPtyView self-contained component
affects:
  - apps/web/src/pages/pty-test.tsx (refactored to factory)
tech-stack:
  added: []
  patterns:
    - Plan A cross-package envelope split (shared schema + serve.ts only, IPC/terminal untouched)
    - createXterm factory pattern (verbatim Phase 9 config extracted for reuse)
    - Semantic action panel via 5 pre-baked ANSI constants (no full key mapping table)
key-files:
  created:
    - apps/web/src/lib/ansi-keys.ts
    - apps/web/src/lib/ansi-keys.test.ts
    - apps/web/src/lib/create-xterm.ts
    - apps/web/src/components/chat/chat-pty-view.tsx
    - apps/proxy/src/__tests__/unit/remote-input-raw.test.ts
  modified:
    - apps/web/src/pages/pty-test.tsx
    - packages/shared/src/schemas/relay-control.ts
    - apps/proxy/src/serve.ts
decisions:
  - Plan A 严格执行：ipc-protocol.ts 与 terminal.ts 未改动，跨包 envelope 层仅新增 remote_input_raw
  - ChatPtyView 使用内联 StatusLine 与 ToolApproval 占位，避开 Plan 10-04b 才创建的正式组件的构造顺序依赖
  - ansi-keys 仅暴露 5 个预烤常量 + sender 函数，不实现完整 ANSI 映射表（CONTEXT D-21 缩减作用域）
metrics:
  duration: ~15 minutes
  completed_date: 2026-04-18
  task_count: 4
  file_count: 8
---

# Phase 10 Plan 05: Chat PTY 模式 Summary

Chat PTY 模式的底层原语交付：createXterm 工厂、5 常量 ansi-keys 库、remote_input_raw 信封（跨 shared + proxy 端到端）、ChatPtyView 自包含组件，以及 pty-test.tsx 工厂化重构。Plan A 边界严格守住——ipc-protocol.ts 与 terminal.ts 未改动。

## Plan A 架构概览

本 plan 的跨包改动严格限定在 3 个文件：

| 文件 | 改动性质 | 说明 |
|------|----------|------|
| `packages/shared/src/schemas/relay-control.ts` | 新增 discriminated union 分支 | `remote_input_raw` 信封：`{ type, sessionId, data: string }` |
| `apps/proxy/src/serve.ts` | 新增 `else if` 分支 | 收到 `remote_input_raw` 后以 `pty_input` IPC 类型转发，不追加 `\r` |
| `apps/web/src/lib/ansi-keys.ts` | 新文件 | 客户端通过 `wsManagerRef.send` 发送 `remote_input_raw` 信封 |

**未改动的文件**（CONTEXT Addendum D-21 方案 A 约束）：
- `apps/proxy/src/ipc-protocol.ts`（0 行 diff）
- `apps/proxy/src/terminal.ts`（0 行 diff）
- `apps/web/src/components/chat/semantic-action-panel.tsx`（未创建，归 Plan 10-04b）
- `apps/web/src/pages/chat.tsx`（0 行 diff，归 Plan 10-04b）

Plan A 可行性的根基：`terminal.ts` L133-L135 已是 raw write，`\r` 追加仅在 `serve.ts` 的 `user_input` PTY 分支里发生；新增 `remote_input_raw` 分支直接复用 `pty_input` IPC 类型，把 data 透传即可。

## 5 ANSI 常量表

`apps/web/src/lib/ansi-keys.ts` 暴露的常量（与 CONTEXT Addendum D-21 5 语义动作一一对应）：

| 常量 | 字节 | 长度 | 语义动作 | 触发场景 |
|------|------|------|----------|----------|
| `ANSI_INTERRUPT` | `\x03` | 1 | `interrupt` | 打断 Claude 输出 / 取消当前操作 |
| `ANSI_TAB` | `\t` | 1 | `toggle_permission` | 切换审批模式 |
| `ANSI_UP` | `\x1b[A` | 3 | `history_prev` | 历史上一条命令 |
| `ANSI_DOWN` | `\x1b[B` | 3 | `history_next` | 历史下一条命令 |
| `ANSI_ESC` | `\x1b` | 1 | `cancel` | 取消 / 关闭浮层 |

公开 API：

```ts
ansiForAction(action: SemanticAction): string
sendRemoteInputRaw(sessionId: string, data: string): void
sendSemanticAction(sessionId: string, action: SemanticAction): void
```

`sendRemoteInputRaw` 在 `sessionId` 或 `data` 为空时早返回，避免无效信封污染链路。

## createXtermTerminal 工厂

`apps/web/src/lib/create-xterm.ts` 导出：

```ts
async function createXtermTerminal(container: HTMLDivElement): Promise<{
  terminal: Terminal;
  serializeAddon: SerializeAddon;
  dispose: () => void;
}>
```

Phase 9 锁定的配置全量 verbatim 搬运：`scrollback: 5000`、`fontFamily` 含 `Sarasa Fixed SC` 链、`fontSize: 14`、`cursorBlink: false`、`disableStdin: true`、`allowProposedApi: true`，WebglAddon 在 `terminal.open()` 后加载（CJK / box-drawing 对齐依赖）。

使用方：
- `apps/web/src/pages/pty-test.tsx`（refactored from inline init）
- `apps/web/src/components/chat/chat-pty-view.tsx`（新文件）

## ChatPtyView 组成契约

`ChatPtyView` 自包含（不组合 InputBar / SemanticActionPanel / QuotePreviewBar）：

```
<div flex-col h-full relative data-slot="chat-pty-view">
  <div data-slot="pty-terminal">               # xterm container（fills remaining height）
  {!ready && <div data-slot="pty-connecting">  # "PTY 正在连接..." overlay
  {pending && <div data-slot="pty-tool-approval-floating" role="dialog">  # 浮层 approval 占位
  <div data-slot="pty-status-line">            # 底部内联 status 条
</div>
```

**消费栈：**
- 挂载时调用 `createXtermTerminal(container)` 拿到 terminal/serializeAddon/dispose
- 订阅 `wsManagerRef.subscribeBinary(sessionId, …)`，snapshot 到达前的 binary 帧入 buffer
- 监听 `relayClientRef.onMessage` 等 `session_snapshot`，触发 `terminal.reset/resize/write` 后 flush buffer
- 读 `useChatStore(s => s.pendingApprovals)`，`status === "pending"` 时渲染浮层占位

**InputBar / SemanticActionPanel 合成由 Plan 10-04b 承担：** chat.tsx 将把 `<ChatPtyView>` 与 `<InputBar>`、`<SemanticActionPanel>` 作为 sibling 布局，导入 `sendSemanticAction` 驱动 PTY 通路。

## 单元测试结果

### apps/web/src/lib/ansi-keys.test.ts（16 assertions）

```
ANSI constants (5 tests): ANSI_INTERRUPT / ANSI_TAB / ANSI_UP / ANSI_DOWN / ANSI_ESC 字节 + 长度
ansiForAction (5 tests): 5 个动作到对应字节的映射
sendRemoteInputRaw (3 tests): 信封形状 + empty sessionId 早返回 + empty data 早返回
sendSemanticAction (3 tests): interrupt/history_prev/toggle_permission/cancel 字节传导
```

全部 16 个 test 通过。

### apps/proxy/src/__tests__/unit/remote-input-raw.test.ts（7 tests）

```
envelope (5 tests): well-formed / empty sessionId / missing data / multi-byte / empty data 语义
forwarding semantics (2 tests): 1-byte (\x03) 与 3-byte (\x1b[A) 均不追加 \r
```

全部 7 个 test 通过。

## Typecheck 结果

```
pnpm --filter web typecheck     → exit 0
pnpm --filter shared typecheck  → exit 0
pnpm --filter proxy typecheck   → exit 0
```

## Proxy 分支语义校验

`apps/proxy/src/serve.ts` 新增的 `remote_input_raw` 分支内无 `\r` 字符（结构化 awk + grep 检查）：

```bash
awk '/remote_input_raw/,/^[[:space:]]*}[[:space:]]*else if/' apps/proxy/src/serve.ts | grep -c '\\r'
→ 0
```

新分支复用 `serializeIpc({ type: "pty_input", sessionId, data: parsed.data })`，bytes 透传，
`logger.info(..., "Raw PTY input forwarded")` 记录 session + bytes 计数。

## 检查点验证（自动模式）

- `auto_advance=true`，Task 4 checkpoint:human-verify 自动批准
- 手工 DevTools 端到端验证（需要 relay + proxy online）延后到 Phase 10 完整验收：
  - `wsManager.send(JSON.stringify({ type: "remote_input_raw", sessionId: "<id>", data: "\u001b[A" }))` → PTY 响应 ↑
  - proxy 日志应显示 `"Raw PTY input forwarded"` + `bytes: 3`（不是 4）

## Deviations from Plan

### [Rule 3 - Blocking] ChatPtyView 暂用内联 StatusLine / ToolApproval 占位

- **Found during:** Task 3
- **Issue:** 计划的 action 样例写 `import { StatusLine } from "./status-line"` 与 `import { ToolApprovalCard } from "./tool-approval-card"`，这两个组件在 Plan 10-04 才创建
- **Fix:** ChatPtyView 改为内联 minimal 实现（status-line 是一条 h-7 底条，tool-approval 浮层是 approval 简卡 + 提示语），保证 `pnpm --filter web typecheck` 退出 0 且 Plan 10-05 完全自包含
- **Files modified:** apps/web/src/components/chat/chat-pty-view.tsx
- **Commit:** e506242
- **Cleanup path:** Plan 10-04 交付 `StatusLine` 与 `ToolApprovalCard` 后，Plan 10-04b 在 chat.tsx 组合时可选择把 ChatPtyView 内部占位替换为正式组件；接口契约（data-slot）已稳定，替换成本小。

### [Rule 3 - Blocking] ansi-keys 改用 wsManagerRef 而非 wsManager

- **Found during:** Task 1
- **Issue:** 计划 action 样例 `import { wsManager } from "@/services/websocket"`，但 `websocket.ts` 导出的是 class `WebSocketManager`，没有 singleton 实例；实际 singleton 是 `use-relay-setup.ts` 的 `wsManagerRef: WebSocketManager | null`
- **Fix:** ansi-keys.ts 改为 `import { wsManagerRef } from "@/hooks/use-relay-setup"`，并做 `if (!ws) return` 防空检查；测试里用 getter mock 保持 ref 可变语义
- **Files modified:** apps/web/src/lib/ansi-keys.ts、apps/web/src/lib/ansi-keys.test.ts
- **Commit:** efe16c4

### [Rule 3 - Blocking] ChatPtyView import 路径修正

- **Found during:** Task 3
- **Issue:** 计划 action 样例 `import { relayClientRef } from "@/services/ensure-binding"`，但 `ensure-binding.ts` 不导出 `relayClientRef`，实际在 `@/hooks/use-relay-setup`
- **Fix:** 统一从 `@/hooks/use-relay-setup` 导入 `wsManagerRef, relayClientRef`
- **Files modified:** apps/web/src/components/chat/chat-pty-view.tsx

### [Rule 3 - Blocking] terminal-replay 函数名修正

- **Found during:** Task 3 design review
- **Issue:** 计划 action 样例调用 `applyTerminalSnapshot`，但 `apps/web/src/lib/terminal-replay.ts` 实际导出是 `applySnapshot`
- **Fix:** 避免多余依赖，直接在 ChatPtyView 内 inline `terminal.reset/resize/write` 模式（与 pty-test.tsx 相同路径），不引入 terminal-replay
- **Files modified:** apps/web/src/components/chat/chat-pty-view.tsx

## Open Items for Plan 10-04b

Plan 10-04b 将消费本 plan 的产出：

1. 创建 `apps/web/src/components/chat/semantic-action-panel.tsx`，导入 `sendSemanticAction` 驱动 PTY 通路；JSON 模式内联 worker_abort / permission-mode chip / InputBar 历史栈
2. `apps/web/src/pages/chat.tsx` 组合：
   - 读 `?mode=pty|json` 路由参数
   - 渲染 `<ChatPtyView sessionId={id}>` 或 `<ChatJsonView>`
   - 在 PTY 视图下方 sibling 渲染 `<InputBar mode="pty">` 与 `<SemanticActionPanel mode="pty">`
3. 可选：把 ChatPtyView 里的内联 StatusLine / ToolApproval 占位替换为 Plan 10-04 创建的正式 `StatusLine` / `ToolApprovalCard`（或保留内联，由 Plan 10-04b 决策）
4. DevTools 端到端手测 `remote_input_raw` 跨 client → relay → proxy → PTY stdin

## 完成的提交

- `efe16c4` feat(10-05): ansi-keys library + 5 pre-baked semantic actions
- `fb2b782` feat(10-05): remote_input_raw envelope -- shared schema + serve.ts branch + test
- `e506242` feat(10-05): ChatPtyView self-contained + createXterm factory

## Self-Check: PASSED

验证清单：

- FOUND: apps/web/src/lib/ansi-keys.ts
- FOUND: apps/web/src/lib/ansi-keys.test.ts
- FOUND: apps/web/src/lib/create-xterm.ts
- FOUND: apps/web/src/components/chat/chat-pty-view.tsx
- FOUND: apps/proxy/src/__tests__/unit/remote-input-raw.test.ts
- MODIFIED: apps/web/src/pages/pty-test.tsx
- MODIFIED: packages/shared/src/schemas/relay-control.ts
- MODIFIED: apps/proxy/src/serve.ts
- UNCHANGED: apps/proxy/src/ipc-protocol.ts（Plan A 边界）
- UNCHANGED: apps/proxy/src/terminal.ts（Plan A 边界）
- UNCHANGED: apps/web/src/components/chat/semantic-action-panel.tsx（Plan 10-04b 归属）
- UNCHANGED: apps/web/src/pages/chat.tsx（Plan 10-04b 归属）
- COMMIT efe16c4: ansi-keys library + tests
- COMMIT fb2b782: remote_input_raw envelope + serve.ts + tests
- COMMIT e506242: ChatPtyView + createXterm factory + pty-test refactor
- TEST web ansi-keys: 16/16 pass
- TEST proxy remote-input-raw: 7/7 pass
- TYPECHECK web/shared/proxy: all exit 0
