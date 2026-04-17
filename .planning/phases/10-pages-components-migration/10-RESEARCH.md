# Phase 10: Pages + Components Migration — Research

**Researched:** 2026-04-17
**Domain:** React 19 SPA / shadcn-new-york / xterm.js / virtual scrolling / PTY raw-key protocol
**Confidence:** HIGH (stack verified via Context7 + registry; cross-package PTY design validated against existing code)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Meta (D-META-01/02):** Phase 10 是重做机会，不是一比一迁移。所有业务组件必须在 10-UI-SPEC.md 统一设计规范下重新设计，不允许零散落地。shadcn 原子组件一次性安装并做主题覆盖。

**视觉基调 (D-01/02/03/04/05):** 开发者工具 + 终端美学；Accent 从 `#00D4AA` 改为琥珀 `#D4A574`（覆盖 Phase 7 D-01）；radius 收到 `0.375rem`（覆盖 Phase 7 `0.25rem`）；深色锁定，不实现 light toggle（CSS 变量架构预留）；Mono 优先 Sarasa Fixed SC；PTY xterm 保留 Phase 9 锁定的 `cursorAccent #00D4AA`（不改 xterm 主题）。

**信息架构 (D-06 ~ D-11):** 移动端（<768px）三页纵深；桌面/平板（≥768px）master-detail；ProxySelect 桌面变为侧栏 dropdown；`ProxySwitcher` 和 `SessionList` 共用组件 + 响应式 layout prop。

**Chat 结构 (D-12 ~ D-14):** JSON/PTY 二选一冻结；单一 `ChatPage` 内部按 `?mode=` 渲染子视图；InputBar 两模式共用但通路不同。

**多会话 (D-15 ~ D-19):** 侧栏点击即时切换主区不触发 route transition（但路由同步）；侧栏可折叠，`cc_sidebarCollapsed`；Cmd+K 基于 shadcn Command；并排 tab ≥ 1024px 启用，最多两列（可拆 Plan 10-06）。

**Chat 业务 (D-20 ~ D-25):** MessageBubble 自研不套 Card；**D-21 PTY 远程输入升级（跨包改动）**：扩展 `apps/proxy/src/ipc-protocol.ts` 的 `pty_input` schema 或新增 `pty_input_raw`，客户端 InputBar 捕获键盘事件映射为转义序列；ToolApproval 分级展示（紧凑卡 + 详情 + 会话白名单 + `y/n/a` 快捷键）；ToolApproval 容器 JSON 内联 / PTY 浮层；虚拟滚动 `@tanstack/react-virtual` + follow-output；Markdown `react-markdown + remark-gfm + rehype-highlight`。

**InputBar (D-26 ~ D-28):** 1-8 行自撑；Enter 发送 / Shift+Enter 换行；`/` 斜杠命令动态获取（不硬编码）；`↑` 召回；文件选择器本期实现；PTY 模式 Enter 走 pty_input 带 `\n`，其他控制键走 raw bytes 通道。

**Dialog (D-29/30):** 新建 session 三字段（name 可选 / mode / cwd）；permission mode / resume 放 Chat 设置菜单。

**组件清单 (D-31/32):** 砍掉 typewriter / safe-area-header / terminal-viewport / modal；shadcn 全集一次装：Dialog / Sheet / Tooltip / Popover / ScrollArea / Textarea / Badge / Avatar / Separator / Select / DropdownMenu / Sonner / Command。

**响应式 (D-33/34/35):** Tailwind 默认断点；`100dvh` + `env(safe-area-inset-*)` + `visualViewport` 校正 iOS 键盘；不迁移 `use-screen-size`。

**A11y (D-36/37):** 每个 plan 自带 A11y，code-reviewer agent 检查。

**切片 (D-38 ~ D-41):** 10-01 Shell + shadcn + 主题 / 10-02 ProxySelect / 10-03 SessionList / 10-04 Chat JSON / 10-05 Chat PTY / 10-06（可选）并排 tab；每 plan 完成后强制视觉验证 + 用户批准；`/pty-test` 保留不删。

### Claude's Discretion

- CSS 变量命名与具体值（Phase 7 token 基础上的调整）
- `ProxySwitcher` 控件交互细节（dropdown / popover 行为）
- Command Palette 结果排序与模糊匹配算法
- 代码块 copy 按钮、时间戳格式、session 列表项二级菜单项
- Virtual scroll overscan / 缓冲策略
- shadcn 主题细节校准（Plan 10-01 视觉审批中确定）
- 并排 tab 分隔拖拽条细节

### Deferred Ideas (OUT OF SCOPE)

- 浅色主题 toggle（架构预留，Phase 10 不填色）
- 多 proxy 同时连接
- session 分组 / 标签 / 收藏
- session 历史回放 UI 入口（Phase 11 后设计）
- Push 通知 / 快捷操作面板（Phase 14）
- Wake Lock / 语音（Phase 13）
- Service Worker 离线（Phase 12）
- session 共享链接 / 协作

### 已放弃方案

- ToolApproval 统一底部 Sheet（被分级浮层卡覆盖）
- 消息流不做虚拟化
- `chat-bubble-list` 保留重命名
- SaaS 现代风视觉
- 移动端 + 平板 + 桌面单一 max-width 居中布局
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FRONT-03 | App Shell 布局（safe area、导航栏、响应式断点） | Section 2.10 响应式 master-detail；Section 2.5 iOS 键盘 visualViewport；Section 4 File Impact — `components/shell/app-shell.tsx` + `sidebar.tsx` |
| FRONT-04 | Proxy Select 页面迁移 | Section 2.10 `ProxySwitcher` 双形态 pattern；Section 4 `components/proxy/` + 整合现 app-store / relay-client |
| FRONT-05 | Session List 页面迁移 | Section 2.10 `SessionList` 双形态；Section 2.9 shadcn Dialog 用作 CreateSessionDialog；Section 4 `components/session/` + file-store 集成 |
| FRONT-06 | Chat 页面迁移（JSON：气泡 + Markdown + 工具审批） | Section 2.3 `@tanstack/react-virtual` 动态高度 + follow-output；Section 2.7 react-markdown 安全配置；Section 2.11 InputBar 完整能力；Section 2.4 shadcn Command 双用途（slash picker） |
| FRONT-08 | 通用组件重实现（InputBar / Toast / StatusLine / BackToBottom 等） | Section 2.6 Sonner 迁移 + useToast 兼容；Section 2.11 InputBar 自撑高 + token 清理；Section 4 组件清单与 Feishu 参考文件对应 |

注：**FRONT-07（Chat PTY）** 在 Phase 9 已产出 `/pty-test`，本 phase 的 Plan 10-05 负责集成到 Chat 页 + D-21 PTY 远程原始键位升级，不属于 FRONT-07 交付但在 Phase 10 的 10-05 plan 中完成。
</phase_requirements>

---

## 1. Executive Summary

**Planner 最需要记住的 5 个决策点：**

1. **D-21 PTY 原始键位是本 phase 唯一跨包改动**。改动面：`apps/proxy/src/ipc-protocol.ts`（IPC schema）+ `apps/proxy/src/serve.ts`（relay-to-terminal 透传）+ `apps/web/src/components/chat/input-bar.tsx`（键盘捕获）+ 可能需要 `packages/shared/src/schemas/envelope.ts` 或 `relay-control.ts`（client-to-relay 协议）。**推荐方案：新增独立消息类型 `pty_input_raw`（而不是给 `pty_input.data` 重载二进制含义）**，理由：schema 单一职责、客户端无需判断字段、服务端 PTY 写入路径可区分是否需要追加回车。详见 Section 2.2。

2. **斜杠命令列表已有动态来源**。proxy 端 `command-discovery.ts` + 现存 `command_list_push` 控制消息 + `useCommandStore` 已对接，**Phase 10 不需要自己拉列表，只需订阅 `command-store.commands`**。这颠覆了 memory `project_slash_command_preset_infeasible.md` 里 "D-28 硬编码不可行" 的担忧——事实是早已非硬编码。详见 Section 2.4。

3. **xterm.js 配置必须抽 hook 共享**。`/pty-test.tsx` 的 xterm 初始化逻辑（含 Sarasa Fixed SC、WebGL、UnicodeGraphemes、`document.fonts.ready`、xtermTheme）必须 **verbatim 复用** 给 `ChatPtyView`，抽成 `apps/web/src/hooks/use-xterm-terminal.ts` 或 `lib/create-xterm.ts`。Phase 9 D-40 ~ D-44 锁定的决策在 Phase 10 不可动（包括 `cursorAccent #00D4AA`）。详见 Section 2.8。

4. **shadcn 主题覆盖层是 Plan 10-01 的硬核**。不是装完就完事——必须一次性把 `--primary` 改成 `#D4A574`、`--radius` 改成 `0.375rem`、Button label 从 `font-weight: 500` 改成 `400`，然后 `/tokens` 页作为视觉回归基准（Phase 7 已有 `token-showcase.tsx`）。**Planner 需要把"主题 override + 视觉审批"作为 10-01 的独立任务，不能塞进"顺便装个 shadcn"**。详见 Section 2.9。

5. **虚拟滚动 + follow-output 有成熟 pattern，但 streaming 场景是真陷阱**。`useVirtualizer` + `measureElement` 的动态高度方案是官方推荐，但 **流式消息内容持续增长需要 `ResizeObserver` 自动重测**（TanStack 内置），且 **"用户滚走后冻结自动追随" 需要用 scroll event 维护 `isAtBottom` 状态**（不是 `intersection observer` 的常见错误方案）。详见 Section 2.3。

**Primary recommendation:** 按 CONTEXT D-38 的 5 plan 切片执行（10-01 到 10-05）；10-06 并排 tab **强烈建议拆为独立 plan** 而不是塞进 10-04/10-05。

---

## 2. Technical Approach

