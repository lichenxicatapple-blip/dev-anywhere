# Phase 6: Feishu Mini Program - Core Interaction - Context

**Gathered:** 2026-04-07
**Status:** Ready for planning

<domain>
## Phase Boundary

飞书小程序的核心交互界面：发送消息、实时看 Claude Code 流式输出、管理会话列表、查看历史消息。同时支持 PTY 会话和 JSON 会话。PTY 会话采用服务端渲染方案，proxy 侧用 @xterm/headless 提取终端文本网格，发送到小程序渲染。JSON 会话解析 StreamJsonEvent 结构化事件渲染为聊天气泡。不包含工具调用审批交互（Phase 7）、markdown/代码高亮渲染（Phase 8）、语音输入（Phase 9）。

</domain>

<decisions>
## Implementation Decisions

### 页面结构与导航
- **D-01:** 双页结构——会话列表页（首页）和聊天页（push 进入）。无 TabBar。
- **D-02:** 冷启动时自动进入上次活跃的会话（sessionId 持久化到 tt.setStorageSync）。无活跃会话时显示列表。后台切回不受影响（Taro onShow 恢复页面状态）。
- **D-03:** 会话标题使用自动摘要——取第一条用户消息前 20 字。无消息的新会话显示"新会话"。

### 会话管理交互
- **D-04:** 会话列表每项显示：摘要标题 + 状态标记（idle/working/waiting/error 用彩色圆点）+ 最后活动时间（相对时间）。
- **D-05:** 创建新会话：导航栏右侧"+"按钮，点击直接创建 JSON 会话并跳转聊天页。
- **D-06:** 终止会话：列表项左滑显示红色"终止"按钮。PTY 会话不显示终止按钮（Phase 5 D-22: PTY 只能从电脑终止）。JSON 会话可从手机终止。
- **D-07:** 会话列表同时显示 PTY 和 JSON 会话，通过标记区分类型。

### PTY 会话——服务端渲染方案（核心功能）
- **D-08:** PTY 会话采用 JSON 结构化文本网格方案。Proxy 侧用 @xterm/headless 的 buffer API（`getLine(i).getCell(j)`）提取终端画布为 `[{text, fg, bg, bold}]` span 行数组，作为新消息类型发送到 relay 再转发到小程序。
- **D-09:** 小程序端用 `<Text selectable>` 组件 + 等宽字体渲染 span 数组。保留颜色，支持长按精确选中文本片段复制。
- **D-10:** 终端视图使用 ScrollView 组件实现双向滚动（scrollX + scrollY），内容自然撑开。
- **D-11:** 字号可调：提供 A-/A+ 按钮切换字号档位（8/10/12/14/16/20px），同时支持双指捏合切换档位。
- **D-12:** 终端视图占满屏幕剩余高度（flex: 1），底部预留输入栏空间。横竖屏自适应。
- **D-13:** PTY 会话可从手机发送文本消息（写入 stdin），但不能终止会话。

### JSON 会话——聊天气泡方案
- **D-14:** 左右气泡布局：用户消息右侧气泡，Claude 回复左侧气泡。经典 IM 风格。
- **D-15:** Phase 6 先做纯文本渲染。代码块、markdown、语法高亮等结构化渲染留给 Phase 8。
- **D-16:** 工具调用（tool_use_request / tool_result）显示为可折叠卡片：标题行显示工具名 + 参数摘要，点击展开/收起完整参数和输出。默认收起。
- **D-17:** 流式文本实时追加到当前气泡。收到 assistant delta 就追加到气泡末尾，气泡自然增长。收到 result 事件后标记完成。

### 流式输出与滚动
- **D-18:** 自动滚底 + 用户上滑暂停。新内容到达时自动滚动到底部。用户向上滑动查看历史时暂停自动滚动，出现"回到底部"按钮。点击按钮或发送新消息后恢复自动滚动。

### JSON 会话数据流修正
- **D-19:** 当前 serve.ts 把 StreamJsonEvent 直接 JSON.stringify 塞进 assistant_message.text——小程序需要解析这个 JSON 字符串还原为 StreamJsonEvent，按事件类型分别渲染（assistant delta → 追加文本、tool_use → 工具卡片、result → 完成标记）。Phase 6 在小程序侧做解析适配，不改 proxy 侧的打包方式。

