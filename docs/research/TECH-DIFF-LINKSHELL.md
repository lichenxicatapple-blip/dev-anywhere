# 与 LinkShell 的技术差异审计

最后更新：2026-05-06

## 结论

当前项目的产品路线仍然成立：本地 proxy、relay、web/PWA 这一条路可以继续。真正落后的地方不是产品形态，而是技术分层。

LinkShell 相比当前项目最关键的优势，是把终端字节流和 AI CLI 语义事件拆开了：

- PTY 只负责输入、输出、resize、snapshot。
- Hook/status/permission 通道负责工具状态、权限请求、阶段状态和回传结果。
- Relay/gateway 主要透传 envelope，并缓存必要的 last status 给重连客户端。

当前项目把太多语义压在 PTY 输出、OSC 解析、JSON stream、relay control message 和 web store 上，导致状态来源多、审批路径分裂、恢复语义不稳定。第一轮追赶应该先补 provider adapter + hook/status/permission 通道，而不是继续把 PTY 渲染修成万能状态机。

## 当前项目数据流

### PTY 路径

涉及文件：

- `apps/proxy/src/terminal.ts`
- `apps/proxy/src/terminal/pty-manager.ts`
- `apps/proxy/src/terminal/osc-extractor.ts`
- `apps/proxy/src/ipc/ipc-protocol.ts`
- `apps/proxy/src/serve.ts`
- `apps/relay/src/handlers/proxy.ts`
- `apps/web/src/components/chat/chat-pty-view.tsx`

数据流：

1. 本地 CLI 入口创建 PTY session。
2. `terminal.ts` 通过 `PtyManager` 启动 `claude`，把 PTY 输出同时写到本地 stdout、headless xterm、IPC binary frame。
3. `terminal.ts` 用 idle timer 推断 `working -> turn_complete`。
4. `osc-extractor.ts` 从 PTY 输出里尝试识别 approval wait。
5. `serve.ts` 接收 `pty_state_push`、`pty_resize`、`pty_snapshot`，再转成 relay control message。
6. relay 对 `pty_state`、`terminal_resize`、`session_snapshot` 只做白名单透传。
7. web 侧显示 xterm，并用 store/dispatcher 处理这些 control message。

问题：

- PTY 字节流同时承担显示和语义识别，职责过重。
- idle timer 是猜测，不是 AI CLI 明确状态。
- OSC approval wait 只能覆盖部分场景，且和 provider 语义耦合不清。
- PTY 路径没有可靠的 `PermissionRequest -> remote decision -> CLI response` 闭环。
- 远端输入主体验仍是聊天式 batch submit：Web `InputBar` 发送 `user_input`，proxy 对 PTY 写入 `text + "\r"`。这不是终端逐键输入。
- 虽然已有 `remote_input_raw -> pty_input` 低层通道，但 Web 没有把 xterm 聚焦、按键捕获、raw key forwarding 做成 PTY 主路径。

### JSON 路径

涉及文件：

- `apps/proxy/src/worker/json-session.ts`
- `apps/proxy/src/session-worker.ts`
- `apps/proxy/src/serve/worker-registry.ts`
- `apps/proxy/src/serve/permission-broker.ts`
- `apps/proxy/src/serve/json-observer.ts`

数据流：

1. web 发 `session_create`。
2. `RelayRouter` spawn `session-worker`。
3. `JsonSession` 用 `claude --output-format stream-json --input-format stream-json --permission-prompt-tool stdio` 启动 Claude。
4. stdout NDJSON 被解析成 assistant/thinking/tool/result envelope。
5. `control_request` 走 `worker_approval_request -> tool_use_request envelope -> tool_approve/tool_deny -> worker_approval_response`。

优点：

- JSON 路径已经有比较清楚的工具审批闭环。
- stream-json schema 有 runtime canary，能暴露 Claude CLI 协议漂移。
- approval 丢失时会 deny，避免 worker 永久挂起。