### 2.1 Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| 页面渲染 / 路由 / 状态订阅 | Browser (React SPA) | — | 纯 SPA，不做 SSR |
| WebSocket / binary 帧分发 | Browser (wsManager) | — | Phase 8 已完成，Phase 10 只消费 |
| PTY 原始字节显示 | Browser (xterm.js) | — | Phase 9 锁定 |
| PTY 原始键位接收 | Browser (InputBar DOM event → ANSI seq) | — | 新增，D-21 |
| PTY stdin 写入 | Proxy `terminal.ts` (`ptyManager.write`) | — | 已实现，仅扩展消息类型 |
| IPC 协议扩展 | Proxy `ipc-protocol.ts` | `packages/shared` (if touched) | D-21 要求 |
| WebSocket JSON 信封透传 | Relay (passthrough) | — | Phase 9 已纯透传，本 phase 不改 relay |
| 虚拟滚动 / follow-output 状态 | Browser (`@tanstack/react-virtual`) | — | 客户端纯 UI |
| Markdown 渲染 | Browser (`react-markdown`) | — | 客户端纯 UI |
| Toast | Browser (Sonner + `useToast` 兼容层) | — | 客户端纯 UI |
| Command Palette / Slash picker | Browser (`cmdk` via shadcn Command) | — | 客户端纯 UI |
| 斜杠命令**数据源** | Proxy (`command-discovery.ts` → `command_list_push`) | Browser `command-store` 订阅 | Phase 8 已对接 |
| 文件树数据源 | Proxy (`dir_list_request` / `file_tree_push`) | Browser `file-store` 订阅 | Phase 8 已对接 |

**关键洞察：** 本 phase 的跨 tier 改动只有 D-21（PTY raw input），其余完全局限在 Browser tier。`CONTEXT.md` "允许跨包改动：仅 D-21" 已明确。

---

### 2.2 D-21 PTY 原始键位通道（最关键跨包改动）

**两层协议的现状与扩展点：**

| 层级 | 文件 | 现有 pty_input 表达 | D-21 扩展方案 |
|------|------|---------------------|---------------|
| client → relay → proxy (WebSocket) | `apps/proxy/src/serve.ts:765-772` — handler 在 WebSocket 路径 | `user_input` envelope（JSON 模式）或 `remote_input` control（PTY 模式，text + "\r" 拼接） | **新增 `remote_input_raw` 控制消息**，payload `{ sessionId, data: string }` 直接透传到 terminal，不追加 `\r` |
| serve → terminal (IPC Unix socket) | `apps/proxy/src/ipc-protocol.ts:92-98` — `pty_input` schema | `{ type: "pty_input", sessionId, data: string }` | **新增 `pty_input_raw` discriminant**，schema 同上但 handler 行为不同（不追加换行） |

**推荐：独立消息类型而不是字段重载。** 理由：
- **Schema 单一职责**：`pty_input` 当前的语义是"文本 + Enter"（serve 加 `\r`）；raw 通道语义是"任意字节，不修饰"；两者混用需要 flag 字段判断，冲突 zod discriminatedUnion 的设计。
- **向后兼容**：现有 Feishu client 只发 `pty_input`，新 web 也会继续用 `pty_input`（Enter 键）+ 新的 `pty_input_raw`（方向键等）。老的 proxy 遇到未知类型走 `safeParse` 失败分支，不会崩溃。
- **服务端写入路径清晰**：`terminal.ts:133-135` 的 handler `ptyManager?.write(msg.data)` 是一条，新增 `pty_input_raw` handler 用同样的 write 但不追加换行，即 `ptyManager?.write(msg.data)`（pty_input 现在也不追加？）

**CRITICAL: 验证 `pty_input` 是否已经不追加换行。**

读 `terminal.ts:133-135`:
```typescript
if (msg.type === "pty_input" && msg.sessionId === sessionId) {
  log.debug({ sessionId, bytes: msg.data.length }, "Remote input received");
  ptyManager?.write(msg.data);
}
```
**[VERIFIED: code read]** terminal.ts 不追加换行，直接 write `msg.data`。

读 `serve.ts:768-773` (relay → terminal 方向):
```typescript
ts.write(serializeIpc({
  type: "pty_input",
  sessionId: parsed.sessionId,
  data: (parsed.payload?.text ?? "") + "\r",
}));
```
**[VERIFIED: code read]** `\r` 追加发生在 **serve.ts 接收 relay envelope 时**，把客户端发来的 `user_input.payload.text` 拼上 `\r` 然后作为 `pty_input` 发给 terminal。

**结论：** 换行追加点在 `serve.ts` 的 `user_input` envelope handler，不在 `terminal.ts`。**所以 D-21 的方案是：**

1. **在 `packages/shared/src/schemas/relay-control.ts`（或 envelope.ts）新增 `remote_input_raw` 消息类型**，payload `{ sessionId, data: string }`。Client 把 raw ANSI 序列放在 `data` 里发给 relay。
2. **在 `serve.ts` 新增该类型的 handler**：直接 `ts.write(serializeIpc({ type: "pty_input_raw", sessionId, data }))`，不追加 `\r`。
3. **在 `ipc-protocol.ts` 新增 `pty_input_raw` discriminant**。
4. **在 `terminal.ts` 新增该类型 handler**：和 `pty_input` 一样 `ptyManager?.write(msg.data)`。
   - 事实上，既然 `pty_input` 已经不加换行，两个 handler 行为完全一致。**planner 可重新评估**：是否真需要区分？区别只在 serve.ts 的上游（JSON user_input 要加 `\r`，raw 不加）。
   - **备选方案 A**：client 端发消息时直接绕过 `user_input`（它的语义是 chat），走新 `remote_input_raw`；serve 端映射到现有 `pty_input`（既然 terminal.ts 不加换行）。则无需改 IPC 协议，只改 shared schema + serve + client。**减少一层改动**。
   - **备选方案 B**：client 端发送 `remote_input_raw` + ANSI 序列；serve 端重用 `pty_input`（不改 IPC）；但 `serve.ts` 内现有的"PTY 模式走 (text + \r)"分支必须识别"这个不是 user_input 而是 raw"——分支是按消息类型走的，不冲突。

**推荐：备选方案 A。** 仅 `packages/shared` + `serve.ts` + `input-bar.tsx` 三处改动，`terminal.ts` 和 `ipc-protocol.ts` 完全不动。Planner 应在 Plan 10-05 采用此方案，跨包改动最小。

**ANSI 键位映射表（client 端 InputBar 在 PTY 模式下的捕获逻辑）：**

| 按键 | Normal 模式序列 (ASCII) | Application Cursor Keys (DECCKM) 序列 |
|------|-------------------------|------------------------------------------|
| ↑ ArrowUp | `\x1b[A` (`ESC [ A`) | `\x1bOA` (`ESC O A`) |
| ↓ ArrowDown | `\x1b[B` | `\x1bOB` |
| → ArrowRight | `\x1b[C` | `\x1bOC` |
| ← ArrowLeft | `\x1b[D` | `\x1bOD` |
| Home | `\x1b[H` | `\x1bOH` |
| End | `\x1b[F` | `\x1bOF` |
| PageUp | `\x1b[5~` | — |
| PageDown | `\x1b[6~` | — |
| Insert | `\x1b[2~` | — |
| Delete | `\x1b[3~` | — |
| Tab | `\t` (`0x09`) | — |
| Shift+Tab | `\x1b[Z` | — |
| Enter | `\r` (`0x0d`) | — |
| Backspace | `\x7f` (DEL) | — |
| ESC | `\x1b` | — |
| F1..F4 | `\x1bOP`..`\x1bOS` | — |
| F5..F12 | `\x1b[15~`..`\x1b[24~` | — |
| Ctrl+A..Ctrl+Z | `\x01`..`\x1a` | — |
| Ctrl+Space | `\x00` (null) | — |
| Alt+key | `\x1b` + key | — |

*Source: [XTerm Control Sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html) — HIGH confidence (canonical reference).*

**DECCKM 问题：** 应用程序（Claude Code、vim、less）可以通过发 `\x1b[?1h` / `\x1b[?1l` 切换光标键模式。客户端 **可以不处理** DECCKM，始终发 Normal 模式序列——大多数程序两种都接受。若要完整兼容，需要在 xterm.js 的 `parser.registerCsiHandler` 里拦截 DECCKM 并在 client 端维护一个 flag；**推荐本 phase 只发 Normal 模式**，Phase 11/12 再评估是否需要 DECCKM 感知。[CITED: xterm.js Context7 docs — `parser.registerCsiHandler` API]

**xterm.js 键位映射实现 pattern：**

方案 X（推荐）：**把 xterm.js 作为键位映射器**。
```typescript
// 本地创建一个辅助 Terminal 实例（不显示），用它的 onData 事件吸收浏览器 KeyboardEvent 并输出 ANSI 序列
// 实际上更简单的做法是直接自己写 keydown handler，因为 xterm.js 的 attachCustomKeyEventHandler
// 处理的也是 DOM KeyboardEvent，内部键位映射逻辑可以参考 xterm.js 源码 src/browser/input/Keyboard.ts

// Plan 10-05 推荐直接手写映射表（约 50 行代码），覆盖上表列出的键位。
// 理由：PTY 模式 InputBar 的 textarea 不是 xterm.js 终端——textarea 的 keydown 事件是浏览器原生，
// xterm 的键位处理依赖于它自己管理的 DOM，复用起来反而绕。
```

方案 Y（备选）：**复用 xterm.js 的 `textarea.addEventListener`**。即 PTY 模式下把 xterm.js 的输入焦点暴露给用户，不用自己的 textarea。但这与 CONTEXT D-26/D-28（InputBar 两模式共用，PTY 也要能"文本 + Enter 发送"）冲突，**不推荐**。

**空状态：** PTY 模式下 InputBar 的 textarea `onKeyDown` 捕获：
- 如果是 "Enter" 且 textarea 有文本：当前行为（发送 text + `\n` via `remote_input`/现有 `user_input`）
- 如果是 "Enter" 且 textarea 为空：发送原始 `\r` via 新 `remote_input_raw`
- 任何其他上述控制键：`preventDefault()` + 查表发 raw 序列 + **不修改 textarea 内容**
- 普通字符：让 textarea 正常输入，显示在编辑区（不发送，直到 Enter）

**NEEDS DECISION (planner):** PTY 模式下"方向键输入"的 UX 含义—— textarea 里的光标位置 vs 远程 PTY 光标位置。现在的设计是"远程 PTY 优先"：方向键直接发给 PTY，不影响 textarea。但这意味着 textarea 本身的上下光标（在多行 textarea 中移动）无法工作。**推荐实现：PTY 模式 textarea 强制为单行 `<input>`，避免混淆；多行编辑让位于"完整输入后 Enter 发送"模式。** Planner 与用户确认。

---

