# 架构治理准则

最后更新：2026-05-06

## 目的

这份文档定义项目救援期的架构边界。它不是风格建议，而是后续清理、重写和新增功能的准入规则。

项目当前的问题不是缺少代码，而是边界持续漂移：PTY、JSON session、relay control、web store、审批 UI 和 session lifecycle 多处重复表达同一件事。后续开发必须先判断新代码归属，再实现。

## 核心原则

1. 一个能力只能有一个 owner。
2. 一个状态只能有一个主来源。
3. 协议消息必须有方向、owner、恢复语义和测试。
4. 新路径落地时必须写明旧路径如何删除或降级。
5. UI 组件不能直接理解 transport raw message。
6. relay 不能理解 provider 业务语义。
7. provider adapter 不能直接操作 web store 或 relay registry。
8. shared 只能放跨进程契约，不能放 runtime 业务实现。

## 模块边界

| 模块               | Owner             | 可以依赖                                              | 禁止依赖                                  | 职责                                                           |
| ------------------ | ----------------- | ----------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| `packages/shared`  | 协议契约          | zod、常量、纯 builder                                 | Node runtime、React、proxy/web 私有类型   | schema、message builders、跨进程常量                           |
| provider adapter   | 本地 AI CLI 适配  | shared schema、hook context、spawn utilities          | relay registry、web store、React 组件     | provider 启动、参数透传、hook 注入计划、hook event 归一化      |
| hook server        | 本地语义入口      | provider adapter、permission broker、session registry | web、relay client internals               | 接收 provider hook event、校验 marker、发 status/permission    |
| permission broker  | 权限状态 owner    | shared schema、session registry                       | UI 组件、provider 私有 transport          | pending permission、allow/deny/timeout/drain/delivered         |
| session lifecycle  | 会话状态 owner    | shared schema、provider adapter、PTY/JSON runner      | React、relay registry                     | session create/register/terminate/reconnect 状态               |
| PTY runner         | 字节流 owner      | node-pty、IPC、headless xterm                         | permission UI、provider semantic state    | stdin/stdout/resize/binary frame/snapshot                      |
| JSON runner        | stream-json owner | provider adapter、permission broker                   | PTY renderer、web store                   | stream-json event parse、turn timeline、provider json runner   |
| proxy relay client | proxy transport   | shared schema、message queue                          | provider internals、React                 | proxy -> relay 连接、发送 envelope/control/binary              |
| relay server       | transport/binding | shared schema、registry                               | provider business logic、web store        | auth、proxy/client binding、binary routing、last status replay |
| web dispatcher     | message mapping   | shared schema、stores                                 | proxy internals                           | raw relay message -> typed store action                        |
| web stores         | UI state owner    | typed dispatcher actions                              | raw WebSocket parsing、proxy internals    | session/proxy/chat/status/file state                           |
| render components  | display           | stores、UI utilities                                  | relay client raw message、proxy internals | xterm、status line、timeline、controls                         |

## Local Runtime 控制面

本地控制面以 `dev-anywhere serve` 为中心：

- `serve` 内嵌 hook server，监听 `127.0.0.1:<固定配置端口>`。
- hook server 不是独立全局服务，不自动随机端口，不监听公网地址。
- 端口冲突时 `serve` fail-fast，并提示用户检查已有进程或配置。
- session 隔离靠 `sessionId + marker + token`，不靠端口隔离。

本地有三条不同通道：

| 通道               | 方向                           | 用途                                                  |
| ------------------ | ------------------------------ | ----------------------------------------------------- |
| terminal IPC       | terminal runtime <-> serve     | PTY 注册、PTY bytes、resize、snapshot、远端输入       |
| worker IPC         | session-worker <-> serve       | JSON event、JSON input、worker 生命周期、待删除旧审批 |
| provider hook HTTP | Claude/Codex provider -> serve | provider 语义事件、tool lifecycle、阻塞式权限请求     |

hook HTTP 不替代 terminal IPC 或 worker IPC。它只承接 provider 主动回调的语义事件；PTY 字节流、远端逐键输入、terminal snapshot 仍归 terminal runtime。

## 协议消息分类

每个新增消息必须归入下表之一。