问题：

- 该路径基本绑定 Claude stream-json，不是通用 provider adapter。
- Codex 还没有同等级 JSON/ACP/provider 接入。
- JSON 路径和 PTY 路径的状态、审批、恢复模型不一致。
- `worker_approval_request` 和未来 hook `PermissionRequest` 语义相似，但现在没有统一抽象。

### Relay 路径

涉及文件：

- `apps/relay/src/handlers/proxy.ts`
- `apps/relay/src/handlers/client.ts`
- `apps/relay/src/router.ts`
- `apps/relay/src/registry.ts`
- `packages/shared/src/schemas/relay-control.ts`
- `packages/shared/src/schemas/envelope.ts`

数据流：

1. proxy 注册到 relay。
2. client 选择 proxy 并绑定。
3. proxy 发 envelope 时 relay 透传给绑定 client。
4. proxy 发 control message 时 relay 只对白名单类型透传。
5. binary PTY frame 由 relay 读取 sessionId prefix 后原样广播。

问题：

- relay 当前显式无状态，不再暴露假的 replay/gap 水位协议。
- 恢复统一由 proxy 重推 `session_list`、`agent_status`、`pending_approvals_push` 和 PTY snapshot。
- control message 与 envelope 并存，且有 `session_list` 这种同名/近似语义。
- 没有 LinkShell 类似的 last `terminal.status` replay。

## LinkShell 关键技术路径

### Hook Server

参考文件：

- `reference/LinkShell/packages/cli/src/runtime/bridge-session.ts`

关键做法：

- 每个 terminal/session 启动本地 hook server，监听 `127.0.0.1`。
- hook URL 带 marker，server 校验 marker，拒绝不属于当前 PTY 的事件。
- hook body 太大时拒绝，避免本地 DoS。
- 普通 hook 立即响应 `ok`。
- `PermissionRequest` 不立即响应，而是挂起 HTTP response，等待远端 decision。

本项目判断：

- hook server 思路应该吸收。
- 不应该默认照搬全局写配置。
- 即使使用隔离配置目录，仍然需要 marker/session token 做运行时认证和防串线。

### Provider Hook 注入

参考文件：

- `reference/LinkShell/packages/cli/src/runtime/bridge-session.ts`

LinkShell 做法：

- Claude 写入或合并 `~/.claude/settings.json`。
- Codex 写入或合并 `~/.codex/hooks.json`，并修改 `~/.codex/config.toml` 打开 hook feature。
- hook command 用 `curl` 把事件 POST 到本地 hook server。

本项目判断：

- 默认不能修改用户全局 `~/.claude` 或 `~/.codex`。
- 第一优先级是研究进程级/会话级注入：CLI 参数、环境变量、项目局部配置、临时配置目录。
- 会话级注入不能绕开用户自己的配置。Claude 的 `--settings` / `--setting-sources` 方案必须保留用户、项目、本地设置来源，临时 hook settings 只能做追加层；Codex 的 `-c` / `--enable` 方案也只能添加 hook 相关覆盖，不能替换用户已有 config。
- Claude Code 支持项目级 `.claude/settings.json` 和本地项目级 `.claude/settings.local.json`；hook 可以优先写入 `.claude/settings.local.json`，但必须确认用户同意，因为它仍然会修改当前 repo 工作区。
- Codex 支持项目级 `.codex/config.toml`；项目被信任后会加载 project-scoped overrides。hook 可以优先写入 `.codex/config.toml`，但必须确认用户同意，因为它仍然会修改当前 repo 工作区。
- 如果 provider 只能通过全局配置启用 hook，全局写入只能通过显式 setup，必须支持 dry-run、备份、回滚、doctor 检查。

### Status Channel

参考文件：

- `reference/LinkShell/packages/shared-protocol/src/index.ts`
- `reference/LinkShell/packages/cli/src/runtime/bridge-session.ts`