### 2.3 `@tanstack/react-virtual` 动态高度 + follow-output

**版本：** `@tanstack/react-virtual@3.13.23` [VERIFIED: npm view 2026-04-17]；React 19 兼容（peerDep `^19.0.0`）。

**核心 API (from Context7 `/tanstack/virtual`)：**

```typescript
const virtualizer = useVirtualizer({
  count: messages.length,
  getScrollElement: () => parentRef.current,
  estimateSize: () => 120,          // 估算值，首次渲染用；实际高度 measureElement 纠正
  overscan: 5,                       // 可视区外预渲染 5 条
  // measureElement 默认用 getBoundingClientRect，streaming 期间 ResizeObserver 会自动触发重测
});

// 渲染
{virtualizer.getVirtualItems().map((vi) => (
  <div
    key={vi.key}
    data-index={vi.index}
    ref={virtualizer.measureElement}     // 这是 ref callback，not a prop
    style={{
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      transform: `translateY(${vi.start}px)`,
    }}
  >
    <MessageBubble message={messages[vi.index]} />
  </div>
))}
```

**Follow-output (auto-scroll-to-bottom + freeze) pattern：**

```typescript
// 状态：用户是否处于"底部附近"（isAtBottom）。只有在此状态下新消息到达才 scrollToIndex(last)。
const [isAtBottom, setIsAtBottom] = useState(true);
const parentRef = useRef<HTMLDivElement>(null);

// 监听 scroll 事件，不用 IntersectionObserver（DOM 虚拟化下 observer 不可靠）
useEffect(() => {
  const el = parentRef.current;
  if (!el) return;
  const onScroll = () => {
    const threshold = 50; // px
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
    setIsAtBottom(atBottom);
  };
  el.addEventListener("scroll", onScroll, { passive: true });
  return () => el.removeEventListener("scroll", onScroll);
}, []);

// 新消息到达（或最后一条内容增长，即 messages[last].text 改变）
useEffect(() => {
  if (isAtBottom && messages.length > 0) {
    virtualizer.scrollToIndex(messages.length - 1, { align: "end", behavior: "auto" });
  }
}, [messages.length, messages[messages.length - 1]?.text, isAtBottom]);
```

**Streaming 内容重测：** `measureElement` 通过 ResizeObserver 自动触发，无需手动调用。但 **注意**：如果 MessageBubble 内部有异步图片加载或代码块高度跳变，可能需要手动 `virtualizer.measureElement(el)` 补测。实际上 Markdown 渲染都是同步的，应该没问题。[VERIFIED: TanStack virtual docs]

**BackToBottom 按钮：** 当 `isAtBottom === false` 时显示浮动按钮，点击调用 `virtualizer.scrollToIndex(last, { align: "end", behavior: "smooth" })`。

**陷阱 (HIGH risk)：** 初次渲染时 `parentRef.current` 可能未 ready，`getScrollElement` 返回 null，virtualizer 会用空视口——**必须等到 ref 挂载后再 render virtualizer 子组件**。解决：用 state `scrollElementReady`，`ref` callback 里 set。

**Overscan 建议：** 5（默认 1 太低，streaming 场景频繁进入新视口会闪烁）。

---

### 2.4 shadcn Command 双用途（CommandPalette + SlashCommandPicker）

**版本：** `cmdk@1.1.1` [VERIFIED: npm view 2026-04-17]；shadcn `command` 组件基于 cmdk。React 19 兼容。

**关键事实（订正 memory 误区）：**

`project_slash_command_preset_infeasible.md` 记载 "D-28 硬编码命令列表不可行"。经代码考古，**命令列表早已不是硬编码**：

- `apps/proxy/src/command-discovery.ts` — 扫描 REPL builtins + `~/.claude/commands/` + project `.claude/skills/` + 其他来源
- `packages/shared/src/schemas/relay-control.ts:130-133` — `command_list_push` 消息
- `apps/proxy/src/__tests__/unit/control-messages.test.ts:178-186` — proxy 在 session sync 时主动推送
- `apps/web/src/stores/command-store.ts` — `setCommands(commands)` 已迁移

**Phase 10 的实际需求：** 仅消费 `useCommandStore.commands`，不需要发请求。Feishu 的 `<SlashCommandPicker commands={...} />` 已经这么做。

**双用途实现 pattern：**

```typescript
// shadcn Command 组件可以接受任何数据源，不限于 palette
// 两实例 (CommandPalette / SlashCommandPicker) 共享同一 shadcn Command atom

// CommandPalette (Cmd+K)
<CommandDialog open={open} onOpenChange={setOpen}>
  <CommandInput placeholder="搜索会话、proxy 或命令…" />
  <CommandList>
    <CommandGroup heading="会话">
      {sessions.map((s) => <CommandItem key={s.id}>{s.name}</CommandItem>)}
    </CommandGroup>
    <CommandGroup heading="Proxy">
      {proxies.map((p) => <CommandItem key={p.proxyId}>{p.name}</CommandItem>)}
    </CommandGroup>
    <CommandGroup heading="动作">
      <CommandItem>新建会话</CommandItem>
    </CommandGroup>
  </CommandList>
</CommandDialog>

// SlashCommandPicker (InputBar 内 `/` 触发)
// 不用 CommandDialog，直接用 <Command /> 裸组件，定位为绝对定位 popover 在 InputBar 上方
<Command shouldFilter={false}>  {/* 外部 filter state 驱动 */}
  <CommandList>
    {filteredCommands.map((cmd) => (
      <CommandItem key={cmd.name} onSelect={() => onSelect(cmd)}>
        <span>{cmd.name}</span>
        <span className="text-xs text-muted-foreground">{cmd.description}</span>
      </CommandItem>
    ))}
  </CommandList>
</Command>
```

**全局 Cmd+K 注册与清理：**

```typescript
// app-shell.tsx 内
useEffect(() => {
  const onKeyDown = (e: KeyboardEvent) => {
    // 避免在 InputBar 内输入 / 时误触发 Cmd+K 逻辑
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      setCommandPaletteOpen(true);
    }
    // 不 handle 其他键，让 SlashCommandPicker 用 InputBar 自己的 onKeyDown 处理
  };
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}, []);
```

**Dialog 冲突避免：** shadcn `CommandDialog` 内部基于 `Dialog` + `Command`；两层 Dialog（CreateSessionDialog + CommandPalette）同时开启时，Radix 自动管理 z-index，无需手动处理。

---

### 2.5 iOS Safari visualViewport 键盘适配

**已有/需要的 API：**

| API | iOS Safari 支持 | Chrome 支持 | 用途 |
|-----|----------------|-------------|------|
| `100dvh` CSS | iOS 15.4+ ✓ | Chrome 108+ ✓ | 基本可用，**替代 100vh** |
| `window.visualViewport` | iOS 13+ ✓ | 61+ ✓ | 键盘弹起时的精确视口高度 + offsetTop |
| `env(safe-area-inset-*)` | iOS 11+ ✓ | — | 刘海屏 / 底部 home 指示器 |

