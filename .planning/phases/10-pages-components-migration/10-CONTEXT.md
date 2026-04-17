# Phase 10: Pages + Components Migration - Context

**Gathered:** 2026-04-17
**Status:** Ready for planning

<domain>
## Phase Boundary

交付 Web 客户端（apps/web）的三页面 + 所有业务组件的完整实现：ProxySelect / SessionList / Chat，接通 Phase 8 的 stores / 路由 / WebSocket 层与 Phase 9 的 xterm.js PTY 链路，最终端到端可用。

**范围覆盖：** FRONT-03（App Shell）、FRONT-04（ProxySelect）、FRONT-05（SessionList）、FRONT-06（Chat JSON 模式）、FRONT-08（通用组件重实现）。FRONT-07（Chat PTY）在 Phase 9 已交付 /pty-test，本 phase 负责集成到 Chat 页 + PTY 远程输入升级。

**范围外：** 客户端断线重连（Phase 11）、PWA / Service Worker / manifest（Phase 12）、Wake Lock / 语音（Phase 13）、Push 通知 / 快捷操作面板（Phase 14）、relay 改造（本 phase 不触 relay）。

**允许跨包改动：** 仅 PTY 原始键位升级（D-21）需动 apps/proxy + packages/shared；其余全部局限在 apps/web。

</domain>

<decisions>
## Implementation Decisions

### Meta — 交付定位

- **D-META-01:** Phase 10 是**重做机会，不是一比一迁移**。Feishu 源码（apps/feishu/src）是参考资料而非规格书。允许重新设计信息架构、组件边界、交互方式、视觉风格，只要 FRONT-03~08 能力覆盖即可。Researcher 和 Planner 不必为"偏离 Feishu 现状"增加摩擦。
- **D-META-02:** **所有业务组件必须在统一设计规范纲领下重新设计**，不允许零散落地、各自拟态。实操流程：
  1. **在进入 /gsd-plan-phase 前必须先跑 /gsd-ui-phase 10，产出 10-UI-SPEC.md**（设计契约），作为下游所有 component 实现的权威依据。
  2. UI-SPEC.md 必须覆盖：视觉 tokens（扩展 Phase 7 + 本 phase D-02/D-03 的覆盖）、排版层级、间距系统、component variants 与状态（default/hover/active/focus/disabled）、交互动效语汇（时长/缓动/发生条件）、icon 规则、空状态/加载/错误态模板、响应式断点内的变体规则。
  3. **不允许某个组件"自己发挥"**：新组件出现之前先回到 UI-SPEC.md 校验 variant 是否存在；缺失则先更新 UI-SPEC.md 再实现，保持设计系统单一真源。
  4. 每个 plan 的视觉验证 checkpoint（D-39）必须包含"与 UI-SPEC 一致性"的人工复核项，不只是"看起来能用"。
  5. shadcn 原子组件（D-32）在 Plan 10-01 安装后，需按 UI-SPEC 做一次集中主题覆盖（theme layer / component className 重映射），之后各业务组件只消费已 override 的原子。

### 视觉基调与主题

- **D-01:** 视觉定位为 **开发者工具感 + 终端美学相容**。JSON 区域的消息气泡、卡片、按钮需要与 Phase 9 xterm.js 终端并置时不违和（同深色背景、接近的圆角、文本优先）。
- **D-02:** **Accent 色从 Phase 7 的 `#00D4AA` 改为琥珀系 `#D4A574`**（覆盖 Phase 7 D-01）。作用范围：按钮 primary、选中状态、进度、强调链接。PTY 终端主题保留 Phase 9 锁定的 `cursorAccent #00D4AA`（不改 xterm 主题，避免牵动 Phase 9 设计决策）。Researcher 需调研 shadcn/ui Tailwind v4 `--primary` token 的覆盖方式。
- **D-03:** shadcn/ui 的默认 radius `0.625rem` 收小到 `0.375rem`，贴近开发者工具质感；具体最终值在 Plan 10-01 视觉校准时确定。
- **D-04:** 深色主题锁定，不实现 light mode toggle。CSS 变量命名按 shadcn dark/light 架构预留，为未来开放浅色主题留余地（Phase 10 仅填深色 token）。
- **D-05:** Monospace 字体优先级：Sarasa Fixed SC（Phase 9 已 serve）→ ui-monospace → SFMono-Regular → Menlo → monospace。JSON 消息正文可保留 sans，代码块和技术标识强制 mono。

### 信息架构