| 类别                | 方向                                      | Owner             | 可 replay            | 可丢                   | 需要 ack             | 例子                    |
| ------------------- | ----------------------------------------- | ----------------- | -------------------- | ---------------------- | -------------------- | ----------------------- |
| binary PTY          | proxy -> relay -> client                  | PTY runner        | 否，靠 snapshot 恢复 | 可丢，但会影响实时显示 | 否                   | PTY bytes               |
| snapshot            | proxy -> relay -> client                  | PTY runner        | 是，按需最新         | 不应丢                 | 否                   | `session_snapshot`      |
| agent status        | provider/hook -> proxy -> relay -> client | hook server       | 是，last status      | 可被新状态覆盖         | 否                   | `terminal_status`       |
| permission request  | provider -> proxy -> relay -> client      | permission broker | 是，pending 列表     | 不可丢                 | 是，业务 ack/result  | `permission_request`    |
| permission decision | client -> relay -> proxy -> provider      | permission broker | 否                   | 不可丢                 | 是，delivered/result | `permission_decision`   |
| terminal input      | client -> relay -> proxy -> PTY           | PTY runner        | 否                   | 不应无声丢             | 视控制权策略         | `remote_input_raw`      |
| timeline event      | provider/json -> proxy -> relay -> client | provider adapter  | 可选，按 seq         | 不应无声丢             | 视队列策略           | assistant/tool/result   |
| session lifecycle   | proxy <-> relay <-> client                | session lifecycle | 是，当前态           | 不应丢                 | 视命令               | create/status/terminate |
| transport control   | proxy/client <-> relay                    | relay server      | 否                   | 不应丢                 | 是                   | register/select/error   |
| diagnostics         | any -> UI/log                             | owner 模块        | 否                   | 可丢                   | 否                   | warning/debug status    |

## 协议与状态机治理计划

### 当前差距

和 LinkShell 对比后，当前项目最需要正视的不是某个 UI 细节，而是协议层和状态机层还没有完全成为“系统事实来源”：

- `MessageEnvelope`、`RelayControl`、terminal IPC、worker IPC 四套消息都存在，但并非每个消息都有明确的 owner、恢复语义和状态影响。
- `SessionState` 已经集中到 `SessionManager`，但输入源仍然分散：hook event、JSON observer、PTY observer、terminal attach、worker exit 都能触发状态变化。
- web 侧 `session.state` 已不再接收 `pty_state` 映射；下一步要继续删除 proxy 侧 PTY observer 对主状态的写入。
- PTY 模式还保留 idle timer / OSC 语义猜测；它们能补洞，但不能成为长期主线。
- JSON 模式的 stream-json 审批和 PTY/hook 审批还没有合并到统一 permission/status 模型。

### 目标形态

后续实现必须向这个目标收敛：

| 层级                  | 权威 owner         | 状态职责                                                                 |
| --------------------- | ------------------ | ------------------------------------------------------------------------ |
| session identity      | SessionManager     | `sessionId/mode/provider/cwd/pid/name`，创建后由生命周期 owner 维护      |
| session lifecycle     | SessionManager     | `idle/working/waiting_approval/error/terminated` 的唯一写入入口          |
| agent semantic status | hook/status router | provider-neutral phase、tool、permission summary、last status replay     |
| permission state      | permission broker  | pending、delivered、decision、timeout、drain                             |
| PTY render state      | PTY runner + xterm | bytes、snapshot、resize、scrollback、raw input                           |
| JSON timeline         | JSON runner        | assistant/thinking/tool/result timeline，不直接拥有 session lifecycle    |
| relay transport       | relay server       | binding、routing、binary frame、last status replay，不理解 provider 业务 |
| web display           | dispatcher + store | 消费 typed state，不解析 provider raw event，不猜 terminal 文本          |

### 状态输入分级

`SessionManager.updateState()` 是唯一会话状态写入口，但输入事件必须分级：

| 输入源                   | 长期地位 | 允许更新 session state | 说明                                                               |
| ------------------------ | -------- | ---------------------- | ------------------------------------------------------------------ |
| provider hook/status     | 主路径   | 是                     | PTY provider 的语义主来源，覆盖 Claude/Codex                       |
| permission broker        | 主路径   | 是                     | pending/resolved 驱动 waiting/working                              |
| JSON observer            | 主路径   | 是                     | JSON runner 在没有统一 hook 前仍是 JSON 模式主路径                 |
| worker lifecycle         | 主路径   | 是                     | worker dead / channel broken 可进入 error 或 terminate             |
| terminal attach/detach   | 主路径   | 是                     | PTY runtime 生命周期，不代表 agent phase                           |
| PTY bytes                | 禁止     | 否                     | 只用于渲染和 snapshot，不用于判断 AI CLI phase                     |
| PTY idle timer           | 待删除   | 暂时允许               | 只作为无 hook 覆盖前的迁移路径，不能扩展                           |
| OSC approval/working     | 待删除   | 暂时允许               | 只作为历史路径，hook `PreToolUse/PermissionRequest` 生效后删除主线 |
| web store / UI component | 禁止     | 否                     | UI 只能展示或发起用户命令，不能自造权威状态                        |
| relay connection state   | 禁止     | 否                     | relay 掉线影响连接提示，不直接改变 session lifecycle               |