*Sources: [tkte.ch VisualViewport 文章](https://tkte.ch/articles/2019/09/23/safari-13-mobile-keyboards-and-the-visualviewport-api.html) + [Apple Forum iOS 26 issue thread](https://developer.apple.com/forums/thread/800125) — MEDIUM confidence (权威但零散).*

**推荐 pattern（InputBar 定位到键盘上方）：**

```typescript
// InputBar 组件内
useEffect(() => {
  const vv = window.visualViewport;
  if (!vv) return; // 桌面浏览器可能没有，降级用 position: fixed bottom: 0

  const updatePosition = () => {
    const el = inputBarRef.current;
    if (!el) return;
    // visualViewport.height = 键盘弹出后实际可用视口高度
    // visualViewport.offsetTop = 键盘弹出后顶部偏移（通常为 0，iOS 26 有 bug）
    // window.innerHeight = layout viewport 高度（不考虑键盘）
    const bottomOffset = window.innerHeight - vv.height - vv.offsetTop;
    el.style.transform = `translateY(-${Math.max(bottomOffset, 0)}px)`;
  };

  vv.addEventListener("resize", updatePosition);
  vv.addEventListener("scroll", updatePosition);
  updatePosition();

  return () => {
    vv.removeEventListener("resize", updatePosition);
    vv.removeEventListener("scroll", updatePosition);
  };
}, []);
```

**iOS 26 已知 bug：** 键盘关闭后 `visualViewport.offsetTop` 不会重置到 0，导致 `bottom: 0` 定位的元素错位。解决：在 `focusout`/`blur` 事件后延迟 300ms 再次调用 `updatePosition()`。*[CITED: Apple Developer Forum thread #800125, 2026 Jan]*

**100dvh 状态：** iOS 15.4+ 已稳定可用，**不需要 JS 补丁**。但 visualViewport API 仍然需要，因为 `100dvh` 只解决"视口高度"，不解决"键盘弹起时元素被遮挡"——需要 API 来获取 offsetTop。

**测试方式：** Playwright MCP 无法模拟 iOS 软键盘；**必须在真机 / iOS 模拟器 Safari 上人工测试**。桌面 Chrome 有 visualViewport，但行为不等同于 iOS（Chrome 桌面不触发 resize）。

---

### 2.6 Sonner 迁移 + useToast 兼容层

**版本：** `sonner@2.0.7` [VERIFIED: npm view 2026-04-17]；React 19 兼容。

**现状：** `apps/web/src/components/toast.tsx`（20 行）+ `apps/web/src/stores/toast-store.ts`。`showToast(message)` / `showErrorToast` 等来自 Feishu 的 API。

**兼容层设计：**

```typescript
// apps/web/src/components/toast.tsx (rewrite)
import { Toaster, toast } from "sonner";
export { Toaster };

// 保留旧 API 给 phase-machine.ts / relay-client 消费者用，零改动
export function showToast(message: string) { toast(message); }
export function showErrorToast(message: string) { toast.error(message); }
export function showSuccessToast(message: string) { toast.success(message); }
export function showWarningToast(message: string) { toast.warning(message); }

// 给新代码用的直接 API
export { toast };

// useToast hook（如果 Feishu 有该名字，保留）
export function useToast() {
  return { toast, dismiss: toast.dismiss };
}
```

**状态色映射到 Sonner variants：**

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

**toast-store.ts 删除：** Sonner 自带 store，旧的 `useToastStore` + `useToastStore.getState().showToast` 调用点必须在 Plan 10-01 全部替换为 `showToast`/`toast.success` 等。`phase-machine.ts:77` 和 `:86` 是现在的两个使用点——**Planner 必须把这两处的修改列入 Plan 10-01 的明确任务**。

---

### 2.7 react-markdown + remark-gfm + rehype-highlight（安全配置）

**版本：** [VERIFIED: npm view 2026-04-17]
- `react-markdown@10.1.0` (React 19 兼容)
- `remark-gfm@4.0.1`
- `rehype-highlight@7.0.2`
- `highlight.js@11.11.1` (peer dep of rehype-highlight)

**安全配置 (XSS 防护)：**

```tsx
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";  // 代码高亮主题

<Markdown
  remarkPlugins={[remarkGfm]}
  rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
  skipHtml                              // 丢弃原始 HTML (XSS 防护)
  disallowedElements={["script", "iframe", "object", "embed"]}  // 双保险
  components={{
    a: ({ href, children, ...rest }) => (
      <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    ),
    code: ({ className, children, ...rest }) => {
      // 为代码块添加 copy 按钮
      const isBlock = className?.includes("language-");
      if (isBlock) return <CodeBlock {...rest}>{children}</CodeBlock>;
      return <code {...rest}>{children}</code>;
    },
  }}
>
  {text}
</Markdown>
```

*[VERIFIED: react-markdown Context7 docs — `skipHtml` + `disallowedElements` are documented XSS mitigation].*

**rehype-highlight vs shiki 选型：**

| 维度 | rehype-highlight | shiki |
|------|------------------|-------|
| Bundle 体积 | ~50KB (highlight.js core) + 按需语言 | ~700KB-1.2MB（full bundle） |
| 精确度 | OK（正则 parser） | 高（TextMate grammar，同 VS Code） |
| Streaming 性能 | 好（同步） | 需要 `react-shiki` 或节流，否则流式每次重新高亮 |
| 深色主题 | `github-dark.css` 够用 | 支持 VS Code 主题 |

**推荐：rehype-highlight**（CONTEXT D-25 已定），理由：流式输出性能敏感、bundle 小、深色主题 `github-dark.css` 与 xtermTheme 视觉呼应。

**代码块 copy 按钮：** 自写 `<CodeBlock>` 组件，用 `navigator.clipboard.writeText(extractTextFromChildren(children))`，按钮内嵌在代码块右上角。

**潜在冲突：** rehype-highlight 会给 `<pre><code>` 加 `class="hljs language-ts"`，自定义 `components.code` 的 render function 必须正确处理这些 class 传递给 hljs CSS。

---

### 2.8 xterm.js 主题与字体的 Phase 9 锁定

**Phase 9 不可动的决策（D-40 ~ D-44 + UI-SPEC Deviation Log）：**
- `xtermTheme` 对象（含 `cursorAccent: "#00D4AA"` 青绿，与 Phase 10 amber 分离）
- `fontFamily: '"Sarasa Fixed SC", "Noto Sans Mono CJK SC", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace'`
- `fontSize: 14`
- `scrollback: 5000`
- WebGL renderer (在 `terminal.open()` 之后加载，有 fallback)
- UnicodeGraphemes addon + `unicode.activeVersion = "15-graphemes"`
- 字体预加载 `await document.fonts.ready`

**Plan 10-05 复用 pattern：** 抽 `apps/web/src/lib/create-xterm.ts`（新）：

```typescript
// Extracted verbatim from pages/pty-test.tsx for reuse by ChatPtyView
export async function createXtermTerminal(container: HTMLDivElement): Promise<{
  terminal: Terminal;
  serializeAddon: SerializeAddon;
  dispose: () => void;
}> {
  await document.fonts.ready;

  const terminal = new Terminal({
    scrollback: 5000,
    fontFamily: '"Sarasa Fixed SC", "Noto Sans Mono CJK SC", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
    fontSize: 14,
    cursorBlink: false,
    cursorInactiveStyle: "none",
    disableStdin: true,         // PTY 模式下 InputBar 负责输入，xterm 不直接接收
    theme: xtermTheme,
    allowProposedApi: true,
  });

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

  return {
    terminal,
    serializeAddon,
    dispose: () => terminal.dispose(),
  };
}
```

**然后 `pty-test.tsx` 和 `ChatPtyView` 都调用 `createXtermTerminal(container)`，verbatim 一致。**

**关键 UX 冲突待 planner 决定：** `disableStdin: true` 下 xterm 不响应键盘。PTY 模式 InputBar 的键位通过 D-21 raw channel 发给 PTY，PTY 回显通过 binary 数据显示在 xterm——**echo 有往返延迟**。本地终端 `/pty-test` 就是这样（测试验证过），用户已接受。

**NEEDS DECISION (planner):** 是否允许本地 echo？即在 InputBar 捕获键位时立即 `terminal.write(localEchoBytes)`，不等服务端回显。**推荐：不做本地 echo**（实现复杂且易与服务端 echo 冲突），沿用 Phase 9 `/pty-test` 纯被动模式。

---

### 2.9 shadcn 原子安装（Plan 10-01）

**已安装：** Button (`apps/web/src/components/ui/button.tsx`)。

**需安装（CONTEXT D-32 全集）：**

```bash
# apps/web 目录下（components.json 已就位，baseColor=neutral, style=new-york）
cd apps/web
npx shadcn@latest add dialog sheet tooltip popover scroll-area textarea badge avatar separator select dropdown-menu sonner command
```

每个命令会自动：
- 安装对应的 `@radix-ui/*` npm 包
- 复制组件代码到 `apps/web/src/components/ui/<name>.tsx`

**Radix peer deps（参考版本，[VERIFIED: npm view 2026-04-17]）：**
- `@radix-ui/react-dialog@1.1.15`
- `@radix-ui/react-popover@1.1.15`
- `@radix-ui/react-tooltip@1.2.8`
- `@radix-ui/react-scroll-area@1.2.10`
- `@radix-ui/react-select@2.2.6`
- `@radix-ui/react-dropdown-menu@2.1.16`

（项目已有 `radix-ui@1.4.3` umbrella package — 可能冲突，planner 在 10-01 首个任务里验证。）

**D-02 + D-03 主题 override（CSS 变量覆盖，放在 `apps/web/src/app.css`）：**

```css
:root {
  /* D-02: Phase 10 accent override */
  --primary: #D4A574;                    /* was #00D4AA */
  --primary-foreground: #1E1E1E;
  --ring: #D4A574;                       /* focus ring matches accent */

  /* D-03: radius override */
  --radius: 0.375rem;                    /* was 0.25rem */

  /* Phase 10 新增：UI-SPEC reserved status colors (与 primary 分离) */
  --color-status-working: #4FC1FF;
  --color-status-success: #00D4AA;       /* 仍保留 teal 作为 status-success */
  --color-status-warning: #E8AB5A;
  --color-status-error: #F44747;
}
```

**Button label weight 404 override（UI-SPEC Deviation Log）：**

在 `apps/web/src/components/ui/button.tsx` 里把 `font-medium` 改成 `font-normal`，或者更稳的做法是在 `@theme` 里定义 `--button-font-weight: 400` 然后 Button 内用 `font-[var(--button-font-weight)]`。**推荐直接改 button.tsx 的 CVA className 字符串**，shadcn 本来就是鼓励魔改的 copy-paste 库。

**Plan 10-01 验证：** `apps/web/src/pages/token-showcase.tsx` 已是 Phase 7 的 token 展示页，Phase 10 在此基础上**扩展一个 shadcn 组件 showcase section**（每个原子的 default/hover/focus/disabled 状态），作为主题 override 的视觉回归基准。

---

### 2.10 响应式 master-detail 布局

**CSS 响应式 class 切换 vs 条件渲染：**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **CSS 响应式（Tailwind `md:` 前缀）** | 无 hydration 闪烁；DOM 稳定；浏览器原生响应 | 两种 layout 的 DOM 同时存在（轻微开销） |
| **条件渲染（`if (width >= 768)`）** | DOM 精简 | 需要 `useMediaQuery` hook 监听；切换时组件重挂载导致状态丢失 |

**推荐：CSS 响应式 class 切换。** 移动端 ≤ 768 显示 `<Outlet />`（路由驱动的页面）；桌面 ≥ 768 显示 `<Sidebar /> + <main><Outlet /></main>`。同一 `Outlet` 子组件（ChatPage 等）两种布局下 DOM 结构不同但 React tree 相同——**不会重挂载，状态保留**。

**react-router v7 与即时切换（D-15）pattern：**

```tsx
// apps/web/src/app.tsx
<Route path="/" element={<AppShell />}>
  <Route index element={<ProxySelectOrRedirect />} />
  <Route path="sessions" element={<SessionListPage />} />
  <Route path="chat/:id" element={<ChatPage />} />
</Route>

// AppShell.tsx
function AppShell() {
  return (
    <div className="flex h-dvh">
      <Sidebar className="hidden md:flex" />  {/* CSS 驱动 */}
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}

// SessionRow.tsx — D-15 "即时切换但不跳转路由"
function SessionRow({ session }) {
  const navigate = useNavigate();
  const handleClick = () => {
    // 路由仍然更新（支持刷新 / 分享 URL）
    navigate(`/chat/${session.id}?mode=${session.mode}`, { replace: false });
    // React Router 会 re-render ChatPage，但因为 AppShell 是父路由
    // 不会触发 page-level transition animation（CONTEXT D-15）
  };
}
```

**侧栏折叠 localStorage 持久化时机：**

```typescript
// hooks/use-sidebar-collapsed.ts
const [collapsed, setCollapsed] = useState(() => localStorage.getItem("cc_sidebarCollapsed") === "1");
const toggle = () => {
  setCollapsed((prev) => {
    const next = !prev;
    localStorage.setItem("cc_sidebarCollapsed", next ? "1" : "0");
    return next;
  });
};
```

推荐：**用户每次 toggle 即写 localStorage**，不是组件卸载时（卸载可能不触发，组件切路由时 cleanup 不可靠）。

---

### 2.11 InputBar 完整能力矩阵

**多行 textarea 自撑高（1-8 行）：**

```typescript
// 参考 GitHub Issues 评论框
const textareaRef = useRef<HTMLTextAreaElement>(null);
useEffect(() => {
  const el = textareaRef.current;
  if (!el) return;
  el.style.height = "auto";
  const lineHeight = 24; // px, matches CSS line-height: 1.5 at 16px
  const minHeight = lineHeight * 1 + 12 * 2; // 1 line + padding
  const maxHeight = lineHeight * 8 + 12 * 2; // 8 lines + padding
  el.style.height = `${Math.max(minHeight, Math.min(el.scrollHeight, maxHeight))}px`;
  el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
}, [value]);
```

**历史命令栈（D-26 `↑` 召回）：**

- 存储位置：`localStorage` key `cc_inputHistory:${sessionId}`（per-session，避免跨 session 串码）
- 大小限制：最近 100 条（FIFO）
- 触发时机：**空输入框** 按 `↑` 召回最新 → 再 `↑` 再往前 → `↓` 往后 → `Esc` 清空

```typescript
const [historyIndex, setHistoryIndex] = useState<number>(-1);
const history = useMemo(() => loadHistory(sessionId), [sessionId]);

const onKeyDown = (e: KeyboardEvent) => {
  if (e.key === "ArrowUp" && value === "" && historyIndex < history.length - 1) {
    e.preventDefault();
    const next = historyIndex + 1;
    setHistoryIndex(next);
    setValue(history[history.length - 1 - next]);
  }
  // 对称处理 ArrowDown / Escape
};
```

**触发检测（`/` 斜杠 + `@` 文件）：**

复用 Feishu `detectPickerMode` 函数（`apps/feishu/src/components/input-bar/index.tsx:38-43`）——**纯函数无 Taro 依赖，可直接复制到 Phase 10 InputBar**。

**PTY 模式 vs JSON 模式键盘分工：**

| 按键 | JSON 模式 | PTY 模式 |
|------|-----------|----------|
| 普通字符 | 进入 textarea | 进入 textarea |
| Enter | `onSend(text)` → envelope `user_input` | `onSend(text + "\n")` → `pty_input`（现有通路） |
| Shift+Enter | textarea 换行 | textarea 换行（多行 input） |
| ↑ 空输入 | 召回历史 | **发 ANSI `\x1b[A` via raw channel** |
| ↑ 非空输入 | 浏览器默认（textarea 内光标） | **发 ANSI `\x1b[A` via raw channel** |
| Ctrl+C | 浏览器默认（copy 选中文本） | **如果有选中 → copy；否则发 `\x03` via raw channel** |
| Tab | 浏览器默认（focus next） | **发 `\t`（阻止默认）** |
| ESC | 关闭 picker（如打开） | **发 `\x1b`（阻止默认）** |
| 方向键 (PTY) | — | 见 ANSI 映射表 |

**FilePathPicker 与 FileWatcher 集成（D-27）：**

现有 `file-store.ts` 仅缓存，不含 FileWatcher。STATE.md 记载 "Phase 10: FileWatcher integration into Chat page file picker" 待办——**这是本 phase 的 Plan 10-04 内新任务**。已有 `dir_list_request`/`dir_list_response`/`file_tree_push` 协议（`packages/shared/src/schemas/relay-control.ts:113-140`），client 发 `dir_list_request(path)` 拉列表，proxy 返回 `dir_list_response` 或推 `file_tree_push`。

FilePathPicker 用 `useFileStore().tree.get(currentPath)` 取列表，当前路径缺失时发 `relayClient.sendControl({ type: "dir_list_request", path })`。复用 Feishu 逻辑（`apps/feishu/src/components/file-path-picker/index.tsx`）—— 176 行，可直接迁移替换 `<View>/<ScrollView>` 为 `<div>`。

---

### 2.12 并排 tab 架构（Plan 10-06 可选）

**两 Chat 实例同时 mount：**

- Zustand store 是全局单例，两个 ChatJsonView 消费同一 `useChatStore` 会串号。**解决：`chat-store` 必须改成 "key by sessionId"**。例如：
  ```typescript
  interface ChatStoreState {
    bySessionId: Map<string, ChatSessionState>;
    ...
  }
  ```
  这是一个**非局部改动**，超出本 phase 范围。**Planner 评估：若要做并排 tab，必须先把 chat-store 重构为 per-session map**。这不是轻量 Plan 10-06。

**NEEDS DECISION (planner):** 并排 tab 的复杂度与当前 store 架构不兼容。两个选项：
1. **推迟并排 tab**：把 D-18 从 Phase 10 踢到 Phase 11 或更晚。
2. **Plan 10-06 先做 store 重构**：chat-store / terminal-store / command-store 改 per-session，再实现并排。

**推荐推迟。** 理由：master-detail（D-15）已满足"多会话浏览"的核心需求；并排 tab 是 nice-to-have；store 重构的 blast radius 很大，会拖累 10-01 ~ 10-05 的交付节奏。**Planner 提给用户 confirm**。

**URL 结构（若推进）：** `/chat/:id1+:id2?mode1=json&mode2=pty` 或 query 参数 `?pane1=session-a-json&pane2=session-b-pty`。推荐 query，路径简洁。

---

## 3. Dependencies to Install

**必装（Plan 10-01）[VERIFIED: npm view 2026-04-17]：**

```bash
cd apps/web

# shadcn 原子（shadcn CLI 会自动安装对应 @radix-ui 包）
npx shadcn@latest add dialog sheet tooltip popover scroll-area textarea badge avatar separator select dropdown-menu sonner command

# 虚拟滚动 + Markdown + Code highlight
pnpm add @tanstack/react-virtual@^3.13.23
pnpm add react-markdown@^10.1.0 remark-gfm@^4.0.1 rehype-highlight@^7.0.2
pnpm add highlight.js@^11.11.1     # peer dep of rehype-highlight
```

**说明：**
- `sonner@^2.0.7` 由 `shadcn add sonner` 带入，无需手动
- `cmdk@^1.1.1` 由 `shadcn add command` 带入，无需手动
- `@radix-ui/*` 全部由 shadcn add 带入
- `lucide-react@^1.8.0` 已装（用于所有 icons）
- `@xterm/*` 全部已装
- `zustand@^5.0.12` 已装
- `react-router@^7.14.1` 已装
- `@cc-anywhere/shared` 已是 workspace dep

**已装但需覆盖的：** `apps/web/src/components/toast.tsx` + `apps/web/src/stores/toast-store.ts` —— Plan 10-01 用 Sonner wrapper 替换 toast.tsx，删除 toast-store.ts（phase-machine 的两个调用点顺带改掉）。

**potential 冲突：** `radix-ui@1.4.3` umbrella package 已装；shadcn add 会装具体 `@radix-ui/react-<name>` 子包，两者可能共存但版本差异需要 Plan 10-01 启动时 pnpm install 后验证。

---

## 4. File-Level Impact Map

### 新增文件（apps/web）

```
apps/web/src/
├── components/
│   ├── ui/                              # shadcn 原子，全部 Plan 10-01
│   │   ├── dialog.tsx
│   │   ├── sheet.tsx
│   │   ├── tooltip.tsx
│   │   ├── popover.tsx
│   │   ├── scroll-area.tsx
│   │   ├── textarea.tsx
│   │   ├── badge.tsx
│   │   ├── avatar.tsx
│   │   ├── separator.tsx
│   │   ├── select.tsx
│   │   ├── dropdown-menu.tsx
│   │   ├── sonner.tsx                   # Toaster wrapper
│   │   └── command.tsx
│   ├── shell/                           # Plan 10-01
│   │   ├── app-shell.tsx
│   │   ├── sidebar.tsx
│   │   ├── empty-state.tsx
│   │   └── command-palette.tsx
│   ├── proxy/                           # Plan 10-02
│   │   ├── proxy-switcher.tsx           # layout=page|dropdown
│   │   └── proxy-status-dot.tsx
│   ├── session/                         # Plan 10-03
│   │   ├── session-list.tsx             # layout=page|sidebar
│   │   ├── session-row.tsx
│   │   └── create-session-dialog.tsx
│   └── chat/                            # Plan 10-04/10-05
│       ├── chat-header.tsx
│       ├── chat-json-view.tsx
│       ├── chat-pty-view.tsx
│       ├── message-bubble.tsx
│       ├── markdown-view.tsx
│       ├── tool-approval-card.tsx
│       ├── input-bar.tsx
│       ├── quote-preview-bar.tsx
│       ├── file-path-picker.tsx
│       ├── back-to-bottom.tsx
│       ├── status-line.tsx
│       ├── slash-command-picker.tsx
│       └── ansi-key-map.ts              # Plan 10-05 D-21: ANSI 序列查表
├── pages/
│   └── chat.tsx                         # 已存在，10-04 改为 ChatPage 分发器
├── lib/
│   ├── create-xterm.ts                  # Plan 10-05: 从 pty-test.tsx 抽出
│   └── ansi-keys.ts                     # Plan 10-05: KeyboardEvent → ANSI 查表
├── hooks/
│   ├── use-sidebar-collapsed.ts         # Plan 10-01
│   ├── use-visual-viewport.ts           # Plan 10-01
│   ├── use-input-history.ts             # Plan 10-04
│   └── use-follow-output.ts             # Plan 10-04
└── utils/
    └── summarize-tool-input.ts          # Plan 10-04: 从 Feishu 复制，纯函数
```

### 修改文件（apps/web）

| 文件 | Plan | 改动 |
|------|------|------|
| `src/app.css` | 10-01 | D-02/D-03 token override；UI-SPEC 全套 CSS 变量 |
| `src/app.tsx` | 10-01 | 包装 AppShell；Sonner Toaster 替代 `<Toast />` |
| `src/lib/router.tsx` | 10-01 | Nested routes：AppShell 作父路由 |
| `src/components/toast.tsx` | 10-01 | 重写为 Sonner wrapper |
| `src/components/ui/button.tsx` | 10-01 | `font-medium` → `font-normal`；radius 验证 |
| `src/stores/toast-store.ts` | 10-01 | **删除**（Sonner 自带 store） |
| `src/services/phase-machine.ts` | 10-01 | 两个 `useToastStore.getState().showToast(...)` 调用替换为 `showToast(...)` |
| `src/pages/proxy-select.tsx` | 10-02 | 重写，使用 ProxySwitcher |
| `src/pages/session-list.tsx` | 10-03 | 重写，使用 SessionList + CreateSessionDialog |
| `src/pages/chat.tsx` | 10-04/10-05 | 重写为分发器（JsonView / PtyView） |
| `src/pages/pty-test.tsx` | 10-05 | 改用 `createXtermTerminal()`（verbatim 等价） |
| `src/pages/token-showcase.tsx` | 10-01 | 扩展 shadcn 原子 showcase section |

### 跨包修改（D-21 PTY 原始键位）

| 文件 | Plan | 改动 |
|------|------|------|
| `packages/shared/src/schemas/relay-control.ts` | 10-05 | 新增 `remote_input_raw` control 消息 schema（推荐方案 A） |
| `apps/proxy/src/serve.ts` | 10-05 | 新增 `remote_input_raw` handler → 直接转发到 terminal 作为 `pty_input` 不加 `\r` |
| `apps/proxy/src/ipc-protocol.ts` | 10-05 | **（方案 A 下可不改）** 或新增 `pty_input_raw` schema |
| `apps/proxy/src/terminal.ts` | 10-05 | **（方案 A 下可不改）** 或新增 `pty_input_raw` handler |
| `apps/web/src/components/chat/input-bar.tsx` | 10-05 | PTY 模式键盘捕获 → `ansi-keys.ts` 查表 → `remote_input_raw` |

### 删除文件（apps/web）

| 文件 | Plan | 原因 |
|------|------|------|
| `src/components/toast.tsx`（旧实现） | 10-01 | 被 Sonner 替换；实际是重写 |
| `src/stores/toast-store.ts` | 10-01 | Sonner 自带 store，不需要 |

### 不动文件（被依赖但 Phase 10 不改）

- `src/stores/app-store.ts` / `chat-store.ts` / `session-store.ts` / `command-store.ts` / `file-store.ts`（**除非做并排 tab，则 chat-store 需 per-session 重构**）
- `src/services/websocket.ts` / `relay-client.ts` / `ensure-binding.ts`
- `src/lib/xterm-theme.ts`（Phase 9 锁定）
- `src/hooks/use-relay-setup.ts`
- `packages/shared/src/schemas/envelope.ts`（不动）

---

## 5. Risks & Tradeoffs

### Risk 1: D-21 PTY 原始键位 — 跨包改动的测试成本
- **失败模式**：proxy 端 IPC handler 漏处理新类型，pty_input_raw 到达后被丢弃；或者 serve.ts 没区分 relay vs client 消息源，误加 `\r`。
- **缓解**：
  - 推荐方案 A（仅改 shared + serve + client，不动 IPC）最小化 blast radius
  - Plan 10-05 必须对 proxy 端跑 unit test（现有 `apps/proxy/src/__tests__/unit/control-messages.test.ts` 模式可复用）
  - 手动测试清单：方向键 → Claude 菜单导航 / Ctrl+C → 中断 / Tab → 命令补全 / ↑ → shell history / ESC → 退出 menu

### Risk 2: `@tanstack/react-virtual` streaming 场景高度抖动
- **失败模式**：流式消息增长时高度频繁变化，overscan 窗口外的元素被回收，滚动跳动；或 follow-output 与用户手动滚动冲突。
- **缓解**：
  - `isAtBottom` 用 50px 阈值（不是 0）容错
  - Markdown code 块高度要 stable（rehype-highlight 同步，好；但如果后续切 shiki 流式需节流）
  - 视觉测试：模拟流式输出 2000 字回答，观察 Playwright 滚动行为

### Risk 3: iOS Safari 键盘适配在真机上 behaviors diverge
- **失败模式**：`visualViewport` API 在模拟器表现 OK，真机 iOS 26 有 offsetTop 不重置的 bug。
- **缓解**：
  - Plan 10-04 完成后必须真机测试（Planner 把此列入 acceptance）
  - `focusout` 事件延迟 300ms 再校正 position
  - 桌面浏览器降级路径：若 `visualViewport` 不存在，直接 `position: fixed bottom: 0 + env(safe-area-inset-bottom)`

### Risk 4: shadcn 主题 override 遗漏某个 CSS 变量
- **失败模式**：某个 shadcn 组件用了 hardcoded Tailwind class（而非 CSS 变量），主题 override 没覆盖，视觉突兀。
- **缓解**：
  - Plan 10-01 `token-showcase` 扩展后强制人工视觉 review（CONTEXT D-39）
  - 以 UI-SPEC.md 的 component state matrix（default/hover/active/focus/disabled）为 checklist 逐项验证

### Risk 5: 并排 tab 架构冲突（D-18）
- **失败模式**：两 ChatJsonView 订阅同一 chat-store 导致消息串号
- **缓解**：
  - **推迟到 Phase 11 +**。Plan 10-06 设为可选，CONTEXT D-38 已提示 Planner 决定
  - 如果必做：先做 store per-session 重构作为 10-06 子任务

### Risk 6: 虚拟滚动 + react-markdown + 流式消息的组合性能
- **失败模式**：消息列表 > 1000 条时，即便虚拟化，每次新消息 measureElement 可能触发 layout thrashing。
- **缓解**：
  - overscan 控制在 5-10
  - `MessageBubble` 用 `React.memo`，避免上游渲染触发整列重渲染
  - Plan 10-04 验收跑 1000 条消息 stress test（Playwright 脚本）

### Risk 7: Sonner + react-router 重连时机的闪烁
- **失败模式**：phase-machine 在重连时 `showToast("Proxy reconnected")`，Sonner toast 在路由切换瞬间被 unmount。
- **缓解**：Sonner `<Toaster />` 挂在 AppShell 根节点（不在路由子树内），toast state 由 Sonner 管理，路由切换不影响。

---

## 6. Runtime State Inventory

**适用性：** Phase 10 以新增为主，但 Plan 10-01 删除 `toast-store.ts` 需检查。

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data (localStorage) | `cc_proxyId` / `cc_sessionId` / `cc_sessionMode` / `cc_relayUrl` / `cc_clientId` / `cc_fontSizeIndex` 全部沿用；新增 `cc_sidebarCollapsed` / `cc_inputHistory:<sessionId>` | 代码新增读写，无需数据迁移 |
| Live service config | 无 — relay / proxy 端无本 phase 改动（D-21 除外，且是新增消息类型，无配置迁移） | 无 |
| OS-registered state | 无 | 无 |
| Secrets / env vars | `VITE_RELAY_URL` 不变 | 无 |
| Build artifacts / installed packages | Plan 10-01 装 shadcn + markdown 新依赖，`apps/web/node_modules` 需 `pnpm install`；`radix-ui@1.4.3` umbrella 可能与 shadcn 子包重复 | Plan 10-01 第一步 `pnpm install` 后 `pnpm --filter web typecheck` 验证 |

---

## 7. Common Pitfalls

### Pitfall 1: `@tanstack/react-virtual` 初次渲染 parentRef 未 ready
- **What goes wrong:** `getScrollElement` 返回 null，`getVirtualItems()` 空数组，页面空白
- **How to avoid:** 用 state + ref callback 确保 mount 后再 render virtualizer children
- **Warning signs:** 首次挂载时 console 无错但 DOM 为空

### Pitfall 2: shadcn `CommandDialog` 内嵌 `<Dialog>` 与外层 `<Dialog>` z-index 冲突
- **What goes wrong:** CreateSessionDialog 打开时按 Cmd+K，Command Dialog 出现在其下方被遮挡
- **How to avoid:** Radix 默认 z-index=50；CommandDialog 手动设 z-60；或通过 `@layer components` 统一管理
- **Warning signs:** 手动点击 Command item 无响应（实际在 CreateSessionDialog 后面）

### Pitfall 3: react-markdown `skipHtml` 被忘记，用户消息里的 `<script>` 执行
- **What goes wrong:** XSS
- **How to avoid:** `skipHtml` 必须加；additionally `disallowedElements=["script","iframe"]`
- **Warning signs:** 测试用户发 `<img src=x onerror=alert(1)>` 未被清除

### Pitfall 4: textarea 自撑高在 iOS Safari 与键盘弹起冲突
- **What goes wrong:** 键盘弹起 → visualViewport resize → textarea 高度重算 → 又触发 resize → 死循环
- **How to avoid:** 把 resize 观察和 height 重算解耦，只监听 `value` change 重算高度，不监听 viewport resize
- **Warning signs:** 打字时页面不断抖动

### Pitfall 5: Sonner 替换时漏改 phase-machine 的 toast 调用点
- **What goes wrong:** TypeScript 报错找不到 `useToastStore`，或调用处仍 import 旧 store 导致 build 失败
- **How to avoid:** Plan 10-01 grep `useToastStore\|showToast` 全仓库确认所有点
- **Warning signs:** 迁移后 proxy offline 时无 toast 显示

### Pitfall 6: D-21 PTY raw 键位 — Enter 在两通路间歧义
- **What goes wrong:** InputBar 在空状态按 Enter 走 raw channel 发 `\r`，但用户期待是发送消息；反之亦然
- **How to avoid:** PTY 模式下 Enter 始终走 `remote_input`（带 `\r`，走现有通路）；其他控制键（方向键等）走 raw channel
- **Warning signs:** PTY session 中 Enter 无反应

### Pitfall 7: xterm.js WebGL renderer 在 Playwright headless 模式不工作
- **What goes wrong:** E2E 测试跑不起来，xterm 画面空白
- **How to avoid:** STATE.md 已记录。Playwright 跑 xterm 视觉测试用 `--headed` 或 MCP browser
- **Warning signs:** CI 测试通过，手动测试画面正常，headless 截图空白

---

## 8. Code Examples

### 8.1 shadcn Command 双用途 (Slash Picker inside InputBar)

```tsx
// apps/web/src/components/chat/slash-command-picker.tsx
import { Command, CommandInput, CommandList, CommandItem, CommandEmpty } from "@/components/ui/command";
import { useCommandStore } from "@/stores/command-store";

interface SlashCommandPickerProps {
  filter: string;                    // 从 InputBar 传入（"/status" → "status"）
  onSelect: (cmd: CommandEntry) => void;
  onClose: () => void;
}

export function SlashCommandPicker({ filter, onSelect, onClose }: SlashCommandPickerProps) {
  const commands = useCommandStore((s) => s.commands);

  return (
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
  );
}
```

### 8.2 ANSI Key Mapping

```typescript
// apps/web/src/lib/ansi-keys.ts

// KeyboardEvent → ANSI escape sequence. Returns null for non-control keys (let browser handle).
// Normal cursor key mode only (not DECCKM application mode).
export function mapKeyToAnsi(e: KeyboardEvent): string | null {
  const { key, ctrlKey, altKey, shiftKey } = e;

  // Control characters (Ctrl+A..Z)
  if (ctrlKey && !altKey && key.length === 1) {
    const code = key.toUpperCase().charCodeAt(0);
    if (code >= 65 && code <= 90) {
      return String.fromCharCode(code - 64); // A=1, B=2, ..., Z=26
    }
    if (key === " ") return "\x00";          // Ctrl+Space = NUL
  }

  // Alt + key = ESC + key
  if (altKey && !ctrlKey && key.length === 1) {
    return "\x1b" + key;
  }

  // Control keys
  switch (key) {
    case "ArrowUp":    return "\x1b[A";
    case "ArrowDown":  return "\x1b[B";
    case "ArrowRight": return "\x1b[C";
    case "ArrowLeft":  return "\x1b[D";
    case "Home":       return "\x1b[H";
    case "End":        return "\x1b[F";
    case "PageUp":     return "\x1b[5~";
    case "PageDown":   return "\x1b[6~";
    case "Insert":     return "\x1b[2~";
    case "Delete":     return "\x1b[3~";
    case "Tab":        return shiftKey ? "\x1b[Z" : "\t";
    case "Escape":     return "\x1b";
    case "Backspace":  return "\x7f";
    case "Enter":      return "\r";
    case "F1":         return "\x1bOP";
    case "F2":         return "\x1bOQ";
    case "F3":         return "\x1bOR";
    case "F4":         return "\x1bOS";
    case "F5":         return "\x1b[15~";
    case "F6":         return "\x1b[17~";
    case "F7":         return "\x1b[18~";
    case "F8":         return "\x1b[19~";
    case "F9":         return "\x1b[20~";
    case "F10":        return "\x1b[21~";
    case "F11":        return "\x1b[23~";
    case "F12":        return "\x1b[24~";
    default: return null;  // 普通字符不拦截
  }
}
```

### 8.3 Virtualized Message List with Follow-Output

```tsx
// apps/web/src/components/chat/chat-json-view.tsx (excerpt)
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef, useEffect, useState } from "react";
import { useChatStore } from "@/stores/chat-store";

export function ChatJsonView({ sessionId }: { sessionId: string }) {
  const messages = useChatStore((s) => s.messages);
  const parentRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 5,
  });

  // Track scroll position for follow-output logic
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

  // Auto-scroll on new message or streaming content growth
  const lastMsg = messages[messages.length - 1];
  useEffect(() => {
    if (isAtBottom && messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: "end", behavior: "auto" });
    }
  }, [messages.length, lastMsg?.text, isAtBottom]);

  return (
    <div ref={parentRef} className="flex-1 overflow-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
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
            <MessageBubble message={messages[vi.index]} />
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## 9. State of the Art

| Old Approach | Current Approach | Why Changed | Impact |
|--------------|------------------|-------------|--------|
| Feishu `rich-text` + marked inline styles | `react-markdown` + `rehype-highlight` | Web 无小程序 rich-text 限制，可用原生 HTML + CSS | ~60% 代码减少 |
| Feishu 自写 modal | shadcn `Dialog` (Radix) | A11y / focus trap / ESC 关闭免费 | 删除 `apps/feishu/src/components/modal` |
| Taro `useScreenSize` | Tailwind 响应式 class | 浏览器原生 CSS 足够，不用 JS 轮询 viewport | 一致的响应式表现 |
| 2-state toast（自写 zustand） | Sonner | 业界标准，stack/queue/dismiss/action 免费 | 删除 `toast-store.ts` |
| Feishu 消息列表无虚拟化 | `@tanstack/react-virtual` | 1000+ 条消息性能 | 滚动流畅 |

**Deprecated/outdated:**
- `apps/feishu/src/**` — 不再维护，仅作参考（REQUIREMENTS Out of Scope）
- `@tanstack/react-virtual` v2.x — v3 是主分支，已稳定多年

---

## 10. Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | 开发 / build | ✓ | ≥20 LTS | — |
| pnpm | workspace 依赖安装 | ✓ | 9.x | — |
| Vite dev server | `pnpm --filter web dev` | ✓ | 6.3.5 | — |
| Playwright MCP | 视觉验证 | ✓ | — | 手动截图 |
| Relay server | 开发联调 | ✓（localhost:3100） | — | — |
| Proxy (terminal + serve) | 真实 session 数据 | ✓ | — | mock data for pure UI plan |
| Sarasa Fixed SC webfont | xterm CJK 对齐 | ✓（relay `/fonts/`） | — | — |
| iOS 真机 / 模拟器 | visualViewport 验证 | ⚠ **user 需确认是否可用** | — | 桌面 Chrome 有限验证（行为不等同） |

**Missing dependencies with no fallback:**
- iOS 真机测试对 D-34 的 visualViewport / 100dvh 验证是必须的。Planner 把此列入 Plan 10-04/10-01 acceptance。

**Missing dependencies with fallback:**
- 无

---

## 11. Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `vitest@^4.1.2` (单测) + Playwright MCP（视觉 / 交互） |
| Config file | `apps/web/vitest.config.ts` / `playwright.config.ts`（已有） |
| Quick run command | `pnpm --filter web test` |
| Full suite command | `pnpm --filter web test && pnpm --filter web exec playwright test`（需 relay + proxy 在线） |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FRONT-03 | AppShell 响应式 layout 在 md 断点切换 | Playwright (viewport 375 / 1024) | `pnpm --filter web exec playwright test shell.spec.ts` | ❌ Wave 0 |
| FRONT-03 | Sonner Toaster 在路由切换时保持 | unit + Playwright | `pnpm --filter web test toast` | ❌ Wave 0 |
| FRONT-04 | ProxySwitcher `layout=page` / `dropdown` 行为等价 | Playwright 双视口对比 | `playwright test proxy-switcher.spec.ts` | ❌ Wave 0 |
| FRONT-05 | CreateSessionDialog 创建 / 关闭 / 字段验证 | unit (Dialog 状态) + Playwright | `pnpm --filter web test session-list && playwright test session-list.spec.ts` | ❌ Wave 0 |
| FRONT-05 | SessionList 点击即时切换 Chat（不触发页面 transition） | Playwright | `playwright test master-detail.spec.ts` | ❌ Wave 0 |
| FRONT-06 | MessageBubble 渲染 user / assistant / tool 三态 | unit (snapshot) | `pnpm --filter web test message-bubble` | ❌ Wave 0 |
| FRONT-06 | Markdown XSS 防护 `<script>` 被丢弃 | unit | `pnpm --filter web test markdown-view` | ❌ Wave 0 |
| FRONT-06 | ToolApprovalCard y/n/a 快捷键只在 focused 时响应 | Playwright (keyboard) | `playwright test tool-approval.spec.ts` | ❌ Wave 0 |
| FRONT-06 | Virtualized list 1000 条消息滚动性能 | Playwright performance trace | manual trace review | ❌ manual |
| FRONT-06 | Follow-output 用户上滑后冻结 | Playwright | `playwright test follow-output.spec.ts` | ❌ Wave 0 |
| FRONT-06 | InputBar `/` 触发 SlashCommandPicker | Playwright (keyboard + click) | `playwright test input-bar.spec.ts` | ❌ Wave 0 |
| FRONT-06 | InputBar `@` 触发 FilePathPicker + dir_list_request | Playwright (with relay mock) | `playwright test file-picker.spec.ts` | ❌ Wave 0 |
| FRONT-08 | Sonner useToast API 兼容（phase-machine 调用不报错） | unit | `pnpm --filter web test phase-machine` | ✓（已有单测，改 Sonner 后更新） |
| D-21 | PTY raw key → ANSI mapping 查表正确 | unit (pure function) | `pnpm --filter web test ansi-keys` | ❌ Wave 0 |
| D-21 | remote_input_raw proxy 端 handler 正确透传 | unit (apps/proxy) | `pnpm --filter proxy test control-messages` | ✓（已有框架，新增 case） |
| D-21 | 方向键在 PTY session 中导航 Claude 菜单 | **manual** | 用户人工验证 + 截图 | — |
| D-34 | iOS 键盘弹起 InputBar 贴键盘上方 | **manual**（真机） | 用户人工验证 | — |

### Sampling Rate

- **Per task commit:** `pnpm --filter web typecheck && pnpm --filter web test`（< 30s）
- **Per plan completion:** + Playwright MCP 视觉验证 + 用户批准截图（CONTEXT D-39）
- **Per wave merge:** 全套单测 + E2E + 手动 iOS 真机验证（Plan 10-04/10-05 required）

### Wave 0 Gaps

- `apps/web/playwright.config.ts` — 已有（Feishu e2e 时建立过），需要配置 apps/web 入口
- `apps/web/src/components/ui/` shadcn 组件对应的测试骨架 — Plan 10-01 建立
- `apps/web/src/lib/ansi-keys.ts` + 测试 — Plan 10-05 新建
- `apps/proxy/src/__tests__/unit/remote-input-raw.test.ts` — Plan 10-05 新建
- Playwright helper `apps/web/e2e/helpers.ts`（common fixtures，如 mock relay server）— Plan 10-01 ~ 10-03 建立

---

## 12. Security Domain

> `security_enforcement` 未在 config 中显式关闭，按默认启用处理。

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | 否（REQUIREMENTS 明确 "面向个人或信任环境"，无 auth system） | — |
| V3 Session Management | 否 | — |
| V4 Access Control | 否 | — |
| V5 Input Validation | **是** | zod schema（packages/shared）；react-markdown `skipHtml` + `disallowedElements`；PTY raw-key mapping 限制为已知序列 |
| V6 Cryptography | 否（本 phase 不处理密钥） | — |
| V7 Error Handling | 部分 | Sonner error toast 显示 relay 错误；不泄漏内部 stack trace |
| V12 File & Resource | **是**（FilePathPicker） | FilePathPicker 只展示 proxy 通过 `dir_list_response` 返回的列表；不直接读 local file system（浏览器沙箱天然隔离） |

### Known Threat Patterns for React SPA + Markdown rendering

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| XSS via Markdown HTML | Tampering | `skipHtml: true` + `disallowedElements: ["script", "iframe", "object", "embed"]` |
| XSS via URL protocol | Tampering | react-markdown 默认 block `javascript:` URLs；`components.a` 强制 `rel="noopener noreferrer"` |
| CSRF | Tampering | 无 auth，无 CSRF 需要；但若未来加 auth，需 SameSite cookie |
| Clickjacking | Information Disclosure | relay 已设 `X-Frame-Options: DENY`（若未设，Phase 10 不负责） |
| PTY command injection | Tampering | user input 走 pty_input 到 proxy 的 PTY stdin，天然隔离在本地 shell；**威胁模型是用户信任自己的本地 proxy** |
| Storage fingerprinting | Information Disclosure | localStorage key 命名不含敏感数据（仅 proxyId/sessionId） |

---

## 13. Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | 方案 A（仅改 shared + serve + client，不改 IPC 和 terminal）可行 | 2.2 | 若 IPC 层必须区分 raw vs text，则回退到完整跨包方案（成本 +1 任务） |
| A2 | `@tanstack/react-virtual` ResizeObserver 自动处理 streaming 消息高度变化 | 2.3 | 若不工作，需手动 `virtualizer.measureElement(el)` 每 delta |
| A3 | iOS 15.4+ 的 `100dvh` + `visualViewport` 够用，不需要 JS 补丁 | 2.5 | 若 iOS 26 bug 严重到 100dvh 也失效，需降级 `height: ${visualViewport.height}px` |
| A4 | shadcn `CommandDialog` 与自定义 `Dialog` 的 z-index 天然不冲突 | 2.4 / Pitfall 2 | 若冲突，手动 `z-60` override |
| A5 | `phase-machine.ts` 调用 `useToastStore.getState().showToast` 是仅两处（grep 验证） | 2.6 / File Impact | grep 时可能漏其他文件，Plan 10-01 全仓库 grep 验证 |
| A6 | 并排 tab 推迟到 Phase 11 是合理的（D-18 不是核心 value） | 2.12 | 若用户要求本 phase 必做，Plan 10-06 必须先做 chat-store per-session 重构 |
| A7 | PTY 模式 InputBar 用单行 `<input>` 而非多行 textarea | 2.2 末尾 | 若用户要求多行（"贴 shell script 到 PTY"），需要额外 UX 决策 |
| A8 | 本地 echo 不做，沿用 Phase 9 纯被动回显 | 2.8 | 延迟感明显时用户抱怨；Phase 11 再加本地 echo |
| A9 | `command_list_push` 已经在 session sync 时推送（Feishu 靠此），Phase 10 只订阅 command-store 即可 | 2.4 / §1 第 2 点 | grep 结果 `control-messages.test.ts:279` 已确认；若实际没推送，需主动发请求 |

---

## 14. Open Questions (Resolved)

1. **D-21 方案选择**：推荐方案 A（仅 shared + serve + client）vs 完整方案（+ IPC + terminal）。Researcher 推荐 A；**Planner 需 confirm 与用户或直接采用**。
   **Resolution:** 方案 A 锁定，详见 CONTEXT Addendum

2. **PTY 模式 InputBar 是 `<input>` 还是 `<textarea>`**（A7）。影响方向键 UX 含义（在编辑区内 vs 发给 PTY）。
   **Resolution:** textarea（CONTEXT D-26 已锁 1-8 行自撑高 textarea）

3. **并排 tab 是否本 phase 实施**（A6）。推荐推迟到 Phase 11；Planner 和用户对齐。
   **Resolution:** 本 phase 交付 Plan 10-06，详见 CONTEXT Addendum

4. **iOS 真机测试如何接入 GSD workflow**。Plan 10-01 和 10-04 的 acceptance 需要真机验证，用户是否有 iPhone 可测？
   **Resolution:** 归 VALIDATION.md Manual-Only Verifications，用户配合真机截图验证（operational，非 plan scope）

5. **`radix-ui@1.4.3` umbrella 与 shadcn add 产生的 `@radix-ui/react-*` 子包是否冲突**。Plan 10-01 开头跑 `pnpm install && pnpm --filter web typecheck` 后决定是否移除 umbrella。
   **Resolution:** Plan 10-01a 首任务跑 typecheck 后决定，归 executor 现场判断

6. **本地 echo（A8）** — 是否在 PTY 模式下做客户端即时回显来掩盖延迟？Researcher 推荐不做。
   **Resolution:** 不做，沿用 Phase 9 纯被动回显（研究推荐，Phase 11+ 再评估）

7. **Plan 10-01 是否拆成 10-01a（shadcn install + theme override）和 10-01b（AppShell + master-detail + Cmd+K + Toast）**。CONTEXT D-38 已建议可拆，Planner 决定。
   **Resolution:** 拆 10-01a/10-01b，详见 CONTEXT Addendum

8. **DECCKM (Application Cursor Keys mode)** 是否需要在 client 端感知并切换 ANSI 序列。Researcher 建议本 phase 仅发 Normal 模式序列，Phase 11+ 再评估。
   **Resolution:** 本 phase 采用语义功能面板而非物理键位捕获（CONTEXT Addendum D-21 重框），DECCKM 无需处理

9. **`useVirtualizer` scrollToIndex behavior: "auto" vs "smooth"** for follow-output。Researcher 建议 streaming 每 delta 用 "auto"（无动画），用户手动点 BackToBottom 用 "smooth"。
   **Resolution:** Planner 实施细节 — streaming delta 用 'auto'（无动画），用户点 BackToBottom 用 'smooth'。由 Plan 10-04 executor 在 code 中实现，无需 plan level 决策

10. **SlashCommandPicker 和 FilePathPicker 的 popover 定位**：在 InputBar 上方绝对定位 vs 直接用 shadcn Popover anchored。Researcher 建议直接 CSS 绝对定位（popover 用在全局 trigger 更合适；输入联动 picker 自己管理更稳），Planner 实施时再 evaluate。
   **Resolution:** Planner 实施细节 — SlashCommandPicker 和 FilePathPicker 用 CSS 绝对定位（与 InputBar 同 stacking context），不复用 shadcn Popover anchor。由 Plan 10-04 executor 实施

---

## 15. Environment-Specific Notes

### 开发命令映射（与 Feishu 对比）

| 任务 | Feishu（已废弃） | apps/web（本 phase） |
|------|------------------|---------------------|
| 开发启动 | `pnpm --filter feishu run dev:h5` | `pnpm --filter web dev`（Vite 端口 5173，不是 5175） |
| 生产构建 | `pnpm --filter feishu run build:h5` | `pnpm --filter web build` |
| 本地预览 | `pnpm --filter feishu run serve:h5` | `pnpm --filter web preview` |
| E2E 测试 | `pnpm --filter feishu exec playwright test` | `pnpm --filter web exec playwright test` |
| Type check | — | `pnpm --filter web typecheck` |
| 单测 | `pnpm --filter feishu run test` | `pnpm --filter web test` |

**注意 memory `feedback_h5_testing.md` 里 "dev:h5 removed, use build:h5 + serve:h5" 适用于 Feishu，不适用于 apps/web。apps/web 用标准 `vite dev`，无 Taro 编译层。**

### 视觉验证工作流（每 plan 结尾）

1. `pnpm --filter web dev` 启动
2. Playwright MCP 打开 `http://localhost:5173/#/<路由>`
3. 模拟移动端视口（`CDP.Emulation.setDeviceMetricsOverride` 或 Playwright `use: { viewport: { width: 390, height: 844 } }`）
4. 截图
5. 附 UI-SPEC 一致性 checklist 给用户
6. 用户批准后 commit

---

## Sources

### Primary (HIGH confidence)

- **Context7: `/xtermjs/xterm.js`** — attachCustomKeyEventHandler, onKey, onData, parser handlers
- **Context7: `/websites/invisible-island_net_xterm`** — CSI sequences, DECCKM cursor key mode, SS3
- **Context7: `/tanstack/virtual`** — useVirtualizer, measureElement, scrollToIndex, rangeExtractor
- **Context7: `/emilkowalski/sonner`** — toast variants, Tailwind classNames override
- **Context7: `/dip/cmdk`** — Command filter, shouldFilter, CommandItem keywords
- **Context7: `/remarkjs/react-markdown`** — skipHtml, disallowedElements, rehypePlugins, allowElement
- **npm registry (2026-04-17)** — 所有包版本 verification via `npm view <pkg> version`
- **代码读取** — `apps/proxy/src/ipc-protocol.ts`, `serve.ts`, `terminal.ts`, `apps/web/src/**` 完整 Phase 8 实现

### Secondary (MEDIUM confidence)

- [tkte.ch Safari VisualViewport 文章 2019](https://tkte.ch/articles/2019/09/23/safari-13-mobile-keyboards-and-the-visualviewport-api.html)
- [Apple Developer Forum iOS 26 offsetTop bug thread](https://developer.apple.com/forums/thread/800125)
- [Virtuoso Message List scroll-to-bottom tutorial](https://virtuoso.dev/virtuoso-message-list/tutorial/scroll-to-bottom-button/) — 参考 pattern，不采用
- [GitHub: xtermjs/xterm.js issue #757 — Document attachCustomKeyEventHandler](https://github.com/xtermjs/xterm.js/issues/757)
- [XTerm Control Sequences (invisible-island)](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)

### Tertiary (LOW confidence — 未采用)

- Streamdown (Vercel) AI-streaming markdown — 新库，稳定性未知
- react-shiki 替换 rehype-highlight — CONTEXT D-25 已选 rehype-highlight

---

## Metadata

**Confidence breakdown:**
- Standard stack & versions: HIGH — 全部 npm verified 2026-04-17
- D-21 PTY raw 跨包设计: HIGH — 代码已读，3 个改动文件都已定位到精确行号
- 虚拟滚动 pattern: HIGH — Context7 官方示例 + follow-output 是业界通用 pattern
- iOS visualViewport: MEDIUM — 真机行为需验证，iOS 26 有已知 bug
- shadcn Command 双用途: HIGH — cmdk 官方推荐用法
- 并排 tab 架构: LOW — Researcher 推荐推迟，不深入研究

**Research date:** 2026-04-17
**Valid until:** 2026-05-17（30 天，所选栈都是稳定版本；iOS 26 bug 进展可能需要更新）
**Next update triggers:** shadcn/ui v4 发布、TanStack virtual v4、Sonner v3
