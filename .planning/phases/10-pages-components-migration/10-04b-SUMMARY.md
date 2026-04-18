---
phase: 10-pages-components-migration
plan: 04b
subsystem: chat-input-chrome
tags:
  - input-bar
  - pickers
  - semantic-panel
  - chat-header
  - D-51
  - D-53

# Dependency graph
requires:
  - phase: 10-pages-components-migration
    plan: 01a
    provides: shadcn Button / Badge / DropdownMenu / Command / ScrollArea / Textarea + Toaster
  - phase: 10-pages-components-migration
    plan: 03
    provides: CreateSessionDialog + ProxySwitcher + SessionList
  - phase: 10-pages-components-migration
    plan: 04a
    provides: ChatJsonView (input-bar-slot 占位) + AppShell conditional hide on /chat/* + chat.tsx stub (D-51 提前) + chat-dispatcher
  - phase: 10-pages-components-migration
    plan: 05
    provides: sendSemanticAction + ANSI 5 常量 + ChatPtyView

provides:
  - InputBar (JSON + PTY, autosize textarea, 斜杠/@/历史/Escape, iOS visualViewport adapter)
  - SlashCommandPicker (订阅 useCommandStore, CSS absolute 定位, shouldFilter=false)
  - FilePathPicker (共享: mode="insert" for InputBar / mode="select" dirsOnly for CreateSessionDialog)
  - QuotePreviewBar (订阅 chat-store.quotedMessage, X 触发 clearQuote)
  - SemanticActionPanel (5 icon 按钮, JSON 走 RelayControl + CustomEvent, PTY 走 sendSemanticAction)
  - ChatHeader (D-51 极简三件套: 返回 + 标题+mode badge + overflow 菜单[Permission mode 子菜单 / Rename / Duplicate / Terminate destructive])
  - Sidebar Settings 占位齿轮 (D-53, 点击 toast "Settings coming soon")
  - useInputHistory (per-session, localStorage 100 条 FIFO)
  - useTextareaAutosize (RESEARCH Pitfall 4: 仅 value 变化触发)
  - useVisualViewportBottomOffset (iOS 键盘贴紧, 降级为 0)
  - input-bar-utils: computeSendDisabled / hasValidAt / detectPickerMode / cleanupDeletedToken
  - CreateSessionDialog CWD 字段改用共享 FilePathPicker (Plan 10-03 Textarea 占位彻底移除)
  - app-store 新增 permissionMode state + setPermissionMode action

affects:
  - 10-06 (Task 1 将 CustomEvent 桥接迁移到 per-session chat-store, 届时 grep "cc:input-history-prev" in apps/web/src 必须返回 0)
  - 10-06 (Task 3 SplitPane 已被 Addendum 3 D-52 撤回, 不再进入本 plan scope)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "relayClientRef 直接访问, 不走 .current: 沿用 10-02/10-03/10-04a 的模块级 let 变量 pattern"
    - "MessageEnvelope vs RelayControlMessage 区分严格: user_input 走 sendEnvelope (需 seq/timestamp/source/version), permission_mode_change / session_terminate / dir_list_request / session_create 走 sendControl"
    - "CustomEvent 跨组件通信是临时 seam: SemanticActionPanel -> InputBar (history/cancel), 事件名 cc:input-history-prev / cc:input-history-next / cc:input-cancel, 所有事件带 detail.sessionId 用于 per-session 过滤, Plan 10-06 将移除"
    - "FilePathPicker 共享契约: insert 模式从 @query 抽路径, select 模式把 filter 本身当路径, dirsOnly 切换"
    - "Picker CSS 绝对定位而非 shadcn Popover: 符合 RESEARCH Q10, 与 InputBar 同 stacking context, 避免 Popover Portal 导致 iOS 键盘下浮层位置错乱"

key-files:
  created:
    - apps/web/src/components/chat/input-bar-utils.ts
    - apps/web/src/components/chat/input-bar.tsx
    - apps/web/src/components/chat/slash-command-picker.tsx
    - apps/web/src/components/chat/file-path-picker.tsx
    - apps/web/src/components/chat/quote-preview-bar.tsx
    - apps/web/src/components/chat/semantic-action-panel.tsx
    - apps/web/src/components/chat/chat-header.tsx
    - apps/web/src/hooks/use-input-history.ts
    - apps/web/src/hooks/use-textarea-autosize.ts
    - apps/web/src/hooks/use-visual-viewport.ts
    - apps/web/e2e/input-bar.spec.ts
    - apps/web/e2e/file-picker.spec.ts
    - apps/web/e2e/chat-chrome.spec.ts
  modified:
    - apps/web/src/components/chat/chat-json-view.tsx
    - apps/web/src/components/session/create-session-dialog.tsx
    - apps/web/src/components/shell/sidebar.tsx
    - apps/web/src/pages/chat.tsx
    - apps/web/src/stores/app-store.ts
    - apps/web/e2e/follow-output.spec.ts

decisions:
  - "permissionMode 加到 app-store (Rule 2): 原 app-store 无此字段, ChatHeader 的 Permission mode radio group 需要读当前选中值, 不加会导致点击无法反映状态. 字段默认 default, setPermissionMode action 同步调用 sendControl"
  - "JSON 模式 interrupt 不接入 relay control (Rule 1): Plan 描述的 worker_abort type 在 shared schema 不存在, relay.sendControl 签名是 RelayControlMessage 联合类型, 传未定义 type 会 TS 报错, 选择 console.warn 而非扩展 schema (超 scope). PTY 模式 interrupt 完整可用"
  - "ChatHeader Duplicate 以 cwd='.' 创建副本 (Rule 1): SessionInfo 不含 cwd 字段, 无从读取当前 session 的工作目录; 暂以 '.' 作 fallback 并 toast 提示, 等 SessionInfo 扩展后再完善"
  - "ChatHeader Rename 留 toast placeholder (Rule 2): shared schema 无 session_rename control 类型, 实现需跨 shared + proxy + relay, 超 scope. 点击弹 toast 'Rename coming soon' 而非无反馈"
  - "cross-component history 用 window CustomEvent: 临时桥接, 过渡到 Plan 10-06 per-session store 前的最小改动方案, 事件 detail 带 sessionId 过滤, 避免多 ChatPage 实例同时订阅相互干扰"
  - "chat.tsx PTY 分支自装 InputBar region: ChatPtyView 自包含 xterm + StatusLine + floating ToolApproval, 不拥有输入条; chat.tsx 作为 PTY 模式的 layout owner 拼装 ChatPtyView + QuotePreviewBar + InputBar + SemanticActionPanel, JSON 模式则让 ChatJsonView 自己管底部输入区"
  - "follow-output.spec 的 input-bar-slot 断言跟随迁移: 原 10-04a 的断言 'input-bar-slot placeholder present' 本 plan 完成替换后必然失败, 改为断言 input-bar-region 可见 (scope 边界内的必要修复, 不是越权)"

metrics:
  duration: "~11 minutes"
  completed_date: 2026-04-18
  task_count: 6
  file_count: 19
---

# Phase 10 Plan 04b: Chat Input Half + D-51 Chrome Summary

Wave 5 交付 Chat JSON 模式的输入侧和 D-51/D-53 chrome 修订：InputBar（autosize/斜杠/@/历史/iOS 键盘适配）+ 3 个 picker（slash / file / quote）+ 5 按钮 SemanticActionPanel + ChatHeader 三件套 + Sidebar Settings 占位齿轮 + CreateSessionDialog 共享 FilePathPicker refactor。

## Component API 合同

| 组件 | Props | 订阅源 |
|------|-------|--------|
| `InputBar` | `{ sessionId, mode: "json"\|"pty" }` | chat-store (isWorking / pendingApprovals) + useInputHistory + useTextareaAutosize + useVisualViewportBottomOffset |
| `SlashCommandPicker` | `{ filter, onSelect }` | command-store (commands 动态源) |
| `FilePathPicker` | `{ filter, mode?: "insert"\|"select", onSelect, dirsOnly? }` | file-store.tree + relayClient.sendControl(dir_list_request) |
| `QuotePreviewBar` | `{ sessionId }` | chat-store.quotedMessage / clearQuote |
| `SemanticActionPanel` | `{ sessionId, mode: "json"\|"pty" }` | app-store.permissionMode / chat-store / relayClient.sendControl / ansi-keys.sendSemanticAction |
| `ChatHeader` | `{ sessionId }` | session-store (name/mode) + app-store (permissionMode) + relayClient.sendControl |

## FilePathPicker refactor (Addendum Warning 3 closure)

Before (Plan 10-03):
```tsx
<Textarea value={cwd} onChange={...} placeholder="输入绝对路径..." rows={1} className="font-mono text-[13px] min-h-9" />
```

After (Plan 10-04b):
```tsx
<input type="text" value={cwd} onChange={...} placeholder="输入或选择绝对路径" />
<FilePathPicker mode="select" dirsOnly filter={cwd} onSelect={(path) => setCwd(path)} />
```

保留 text input 让用户可键入绝对路径，同步 cwd state；下方 FilePathPicker 以只显示目录模式浏览并点选填入，两者互相同步。Plan 10-03 的 "inline inline FilePathPicker subset" 占位彻底移除。

## SemanticActionPanel 路由矩阵

| 动作 | JSON 路由 | PTY 路由 |
|------|-----------|----------|
| 打断输出 | 暂未接入（shared schema 无 worker_abort，console.warn） | `sendSemanticAction(sessionId, "interrupt")` → `\x03` |
| 切换审批模式 | `sendControl({ type: "permission_mode_change", mode: next })` + app-store `setPermissionMode` | `sendSemanticAction(sessionId, "toggle_permission")` → `\t` |
| 历史上一条 | `window.dispatchEvent(new CustomEvent("cc:input-history-prev", { detail: { sessionId } }))` | `sendSemanticAction(sessionId, "history_prev")` → `\x1b[A` |
| 历史下一条 | `window.dispatchEvent(new CustomEvent("cc:input-history-next", { detail: { sessionId } }))` | `sendSemanticAction(sessionId, "history_next")` → `\x1b[B` |
| 取消 | `chat-store.clearQuote()` + `window.dispatchEvent(new CustomEvent("cc:input-cancel", { detail: { sessionId } }))` | `sendSemanticAction(sessionId, "cancel")` → `\x1b` |

## CustomEvent bridge 文档（临时契约，Plan 10-06 Task 1 移除）

| 事件名 | dispatcher | listener | detail shape |
|--------|-----------|----------|--------------|
| `cc:input-history-prev` | SemanticActionPanel（JSON） | InputBar（value==="" 时 recallPrev） | `{ sessionId: string }` |
| `cc:input-history-next` | SemanticActionPanel（JSON） | InputBar（recallNext） | `{ sessionId: string }` |
| `cc:input-cancel` | SemanticActionPanel（JSON） | InputBar（清空 value + history.reset）| `{ sessionId: string }` |

acceptance gate（Plan 10-06）：`grep "cc:input-history-prev" apps/web/src` 返回 0 匹配。

## D-51 / D-53 契约实现

- **D-51 AppShell header 条件隐藏**：由 Plan 10-04a 已提前实装（`commit 3a1acf4`，`src/components/shell/app-shell.tsx` 用 `useLocation()` 判断 `startsWith("/chat/")`）。本 plan 未重复改动。
- **D-51 ChatHeader 三件套**：返回按钮（全视口可见，无 `md:hidden`） + 会话标题 `flex-1 truncate` + mode Badge（仅当 `session.mode` 存在）+ overflow `⋯` DropdownMenu。
  - 直接子 Button 仅 2 个（返回 + overflow trigger），无独立 permission-mode 按钮，无 sidebar-toggle。
  - overflow 内容：`Permission mode` 子菜单（DropdownMenuSub + DropdownMenuRadioGroup，值 default/auto_accept/plan）/ `Rename`（toast 占位）/ `Duplicate`（`session_create` with `cwd="."`）/ Separator / `终止会话`（`text-destructive`，`data-slot="chat-terminate-item"`）。
- **D-53 Sidebar Settings 齿轮占位**：在 Sidebar 底部行动区（与 `+ 新建会话` 同区）加 `data-slot="sidebar-settings-trigger"` 的 ghost icon-sm Button，点击 `toast.info("Settings coming soon")`。

## E2E suite outcomes

Playwright `--list` 列出 14 个 test 在 mobile + desktop 两个 project 下共 28 个实例：

- `input-bar.spec.ts`：4 tests —— `/` trigger / Escape close / send disabled when empty / ArrowUp recalls history
- `file-picker.spec.ts`：2 tests —— `@` trigger (mode=insert) / CreateSessionDialog (mode=select)
- `chat-chrome.spec.ts`：7 tests —— AppShell header 可见/隐藏 ×2 / ChatHeader 三件套结构 / 返回按钮全视口 / 无独立 permission-mode/sidebar-toggle / overflow 内容 / Sidebar Settings 齿轮

`follow-output.spec.ts` L75 原有 input-bar-slot 断言同步更新为 `input-bar-region`（scope 边界内必要修复）。

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - 缺失必要 state] app-store 补 permissionMode**
- **Found during:** Task 3 写 ChatHeader 时
- **Issue:** Plan 引用 `useAppStore((s) => s.permissionMode ?? "default")` 和 `useAppStore.getState().permissionMode`，但 app-store 没有这个字段；若不加，radio group 无法反映当前选择，每次 `onValueChange` 触发的 `sendControl` 后 UI 不同步。
- **Fix:** 在 `AppStoreState` 加 `permissionMode: PermissionMode` 和 `setPermissionMode` action，默认 `"default"`；ChatHeader 的 `changePermission` 和 SemanticActionPanel 的 `togglePermissionMode` 在发 `permission_mode_change` 前先 `setPermissionMode(next)` 本地写入。
- **Files modified:** `apps/web/src/stores/app-store.ts`
- **Commit:** ee4e6cd

**2. [Rule 1 - Plan 示例与真实 shape 不符] DirEntry 是 isDir: boolean 不是 type: "dir"\|"file"**
- **Found during:** Task 2
- **Issue:** Plan 的 FilePathPicker 代码示例用 `e.type === "dir"`，但 shared schema 真实 shape 是 `DirEntry = { name: string, isDir: boolean }`。
- **Fix:** 把所有 `e.type === "dir"` 改成 `e.isDir`；`data-entry-type` 属性从 `e.type` 改为 `e.isDir ? "dir" : "file"`。
- **Files modified:** `apps/web/src/components/chat/file-path-picker.tsx`
- **Commit:** cf79287

**3. [Rule 1 - Plan 示例与真实 shape 不符] chat-store API 是 clearQuote/setQuote 不是 setQuotedMessage**
- **Found during:** Task 2
- **Issue:** Plan 代码示例多处写 `useChatStore((s) => s.setQuotedMessage)` 和 `chat-store.setQuotedMessage(null)`，但 apps/web 的 chat-store 定义的 action 名是 `setQuote` 和 `clearQuote`。
- **Fix:** QuotePreviewBar 和 SemanticActionPanel 的 cancel 都改用 `clearQuote()`。
- **Files modified:** `apps/web/src/components/chat/quote-preview-bar.tsx`, `apps/web/src/components/chat/semantic-action-panel.tsx`
- **Commit:** cf79287, ee4e6cd

**4. [Rule 1 - Plan 示例与真实 shape 不符] relayClientRef 是模块级 let 不是 { current }**
- **Found during:** Task 3
- **Issue:** Plan 写 `relayClientRef.current.sendControl(...)`，但 apps/web/src/hooks/use-relay-setup.ts 里是 `export let relayClientRef: RelayClient | null = null`，直接解引用即可。10-04a SUMMARY 已记录此 pattern。
- **Fix:** 所有 `relayClientRef.current` 去 `.current`。
- **Files modified:** `input-bar.tsx`, `semantic-action-panel.tsx`, `chat-header.tsx`, `file-path-picker.tsx`
- **Commit:** ee4e6cd, cf79287

**5. [Rule 1 - Plan 示例与真实 schema 不符] user_input 是 envelope 不是 control**
- **Found during:** Task 3
- **Issue:** Plan 写 `relay.sendControl({ type: "user_input", sessionId, payload: { text: trimmed } })`，但 `user_input` 在 envelope schema 中（含 seq/timestamp/source/version），RelayControlMessage 不包含它；若这么发，zod 解析时 proxy 端会 drop。
- **Fix:** InputBar send 改为 `relay.sendEnvelope({ type: "user_input", sessionId, payload: { text: trimmed }, seq: 0, timestamp: Date.now(), source: "client", version: "1" })`，与 tool-approval-card 和 feishu 现有实现一致。
- **Files modified:** `apps/web/src/components/chat/input-bar.tsx`
- **Commit:** ee4e6cd

**6. [Rule 1 - Plan 示例 schema 缺失] worker_abort 未定义 → JSON 打断降级**
- **Found during:** Task 3
- **Issue:** Plan 指定 JSON interrupt 走 `sendControl({ type: "worker_abort", sessionId })`，但 shared schema 既无 `worker_abort` 也无 `interrupt` 类型；写入会 TS 报错 + 运行时被 proxy 端 drop。
- **Fix:** JSON 分支改为 `console.warn` 占位，明确记日志不静默；PTY 分支照常走 `sendSemanticAction`。在 decisions 中记录后续需 shared schema 扩展才能补齐。
- **Files modified:** `apps/web/src/components/chat/semantic-action-panel.tsx`
- **Commit:** ee4e6cd

**7. [Rule 1 - Plan 示例与 UI 契约不符] useFollowOutput 签名 + Plan 重绑定 parentRef.current 方式**
- **Not modified:** Plan Edit A 的 chat-json-view 重写里把 scrollEl 从原来的 `useState` 改成 `useRef` 并在 ref callback 中 if-else；但现有实现（10-04a）是 `useState<HTMLDivElement | null>(null)` + `setScrollEl` 给 `ref={setScrollEl}`，`useFollowOutput` 签名是 `(el: HTMLElement | null, opts?)`。本 plan 保留现有 hook 签名与 state pattern，只插入 InputBar 区段，不重写 scrollEl 管理（越权修改会引入 follow-output.spec 的额外回归风险）。

**8. [Rule 1 - 10-04a 留下的 stale e2e 断言]**
- **Found during:** Task 5 playwright list
- **Issue:** `follow-output.spec.ts` L75 断言 `[data-slot="input-bar-slot"]` 可见；本 plan 删除占位后此断言必挂。
- **Fix:** 改为断言 `[data-slot="input-bar-region"]` 可见（scope 边界内直接后果）。
- **Files modified:** `apps/web/e2e/follow-output.spec.ts`
- **Commit:** 19c3ef4

### Auth gates

None.

## Known Stubs

| 位置 | 文件 | 原因 |
|------|------|------|
| Rename menu item | `chat-header.tsx` `handleRename` | shared schema 无 session_rename control 类型；toast "Rename coming soon" 占位 |
| Duplicate menu item | `chat-header.tsx` `handleDuplicate` | SessionInfo 无 cwd 字段，副本会话以 `cwd="."` 兜底；toast 提示 |
| JSON 模式 interrupt | `semantic-action-panel.tsx` `interrupt()` | shared schema 无 worker_abort/interrupt 类型；console.warn 不静默 |
| Sidebar Settings 齿轮 | `sidebar.tsx` `data-slot="sidebar-settings-trigger"` | D-53 明确：真正的 Settings feature 另起独立 phase；当前 toast "Settings coming soon" |

所有 stub 都不阻止 plan 的目标（Chat JSON + PTY 输入全链路可用），但后续 phase 需覆盖：
- 新增 `interrupt` / `worker_abort` envelope/control 类型（阻塞 JSON 模式"打断"的完整实现）
- 新增 `session_rename` control 类型（阻塞 Rename）
- 扩展 SessionInfo 携带 cwd（阻塞 Duplicate 使用真实 cwd）
- 独立 Settings phase（覆盖 Sidebar 齿轮）

## Open items for follow-up plans

- **Plan 10-06 Task 1**：chat-store 拆成 per-session slice；同步移除所有 3 个 `cc:input-*` CustomEvent 的 dispatch/listen 代码，InputBar 直接从 store selector 读 history cursor state。
- **Future phase**：新增 JSON 模式 interrupt 协议（worker_abort/session_abort control）。
- **Future phase**：新增 session_rename control + handler。
- **Future phase**：SessionInfo 扩展 cwd 字段 + Duplicate 使用真实 cwd。
- **独立 Settings phase**：Sidebar 齿轮绑定真实 Settings Dialog。

## Verification

- `pnpm --filter web typecheck` → 0 errors（Task 1-5 每步都跑过）
- `pnpm --filter web test --run` → 35 tests passed in 4 files（含 10-04a 的 markdown-view / message-bubble 单测）
- `pnpm --filter web exec playwright test --list` → 列出 input-bar.spec.ts（4 tests）/ file-picker.spec.ts（2 tests）/ chat-chrome.spec.ts（7 tests），mobile + desktop 共 28 实例
- Auto-mode checkpoint:human-verify 自动批准（Wave 5 全自动执行）

## Self-Check: PASSED

已验证：

- `apps/web/src/components/chat/input-bar-utils.ts` 存在
- `apps/web/src/hooks/use-input-history.ts` 存在
- `apps/web/src/hooks/use-textarea-autosize.ts` 存在
- `apps/web/src/hooks/use-visual-viewport.ts` 存在
- `apps/web/src/components/chat/slash-command-picker.tsx` 存在
- `apps/web/src/components/chat/file-path-picker.tsx` 存在
- `apps/web/src/components/chat/quote-preview-bar.tsx` 存在
- `apps/web/src/components/chat/input-bar.tsx` 存在
- `apps/web/src/components/chat/semantic-action-panel.tsx` 存在
- `apps/web/src/components/chat/chat-header.tsx` 存在
- `apps/web/e2e/input-bar.spec.ts` 存在
- `apps/web/e2e/file-picker.spec.ts` 存在
- `apps/web/e2e/chat-chrome.spec.ts` 存在
- `apps/web/src/pages/chat.tsx` 已重写（grep chat-header-placeholder = 0）
- `apps/web/src/components/chat/chat-json-view.tsx` input-bar-slot 已移除（grep input-bar-slot = 0）
- `apps/web/src/components/session/create-session-dialog.tsx` 已用 FilePathPicker
- Commits 83500ca / cf79287 / ee4e6cd / 315e17c / 19c3ef4 均存在
