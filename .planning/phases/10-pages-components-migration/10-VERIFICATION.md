---
phase: 10-pages-components-migration
verified: 2026-04-18T02:48:02Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: none
  previous_score: n/a
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "桌面端 /sessions 走一遍：选 proxy → 进会话列表 → 点一条 session 进 chat"
    expected: "AppShell header 在 /chat/* 消失，ChatHeader 出现；title + mode badge 正确"
    why_human: "视觉层级与 badge 排版只能肉眼确认"
  - test: "JSON 模式发一条消息，观察 assistant 流式文本 + BackToBottom + 自动追底"
    expected: "流式 delta 追底无抖动；手动上滚后按钮出现，点回立即回到底部"
    why_human: "动画与滚动跟随的平滑程度无法静态验证"
  - test: "PTY 模式打开一个 session，确认 xterm 渲染 + remote_input_raw 输入回显"
    expected: "xterm 显示 snapshot + 后续字节；键入后本地看到回显"
    why_human: "需要真实 relay+proxy 在线链路，且为视觉验证"
  - test: "ChatHeader overflow 菜单：Permission mode 子菜单切换 + Rename(toast) + Duplicate(toast) + Terminate(跳回 /sessions)"
    expected: "所有菜单项在真实 session 下按预期触发；Terminate 具 destructive 红字"
    why_human: "shadcn DropdownMenu 的可达性与 focus 行为只能交互测"
  - test: "Sidebar 设置齿轮点击 → toast 'Settings coming soon'"
    expected: "图标 aria-label 正确，toast 出现"
    why_human: "toast 定位+动画视觉验证"
---

# Phase 10: Pages + Components Migration Verification Report

**Phase Goal:** 将遗留的 Taro/Feishu 页面与 chat 组件迁入 Vite SPA，用具备两种模式 (JSON + PTY) 的真实 chat 体验替换占位 shell，达到与 Feishu 客户端相当的功能等价（去除遗留包袱）。