- **D-06:** **移动端（视口 < 768px）保持三页纵深**：ProxySelect → SessionList → Chat。路由沿用 Phase 8 D-04：`/`（ProxySelect）、`/sessions`（SessionList）、`/chat/:id?mode=pty|json`。
- **D-07:** **桌面与平板（视口 ≥ 768px）采用 master-detail 布局**：左侧 SessionList 侧栏（260–300px，宽度不跨断点变化） + 主区 Chat。ProxySelect 在桌面/平板**不是独立页面**，改为侧栏顶部的 dropdown/popover 控件；移动端仍是独立全屏页。
- **D-08:** 侧栏内容采用**紧凑型**布局：顶部 proxy 切换器 + 中部 session 滚动列表 + 底部"+ 新建 session"浮动按钮。全局设置入口与字号控制不塞进侧栏，放到全局 header 或右上角菜单（具体位置 Planner 决定）。
- **D-09:** 空状态内嵌在主布局中（无单独 onboarding 页）。未选 proxy 时侧栏/ProxySelect 页显示"请先连接本地 proxy"+ 安装指引；未选 session 时主区显示占位引导"点左侧或 + 新建 session 开始"。
- **D-10:** ProxySelect 的两种形态（移动端页 vs 桌面侧栏控件）共用同一个业务组件 `ProxySwitcher`，通过 prop 或响应式样式切换布局；底层数据和行为（调用 `relayClient.selectProxy`、更新 app-store、localStorage 持久化）完全一致。
- **D-11:** SessionList 同理：`SessionList` 业务组件同时承载移动端全屏页和桌面侧栏中部区块。

### Chat 页结构

- **D-12:** JSON 和 PTY 两模式**严格二选一**，创建 session 时用户选定并冻结，session 生命周期内不可改。这延续 Feishu 现状，避免数据模型双写。
- **D-13:** Chat 页为单一 `ChatPage` 组件，内部依据 `?mode=` 子路由参数渲染 `<ChatJsonView />` 或 `<ChatPtyView />`。外层 chrome（header、session 标题、返回按钮、桌面折叠/展开侧栏按钮、permission mode 菜单）由 `ChatPage` 统一承载，两模式共用。
- **D-14:** InputBar 在两种模式下都显示并工作；JSON 模式把文本走 JSON 链路送给 Claude，PTY 模式走 `pty_input` 消息写入 PTY stdin。

### 多会话增强（≥768px）

- **D-15:** 侧栏 session 项点击**即时切换主区 Chat，不跳转路由**（路由仍更新以保持可分享/可返回，但不触发页面级 transition）。master-detail 核心体验。
- **D-16:** 侧栏可折叠/展开 toggle（顶部按钮或边缘拖拽），折叠后主区占满宽度（PTY 终端获得更宽视野）。偏好记入 localStorage `cc_sidebarCollapsed`。
- **D-17:** **Cmd+K / Ctrl+K Command Palette**：全局快捷键唤起，基于 shadcn `Command` 组件。MVP 搜索范围：proxies、sessions、常用动作（新建 session / 切换 proxy / 打开设置）。移动端不绑快捷键但保留入口（header 搜索图标）。
- **D-18:** **并排 tab**（平板/桌面独享）：主区支持分列同时显示两个 session（左右各一个 Chat）。PTY 模式下两个终端各自独立 resize。拆分/合并通过主区顶部的"分列"按钮触发；并排状态下无法再分列（MVP 最多两列）。视口 < 1024px 时禁用分列（空间不够）。
- **D-19:** 并排 tab 的实现复杂度可能促使它拆为独立 Plan 10-06；Planner 根据任务规模决定。

### Chat 业务细节

- **D-20:** Chat 消息气泡业务组件**自研**（不用 shadcn Card 强套），使用 Tailwind + 新 token 实现。组件边界（单个 `MessageBubble` 带 role prop vs 拆分 User/Assistant/Tool）由 Planner 决定，不强制沿用 Feishu 的 `user-bubble` / `assistant-bubble` / `chat-bubble-list` 拆分。
- **D-21:** **PTY 远程输入升级**：不仅迁移 Feishu 的"文本 + `\n` 通过 `pty_input` 消息"的基础形态，还要**新增原始键位通道**（方向键 / Ctrl 组合 / Tab / ESC / Enter 等控制字符），让远程 PTY 交互贴近本地终端。实现方式：扩展 `apps/proxy/src/ipc-protocol.ts` 的 `pty_input` schema（或新增 `pty_input_raw` 类型），payload 携带原始字节；proxy 端 `terminal.ts` 的 pty_input 处理直接 write bytes 到 PTY stdin 无需加 `\n`。客户端 InputBar 在 PTY 模式下捕获键盘事件映射为对应的转义序列（可参考 xterm.js 自己的 key mapping 实现）。Researcher 需调研 xterm.js 如何做键位映射（xterm 内置 attachCustomKeyEventHandler / onKey）。
- **D-22:** ToolApproval 交互采用**分级展示**：
  - **紧凑卡**：显示工具名 + 单行参数摘要 + 三按钮（Allow / Always Allow this tool / Deny）
  - **详情展开**：点"详情"展开完整 JSON 参数
  - **会话白名单**：Always Allow 选项把 `{sessionId, toolName}` 写入 localStorage，当前 session 周期内不再弹出（session 结束清理）
  - **快捷键**：`y` = Allow / `n` = Deny / `a` = Always Allow（聚焦态）
