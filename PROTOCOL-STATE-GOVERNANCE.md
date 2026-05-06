# 协议与状态机治理

最后更新：2026-05-06

## 目标

这份文档专门约束 Dev Anywhere 的协议层和状态机层。它的目标不是重述产品，而是把后续追赶 LinkShell 的技术路径写成可执行规则：

- 哪类消息属于哪个 owner。
- 哪些消息可以改变 session lifecycle。
- 哪些状态是主路径，哪些只是迁移期旧路径。
- 哪些旧路径必须删除，而不是长期 fallback。

项目尚未上线，不做旧协议或旧磁盘数据兼容。新契约可以直接收紧；旧路径只在当前代码切换过程中短期存在，并必须写清删除条件。

## 和 LinkShell 的真实差距

LinkShell 的优势不是 UI 好看，而是语义和字节流分离得更彻底：

- PTY 只处理输入、输出、resize、snapshot。
- hook/status 负责 agent phase、tool lifecycle、permission request、permission resolution。
- gateway/relay 主要做 transport binding 和必要的 last status replay。
- web 不从 terminal bytes 猜 agent 状态。

Dev Anywhere 当前已经补上了 Claude/Codex provider hook path，但协议和状态还没完全收敛：

- `session_status`、`pty_state`、hook event、JSON observer 都能影响 UI 看到的状态。
- PTY idle timer / OSC 仍然能写主状态。
- JSON `worker_approval_request` 和 hook permission broker 语义相似但路径不同。
- relay 有 replay 协议外壳，但没有 last status replay 的真实语义。
- web dispatcher 会把 `pty_state` 映射进 `session.state`，这会让 UI 继续依赖 PTY 猜测。

## 状态模型

### Session Identity

Owner：`apps/proxy/src/serve/session-manager.ts`

字段：

- `sessionId`
- `mode`: `pty | json`
- `provider`: `claude | codex`
- `cwd`
- `pid`
- `name`
- provider 自身 session id，例如 `claudeSessionId`

规则：

- `provider` 是必填 identity，不做缺省迁移。
- `mode` 和 `provider` 创建后不应被 UI 或 relay 改写。
- relay 可以知道 `sessionId/mode/provider/state`，但不能根据 provider 做业务分支。

### Session Lifecycle

Owner：`SessionManager.updateState()`

状态：

- `idle`
- `working`
- `waiting_approval`
- `error`
- `terminated`

长期允许输入源：

- provider hook/status router
- permission broker
- JSON observer
- worker lifecycle
- terminal attach/detach
- explicit terminate

禁止输入源：

- web component
- web store 自行猜测
- relay connection state
- terminal bytes
- chat timeline event

迁移期输入源：

- PTY idle timer
- OSC approval/working signal

删除条件：

- hook/status 覆盖 PTY Claude/Codex 主流程后，PTY idle/OSC 不再写入 `SessionState`。

### Agent Status

Owner：待新增 `agent-status` / hook status router

目标字段：

- `sessionId`
- `provider`
- `phase`: `idle | thinking | tool_use | outputting | waiting_permission | error`
- `toolName`
- `toolInput`
- `permissionRequest`
- `permissionResolution`
- `summary`
- `seq`
- `updatedAt`

规则：

- agent status 是 UI 状态栏、工具提示、审批摘要的主来源。
- `session_status` 不承载 tool detail。
- `pty_state` 不再作为 agent status 主来源。
- relay 只缓存 last agent status，不理解字段业务含义。

### Permission State

Owner：permission broker

字段：

- `requestId`
- `sessionId`
- `provider`
- `toolName`
- `input`
- `createdAt`
- `timeout`
- `delivered`
- `resolution`

规则：

- `allow/deny` 必须最终回到 provider 或 worker，不允许 UI 点击后本地假定成功。
- pending 清理必须覆盖 allow、deny、timeout、session terminate、worker disconnect。
- JSON `worker_approval_request` 后续要合并到统一 permission 语义；未合并前不得继续扩展旧 manager。

## 协议分层

### MessageEnvelope

Owner：`packages/shared/src/schemas/envelope.ts`

用途：

- chat timeline
- tool request/result
- session lifecycle broadcast
- auth/sync 基础消息

约束：

- envelope 可以进入 chat/session store。
- envelope 不承载 PTY bytes。
- envelope 不承载 terminal snapshot。
- `session_status` 只表达 lifecycle，不表达 provider tool phase。

### RelayControl

Owner：`packages/shared/src/schemas/relay-control.ts`

用途：

- proxy/client 注册和选择
- session create/list/control request
- PTY control：resize、snapshot、raw input
- pending approvals push
- command/file resource push

约束：

- control message 不能伪装成 envelope。
- control message 必须有明确方向。
- relay 只能基于 type 做 transport routing，不能理解 Claude/Codex 业务。
- `session_sync` 只给 relay 建立 proxy-session binding，不是 UI session list。

### Terminal IPC

Owner：terminal runtime + serve

用途：