### 会话创建与目录选择
- **D-20:** 从手机创建 JSON 会话时支持指定工作目录（cwd）。小程序展示 proxy 机器上的目录列表供选择，支持路径补全。
- **D-21:** 新增 relay 控制消息：`dir_list_request(proxyId, path)` → proxy 列出指定目录内容；`dir_list_response(entries[])` → 返回目录/文件列表。复用此协议同时支持 @file 路径补全。
- **D-22:** SessionCreatePayload 扩展 `cwd` 字段。proxy 收到后以指定目录启动 claude 进程。

### Proxy 识别与多机器支持
- **D-23:** proxy_register 消息扩展 `name` 字段（默认取 hostname，用户可自定义），RelayControlSchema 相应更新。
- **D-24:** 三级导航：proxy 选择页 → 会话列表页 → 聊天页。Proxy 选择页始终显示（不自动跳过，用户有多台电脑的场景）。proxy_list_response 返回 `proxyId + name`。

### 工具调用审批（纳入 Phase 6）
- **D-25:** 工具审批交互纳入 Phase 6。Claude Code 的 `--permission-prompt-tool stdio` 协议层只有 allow/deny，但小程序 UI 提供三个选项：
  - **允许（本次）**：发送 `tool_approve`，仅本次生效
  - **允许同类工具（本会话）**：发送 `tool_approve` + proxy 侧维护 session 级工具白名单，后续同名工具自动批准
  - **拒绝**：发送 `tool_deny`
- **D-26:** 工具审批卡片显示：工具名称、参数预览（JSON 格式化截断）、三个操作按钮。参考 cc-connect 的 `summarizeInput` 做参数摘要。
- **D-27:** Proxy 侧 session 级工具白名单：用户选择"允许同类工具"后，proxy 在当前 session 的 approvalStrategy 中缓存该 toolName，后续同名工具自动 allow，不再转发到小程序。会话结束白名单清除。

### 命令和文件补全
- **D-28:** 斜杠命令补全：输入 `/` 触发命令列表下拉。命令列表（/compact, /status, /model 等）客户端写死。带选项的命令（如 /model）展示子选项供选择。
- **D-29:** @file 路径补全：输入 `@` 触发文件浏览器，复用 D-21 的 `dir_list_request/response` 协议。支持逐级目录浏览和搜索。
- **D-30:** 参考 cc-connect 的实现（`reference/cc-connect/`），特别是 `agent/claudecode/` 的权限处理和 `core/interfaces.go` 的会话接口设计。

### cc-connect 关键借鉴（必须实现）
- **D-31:** JSON 会话启动时必须加 `--fork-session`，防止干扰用户电脑上正在使用的本地 Claude Code 终端会话。
- **D-32:** 权限响应走独立路径，不被"会话忙"状态阻塞。relay 收到 permission_response 消息后立即转发到 proxy，不排队。
- **D-33:** 消息不能 mid-turn inject——会话忙时新消息排队，等当前 turn 的 result 事件到了再发下一条。proxy 侧实现消息队列。
- **D-34:** 启动 claude 子进程前过滤 `CLAUDECODE` 环境变量，防止检测到嵌套会话后改变行为。

### 会话恢复（Resume）
- **D-35:** JSON 会话启动后，捕获 Claude Code `system` 事件中的内部 session ID，持久化映射（我们的 sessionId → Claude session ID）。
- **D-36:** 仅 JSON 会话支持自动恢复。当 JSON 会话进程死亡（worker 崩溃、proxy 重启、电脑重启）后，用户在小程序点击该会话时，自动用 `--resume <claude-session-id> --fork-session` 恢复对话上下文。PTY 会话进程死亡后标记为"已结束"，用户可通过 D-37 的历史会话浏览以 JSON 模式恢复对话。Resume 失败时展示提示（如"会话已过期"），引导用户新建。
- **D-37:** 支持浏览和恢复电脑上任意 Claude Code 历史会话（不限于 cc-anywhere 创建的）。Proxy 扫描 `~/.claude/projects/` 下的会话文件，参考 cc-connect 的 `scanSessionMeta` + `findProjectDir`。新增 relay 控制消息 `session_history_request/response`，小程序在会话列表页展示"历史会话"区域，选择后用 `--resume <id> --fork-session` 恢复。