### 协议收敛顺序

1. **写清现状契约**：把当前 Envelope、Control、IPC、worker IPC 的 owner 和状态影响列成表，作为改代码前的基线。
2. **新增 agent status contract**：shared 中定义 provider-neutral status，不再让 `pty_state` 同时承担渲染和 agent phase。
3. **统一 permission contract**：hook `PermissionRequest/PreToolUse` 和 JSON `control_request` 都进入同一 broker 语义；旧 worker approval 只保留到统一路径落地。
4. **降级 `pty_state`**：`pty_state` 保留给短期 UI 提示或调试，不再写入 `session.state` 主路径。web 侧已完成。
5. **relay last status replay**：relay 只缓存 last agent status / session lifecycle，不缓存 provider 私有 payload。
6. **web dispatcher 分流**：session lifecycle、agent status、PTY render、chat timeline 分别进入不同 store/action。
7. **删除旧猜测路径**：删除 PTY idle/OSC 对主状态的写入，保留必要日志用于诊断。

### 第一轮可执行切片

当前已完成：

- provider metadata 已成为 session identity 必填字段。
- Claude/Codex PTY provider hook path 已接入。
- hook permission allow/deny 已能真实驱动 provider。

下一轮按顺序执行：

1. 产出 `PROTOCOL-STATE-GOVERNANCE.md`，列出现有消息、owner、方向、状态影响、删除债务。
2. 新增 shared `agent_status` schema 和 proxy/web contract tests。
3. 让 hook event router 发送 agent status；`session_status` 只表达 lifecycle。
4. web 增加 agent status store/dispatcher，status line 改读 agent status + lifecycle 聚合。已完成。
5. 删除 web `pty_state -> session.state` 主路径映射。已完成。
6. 删除或降级 proxy `PtyObserver` 的主流程状态写入。

## 状态来源规则

### Session State

主来源：session lifecycle。

允许输入：

- provider runner started/exited
- PTY registered/deregistered
- permission broker waiting/resolved
- explicit terminate

禁止输入：

- UI 组件猜测
- relay 连接状态直接改 session state
- PTY idle timer 直接成为最终状态

### Agent Status

主来源：hook/status channel。

允许降级输入：

- JSON stream event 可转成 status。
- PTY idle/OSC 只能作为无 hook provider 的显式降级信号，且必须在同一计划里写删除条件。

禁止输入：

- status line 从 terminal text 反推。
- chat timeline 事件直接覆盖 provider status。

### Permission State

主来源：permission broker。

必须记录：

- requestId
- sessionId
- terminalId/provider
- createdAt
- timeout
- delivered
- resolution source

禁止输入：

- Web localStorage 独立维护真实 whitelist。
- UI 点击后直接假定 provider 已收到。

## Provider Adapter Contract

每个 provider 必须实现或显式声明不支持：

- `providerId`
- `displayName`
- `spawnPty(context)`
- `spawnJson(context)`
- `createHookInjectionPlan(context)`
- `normalizeHookEvent(raw)`
- `formatPermissionDecision(decision)`
- `supportsHooks`
- `supportsSessionScopedConfig`
- `supportsProjectScopedConfig`
- `supportsGlobalSetup`

Provider adapter 不允许：

- 直接发送 relay message。
- 直接修改 web store。
- 静默写用户全局配置。
- 未经 setup 修改项目局部配置。

## Hook 注入策略

优先级：

1. 会话级 CLI 参数或临时 settings/config。
2. 项目局部配置，必须显式确认。
3. 隔离配置目录，必须验证用户原配置仍被加载。
4. 全局配置，必须显式 setup、dry-run、备份、回滚。

硬约束：

- 不能绕过用户已有设置。
- 不能默认写 `~/.claude` 或 `~/.codex`。
- 不能默认写当前 repo 的 `.claude` 或 `.codex`。
- marker/session token 必须存在，即使使用隔离配置目录。

## Relay 边界

relay 只能理解：

- auth
- proxy/client binding
- transport routing
- binary frame routing
- last status replay
- health/diagnostics

relay 不允许理解：

- Claude/Codex provider 差异
- tool 参数业务语义
- permission allow/deny 策略
- prompt/timeline 展示逻辑

## Web 渲染边界

### `chat-pty-view`

只负责：

- xterm lifecycle
- binary frame
- snapshot
- resize
- raw input