- **D-23:** ToolApproval 呈现容器（**覆盖之前的"底部 Sheet 统一"决策**）：
  - JSON 模式：卡片嵌入消息流，按触发顺序插入。
  - PTY 模式：浮层卡（绝对定位于 PTY 终端下方或右下角），不遮挡终端主视野；多审批时纵向堆叠列表（用户逐个处理，或键盘 `a/n` 快速连续响应）。
  - 跨模式共享 `ToolApprovalCard` 业务组件，容器决策由 Chat 子视图控制。
- **D-24:** 消息流使用 `@tanstack/react-virtual` 虚拟滚动，支持动态高度（messages 可能包含高矮不一的 markdown）。默认 follow-output（新消息自动追随到底部），用户往上翻时冻结自动追随，回到底部再恢复。
- **D-25:** Markdown 渲染栈：`react-markdown + remark-gfm + rehype-highlight`。代码高亮主题与深色终端呼应（highlight.js 的 "github-dark" 或自定义）。

### InputBar 能力

- **D-26:** Phase 10 的 InputBar 必须实现：
  - 多行 textarea 自撑高（min 1 行 / max 8 行 / 超出内部滚动）
  - Enter 发送，Shift+Enter 换行
  - 斜杠命令浮层（`/` 触发 shadcn Command 下拉；命令源**动态获取**——对齐 memory 中的 "SlashCommand preset infeasible" 教训，不硬编码列表）
  - 历史命令调回（↑ 键在空输入框时召回上一条已发送；侧栏或菜单里有完整历史）
- **D-27:** 文件/目录选择器 + 引用预览**本期一并实现**（整合 STATE.md 待办项"Phase 10: FileWatcher integration into Chat page file picker"）。@文件路径触发选择器，引用消息则在 InputBar 上方显示 quote preview bar。实现可能显著放大 Plan 10-04 工作量，Planner 可选择拆到独立 Plan 10-04b。
- **D-28:** PTY 模式 InputBar 同时提供"文本 + Enter 发送"和"原始键位"两种输入通路（见 D-21）。UI 上不需要 toggle；Enter 发送走 pty_input（带 `\n`），其他控制键（方向键等）走 pty_input_raw（原始字节）。

### 新建 session Dialog

- **D-29:** 最小字段：`name`（可选，不填则自动生成）、`mode`（JSON|PTY 二选一）、`CWD`（工作目录，使用 FileWatcher 提示或直接输入）。
- **D-30:** `permission mode`（default/auto_accept/plan）和 resume/preset 功能放到 Chat 页的会话设置菜单，不塞进创建 Dialog。保持创建流程最短。

### 通用组件清单

- **D-31:** 砍掉不再需要的 Feishu 组件（功能被其他方案接管）：
  - `typewriter` — xterm.js 的逐字输出替代
  - `safe-area-header` — 改用 CSS `env(safe-area-inset-*)`
  - `terminal-viewport` — 被 xterm.js 完全替代
  - `modal` — 全部换为 shadcn `Dialog`
- **D-32:** shadcn/ui 原子组件在 **Plan 10-01 一次性安装全集**：Dialog / Sheet / Tooltip / Popover / ScrollArea / Textarea / Badge / Avatar / Separator / Select / DropdownMenu / Sonner（Toast 替换 Phase 8 的占位 toast）/ Command（Cmd+K 和斜杠浮层）。Plan 10-01 统一预览 + polish，后续 plan 即取即用，避免风格漂移。

### 响应式与视口

- **D-33:** 断点沿用 Tailwind 默认：`sm 640px / md 768px / lg 1024px / xl 1280px`。master-detail 激活阈值 = `md` (768px)；并排 tab 激活阈值 = `lg` (1024px)。
- **D-34:** 视口高度使用 `100dvh`，安全区使用 `env(safe-area-inset-top/bottom/left/right)`。iOS Safari 键盘弹起用 `visualViewport` API 校正 InputBar 位置；不做 JS-based 100vh 回退。
- **D-35:** `use-screen-size` hook 不迁移；所有响应式走 Tailwind 类名 + CSS 原生。

### A11y 基线

- **D-36:** A11y 要求**每个 plan 自带**，不开专工 plan：
  - 语义 HTML tag（nav / main / section / article / form）
  - ARIA label（给 icon-only 按钮、状态指示器）
  - Tab 顺序合理（含 InputBar、ToolApproval 快捷键聚焦）
  - Focus ring 必须可见，使用 shadcn 默认 `--ring`
  - shadcn/ui + radix 的 A11y 默认不要用 CSS 破坏（不随便去 outline: none）
- **D-37:** code-reviewer agent 在每个 plan 结尾把 A11y 作为 checklist 项之一。

### 切片与交付