- terminal runtime 注册 PTY session
- PTY binary frames
- PTY input
- PTY resize
- snapshot
- bridge status

约束：

- PTY bytes/snapshot/resize/input 归 PTY runner。
- terminal IPC 里的 `pty_state_push` 是迁移期旧路径，不应扩展。
- provider hook context 由 serve 创建并通过 IPC 返回 terminal runtime。

### Worker IPC

Owner：JSON runner + WorkerRegistry

用途：

- stream-json event
- JSON input
- worker lifecycle
- JSON control_request approval

约束：

- worker IPC 是 JSON runner 私有控制面。
- `worker_approval_request/response` 是待合并旧路径。
- worker event 可以生成 timeline，也可以通过 JSON observer 更新 lifecycle，但不能直接写 web store。

### Provider Hook HTTP

Owner：hook server + hook event router + permission broker

用途：

- provider semantic events
- tool lifecycle
- blocking permission request

约束：

- 必须校验 `sessionId + marker + token`。
- hook event 要先归一化再进入状态/权限逻辑。
- 非 permission event 应快速响应。
- permission event 挂起响应，等待 remote decision 后返回 provider。

## 现有消息治理表

| 消息/通道                         | 方向                         | Owner              | 可改变 session state      | 状态              |
| --------------------------------- | ---------------------------- | ------------------ | ------------------------- | ----------------- |
| `session_list` envelope           | proxy -> relay -> web        | session lifecycle  | 否                        | 保留              |
| `session_status` envelope         | proxy -> relay -> web        | session lifecycle  | 否，已是结果              | 保留              |
| `session_sync` control            | proxy -> relay               | session lifecycle  | 否                        | 保留              |
| `pty_state` control               | proxy -> relay -> web        | PTY runner         | 迁移期 web 会映射         | 待降级            |
| `pty_state_push` IPC              | terminal -> serve            | PTY runner         | 迁移期 proxy 会映射       | 待删除主线        |
| PTY binary frame                  | terminal -> serve -> relay   | PTY runner         | 否                        | 保留              |
| `session_snapshot` control        | proxy -> relay -> web        | PTY runner         | 否                        | 保留              |
| `remote_input_raw` control        | web -> relay -> proxy -> PTY | PTY runner         | 否                        | 升级为 PTY 主输入 |
| `user_input` envelope, JSON       | web -> relay -> proxy        | JSON runner        | 是，经 JsonObserver       | 保留              |
| `user_input` envelope, PTY        | web -> relay -> proxy        | 历史 batch input   | 否                        | 降级为辅助入口    |
| `worker_event` IPC                | worker -> serve              | JSON runner        | 是，经 JsonObserver       | 保留              |
| `worker_approval_request` IPC     | worker -> serve              | JSON runner        | 是，经 JsonObserver       | 待合并            |
| `tool_use_request` envelope       | proxy -> relay -> web        | permission broker  | 否，已是结果              | 保留              |
| `tool_approve/tool_deny` envelope | web -> relay -> proxy        | permission broker  | 是，resolved 后回 working | 保留              |
| provider hook HTTP                | provider -> serve            | hook/status router | 是                        | 主路径            |
| `turn_result` control             | proxy -> relay -> web        | JSON runner        | 否，已是结果              | 保留              |

## 第一阶段实施顺序

1. 新增 shared `agent_status` contract。
2. HookEventRouter 在处理 `SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop` 时发送 `agent_status`。
3. relay 支持 last `agent_status` replay 给新绑定 client。
4. web 增加 agent status dispatcher/store，`StatusLine` 改为读取 agent status + lifecycle。
5. 移除 web `pty_state -> session.state` 映射。
6. proxy 降级 `PtyObserver`：保留调试/无 hook provider 显式模式，不再作为主状态输入。
7. JSON approval 合并到 permission broker 语义，删除 `ToolApprovalManager` 或把它变成 broker adapter。

## 测试要求

每个阶段都必须补对应测试：

- shared schema contract：新增/收紧消息必须测。
- SessionManager FSM：非法转换和 pending 清理必须测。
- HookEventRouter：hook event -> lifecycle/status/permission 必须测。
- Relay：last status replay 必须测。
- Web dispatcher：raw message 只能进 dispatcher/store，组件不解析 transport。
- PTY 输入：逐键输入、Ctrl+C、Enter、Backspace、Tab、resize、snapshot 必须有高价值覆盖。

## 删除债务

| 路径                                        | 删除条件                                         |
| ------------------------------------------- | ------------------------------------------------ |
| PTY idle timer 写 `SessionState`            | `agent_status` 覆盖 PTY Claude/Codex 主流程      |
| OSC approval wait 写 `SessionState`         | hook `PreToolUse/PermissionRequest` 覆盖真实审批 |
| web `pty_state -> session.state`            | web status line 接入 agent status                |
| `worker_approval_request/response` 独立路径 | JSON approval 合并到 permission broker           |
| `user_input` 作为 PTY 主输入                | xterm raw input 成为 PTY 主输入                  |