不负责：

- agent phase 推断
- permission state owner
- session lifecycle owner
- 聊天式 batch input 的状态 owner

### `status-line`

只负责：

- 展示 `agent status`
- 展示 permission summary
- 展示 connection hint

不负责：

- 从 chat message 推断状态
- 从 terminal bytes 推断状态
- 修改 session state

### `chat-json-view`

只负责：

- user/assistant/tool timeline
- markdown rendering
- tool result display

不负责：

- PTY rendering
- provider status owner
- relay raw message parsing

### `input-bar`

JSON 模式负责：

- 多行消息编辑
- slash command / file token picker
- 历史草稿
- `user_input` envelope

PTY 模式只允许作为辅助入口：

- 批量粘贴/提交文本
- 移动端软键盘辅助入口
- 显式提示它不是主终端输入 surface

PTY 模式不允许：

- 作为唯一输入方式。
- 拦截 xterm 的主键盘输入。
- 把 Enter 提交伪装成真实终端逐键交互。

## 重写准入规则

允许重写的条件：

- 当前路径跨越两个以上 owner。
- 当前路径无法测试关键失败模式。
- 当前路径依赖猜测状态且已有更可靠来源。
- 当前路径阻碍 provider 中立。
- 当前路径存在真实安全/配置污染风险。

重写必须同时提供：

- 新 owner。
- 旧路径删除或降级计划。
- 破坏性边界和删除范围。
- 最小测试。
- 回滚方式。

禁止：

- 新旧路径长期并存且无删除日期。
- 为绕过测试而新增旁路。
- 组件直接接入新 raw message。
- 在 shared 中加入运行时副作用。

## 测试治理

项目救援期的测试分层：

| 层级              | 覆盖内容                                     | 必须验证                                      |
| ----------------- | -------------------------------------------- | --------------------------------------------- |
| module unit       | provider adapter、hook registry、broker、FSM | owner 边界、错误输入、timeout、清理路径       |
| protocol contract | shared schema、IPC、relay envelope           | 方向、字段、兼容性、未知字段策略              |
| integration       | serve + worker/terminal IPC + relay router   | 创建会话、输入、审批、断线、恢复、状态 replay |
| render contract   | web dispatcher、store、xterm view、timeline  | raw message 不进组件、状态不重叠、输入不丢    |
| smoke/e2e         | 本地 serve + relay + web 的最小上线路径      | 用户可连接、可输入、可审批、可恢复            |

测试规则：

- 每个新 owner 模块必须先有 module unit 测试。
- 每个新增协议消息必须有 schema/contract 测试。
- 每次删除旧路径必须补一个失败模式测试，证明主流程不再依赖旧路径。
- PTY 渲染、远端逐键输入、permission broker、hook 注入属于高风险路径，不能只靠手测。
- 大重写前先补 characterization tests，锁住当前可接受行为；重写后删除过时测试，而不是让旧行为继续约束新架构。

## 删除债务登记

这些路径只允许作为迁移期间的待删除旧路径，不能被继续扩展：

| 旧路径                                       | 当前用途                            | 删除条件                                                                |
| -------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `worker_approval_request/response` JSON 审批 | stream-json `control_request` 审批  | hook `PermissionRequest` 接入统一 permission broker 和 relay 决策后删除 |
| PTY idle timer 状态推断                      | PTY 无 hook provider 的短期降级信号 | hook/status channel 覆盖 PTY Claude 主流程后从主状态路径移除            |
| OSC approval wait 识别                       | PTY 审批等待的旧语义猜测            | hook `PermissionRequest` 对 PTY Claude 生效后删除审批主流程依赖         |

## Review Checklist

每次代码改动前检查：

- 新代码属于哪个 owner？
- 是否新增协议消息？方向、owner、replay/drop/ack 是否写清？
- 是否绕过用户已有 Claude/Codex 配置？
- 是否修改全局或项目配置？是否显式确认、备份、回滚？
- 是否让 relay 理解了 provider 业务？
- 是否让 UI 组件解析了 raw transport message？
- 是否新增第二个状态来源？
- 是否留下旧路径不删？
- 是否有最小测试覆盖失败模式？

## 第一轮治理落点

1. 新增 provider adapter contract。
2. 新增 hook server MVP。
3. 新增 permission broker。
4. 新增 agent status schema。
5. relay 增加 last status replay。
6. web dispatcher 接管 status message。
7. 渲染层按 PTY/status/timeline 分流。
8. 将 PTY idle/OSC 从主流程移除；如短期保留无 hook provider 降级模式，必须绑定删除条件。