### PTY 语义信号提取
- **D-38:** 从 PTY 原始字节流提取 OSC 序列（实验验证，1142 个事件中提取 51 条 OSC 0 + 8 条 OSC 9）。Claude Code 使用三种 OSC 信号：
  - **OSC 0**（终端标题）：spinner 字符（`⠂`/`⠐`=working，`✳`=idle）+ 任务描述文本
  - **OSC 9**（通知）：`"Claude is waiting for your input"` = 任务完成等待输入；`"Claude needs your permission to use {tool}"` = 等待工具审批（带工具名）
  - OSC 8（超链接）：文件路径链接，暂不需要
- **D-39:** 基于 OSC 9 通知信号判断终态类型，不依赖屏幕内容检测（纯协议层，无 UI 耦合）：
  - OSC 9 包含 `"waiting for your input"` → **TURN_COMPLETE**
  - OSC 9 包含 `"needs your permission"` → **APPROVAL_WAIT**（可提取工具名）
  - 仅 OSC 0 idle 无 OSC 9 → **MID_PAUSE**（不通知）
  Phase 6 做信号提取和状态分类，通知推送和语音播报由后续 phase 消费。

### Claude's Discretion
- PTY 终端帧的推送频率和节流策略
- PTY 终端帧的增量更新机制（全量 vs 只发变化行）
- JSON 会话气泡的具体视觉样式（圆角、间距、配色）
- "回到底部"按钮的出现/消失条件和位置
- 会话列表的空状态展示
- 聊天页和终端页的切换动画
- 斜杠命令的完整列表和子选项
- 目录浏览器的 UI 交互细节

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Protocol & Message Schemas
- `packages/shared/src/schemas/envelope.ts` — 16 种 MessageEnvelope 消息类型，小程序需要解析的核心
- `packages/shared/src/schemas/chat.ts` — UserInputPayload, AssistantMessagePayload, ThinkingPayload
- `packages/shared/src/schemas/tool.ts` — ToolUseRequestPayload, ToolResultPayload
- `packages/shared/src/schemas/session.ts` — SessionCreatePayload, SessionListPayload, SessionStatusPayload, PtySnapshotPayload
- `packages/shared/src/schemas/relay-control.ts` — client_register, proxy_list, proxy_select 等控制协议

### PTY 终端渲染（服务端）
- `apps/proxy/src/terminal-tracker.ts` — @xterm/headless + serialize addon，需要扩展为提取文本网格
- `apps/proxy/src/event-store.ts` — 二进制事件存储格式，PTY 事件的 payload 结构
- `apps/proxy/src/session-worker.ts` — JSON 会话 worker，理解 StreamJsonEvent 的打包方式（line 50-61）

### Relay Server
- `apps/relay/src/server.ts` — Relay 主体，需要路由新的终端帧消息类型
- `apps/relay/src/handlers/client.ts` — Client 连接处理，client_register 协议
- `apps/relay/src/buffer-compressor.ts` — 缓冲区压缩策略，理解 PTY snapshot 和 JSON result 的压缩触发

### Feishu Mini Program（当前状态）
- `apps/feishu/src/pages/spike-render/index.tsx` — Spike 验证结果：JSON Grid + ScrollView + 字号调节方案已验证可行
- `apps/feishu/src/app.config.ts` — 页面注册配置
- `apps/feishu/config/index.ts` — Taro 构建配置

### Phase 4/5 上下文（前序决定）
- `.planning/phases/04-relay-server-core-transport/04-CONTEXT.md` — 消息路由、proxy 注册、seq 分配
- `.planning/phases/05-relay-server-resilience/05-CONTEXT.md` — client_register 协议、断线重连、缓冲区策略、冷启动 storage 缓存

### cc-connect 参考实现
- `reference/cc-connect/agent/claudecode/session.go` — Claude Code 会话管理、权限处理、handleControlRequest 实现
- `reference/cc-connect/agent/claudecode/claudecode.go` — permission mode（default/acceptEdits/auto/bypassPermissions）设计
- `reference/cc-connect/core/interfaces.go` — PermissionResult 结构、AgentSession 接口设计
- `reference/cc-connect/core/engine.go` — 消息路由和权限流转

