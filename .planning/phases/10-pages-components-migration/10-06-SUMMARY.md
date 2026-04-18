---
phase: 10-pages-components-migration
plan: 06
wave: 6
subsystem: apps/web/chat
type: refactor
tags:
  - chat-store
  - per-session
  - zustand
  - custom-event-retirement
requirements:
  - FRONT-06
dependency-graph:
  requires:
    - 10-04a (chat-dispatcher foundation)
    - 10-04b (InputBar + SemanticActionPanel + CustomEvent bridge seam)
    - 10-05 (ChatPtyView)
  provides:
    - per-session chat state isolation (bySessionId slice map)
    - store-backed InputBar draft + history cursor
  affects:
    - apps/web/src/components/chat/*
    - apps/web/src/services/chat-dispatcher.ts
tech-stack:
  patterns:
    - per-session slice map (Record<sessionId, slice>) with EMPTY_SLICE fallback
key-files:
  created:
    - apps/web/src/stores/chat-store.test.ts
  modified:
    - apps/web/src/stores/chat-store.ts
    - apps/web/src/services/chat-dispatcher.ts
    - apps/web/src/components/chat/chat-json-view.tsx
    - apps/web/src/components/chat/chat-pty-view.tsx
    - apps/web/src/components/chat/input-bar.tsx
    - apps/web/src/components/chat/quote-preview-bar.tsx
    - apps/web/src/components/chat/semantic-action-panel.tsx
    - apps/web/e2e/follow-output.spec.ts
  deleted:
    - apps/web/src/hooks/use-input-history.ts
decisions:
  - CustomEvent bridge 完全退场, per-session 游标+草稿搬进 chat-store
  - localStorage 持久化历史栈收敛在 InputBar 内部 ref, 不进 store state (避免持久化污染 dev store 快照)
metrics:
  duration: ~8min
  completed: 2026-04-18
---

# Phase 10 Plan 06: chat-store 按 session 切片重构 Summary

Flat chat-store 改为 `bySessionId: Record<string, ChatSessionSlice>`; 所有 action 首参数变为 sessionId; 6 个 chat/* consumer 切到 sessionId-scoped selector + EMPTY_SLICE fallback; InputBar 与 SemanticActionPanel 之间的 `cc:input-history-*` / `cc:input-cancel` CustomEvent 桥接全部退场, 跨组件共享的 draft + history cursor 从 window.dispatchEvent 改为 store action。

## Shape Diff

| Before (flat)                                    | After (per-session)                                              |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `messages: ChatMessage[]`                        | `bySessionId[sid].messages`                                      |
| `isWorking: boolean`                             | `bySessionId[sid].isWorking`                                     |
| `workingToolName: string`                        | `bySessionId[sid].workingToolName`                               |
| `pendingApprovals: ToolApprovalRequest[]`        | `bySessionId[sid].pendingApprovals`                              |
| `quotedMessage: QuotedMessage \| null`           | `bySessionId[sid].quotedMessage`                                 |
| —                                                | `bySessionId[sid].inputDraft` (新增, 取代 InputBar 本地 useState) |
| —                                                | `bySessionId[sid].inputHistoryCursor` (新增, 取代 CustomEvent)    |
| `appendAssistantText(text)`                      | `appendAssistantText(sessionId, text)`                           |
| `addUserMessage(msg)`                            | `addUserMessage(sessionId, msg)`                                 |
| `markTurnComplete()`                             | `markTurnComplete(sessionId)`                                    |
| `addToolCall(messageId, toolCall)`               | `addToolCall(sessionId, messageId, toolCall)`                    |
| `updateToolResult(messageId, idx, output)`       | `updateToolResult(sessionId, messageId, idx, output)`            |
| `toggleToolCollapse(messageId, idx)`             | `toggleToolCollapse(sessionId, messageId, idx)`                  |
| `addApprovalRequest(req)`                        | `addApprovalRequest(sessionId, req)`                             |
| `updateApprovalStatus(id, status)`               | `updateApprovalStatus(sessionId, id, status)`                    |
| `setWorking(isWorking)`                          | `setWorking(sessionId, isWorking)`                               |
| `setWorkingTool(name)`                           | `setWorkingTool(sessionId, name)`                                |
| `setQuote(q)` / `clearQuote()`                   | `setQuotedMessage(sessionId, q \| null)` (合并二者为 nullable 参数) |
| `loadHistory(messages)`                          | `loadHistory(sessionId, messages)`                               |
| `clearMessages()`                                | `clearSession(sessionId)` / `clearAllSessions()`                 |
| —                                                | `setInputDraft(sessionId, draft)` (新增)                          |
| —                                                | `moveInputHistoryCursor(sessionId, delta)` (新增)                 |
| —                                                | `resetInputHistoryCursor(sessionId)` (新增)                       |

`bySessionId` 用 `Record<string, ChatSessionSlice>` 而非 `Map` (PATTERNS.md 反模式警告: zustand shallow 比较不认 Map 引用变化, 导致 selector 漏订阅)。

## Consumer Migration

| Component                   | Old Selector                                         | New Selector                                                                      |
| --------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `chat-json-view.tsx`        | `s.messages`                                         | `s.bySessionId[sessionId]?.messages ?? EMPTY_SLICE.messages`                      |
| `chat-json-view.tsx`        | `s.pendingApprovals`                                 | `s.bySessionId[sessionId]?.pendingApprovals ?? EMPTY_SLICE.pendingApprovals`      |
| `chat-json-view.tsx`        | `s.isWorking`                                        | `s.bySessionId[sessionId]?.isWorking ?? EMPTY_SLICE.isWorking`                    |
| `chat-pty-view.tsx`         | `s.pendingApprovals`                                 | `s.bySessionId[sessionId]?.pendingApprovals ?? EMPTY_SLICE.pendingApprovals`      |
| `input-bar.tsx`             | `s.isWorking` / `s.pendingApprovals` + 本地 useState | `s.bySessionId[sessionId] ?? EMPTY_SLICE` (whole slice, 读 draft/cursor/working)   |
| `quote-preview-bar.tsx`     | `s.quotedMessage` + `s.clearQuote`                   | `s.bySessionId[sessionId]?.quotedMessage ?? null` + `setQuotedMessage(sid, null)` |
| `semantic-action-panel.tsx` | `clearQuote()` + `window.dispatchEvent(...)`         | 直接调 `moveInputHistoryCursor / setInputDraft / setQuotedMessage / resetInputHistoryCursor` |
| `tool-approval-card.tsx`    | 无 chat-store 读 (prop drill)                         | 无变化                                                                            |
| `message-bubble.tsx`        | 无 chat-store 读 (prop drill)                         | 无变化                                                                            |

## CustomEvent Retirement Log

Plan 10-04b 临时 seam 全部移除:

| 原 dispatch / listen                       | 替换                                                      |
| ------------------------------------------ | --------------------------------------------------------- |
| `cc:input-history-prev` dispatch (SemanticActionPanel JSON 分支) | `moveInputHistoryCursor(sessionId, +1)` 直调 store action |
| `cc:input-history-next` dispatch (SemanticActionPanel JSON 分支) | `moveInputHistoryCursor(sessionId, -1)` 直调 store action |
| `cc:input-cancel` dispatch (SemanticActionPanel JSON 分支)       | `setQuotedMessage(sid,null)` + `setInputDraft(sid,"")` + `resetInputHistoryCursor(sid)` 直调 |
| `cc:input-history-prev` listener (InputBar)      | cursor useEffect 监听 `slice.inputHistoryCursor` 变化同步 draft |
| `cc:input-history-next` listener (InputBar)      | 同上                                                      |
| `cc:input-cancel` listener (InputBar)            | 同上 (cursor=-1 + draft 被 setInputDraft 直接覆盖)          |
| `useInputHistory` hook                          | 收敛到 InputBar 内部 ref + localStorage 辅助函数, 并不再对外 export |

Grep 验证:

```
$ grep -rn "cc:input-history-prev\|cc:input-history-next\|cc:input-cancel" apps/web/src
(0 matches)
```

`use-input-history.ts` 文件已删除 (orphan hook, 无其他 consumer)。

## 测试 & 静态检查

### Unit (vitest)

- `chat-store.test.ts`: 12 个 per-session 用例, 全部 PASS
  - initial 空 object
  - 新 session 自动建 slice
  - 两 session 消息独立
  - 流式追加合并到同 session 最后 partial 消息
  - `markTurnComplete` 仅影响目标 session
  - 审批增/改 scoped by session
  - `clearSession` 只清指定 slice
  - `EMPTY_SLICE` 字段含 `inputDraft=""` / `inputHistoryCursor=-1`
  - `setInputDraft` + `moveInputHistoryCursor` clamp 在 [-1, historyLen-1]
  - `setQuotedMessage` nullable
  - `addToolCall` + `updateToolResult` 定位到 messageId
  - `clearAllSessions` 擦光 bySessionId

- 全部 unit: `pnpm --filter web test --run` → 5 files / 47 tests PASS

### 静态

- `pnpm --filter web typecheck` → 0 errors
- `pnpm --filter web exec playwright test --list` → 11 files / 84 tests 仍正确枚举
  - `follow-output.spec.ts` 中 3 处 `page.evaluate(store.*)` 调用改成 sessionId-first 签名, 传入路由里实际使用的 `fo-sess`
  - `input-bar.spec.ts` / `file-picker.spec.ts` / `chat-chrome.spec.ts` / `tool-approval.spec.ts` 无需改动 (它们不直接触达 store API)

### Grep 断言

| 断言                                                                                       | 结果           |
| ------------------------------------------------------------------------------------------ | -------------- |
| `grep "cc:input-history-prev\|cc:input-history-next\|cc:input-cancel" apps/web/src`          | 0 matches      |
| flat reads `s.messages\|s.isWorking\|s.pendingApprovals\|s.quotedMessage` in chat/pages      | 0 matches      |
| `bySessionId` 在 chat consumer (非 action ref)                                               | 7 selector 引用 |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - 关键能力补充] `loadHistory` 迁入 per-session 签名, 未走 action 循环**

- **Found during:** Task 1 (dispatcher Edit B)
- **Issue:** 计划文档 Edit B 建议用 `addUserMessage` 循环塞入 history, 会破坏 role 语义 (把 assistant 当 user 写) 且无法区分历史条目 id
- **Fix:** 给 chat-store 加原生 `loadHistory(sessionId, messages)` action, 维持 role 正确性, id 形如 `history-{sid}-{i}`, dispatcher 单行调用
- **Files modified:** `apps/web/src/stores/chat-store.ts`, `apps/web/src/services/chat-dispatcher.ts`
- **Commit:** cbfcf5b

**2. [Rule 1 - 行为修正] ArrowDown 在 cursor=0 时清空 draft + reset cursor**

- **Found during:** Task 2 (InputBar)
- **Issue:** 旧 `useInputHistory.recallNext` 在 `index<=0` 时返回空串并 reset; 移入 store 后若仅调 `moveCursor(-1)`, cursor 会停在 0 导致 draft 一直锁在最新历史条目, 无法回到"空白状态"
- **Fix:** InputBar ArrowDown 分支: cursor>0 时 moveCursor(-1); cursor==0 时 resetCursor + setInputDraft("") 双写, 与旧行为对齐
- **Files modified:** `apps/web/src/components/chat/input-bar.tsx`
- **Commit:** 21c3e3d

**3. [Rule 1 - 死代码清理] 删除 `useInputHistory` hook**

- **Found during:** Task 2 grep 后发现 0 consumer
- **Issue:** InputBar 把 history 搬入 ref 后, hook 已 orphan; 保留会是死代码
- **Fix:** `rmtrash apps/web/src/hooks/use-input-history.ts`
- **Commit:** 21c3e3d

## Phase 10 Closeout Checklist

| 需求       | 状态 | 交付 Plan                                 | 备注                                                                                                   |
| ---------- | ---- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| FRONT-03   | done | 10-02 / 10-03                             | AppShell + 路由 + SessionList                                                                           |
| FRONT-04   | done | 10-04a / 10-04b / 10-06                   | Chat JSON view + dispatcher + per-session store                                                          |
| FRONT-05   | done | 10-05                                     | Chat PTY view (xterm)                                                                                   |
| FRONT-06   | done | 10-06 (本 plan)                           | 按 session 切片 + CustomEvent bridge 退场 + per-session InputBar draft/cursor                         |
| FRONT-08   | done | 10-01b                                    | 可搜索 / 快捷键 (已在 10-04b 替换为更简洁的 chat-header overflow menu; D-51 删除 sidebar-toggle / cmd-palette) |
| SplitPane  | defer | Backlog (D-52)                            | 降级, 当前多会话通过 sidebar 切换; 若后续有硬需求再起新 phase                                            |

## Self-Check: PASSED

- [x] `apps/web/src/stores/chat-store.ts` — FOUND
- [x] `apps/web/src/stores/chat-store.test.ts` — FOUND
- [x] `apps/web/src/services/chat-dispatcher.ts` — FOUND
- [x] `apps/web/src/components/chat/chat-json-view.tsx` — FOUND (migrated)
- [x] `apps/web/src/components/chat/chat-pty-view.tsx` — FOUND (migrated)
- [x] `apps/web/src/components/chat/input-bar.tsx` — FOUND (CustomEvent retired)
- [x] `apps/web/src/components/chat/quote-preview-bar.tsx` — FOUND (migrated)
- [x] `apps/web/src/components/chat/semantic-action-panel.tsx` — FOUND (CustomEvent retired)
- [x] `apps/web/src/hooks/use-input-history.ts` — DELETED (intentional)
- [x] `apps/web/e2e/follow-output.spec.ts` — FOUND (API updated)
- [x] commit aeafb32 — FOUND (RED test)
- [x] commit cbfcf5b — FOUND (Task 1 GREEN)
- [x] commit 21c3e3d — FOUND (Task 2 consumers + e2e)

## TDD Gate Compliance

- [x] RED: `test(10-06): add chat-store per-session test cases (RED)` @ aeafb32 (12 failing tests)
- [x] GREEN: `refactor(10-06): chat-store per-session slice map + dispatcher sessionId wiring` @ cbfcf5b (12/12 pass)
- REFACTOR: 未单独提交 (Task 2 属于 consumer 迁移, 非同一 RED 的 refactor phase)