LinkShell 的 `terminal.status` payload 包含：

- `phase`: thinking、tool_use、outputting、waiting、idle、error
- `seq`
- `toolName`
- `toolInput`
- `permissionRequest`
- `summary`
- `topPermission`
- `permissionResolution`

本项目现状：

- `pty_state` 只有 working、turn_complete、approval_wait。
- `session_status` 只有 idle、working、waiting_approval、error、terminated。
- JSON 路径的 assistant/tool/result 是 envelope，PTY 路径主要是 control + binary。

救援方向：

- 增加 provider-neutral `terminal_status` 或 `agent_status` schema。
- 不把它做成 UI store 私有状态，必须进入 shared schema。
- PTY idle/OSC 不作为长期备用路径。Hook/status channel 覆盖同等能力后，应删除主流程依赖；只允许在无 hook provider 的显式降级模式里短期存在，并写明删除条件。
- 协议和状态机的 owner、输入源分级、删除债务已经单独登记在 `docs/governance/PROTOCOL-STATE-GOVERNANCE.md`，后续实现必须以该文档为准。

### Terminal Input Channel

参考文件：

- `reference/LinkShell/packages/shared-protocol/src/index.ts`
- `reference/LinkShell/packages/gateway/src/relay.ts`
- `reference/LinkShell/packages/cli/src/runtime/bridge-session.ts`

LinkShell 做法：

- 协议中有 `terminal.input`。
- Web client 发原始输入数据。
- gateway 校验 controller 后转发给 host。
- host bridge 收到 `terminal.input` 后直接 `pty.write(p.data)`。

本项目现状：

- `InputBar` 是 JSON + PTY 统一输入栏。
- PTY 模式按 Enter 后发送 `user_input` envelope。
- proxy 收到 PTY `user_input` 后写入 `text + "\r"`。
- `remote_input_raw` 已存在，proxy 会转成 `pty_input`，但 Web 侧主要只给 Ctrl+C 等控制键使用，没有成为终端主输入路径。

差距：

- LinkShell 是终端逐键输入模型。
- 当前项目是聊天式批量提交模型。
- 这会导致远端用户无法自然使用 Tab、方向键、Backspace、Ctrl 组合键、Esc、交互式 TUI 和命令行编辑。

救援方向：

- PTY view 中 xterm 必须可聚焦，并成为 PTY 模式的主输入 surface。
- 普通字符、Enter、Backspace、方向键、Tab、Ctrl+C、Esc 等都走 raw input。
- PTY 模式不再渲染聊天式 InputBar；JSON 模式仍保留消息输入栏。
- relay/proxy 需要 controller/接管状态，避免多个远端 client 同时写 PTY。
- 手机端需要单独软键盘策略，因为移动浏览器对 Tab、Ctrl、方向键捕获不可靠。

### Permission Decision

参考文件：

- `reference/LinkShell/packages/cli/src/runtime/bridge-session.ts`
- `reference/LinkShell/packages/gateway/src/agent-permission-http.ts`
- `reference/LinkShell/packages/gateway/src/relay.ts`

LinkShell 做法：

- hook `PermissionRequest` 生成 `requestId`。
- pending permission 存在 map 中，直到用户决策或会话/provider 结束。
- 远端 decision 通过 `permission.decision` 回到 host。
- host resolve pending HTTP response 后，再发 `permission.decision.result` / status snapshot。
- Stop、PostToolUse、terminal drain 会清理 pending。

本项目现状：

- JSON 路径的 pending approval 已接入 `PermissionBroker`，但 worker IPC 仍保留 `worker_approval_request/response` transport。
- PTY 路径没有同等能力。
- approval 恢复靠 `pending_approvals_push` 补齐当前 pending；`permission_request_delivered` / `permission_decision_result` 已补上 request delivered 和 decision result 语义。

救援方向：