### Proxy 侧（需要扩展）
- `apps/proxy/src/json-session.ts` — ApprovalStrategy 接口，当前默认 deny-all，需要改为转发到 relay → 小程序
- `apps/proxy/src/serve.ts` — 当前 auto-deny 工具请求（line 190-196），需要改为转发到 relay 等待远程审批

### 项目约束
- `.planning/REQUIREMENTS.md` — FEISHU-01（流式输出）、FEISHU-03（会话管理）、FEISHU-04（历史消息）、FEISHU-02（工具审批，原 Phase 7 现纳入 Phase 6）
- `CLAUDE.md` — 技术栈约束：Taro + React、NutUI React Taro 组件库

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Spike 验证代码** (`apps/feishu/src/pages/spike-render/`) — JSON Grid 渲染、ScrollView 双向滚动、字号切换、双指缩放手势处理，已在真机验证通过
- **MessageEnvelopeSchema** (packages/shared) — 消息校验直接使用
- **RelayControlSchema** (packages/shared) — client_register, proxy_list 等控制消息
- **TerminalTracker** (apps/proxy) — @xterm/headless 已集成，需扩展 buffer 文本提取

### Established Patterns
- ESM + TypeScript 全项目统一
- Taro 3.6 + React 18 + @tarojs/plugin-platform-lark
- pino 结构化 JSON 日志
- zod schema 校验 + discriminatedUnion 消息类型
- ScrollView 组件支持飞书小程序双向滚动（spike 验证）
- MovableView scale 不支持飞书小程序（spike 排除）
- RichText 不支持精确文本选中复制（spike 排除）

### Integration Points
- `apps/proxy/src/terminal-tracker.ts` — 需要新增 buffer 文本网格提取方法
- `apps/proxy/src/serve.ts` — 需要定时将终端帧发送到 relay
- `packages/shared/src/schemas/` — 需要新增终端帧消息类型（terminal_frame）
- `apps/relay/src/router.ts` — 需要路由终端帧消息
- `apps/feishu/src/app.config.ts` — 注册新页面（session-list, chat）
- `apps/feishu/src/pages/` — 新建会话列表页和聊天页

</code_context>

<specifics>
## Specific Ideas

- PTY 远程查看是用户开发 CC Anywhere 的核心诉求——在手机上实时看到电脑终端画面，偶尔发个消息。这决定了 PTY 渲染必须是 Phase 6 的一等公民，不是附属功能。
- 终端视图的交互模型应该接近原生终端体验：内容超出屏幕就滚动查看，不搞花哨的自由缩放。字号可调解决"字太小"的问题。
- JSON 会话和 PTY 会话在聊天页是两套不同的渲染模式：JSON 走聊天气泡，PTY 走终端文本网格。根据会话 mode 字段切换。
- spike 验证了 ScrollView scrollX+scrollY 在飞书真机可用、Text selectable 可精确复制、200 行渲染性能可接受。

</specifics>

<deferred>
## Deferred Ideas

- **PTY 实时输出转发到 relay** — 当前 proxy 只在 WORKING→IDLE 时发送 pty_snapshot。Phase 6 需要增加实时终端帧推送。这属于 Phase 6 的实现范围，但具体频率和节流策略由 planner 决定。
- **认证流程（配对码 + 长期 token）** — Phase 6 之前或 Phase 6 内实现
- **小程序消息缓存快照清理策略** — 已记录为 todo，Phase 8 实现
- **PTY 会话的 xterm.js WebView 渲染** — spike 排除了此方案，但如果 JSON Grid 性能不足可作为后备
- **markdown / 代码块 / 语法高亮渲染** — Phase 8 (FEISHU-05, UX-01)
- **工具审批交互** — Phase 7 (FEISHU-02)
- **会话命名和状态标记增强** — Phase 10 (UX-04)

### Reviewed Todos (not folded)
- "小程序消息缓存采用快照清理策略" — relevance score 0.3，属于 Phase 8 的渲染优化范围，不是 Phase 6 核心交互

</deferred>

---

*Phase: 06-feishu-mini-program-core-interaction*
*Context gathered: 2026-04-07*
