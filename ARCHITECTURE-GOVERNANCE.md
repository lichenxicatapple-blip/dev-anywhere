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
| JSON runner        | stream-json owner | provider adapter、permission broker                   | PTY renderer、web store                   | stream-json event parse、turn timeline、Claude JSON fallback   |
| proxy relay client | proxy transport   | shared schema、message queue                          | provider internals、React                 | proxy -> relay 连接、发送 envelope/control/binary              |
| relay server       | transport/binding | shared schema、registry                               | provider business logic、web store        | auth、proxy/client binding、binary routing、last status replay |
| web dispatcher     | message mapping   | shared schema、stores                                 | proxy internals                           | raw relay message -> typed store action                        |
| web stores         | UI state owner    | typed dispatcher actions                              | raw WebSocket parsing、proxy internals    | session/proxy/chat/status/file state                           |
| render components  | display           | stores、UI utilities                                  | relay client raw message、proxy internals | xterm、status line、timeline、controls                         |

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

允许 fallback：

- JSON stream event 可转成 status。
- PTY idle/OSC 只能作为无 hook provider 的降级信号。

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
- 移动端软键盘 fallback
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
- 兼容策略。
- 最小测试。
- 回滚方式。

禁止：

- 新旧路径长期并存且无删除日期。
- 为绕过测试而新增旁路。
- 组件直接接入新 raw message。
- 在 shared 中加入运行时副作用。

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
8. 降级 PTY idle/OSC 为 fallback。