- provider-neutral `PermissionBroker` 已承接 JSON `control_request` 和 hook `PermissionRequest` 的 pending/resolve/cleanup。
- 权限类 provider hook 使用极长 command timeout lease，避免 provider 默认短超时破坏“等待用户审批”的原生体验。
- approval response 已开始区分：
  - relay/client 收到了
  - proxy 收到了
  - provider CLI 是否实际收到并继续
- drain/exit 必须产生明确状态；审批不能因为时间流逝自动拒绝。

### Relay Status Replay

参考文件：

- `reference/LinkShell/packages/gateway/src/relay.ts`
- `reference/LinkShell/packages/gateway/src/sessions.ts`

LinkShell 做法：

- gateway 对 `terminal.status` 做 last status cache。
- client resume 时 replay terminal output buffer，同时 replay 每个 terminal 的 last status。

本项目现状：

- relay 明确无状态。
- PTY snapshot 由 client `session_subscribe` 触发 proxy serialize。
- status 没有 relay last cache。

救援方向：

- relay 可以继续无长历史，但应缓存每 session/terminal 的 last status。
- 这不是完整 replay，不需要引入 Redis。
- 新 client 绑定或 subscribe 时应立刻拿到最近 status，避免 UI 显示过期状态。

## 差异分级

### 必须追赶

1. Provider adapter 边界。
2. Hook/status/permission 独立通道。
3. Permission broker。
4. Status schema 进入 shared。
5. Relay last status replay。
6. 不修改全局配置的 hook 注入策略。
7. PTY 远端逐键输入模型。

### 可以清理或重写

1. PTY idle timer 应从主状态路径移除，不再扩大；如暂存于无 hook provider 降级模式，必须有删除条件。
2. OSC approval 识别应从主审批路径移除，不再作为主审批机制；Hook permission broker 落地后删除旧识别路径。
3. `session_list` 同时存在 control/envelope 语义，应重命名或统一。
4. `serve.ts` 中 IPC、relay、session lifecycle 过度集中，应在 hook/status 通道落地时拆分。
5. `ToolApprovalCard` 的本地 whitelist 如果与 server-side whitelist 不一致，应删除或改成真实 server-side 行为。
6. 没有主流程入口的 dead web state、debug routes、file watcher 应继续清理。
7. 渲染层要做集中治理，不能继续在 chat view、xterm view、store、dispatcher 之间补丁式修 bug。

### 待删除旧路径

| 旧路径                                  | 删除条件                                                                |
| --------------------------------------- | ----------------------------------------------------------------------- |
| JSON `worker_approval_request/response` | hook `PermissionRequest` 接入统一 permission broker 和 relay 决策后删除 |
| PTY idle timer 主状态路径               | hook/status channel 覆盖 PTY Claude 主流程后删除                        |
| OSC approval wait 主审批信号            | hook `PermissionRequest` 覆盖 PTY Claude 审批后删除                     |

8. 架构边界要做集中治理，不能继续让 provider、proxy service、relay protocol、web store 互相穿透。

### 不建议照搬

1. 默认写用户全局 `~/.claude` / `~/.codex`。
2. 移动端、screen share、live activity、premium gateway 等重功能。
3. 把远程终端产品的主入口模型照搬到透明代理产品。

## 第一轮追赶计划

### Step 1：Provider Adapter Contract

新增设计目标：

- `providerId`: claude / codex / mock
- `spawnCommand(args, cwd, env)`
- `supportsPty`
- `supportsStreamJson`
- `supportsHooks`
- `createHookInjectionPlan(sessionContext)`
- `normalizeHookEvent(rawEvent)`
- `formatPermissionDecision(decision)`

第一轮先做 `mock` provider，用于测试 hook/status/permission 闭环。

### Step 2：Hook Server MVP

实现目标：