- **D-38:** Plan 切片建议（最终由 Planner 确定）：
  - **前置（非本 phase 内的 plan，但必须在 /gsd-plan-phase 10 之前完成）：** `/gsd-ui-phase 10` 产出 `10-UI-SPEC.md`（设计契约），见 D-META-02。
  - **10-01** App Shell + shadcn/ui 原子全集 + **按 UI-SPEC 做主题 override 层**（tokens、radius、字体、component className 映射）+ 响应式 Layout（含 master-detail 骨架 + 空状态占位）+ Cmd+K palette 框架 + Toast 替换为 Sonner
  - **10-02** ProxySelect（移动端页 + 桌面侧栏 `ProxySwitcher` 控件）
  - **10-03** SessionList（移动端页 + 桌面侧栏列表 + 新建 session Dialog）
  - **10-04** Chat JSON 模式（消息流 + 虚拟滚动 + Markdown 渲染 + InputBar 全功能 + ToolApproval 分级卡）
  - **10-05** Chat PTY 模式（xterm 集成 + PTY 原始键位升级跨包改动）
  - **10-06（可选）** 并排 tab（分列主区），如 Planner 评估 10-04/10-05 已过载。
  - **注：** 若 Planner 评估 Plan 10-01 负载过重（shadcn 安装 + 主题 override + master-detail 骨架 + Cmd+K + Toast 替换同时交付），可拆为 10-01a（shadcn + 主题层）+ 10-01b（Layout + Cmd+K + Toast）。
- **D-39:** **每个 plan 完成后强制视觉验证**：Claude 启动 `pnpm --filter web dev`，用 Playwright MCP 打开页面并截图；**截图复核必须附带"与 10-UI-SPEC.md 一致性"检查项**（tokens / variants / 状态 / 间距 / 动效是否匹配规范）；用户在聊天窗口看图批准后再 commit。对应 memory 中的 "UI/UX needs approval" 和 "Test before commit"。
- **D-40:** 起步 Plan 是 10-01（必须先有 Shell 和主题 override 层），首个用户可见页面是 10-02 ProxySelect。
- **D-41:** `/pty-test` 调试页保留（不删），方便以后排查 PTY 链路时跳过完整 Chat 启动路径。

### Claude's Discretion

- CSS 变量命名与具体值（在 Phase 7 token 基础上的细微调整）
- `ProxySwitcher` 控件的交互细节（dropdown / popover / 下拉时的悬停行为）
- Command Palette 的结果排序与模糊匹配算法
- 代码块 copy 按钮、message 时间戳格式、session 列表项的二级菜单项
- Virtual scroll 的 overscan 数量与缓冲区策略
- shadcn 安装后的主题细节校准（在 Plan 10-01 视觉审批中确定）
- 并排 tab 的主区分隔拖拽条细节（鼠标拖拽 vs 按钮切换默认比例）

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### 本 phase 设计契约（最高权威，planner/implementer 必读）
- `.planning/phases/10-pages-components-migration/10-UI-SPEC.md` — **先于 planning 产出**；所有组件实现必须遵守。未产出该文件时不得进入 `/gsd-plan-phase 10`。
- `.planning/phases/10-pages-components-migration/10-CONTEXT.md` — 本文件

### 项目级规格
- `.planning/REQUIREMENTS.md` — FRONT-03/04/05/06/08（本 phase 覆盖的 REQ）和 FRONT-07（Phase 9 已交付的 PTY）
- `.planning/PROJECT.md` — 项目总纲、Core Value、Constraints

### Phase 7 设计基础（已锁定的 token）
- `apps/web/src/app.css` — Tailwind v4 CSS 变量与设计 token 定义（本 phase 会修改 `--primary` 和 radius）
- `apps/web/tailwind.config` 或 CSS `@theme` 块 — 主题配置
- `.planning/phases/07-project-scaffold-design-tokens/07-CONTEXT.md` — 设计 token 原始决策（注意：本 phase D-02 覆盖其 accent 决策）

### Phase 8 业务逻辑基础（完整依赖）
- `.planning/phases/08-business-logic-adaptation/08-CONTEXT.md` — 全部决策；特别关注 D-04（路由）、D-17（toast）、D-19（localStorage keys）、D-22（测试策略）
- `apps/web/src/stores/` — Zustand stores（app / session / chat / command / file / terminal）
- `apps/web/src/services/phase-machine.ts` — 状态机
- `apps/web/src/services/websocket.ts`、`relay-client.ts`、`ensure-binding.ts` — 协议层
- `apps/web/src/lib/router.ts` — react-router v7 hash 路由
- `apps/web/src/hooks/use-relay-setup.ts` — 应用启动钩子
- `apps/web/src/app.tsx` — 当前入口，Phase 10 扩充 Layout 路由