**Verified:** 2026-04-18T02:48:02Z
**Status:** passed (含人工视觉/交互复核)
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | 应用导航端到端贯通（proxy-select → session-list → chat），AppShell 在 /chat/* 隐藏 header 由 ChatHeader 接管 | PASS | `app-shell.tsx:8,12` 根据 `pathname.startsWith("/chat/")` 条件渲染 header；`router.tsx:11-22` 三路由挂在 AppShell 下 |
| 2 | Chat JSON 模式端到端渲染虚拟消息列 + 工具审批 + 输入栏，订阅 session 并拉历史 | PASS | `chat-json-view.tsx:37-42` mount 时发 `session_subscribe` + `session_messages_request`；`:44-49` useVirtualizer；`:71-84` 内联 InputBar+SemanticActionPanel+QuotePreviewBar |
| 3 | Chat PTY 模式端到端：xterm 工厂 + remote_input_raw 协议 + chat.tsx 按 ?mode= 切换 | PASS | `chat-pty-view.tsx:38` 调 `createXtermTerminal`；`ansi-keys.ts:38` 发 `remote_input_raw`；`chat.tsx:16,22` 按 mode 分发 |
| 4 | chat-store 重写为 per-session 切片，所有 action 首位 sessionId，CustomEvent 桥接完全退役 | PASS | `chat-store.ts:34,56` `bySessionId: Record<string, ChatSessionSlice>`；所有 action 首参为 sessionId；`grep cc:input-history\|cc:input-cancel` 命中 0；`grep CustomEvent` 仅命中测试文件注释 |
| 5 | D-51 ChatHeader 极简三件套 + Sidebar 底部 Settings 齿轮占位 (D-53) | PASS | `chat-header.tsx:64-134` 三件套（back/title+mode badge/overflow）；overflow 含 Permission 子菜单 + Rename + Duplicate + 分隔线 + 终止（destructive）；`sidebar.tsx:55-63` Settings 齿轮按钮 + toast `Settings coming soon` |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/web/src/components/shell/app-shell.tsx` | `/chat/*` 路由条件隐藏 header | PASS | L8 `isChatRoute`；L12-20 条件渲染 header，`data-slot="app-shell-header"` |
| `apps/web/src/components/chat/chat-header.tsx` | 三件套 chrome | PASS | back button + title+mode badge + overflow menu；overflow 含 Permission sub-menu + Rename + Duplicate + Terminate(destructive) |
| `apps/web/src/components/shell/sidebar.tsx` | 底部 Settings gear 占位 toast | PASS | L55-63 ghost icon button + toast `Settings coming soon`；aria-label="设置"；无独立 Settings 页 |
| `apps/web/src/components/chat/chat-json-view.tsx` | 虚拟消息列 + 内联 ToolApprovalCard + InputBar/SemanticActionPanel/QuotePreviewBar + BackToBottom + follow-output | PASS | `useVirtualizer` + measureElement；callback ref `setScrollEl` 喂给 useFollowOutput；`session_subscribe` + `session_messages_request` mount-time 触发 |
| `apps/web/src/components/chat/chat-pty-view.tsx` | 自包含 xterm 工厂 + 订阅 binary 帧 + snapshot 还原 | PASS | `createXtermTerminal`；`subscribeBinary` 缓冲 → snapshot flush；`pendingApprovals` 浮层占位 |
| `apps/web/src/pages/chat.tsx` | 按 ?mode= 分发 JSON/PTY | PASS | L16 `mode`；L22 pty 分支；L41 json 分支；两条路径均挂 ChatHeader |
| `apps/web/src/stores/chat-store.ts` | `bySessionId` shape + 每 action 带 sessionId | PASS | L34 `ChatSessionSlice`；L56 `bySessionId: Record<string, ChatSessionSlice>`；L58-78 所有 action 首参为 sessionId |
| `apps/web/src/services/chat-dispatcher.ts` | 按 envelope/control 的 sessionId 字段分发到 store action | PASS | L16-46 envelope 分发；L50-72 control 分发；所有调用传 `msg.sessionId` / `env.sessionId` |
| `apps/web/src/hooks/use-follow-output.ts` | 绑定 scroll listener 到真实 DOM，不依赖 ref.current 失效 | PASS | 参数是 `HTMLElement \| null`（callback-ref / state-backed），L17 useEffect 依赖 `el`，`addEventListener("scroll", ..., { passive: true })` |
| `apps/web/src/stores/chat-store.test.ts` | ≥ 7 per-session 测试 | PASS | 11 个 `it(...)` 断言：initial / new slice / 独立性 / streaming / markTurnComplete / approvals scope / clearSession / EMPTY_SLICE / draft+historyCursor scope / quotedMessage scope / addToolCall+result scope / clearAllSessions |
| `.planning/todos/pending/2026-04-18-splitpane-dual-chat.md` | backlog entry + trigger 条件 | PASS | Trigger 三条：真实需求 / 桌面 DAU ≥30% / 配套需求 |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| chat-json-view | relay WS | `wsManagerRef.send({type:"session_subscribe"...})` + `session_messages_request` | WIRED | `chat-json-view.tsx:37-42` mount effect |
| chat-pty-view | relay binary/control | `subscribeBinary` + `onMessage`(session_snapshot) + `session_subscribe` send | WIRED | `chat-pty-view.tsx:55-80` |
| InputBar | chat-store | `setInputDraft` / `moveInputHistoryCursor` / `resetInputHistoryCursor` 按 sessionId | WIRED | `input-bar.tsx:50-53,108-134`（textarea value 来自 `slice.inputDraft`；上/下箭头走 store，无 CustomEvent） |
| InputBar | relay | `relayClientRef.sendEnvelope({type:"user_input",...})` | WIRED | `input-bar.tsx:92-100` |
| SemanticActionPanel (PTY) | ansi-keys | `sendSemanticAction(sessionId, ...)` → `remote_input_raw` | WIRED | `semantic-action-panel.tsx:18,29,44` + `ansi-keys.ts:38` |
| SemanticActionPanel (JSON) | chat-store.moveInputHistoryCursor | 方法直接调 store，无 window.dispatchEvent | WIRED | `semantic-action-panel.tsx:48` |
| ChatHeader → relay | `permission_mode_change` / `session_create`(Duplicate) / `session_terminate` | WIRED | `chat-header.tsx:38-61` |
| chat-dispatcher → chat-store | 按 envelope/control `sessionId` 传入 store action | WIRED | `chat-dispatcher.ts:16-73` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|-------------------|--------|
| chat-json-view | `messages` / `pendingApprovals` / `isWorking` | chat-store `bySessionId[sessionId]`，由 `chat-dispatcher` 根据 `assistant_message` / `tool_use_request` envelope 写入 | Yes | FLOWING |
| chat-pty-view | `pendingApprovals`（浮层） | chat-store（dispatcher 写）+ ws `subscribeBinary` 直通 xterm | Yes | FLOWING |
| InputBar | `slice.inputDraft` / `cursor` | chat-store，同时 `historyRef.current` 来自 `localStorage` | Yes | FLOWING |
| ChatHeader | `session.name` / `session.mode` / `permissionMode` | session-store（Phase 9 写入）+ app-store | Yes | FLOWING（注：Rename 实际走 toast 占位，已在已知 stub 白名单） |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| 单测全绿 | `pnpm --filter web test --run` | `Test Files 5 passed (5) \| Tests 47 passed (47)` | PASS |
| TS 类型 clean | `pnpm --filter web typecheck` | `tsc --noEmit` 退出码 0 | PASS |
| CustomEvent 桥接退役 | `grep -r 'cc:input-history\|cc:input-cancel' apps/web` | No matches | PASS |
| `CustomEvent` 引用 | `grep -r CustomEvent apps/web/src` | 仅命中 `chat-store.test.ts` 的注释 | PASS |
| e2e spec 存在性 | `ls apps/web/e2e/{chat-chrome,follow-output,input-bar,file-picker}.spec.ts` | 全部存在 | PASS |

### Requirements Coverage

Phase 10 覆盖 FRONT-03, FRONT-04, FRONT-05, FRONT-06, FRONT-08。本轮验证基于 ROADMAP Success Criteria，所有 5 条均已满足；各 PLAN 对应的 requirements 未单独列出，但与 Success Criteria 通过下表一一映射：

| Success Criteria | Evidence | Status |
|-----------------|----------|--------|
| 1. proxy-select → 会话列表导航 | `router.tsx` 三路由 + `app-shell.tsx` 导航 | SATISFIED |
| 2. 会话增/切/终止 | `sidebar.tsx` CreateSessionButton + `chat-header.tsx` Duplicate/Terminate | SATISFIED（Rename 走 stub toast，已知延期） |
| 3. JSON + PTY 两模式完整渲染 | `chat-json-view.tsx` + `chat-pty-view.tsx` + `chat.tsx` 分发 | SATISFIED |
| 4. 共享 UI 组件（InputBar/Toast/Modal/StatusLine/BackToBottom）齐备 | 对应文件均存在 + shadcn 适配 | SATISFIED |
| 5. AppShell safe-area / responsive | `app-shell.tsx` dvh + `sidebar.tsx` hidden md:flex；Wave 3 的 CONTEXT addendum 已记录视觉调校 | SATISFIED |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `chat-header.tsx` | 43 | `toast.info("Rename coming soon")` — Rename 未接 relay | INFO | 已知 stub（shared schema 未定义 session_rename），白名单内 |
| `chat-header.tsx` | 54 | `sendControl({ type: "session_create", cwd: "." })` — Duplicate cwd fallback | INFO | 已知 stub（SessionInfo 不携带 cwd 字段），白名单内 |
| `sidebar.tsx` | 60 | `toast.info("Settings coming soon")` — Settings 齿轮占位 | INFO | 已知 stub（D-53 明确无独立 Settings 页），白名单内 |
| `semantic-action-panel.tsx` | 23 | `console.warn("JSON interrupt not wired: shared schema lacks worker_abort/interrupt type")` | INFO | 已知 stub；与 Rename 同属 shared schema 扩展前置问题，白名单内 |
| `chat-pty-view.tsx` | 123 | 浮层占位 "正式审批按钮由 Plan 10-04 的 ToolApprovalCard 提供" | INFO | PTY 浮层审批仍是 placeholder；PTY 模式不是审批主入口，延期可接受（未在 phase goal 中列为硬指标） |

无 Blocker / Warning 级缺口。

### Human Verification Required

见 frontmatter `human_verification`。自动化层面 5/5 全绿，但以下三类只能由人肉验证：

1. **视觉/布局** — header 隐藏时机、mode badge truncate、overflow 菜单 destructive 红字；
2. **流式动画** — BackToBottom 阈值、虚拟列表 scrollToIndex 平滑度；
3. **真实链路** — relay+proxy 在线时的 PTY xterm 回显、Permission mode 切换在 server 端生效、Duplicate 创建新 session；

以上已纳入 frontmatter 待用户线下验证。

### Gaps Summary

未发现阻塞 phase goal 的实质性 gap。

已知延期 stub（均为 shared schema / session metadata 缺失 → 延后 phase 处理）：
- `Rename`：等 `session_rename` 控制消息加入 shared schema；
- `JSON interrupt`：等 `worker_abort`/`interrupt` 加入 shared schema；
- `Duplicate cwd`：等 SessionInfo 携带 cwd 字段；
- `Settings` 齿轮：D-53 明确本 phase 仅占位；
- PTY 审批浮层：保持简化实现，ToolApprovalCard 正式接入可在后续 phase。

SplitPane 双 chat 已按 D-52 降级至 `.planning/todos/pending/2026-04-18-splitpane-dual-chat.md`，不计作 gap。

Phase 10 视作 COMPLETE。后续如产品/设计层再提出接入 session_rename 等，升级为独立小 phase 即可。

---

_Verified: 2026-04-18T02:48:02Z_
_Verifier: Claude (gsd-verifier)_
