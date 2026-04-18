---
phase: 10-pages-components-migration
plan: 08
status: implemented
---

# Phase 10 Wave 8 — Chat panel convergence

## 目标回顾

Phase 10 UI 走查发现 chat panel 底部输入复合区视觉杂乱：右侧竖排 5 按钮 `SemanticActionPanel`、h-24px 文字 `StatusLine`（只显示一种 working 态）、三档图标尺寸混排。Plan 10-08 做纯 UI 收敛，不引入新功能。

## 布局变化

### Before

```
┌── ChatHeader ──────────────────────────────────┐
│ ← ~/workspace/cc_anywhere [JSON]           ⋮ │
│                                                │
│   消息区 / xterm                                │
│                                                │
├── ToolApprovalCard (pending 时) ───────────────┤
├── StatusLine 24px 文字 "Claude 正在响应…" ─────┤
├── QuotePreviewBar (引用时) ────────────────────┤
│ [textarea          ][Send]       [⏹]           │
│                                  [⚙]           │
│                                  [↑]           │
│                                  [↓]           │
│                                  [✖]           │
└────────────────────────────────────────────────┘
                                   ↑ SemanticActionPanel 5 按钮竖栏
```

### After

```
┌── ChatHeader ──────────────────────────────────┐
│ ← ~/workspace/cc_anywhere [JSON]           ⋮ │
├── StatusLine 4px 色带 (5 态) ───────────────────┤
│                                                │
│   消息区 / xterm                                │
│                                                │
├── ToolApprovalCard (pending 时) ───────────────┤
├── QuotePreviewBar (引用时) ────────────────────┤
│ [textarea ..................] […] [↑/⏹]        │
└────────────────────────────────────────────────┘
                                ↑ InputMenu / 主按钮 (Send idle ↔ Stop working)
```

## 组件迁移表

| 原件 / 行为 | 去向 |
|---|---|
| `status-line.tsx` 文字条（h-24px, 1 态）| **重写**为 4px 色带（5 态，sweep+breathe 动画）；位置从 ChatJsonView 底部迁到 ChatHeader 正下方 |
| `semantic-action-panel.tsx` 5 按钮竖栏 | **整块删除** |
| SemanticAction `interrupt` | `SendButton` 的 Stop 变体（working 时替代 Send）|
| SemanticAction `toggle_permission` | ChatHeader overflow 的 Permission mode 子菜单（已有；PTY fanout 新加）|
| SemanticAction `history_prev/next` | JSON: **删除键盘绑定**（消息区可见历史）；PTY: 保留 textarea 空时 ArrowUp/Down |
| SemanticAction `cancel` | 复用既有 Esc 键 + QuotePreviewBar 的 × |
| `ansi-keys.ts` 预烤 ANSI 常量表 | **删除**（`SemanticAction` / `ACTION_MAP` / `sendSemanticAction` / 5 个 ANSI_* 常量）；只保留 `sendRemoteInputRaw`（SendButton Stop 用） |

## 新增组件

| 文件 | 作用 |
|---|---|
| `apps/web/src/components/chat/status-line.tsx` | 4px 色带，props: `state`，5 态颜色 + 动画映射 |
| `apps/web/src/components/chat/status-line.css` | keyframes: `cc-status-sweep` (1.5s linear), `cc-status-breathe` (2s/1.5s ease-in-out) |
| `apps/web/src/components/chat/send-button.tsx` | Send/Stop 双形态；Stop 按 mode 分叉（JSON → `session_worker_abort` control / PTY → `remote_input_raw "\x03"`）|
| `apps/web/src/components/chat/input-menu.tsx` | `…` 菜单壳，桌面 Popover / 移动 BottomSheet；初版占位"更多功能即将加入" |
| `apps/web/src/hooks/use-media-query.ts` | 通用 matchMedia 订阅 hook；InputMenu 响应式用 |

## 协议扩展

**shared (`packages/shared/src/schemas/relay-control.ts`)**

1. 新增 `session_worker_abort` 控制消息：`{ type, sessionId }`
2. 扩展 `permission_mode_change`：`sessionId` 可选字段

**proxy (`apps/proxy/src/serve.ts`)**

1. 新增 `session_worker_abort` handler：
   - JSON mode → `process.kill(pid, "SIGINT")` 让 claude CLI 中止当前 turn
   - PTY mode → 写 `\x03` 到 PTY stdin（避免杀 terminal wrapper 进程）
   - 已 TERMINATED / session not found → 记录并丢弃
2. 扩展 `permission_mode_change` handler：
   - 带 `sessionId` 且 session.mode === "pty"：写 Tab ANSI 到 PTY stdin
   - 其他情况：保持原有 log 行为（向后兼容）

## 状态聚合优先级

`ChatPageInner` 根据 connection / approval / session / working 聚合 `statusState`：

| 优先级 | 条件 | 输出 state | 色带颜色 | 动画 |
|---|---|---|---|---|
| 1 | `!connected \|\| !proxyOnline` | `disconnected` | `--destructive` 红 | breathe 1.5s |
| 2 | `pendingApprovals.some(pending)` | `waiting_approval` | `--color-status-warning` 琥珀 | breathe 2s |
| 3 | `session.state === "terminated"` | `terminated` | `--muted-foreground` 灰 | — |
| 4 | `isWorking` | `working` | `--color-status-working` 蓝 | sweep 1.5s |
| 5 | 默认 | `idle` | `--color-status-success` 绿 | — |

## 设计决策备录