- daemon 内启动一个只监听 `127.0.0.1` 的 hook server。
- endpoint: `/hook?sessionId=...&terminalId=...&marker=...`
- 校验 sessionId、terminalId、marker、session state。
- 支持 mock hook event。
- 暂不写 Claude/Codex 全局配置；真实 provider 注入优先走项目局部配置或临时配置目录。

### Step 3：Status Schema

新增 shared schema：

- `terminal_status` 或 `agent_status`
- phase: idle / thinking / tool_use / waiting_permission / outputting / error
- provider
- terminalId
- seq
- toolName / toolInput / summary
- topPermission
- permissionResolution

### Step 4：Permission Broker

实现目标：

- requestId -> pending permission。
- 支持 allow / deny / drain；审批无限等待，不做时间自动拒绝。
- 支持 delivered/result 状态。
- JSON control request 和 hook permission request 都可接入。

### Step 5：Relay Last Status Cache

实现目标：

- relay registry 缓存每 proxy/session/terminal 的最后一条 status。
- client bind、register restored、session_subscribe 时 replay last status。
- 不做完整历史 replay。

### Step 6：Rendering Layer Governance

治理目标：

- 明确 web 渲染层只消费三类输入：PTY bytes/snapshot、agent status、chat/tool timeline。
- `chat-pty-view` 只处理 xterm 生命周期、binary frame、snapshot、resize、输入回传。
- `status-line` 只消费 provider-neutral status，不再从 PTY idle 或 chat message 里反推状态。
- `chat-json-view` 只处理 timeline，不再承担 session lifecycle 和 approval routing。
- dispatcher 负责协议消息到 store action 的映射，组件不直接解析 relay raw message。
- store 字段必须能追溯到一个协议消息或 UI 交互；无入口字段直接删除。

第一轮不追求 UI 大改版，先把渲染职责边界写清楚，再按边界清理重叠逻辑。

### Step 7：Architecture Governance

治理目标：

- 明确模块所有权：provider adapter、hook server、permission broker、session lifecycle、relay transport、web dispatcher、render store 各自独立。
- `packages/shared` 只能放跨进程协议 schema、builders、常量；不能放 UI 或 Node-only runtime 逻辑。
- `apps/proxy/src/serve.ts` 只能保留启动装配；路由、hook server、permission broker、session lifecycle 要拆到独立模块。
- relay 只能理解 transport、binding、auth、last-status replay；不能理解 provider 业务语义。
- web 只能通过 shared schema 消费消息；组件不直接依赖 proxy 内部字段。
- 每个新增协议消息必须说明方向、owner、是否可 replay、是否可丢、是否需要 ack。
- 每次重写必须有迁移边界：保留兼容、删除旧路径、补测试，不能新旧路径长期并存。

第一轮架构治理产物：

- `docs/governance/ARCHITECTURE-GOVERNANCE.md`
- 模块边界表
- 协议消息分类表
- 清理/重写准入规则
- 禁止新增补丁式跨层依赖的 review checklist

## 第一轮验证

- Unit: hook URL marker 校验。
- Unit: normalize mock hook event -> status payload。
- Unit: PermissionBroker allow / deny / indefinite wait / drain。
- Relay integration: last status replay to newly bound client。
- Proxy integration: mock provider hook event -> relay -> client。
- Web smoke: status line 能显示 hook status，不依赖 PTY idle 推断。
- Web smoke: PTY 渲染、status line、timeline 各自更新，不互相覆盖状态。
- Architecture check: 新增代码符合模块边界，协议消息有 owner/replay/drop/ack 分类。

## 风险

- Claude/Codex 是否支持非全局 hook 注入需要继续验证。
- 隔离配置目录可能影响登录态、MCP、插件、历史记录。
- 如果 provider 只能全局启用 hooks，需要把 setup UX 做得非常谨慎。
- 过早改真实 Claude/Codex hook 可能污染用户环境；第一轮必须用 mock provider 或临时目录验证。