### Phase 9 PTY 链路（需集成）
- `.planning/phases/09-pty-pipeline-full-chain/09-CONTEXT.md` — PTY 相关决策；特别关注 D-09 ~ D-11（xterm）、D-26（字节分发）、D-40 ~ D-44（主题与字体）、D-06（binary 帧格式）
- `apps/web/src/pages/pty-test.tsx` — xterm 完整集成参考实现（保留不删，Chat PTY 模式复用其 xterm 配置）
- `apps/proxy/src/ipc-protocol.ts` — `pty_input` schema（本 phase D-21 将扩展）
- `apps/proxy/src/serve.ts` L577 附近 — pty_input 处理路径
- `apps/proxy/src/terminal.ts` L133 附近 — PTY stdin 写入
- `packages/shared/src/schemas/` — 消息协议类型（本 phase 新增 raw input 字段时需对齐）

### Feishu 源码（仅作参考，不是规格）
> 依 D-META-01，以下仅作为参考文件。不必保留其组件边界、不必复现其视觉。
- `apps/feishu/src/pages/chat/index.tsx`（843 行）— JSON/PTY 双模式整合参考
- `apps/feishu/src/pages/proxy-select/index.tsx`（107 行）
- `apps/feishu/src/pages/session-list/index.tsx`（345 行）
- `apps/feishu/src/components/input-bar/`、`markdown-view/`、`tool-approval-card/`、`chat-bubble-list/`、`slash-command-picker/`、`quote-preview-bar/`、`file-path-picker/`、`directory-picker/`、`session-list-item/`、`proxy-list-item/`、`back-to-bottom/`、`empty-state/`、`status-line/`、`user-bubble/`、`assistant-bubble/`、`tool-call-card/` — 业务组件原始实现

### shadcn/ui 资源
- `apps/web/src/components/ui/button.tsx` — 当前唯一已安装的 shadcn 组件，是风格参考
- 官方文档（Planner / Researcher 在实施时查 context7）：Dialog、Sheet、Command、Popover、Tooltip、ScrollArea、Textarea、Sonner