**1. StateDot 刻意不加入 ChatHeader**

StatusLine 4px 色带已经是聚合信号的唯一可视通道。ChatHeader 再加 `StateDot` 小圆点会是冗余（覆盖相同 5 态信息，视觉重量更轻却不增加信息）。StateDot 仅保留在 sidebar `session-row`（多会话一览才需要每行独立指示）。

**2. PTY 原生键盘透传明确不做**

用户对齐：CC Anywhere 核心目标是跨设备监控，PTY / JSON 是两种 view 模式，不追求输入体验完全一致。PTY 特色交互（Tab 切 permission、/ menu、Esc 双击等）改以"快捷功能"方式提供（入口在 ChatHeader overflow 或 InputMenu），不做 xterm keydown 捕获 + 字符流透传。IME、移动软键盘、桌面浏览器快捷键吞键等边界全部规避。

**3. JSON 模式删 ↑↓ 历史，PTY 保留**

JSON 聊天消息区本身结构化显示所有 user_input，"点气泡 Quote/复制"比 `↑` 翻 localStorage 历史更直观；localStorage 是冗余。PTY 的 xterm 输出是渲染文本，结构化复用难，`↑↓` 是唯一便捷的"重发历史"入口，保留 textarea 空时的 keyboard binding。

**4. SendButton Stop 保持 primary amber 色（不 destructive）**

用户对齐：打断当前 turn 是常规操作（不是"终止会话"那种危险操作），视觉上不该警示红，保持 amber 主色。

**5. InputMenu 首版是"壳"**

只放 disabled 占位项"更多功能即将加入"。桌面 Popover / 移动 BottomSheet、a11y、响应式切换、焦点管理全部就位，下一个 plan 只需往 menu 塞项目即可（例如 Resume / Edit previous message / xterm 清屏 / 字号等）。

## 下一步计划范围（后续 plan）

- **Resume / 编辑历史消息**：用户需先选 A（纯文本复用）/ B（会话回滚，需 proxy session-manager 截断）/ C（fork 派生）三种语义之一，然后接入 InputMenu 作为首个功能项
- **PTY xterm 字号 A-/A+**：InputMenu 里加两个按钮，调用 xterm `options.fontSize` setter
- **PTY xterm 清屏**：`term.clear()` 的菜单入口（争议：是否真需要，CLI 本身可 `clear`）
- **`session_worker_abort` worker 侧适配**：目前依赖 SIGINT 让 worker 的 claude CLI stream-json 自然中止；若观察到有 corner case（如 worker 卡在非 CLI 的 I/O），再补 worker stdin 信号路径

## 验证状态

| 检查项 | 结果 |
|---|---|
| `pnpm --filter shared typecheck` | ✓ clean |
| `pnpm --filter web typecheck` | ✓ clean |
| `pnpm --filter web test --run` | ✓ 34 tests passed |
| `pnpm --filter proxy typecheck`（仅本 plan 改动）| ✓ clean（本 plan 新增 serve.ts handler 无类型错误）|
| `rg "SemanticActionPanel\|sendSemanticAction"` in apps/web/src, packages/shared/src | ✓ 0 匹配（仅 chat.tsx 注释说明移除，保留）|
| 桌面 1280×800 手动验证 | ⏳ 待用户本地硬刷验证（Playwright MCP 本轮不可用）|
| 移动 390×844 手动验证 | ⏳ 同上 |

## 遗留事项（非本 plan 引入）

`apps/proxy/src/__tests__/unit/terminal-data-flow.test.ts` 和 `frame-pusher.test.ts` 中存在**此前 session 未提交的 in-progress 工作**（`extractGridAtOffset` 方法尚未实现但测试引用），在 `proxy` 子包全量 typecheck 下会报 TS7006。这批工作不属于 10-08 范围，需要用户决定：
- 提交并补实现 `extractGridAtOffset`
- 或恢复到 HEAD（丢弃这批实验性工作）

## 文件清单

**新增**：
- `apps/web/src/components/chat/status-line.css`
- `apps/web/src/components/chat/send-button.tsx`
- `apps/web/src/components/chat/input-menu.tsx`
- `apps/web/src/hooks/use-media-query.ts`

**重写**：
- `apps/web/src/components/chat/status-line.tsx`（文字条 → 4px 色带）
- `apps/web/src/lib/ansi-keys.ts`（去除 SemanticAction 表，保留 `sendRemoteInputRaw`）
- `apps/web/src/lib/ansi-keys.test.ts`（同步去除 SemanticAction 相关测试）

**修改**：
- `apps/web/src/pages/chat.tsx`（统一布局 + statusState 聚合 + 移除 SemanticActionPanel 引用）
- `apps/web/src/components/chat/chat-json-view.tsx`（移出 StatusLine / QuotePreviewBar / InputBar，只留消息区 + 审批卡）
- `apps/web/src/components/chat/chat-pty-view.tsx`（移除底部 h-7 文字 status）
- `apps/web/src/components/chat/chat-header.tsx`（`changePermission` 传 sessionId）
- `apps/web/src/components/chat/input-bar.tsx`（接入 SendButton + InputMenu，删 JSON ↑↓ 分支）
- `packages/shared/src/schemas/relay-control.ts`（新增 `session_worker_abort`，扩展 `permission_mode_change`）
- `apps/proxy/src/serve.ts`（新增 `session_worker_abort` handler，扩展 `permission_mode_change` handler）

**删除**：
- `apps/web/src/components/chat/semantic-action-panel.tsx`