### 全局约束
- `/Users/admin/workspace/cc_anywhere/CLAUDE.md` — 项目开发规范、命令入口
- `/Users/admin/CLAUDE.md` — 全局代码规范
- Memory 中的相关 feedback：`feedback_ui_approval.md`、`feedback_test_before_commit.md`、`feedback_design_before_code.md`、`feedback_phase10_redesign_not_migrate.md`、`project_slash_command_preset_infeasible.md`、`feedback_h5_testing.md`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets（可直接用或改造）
- **apps/web/src/stores/**：Zustand stores 都在位，Phase 10 只订阅不需要改底层 store 代码。
- **apps/web/src/services/websocket.ts**：统一 WebSocket 管理器（text + binary 分发）已实现，Phase 10 只当消费者。
- **apps/web/src/services/phase-machine.ts**：状态机已能把 phase 驱动路由，本 phase 按 phase 显示对应页面/空状态即可。
- **apps/web/src/components/ui/button.tsx**：shadcn Button 可直接使用，包含 size 变体（xs/sm/default/lg/icon/icon-xs/icon-sm）。
- **apps/web/src/components/toast.tsx**：Phase 8 占位 toast；Plan 10-01 替换为 shadcn Sonner，同时保留 `useToast` API 兼容以减少侵入。
- **apps/web/src/pages/pty-test.tsx**：完整 xterm 配置参考（WebGL renderer、UnicodeGraphemes、字体预加载、主题），Chat PTY 模式复用主体逻辑。
- **apps/web/src/pages/token-showcase.tsx**：设计 token 校验页，可作为 D-02 accent 色替换的验证页。
- **node_modules `@tanstack/react-virtual`** 将新增；所有其他依赖（react-markdown / remark-gfm / rehype-highlight、shadcn 原子）也在 Plan 10-01 一次装齐。

### Established Patterns
- ESM + TypeScript 全项目统一
- Tailwind v4 `@theme` CSS 变量
- shadcn/ui + radix primitives 作为原子
- Zustand 状态管理，非 React state 穿插
- Vite 开发代理 WebSocket 到 relay
- Playwright MCP 作为视觉验证工具

### Integration Points（需要接线的位置）
- `apps/web/src/app.tsx` — 新增顶层 Layout 路由（Outlet 承载子页），响应式 master-detail 骨架从这里开始
- `apps/web/src/lib/router.ts` — 路由配置可能需要扩展（Layout 父路由、并排 tab 子路由若采用 query 参数则不动）
- `apps/web/src/components/toast.tsx` — Plan 10-01 替换为 Sonner wrapper
- `apps/proxy/src/ipc-protocol.ts` — D-21 PTY 原始键位通道（影响跨包 type 同步）
- `packages/shared/src/schemas/` — 若将 raw input 字段放到 shared schema，此处需更新

### 跨包影响
- **D-21 PTY 原始键位**：唯一超出 apps/web 范围的决策，会同时改动 apps/proxy + packages/shared。Planner 需要评估是否拆到 Plan 10-05 内部还是放到独立 plan；也可评估 defer 到 Phase 11。

</code_context>

<specifics>
## Specific Ideas

- **视觉定位的原点**：Claude Code 是琥珀色 CLI 气质的工具（官方 codebase terminal theme）。Phase 10 希望 web 客户端与之呼应，而不是突兀的 Linear/Raycast SaaS 感——但也不是复古 CLI 终端（那是 PTY 区域的工作）。JSON 区域的目标：`如果把 VS Code 的 source control panel 放到手机上，看起来会是什么样`。
- **主视野概念**：移动端用户的主视野是"看 Claude Code 在干什么"（读输出），次视野是"让它做点啥"（InputBar 发送）。平板/桌面的主视野是"同时看多个 session 在干什么"（并排 tab + 侧栏全貌）。UI 的层级要服务这个主视野。
- **避免过度小程序化**：Feishu 版因 Taro 限制做了一些"模拟浏览器"的工作（如 safe-area 计算、自写 modal）——Web 原生直接一行 CSS 就能解决的事，不要保留那套抽象。
- **ToolApproval 分级的动机**：Claude Code 实际工作中有大量"Read file"类低风险工具调用，每次弹 modal 打断阅读节奏很烦。分级 + 会话白名单让安全操作快速通过，高风险操作（Bash / Write）保持需要审阅。
- **PTY 原始键位的动机**：远程 Claude Code 会话如果真的要达到"和本地体验一致"，方向键选菜单、Ctrl+C 终止、Tab 补全都必须工作。否则 PTY 模式只是只读流，失去核心价值。
- **并排 tab 的典型场景**：一边跑 Bash 部署（PTY session A），一边让 Claude 改代码（JSON session B），两个屏同看。平板横屏是最佳落地点。

</specifics>

<deferred>
## Deferred Ideas

### 推迟到其他 phase
- **浅色主题 toggle** — Token 架构预留但 Phase 10 不实现；可在 v2.1 视需求开放
- **多 proxy 同时连接（目前仅单 proxy 切换）** — 未来若出现多机协作场景再考虑
- **session 分组 / 标签 / 收藏** — 超出 Phase 10 范围
- **session 历史回放的 UI 入口** — Phase 11 实现 replay 后再设计 UI
- **Push 通知 / 快捷操作面板** — Phase 14
- **Wake Lock / 语音** — Phase 13
- **Service Worker 离线** — Phase 12
- **session 共享链接 / 协作** — 超出项目 Out of Scope 范畴

### 讨论中出现过但放弃
- "ToolApproval 统一底部 Sheet"（被 D-23 覆盖为分级浮层卡）
- "消息流不做虚拟化，直接 render"（被 D-24 覆盖为 @tanstack/react-virtual）
- "chat-bubble-list 保留重命名"（被 D-20 覆盖为自研 MessageBubble）
- "视觉定位走现代 SaaS 风"（被 D-01/D-02 覆盖为开发者工具 + 琥珀色）
- "移动端 +平板+桌面单一布局 max-width 居中"（被 D-07/D-18 覆盖为 master-detail + 并排 tab）

### Reviewed Todos（STATE.md 里相关的未完成项）
- **folded into Phase 10:** "FileWatcher integration into Chat page file picker" — 整合进 D-27，InputBar 文件选择器实现
- **not folded:** "Web font deployment for Sarasa Fixed SC" — 已在 Phase 9 由 relay `/fonts/` 静态服务解决；Phase 10 无需再处理
- **not folded:** "Scrollback cleanup for resize-triggered duplicate frames" — 归属 Phase 11 PTY Resilience，本 phase 不处理

</deferred>

---

## Addendum (2026-04-17, post-discussion locked decisions)

> 以下决策在 research 完成后 / planning 前产生，**优先级高于前文同主题决策**。

- **D-21 重框（覆盖 D-21 原"键位通道"语义）**：
  - **后端通道**采用方案 A：新增 relay envelope 消息类型 `remote_input_raw`（`{ type, sessionId, data: string }`），只改 `packages/shared/src/schemas/relay-control.ts` + `apps/proxy/src/serve.ts` + client。`apps/proxy/src/ipc-protocol.ts` 与 `apps/proxy/src/terminal.ts` **保持不变**（已核实 terminal.ts L135 是 raw write，`\r` 追加仅在 serve.ts L771 envelope 层）。
  - **客户端 UI** 从"物理键盘捕获 + 全键位 ANSI 映射表"调整为**语义功能面板**（非键位按钮），跨 JSON / PTY 模式统一呈现：
    - 打断输出 — PTY 发 `\x03` / JSON 发 `worker_abort` 控制消息
    - 切换审批模式 — PTY 发 `\t` / JSON 操作 permission-mode chip
    - 历史上一条 — PTY 发 `\x1b[A` / JSON 走 InputBar 本地历史栈
    - 历史下一条 — PTY 发 `\x1b[B` / JSON 同上
    - 取消 — PTY 发 `\x1b` / JSON 关闭浮层或清空 quote
  - **放弃物理键盘捕获**：不实现 research §2.2 完整 ANSI 映射表。`apps/web/src/lib/ansi-keys.ts` 缩减为 5 条预烤 ANSI 常量 + 对应 sender 函数。
  - **UI 位置**：InputBar 旁或 Chat 头部的可折叠面板（延续 Feishu `settings-panel` pattern），具体空间位置由 Planner 在 Plan 10-04 统筹。

- **D-18 重确认：并排 tab 本 phase 交付**：
  - 新增 Plan 10-06（并排 tab + chat-store per-session 重写）。
  - chat-store 当前未接线（仅 `pages/chat.tsx` 只读 selector），本 phase 首次通电直接按 per-session slice map 设计（key = sessionId），避免 Phase 11 再重构已落地消费者。
  - chat-store 新 shape 参考 `apps/web/src/stores/session-store.ts` 的 Map-like pattern（sessions[] + currentSessionId）。
  - 所有 chat-store action 签名带 sessionId 第一参数（例：`appendAssistantText(sessionId, text)`）。
  - SplitPane 布局组件新建于 `apps/web/src/components/shell/split-pane.tsx`，激活阈值 = `lg` (1024px)，MVP 最多两列。
  - URL 结构：`/chat/:id?mode=...&split=<secondSessionId>` 承载双 sessionId。

- **D-38 细化：Plan 切片定稿为 7 个 Plan**：
  - **10-01a** — shadcn 14 原子安装（Dialog / Sheet / Tooltip / Popover / ScrollArea / Textarea / Badge / Avatar / Separator / Select / DropdownMenu / Sonner / Command）+ 主题 override（`--primary` amber `#D4A574`、`--radius` `0.375rem`、Button label `font-weight: 400`）+ `apps/web/playwright.config.ts` 与 `apps/web/e2e/helpers.ts` 配置
  - **10-01b** — AppShell + Sidebar + EmptyState + master-detail 响应式骨架（md 768px 激活）+ CommandPalette (Cmd+K) + Sonner 迁移（toast.tsx 改为 Sonner wrapper 保留 useToast API）+ 顶层 Layout 父路由
  - **10-02** — ProxySwitcher（`layout="page"|"dropdown"`）+ ProxyStatusDot + proxy-select.tsx 重写
  - **10-03** — SessionList（`layout="page"|"sidebar"`）+ SessionRow + CreateSessionDialog + master-detail 点击即时切换主区
  - **10-04** — Chat JSON 模式：ChatPage 调度 / ChatHeader / ChatJsonView / MessageBubble / MarkdownView / ToolApprovalCard / InputBar（含斜杠 / @ / 历史）/ SlashCommandPicker / QuotePreviewBar / FilePathPicker / BackToBottom / StatusLine + **语义功能面板**（D-21 新形态，JSON 模式实现）+ websocket.ts JSON 消息 dispatcher 接线 chat-store
  - **10-05** — Chat PTY 模式：ChatPtyView + `apps/web/src/lib/create-xterm.ts` 抽 pty-test 共享配置 + `apps/web/src/lib/ansi-keys.ts` 5 条 ANSI 常量 + 语义功能面板 PTY 通路 + `remote_input_raw` envelope 端到端（shared schema + serve.ts + proxy 单测）
  - **10-06** — chat-store per-session 重写（Map-like slice map）+ 所有 Chat 消费者改 sessionId-scoped selector + SplitPane 布局组件 + chat.tsx URL 双 sessionId + e2e/split-pane.spec.ts

- **PATTERNS.md 两行标注修订**：PATTERNS.md 第 99–100 行的 `apps/proxy/src/ipc-protocol.ts` 与 `apps/proxy/src/terminal.ts` 标为 "modify, option B only"；本 phase 采用方案 A，这两个文件**不修改**，Planner 请忽略这两条 analog 行并**不要将其列入任何 PLAN.md 的 `files_modified` 清单**。

---

## Addendum (2026-04-18, post-Wave-3 UX adjustments)

> 以下是 Wave 1-3 执行后、视觉验证阶段发现的 UI-SPEC 偏离。**优先级高于前文**；Wave 4+ planner 请以此为准。

- **D-42：CommandPalette / Cmd+K 入口下架**
  - 原 UI-SPEC 将 `命令面板 + Cmd+K` 列为 10-01b must_have
  - 实际用 review 发现：app surface area 小（3 页）、`动作` 分组里只有"新建会话"重复 sidebar 现有 CTA、`会话/Proxy` 分组的搜索价值未兑现
  - 决策：**删除** `components/shell/command-palette.tsx`、AppShell header 搜索按钮、`useKeyboardShortcut` 对 Cmd+K 的注册、`e2e/shell.spec.ts` Cmd+K 测试组
  - **保留**：shadcn `Command` / `CommandDialog` / `CommandInput` 原子（未来 Settings 面板可复用）+ `useKeyboardShortcut` hook 本体
  - 后续再启用触发点：Settings feature 落地时加一个 header 齿轮图标打开 Settings Dialog（**不走 Cmd+K**）

- **D-43：Sidebar 三段改 breadcrumb 型布局**
  - 原结构：ProxySwitcher dropdown 行 + Separator + SessionList + Separator + CreateSessionButton
  - 实际视觉：三段视觉语言一致都像"一行" → 语义层级不清（scope 和 object 长得一样）
  - 新结构：
    - **Proxy chip**：`p-2` 外层，内部按钮带 `border + chevron` 作为"scope selector card"
    - **会话 section**：小字 label `会话 · N`（从 `useSessionStore.sessions.length` 来）+ edge-to-edge session row list
    - **+ 新建会话 card**：`p-2` 外层，outline button 作为常驻次级 CTA
  - 删除内部 `<Separator />`；用 card vs row 视觉对比做分层

- **D-44：Desktop `/` 和 `/sessions` 主区改 EmptyState，消除重复渲染**
  - 原实现：ProxySelectPage → `<ProxySwitcher layout="page" />`、SessionListPage → `<SessionList layout="page" />`（主区在 desktop 重复渲染 sidebar 已经有的列表 + 重复的 "+ 新建会话" 大按钮）
  - 新实现：
    - `pages/proxy-select.tsx`：`<div className="md:hidden">` 渲染 page layout；`<div className="hidden md:block">` 渲染 `<EmptyState variant="no-session" />`
    - `pages/session-list.tsx`：同样的双视图分叉
  - **主区空状态 NOT 自带 CTA** — 用户确认首屏 CTA 由 sidebar 承担即可，主区保持文案 only

- **D-45：Proxy offline 可视禁用**
  - 原实现：offline proxy 可点击，触发 server 反错（"Proxy not online"）
  - 新实现：`disabled={!p.online}` + `disabled:opacity-50 disabled:cursor-not-allowed` + `title` tooltip；在 `page` 和 `dropdown` 两个 layout 都应用
  - Toast 错误文案从 `Proxy not online: {proxyId}` 改为 `选择 {displayName} 失败：{reason}`（用 proxy name 而非内部 id）

- **D-46：Session row truncation chain 修复（不是 UI-SPEC 偏离，是 bug）**
  - Session row 在 sidebar 长名字不截断，原因：`<li>` 未 `w-full`、`<ul>` 未 `w-full min-w-0`、Radix ScrollArea Viewport 内部 table-wrapper 允许内容横向溢出
  - 新实现：
    - `session-row.tsx` `<li>` 加 `w-full min-w-0`
    - `session-list.tsx` `<ul>` 加 `w-full min-w-0`
    - sidebar layout 用 plain `<div className="h-full overflow-y-auto">` 替代 `ScrollArea`（避免 radix 内部 wrapper）；page layout 继续用 ScrollArea（无截断场景）

- **D-47：useKeyboardShortcut API 规范化**
  - 原 API：`{ meta: true, ctrl: true, preventDefault: true }` — 两个 flag 均 `true` 但实现是 OR 关系，语义和实现不一致
  - 新 API：单一 `modifier: boolean`，含义"需任一修饰键（metaKey || ctrlKey）"，跨平台兼容
  - hook 保留（Wave 4+ 还会用），调用方仅 CommandPalette 一处、随其删除

- **D-48：html + body 背景锁定**
  - `<html>` 原默认透明；配合 body `bg-background` 在极端布局（Radix Dialog scrollbar 补偿、resize 节流）可能露出浏览器默认白底
  - 修法：`app.css` 将 `body` 的 `@apply bg-background text-foreground` 扩到 `html, body`
  - 防御性加固，不是必修 bug

- **D-49：Token Showcase 标签改为动态读 CSS var**
  - Phase 07 的 Token Showcase 页用硬编码 hex 字符串做标签（`"#00D4AA / primary"`）；10-01a 改主题为 amber 后标签对不上 swatch 实际颜色
  - 修法：`useCssVarValues` hook 在 useEffect 里取 `getComputedStyle(document.documentElement).getPropertyValue(cssVar)`，动态渲染标签文字
  - 以后再改主题 token，标签自动同步

- **D-50：AppShell header 极简**
  - 原实现含"搜索"按钮 + ⌘K kbd（搭配 Cmd+K）
  - 新实现：只留 `CC Anywhere` 文字标题
  - 右侧留空间给未来 Settings 齿轮 / 帮助图标等

### 未回滚但需注意的事项

- 原 10-01b 的 20 个 Playwright e2e 测试，移除 Cmd+K 组后剩 16 个；全 passing
- UI-SPEC `Copywriting Contract` 的 `命令面板 placeholder` 条目（L236）**作废**
- UI-SPEC `Responsive` 部分（L264-266）的 `ProxySelect becomes sidebar-top dropdown, not a page` **生效**（10-02 原实现是 page in all viewports，现已按 UI-SPEC 修）

---

*Phase: 10-pages-components-migration*
*Context gathered: 2026-04-17*
*Addendum 1: 2026-04-17 (planning-phase locked decisions)*
*Addendum 2: 2026-04-18 (post-Wave-3 UX adjustments)*
