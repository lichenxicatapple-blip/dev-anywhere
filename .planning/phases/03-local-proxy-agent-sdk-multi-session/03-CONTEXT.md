# Phase 3: Proxy Service & Multi-Session - Context

**Gathered:** 2026-04-04
**Status:** Ready for planning
**Note:** 基于用户需求和 cc-connect 参考研究，对原 Phase 3 架构进行了重大重设计。放弃 Agent SDK，采用服务+客户端架构。

<domain>
## Phase Boundary

将 Phase 2 的独立 CLI 工具改造为"服务 + 瘦客户端"架构。服务进程集中管理所有会话（PTY 和 JSON 两种模式），CLI 客户端通过本地 IPC 连接服务。飞书（Phase 6）将通过 relay（Phase 4）连接同一个服务进程，实现所有会话的统一可见和管理。不包含 relay 连接、飞书 UI 或远程消息桥接。

</domain>

<decisions>
## Implementation Decisions

### 架构：服务 + 瘦客户端模型
- **D-01:** `cc-anywhere serve` 启动常驻服务进程，内含 SessionManager，监听本地 Unix domain socket 接受 CLI 客户端连接。
- **D-02:** `cc-anywhere`（无参数或带 claude 参数）作为瘦客户端运行：连接本地服务，请求创建 PTY 会话，桥接终端 I/O 到服务管理的会话。
- **D-03:** CLI 客户端连接服务时，如果服务没在运行，自动后台拉起服务进程（类似 Docker daemon 的行为）。
- **D-04:** PTY 由客户端进程管理（不在服务端），保证本地终端零延迟。服务只做会话注册和消息中转，不管 PTY 进程生命周期。

### 放弃 Agent SDK，采用 claude --stream-json
- **D-05:** 放弃 `@anthropic-ai/claude-agent-sdk` 依赖。远程控制通道使用 `claude --output-format stream-json --input-format stream-json --permission-prompt-tool stdio --verbose` 启动 claude 子进程，通过 JSON 事件流通信。
- **D-06:** 这是 cc-connect 项目验证过的成熟方案，只依赖 claude CLI 本身，无额外 SDK 依赖，不受 Agent SDK v0.2.x 变动影响。
- **D-07:** `--verbose` 是必须的，pipe 模式下 stream-json 格式要求此 flag。stdout 中会混入非 JSON 行，解析时逐行尝试 JSON.parse，失败则跳过（与 cc-connect 处理方式一致）。
- **D-08:** 超长 JSON 行可能被 Node.js 的 data 事件分片，需要做行缓冲拼接后再解析。

### 两种会话模式
- **D-09:** PTY 会话（mode: "pty"）：由终端 CLI 客户端发起。claude 通过 node-pty 在客户端进程中 spawn，Phase 2 的 PtyManager 直接复用。终端关闭则会话结束。
- **D-10:** JSON 会话（mode: "json"）：由飞书远程发起（Phase 6 实现）。claude 通过 `--stream-json` 在服务进程中 spawn，结构化事件直接供远程消费。用户可从飞书主动关闭。
- **D-11:** 两种模式在会话列表中有明确标识，用户一眼能分清哪些是终端会话、哪些是远程会话。

### PTY 会话与服务的协作
- **D-12:** PTY 会话启动后，客户端向服务注册会话信息（id、mode、状态）。PTY 输出经过 tap 旁路发送给服务，服务转发给 relay（Phase 4 实现）。
- **D-13:** 飞书可以向 PTY 会话发送输入。服务将输入转发给客户端，客户端写入 PTY stdin。
- **D-14:** 客户端断开连接（终端关闭）时，通知服务注销该会话。服务将会话标记为 terminated。

### SessionManager
- **D-15:** SessionManager 维护 `Map<sessionId, SessionInfo>` 内存数据结构。SessionInfo 包含：id（nanoid 生成）、mode（"pty" | "json"）、state（复用 shared 包 SessionState 枚举）、createdAt、name（可选）。
- **D-16:** 会话状态机遵循 shared 包已定义的状态：idle -> working -> waiting_approval -> idle（循环），任意状态 -> error，任意状态 -> terminated。
- **D-17:** SessionManager 支持 JSON 文件持久化（参考 cc-connect 的 sessionSnapshot 方案），服务重启后可恢复会话元数据。
- **D-18:** API：createSession、listSessions、getSession、terminateSession、terminateAll。返回类型与 shared 包的 Session schema 对齐。

### JSON 会话的 tool approval
- **D-19:** JSON 会话通过 `--permission-prompt-tool stdio` 接收 control_request 事件（type: "control_request", subtype: "can_use_tool"）。Phase 3 默认策略为全部拒绝（deny），确保安全。
- **D-20:** 通过向 claude stdin 写入 control_response JSON 来回复审批决策。Phase 7 将实现从飞书远程审批。
- **D-21:** approval 策略设计为可注入函数，方便后续替换。

### 孤儿进程清理
- **D-22:** 服务进程启动 30 秒间隔的 reaper 定时器，遍历所有已跟踪的 JSON 会话，检测 claude 子进程是否存活。PTY 会话由客户端管理，服务只跟踪注册状态。
- **D-23:** 服务进程退出时，terminateAll() 给所有 JSON 会话的 claude 子进程发 SIGTERM，超时后 SIGKILL。PTY 会话由各自客户端负责清理。

### 客户端退出与注销
- **D-24:** 客户端进程退出时（正常退出、Ctrl+C、SIGTERM），必须向服务发送注销请求，服务将对应 PTY 会话标记为 terminated。
- **D-25:** 客户端在 SIGINT/SIGTERM 信号处理器中执行注销，确保非正常退出也能通知服务。

### 心跳检测
- **D-26:** 客户端每 10 秒向服务发送心跳消息。服务对每个 PTY 会话记录最后心跳时间。
- **D-27:** 服务检测到连续 3 次（30 秒）未收到心跳的 PTY 会话，自动标记为 terminated 并清理注册信息。这是客户端被 kill -9 或崩溃的兜底机制。
- **D-28:** 客户端重启后是新进程、新会话。旧会话通过心跳超时自动清理，不支持 PTY 会话 resume（PTY 进程已随客户端死亡）。

### IPC 协议
- **D-29:** 服务监听 Unix domain socket（路径如 `~/.cc-anywhere/cc-anywhere.sock`），CLI 客户端连接此 socket 通信。
- **D-30:** IPC 消息格式复用 shared 包的 MessageEnvelope schema（或其子集），保持协议一致性。

### Claude's Discretion
- Unix socket 路径和权限的具体设计
- 服务自动拉起的实现细节（fork、spawn、锁文件）
- SessionInfo 的精确 TypeScript 类型
- reaper 的超时和重试参数
- 行缓冲拼接的具体实现

### Folded Todos
- **审视 vitest config 是否需要每个包单独配置** — 随着 Phase 3 为 proxy 包添加更多测试文件，评估当前每包独立 vitest.config.ts 的方案是否合理。低优先级，不阻塞主线开发。

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### cc-connect 参考实现
- `reference/cc-connect/agent/claudecode/session.go` -- claude --stream-json 的进程管理、stdin/stdout JSON 通信、permission 处理的完整实现
- `reference/cc-connect/agent/claudecode/claudecode.go` -- Agent 接口设计、StartSession/ListSessions 模式、session ID 和 --resume 的使用
- `reference/cc-connect/core/session.go` -- SessionManager 设计：内存 map + JSON 文件持久化、多用户多会话、active session 跟踪
- `reference/cc-connect/core/interfaces.go` -- Agent/AgentSession/Platform 接口定义、PermissionResult 结构

### stream-json 协议验证
- `reference/test-stream-json.mjs` -- 本地验证脚本，确认 claude --stream-json 通过子进程 pipe 输出结构化 JSON 事件流

### Protocol & Session Schemas
- `packages/shared/src/schemas/session.ts` -- Session CRUD 消息 schema
- `packages/shared/src/constants/session.ts` -- SessionState 枚举（idle/working/waiting_approval/error/terminated）
- `packages/shared/src/schemas/tool.ts` -- Tool approval 消息 schema
- `packages/shared/src/schemas/envelope.ts` -- MessageEnvelope schema，IPC 协议可复用

### Existing Proxy Code
- `apps/proxy/src/pty-manager.ts` -- Phase 2 的 PtyManager，PTY 会话模式直接复用
- `apps/proxy/src/tap.ts` -- DataTap 接口，PTY 输出旁路到服务
- `apps/proxy/src/index.ts` -- 当前入口点，需重构为客户端模式

### Project Context
- `.planning/PROJECT.md` -- 核心价值和约束
- `.planning/REQUIREMENTS.md` -- PROXY-02（双通道并行）、PROXY-03（多会话管理）
- `.planning/research/PITFALLS.md` -- 进程清理、信号处理的已知陷阱

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `PtyManager` (apps/proxy/src/pty-manager.ts): PTY 会话的完整实现。客户端模式下直接复用，需要移除 process.exit() 调用改为事件通知。
- `DataTap` (apps/proxy/src/tap.ts): 数据旁路接口。从 noop 实现改为向服务发送 PTY 输出数据。
- `SessionState` (packages/shared/src/constants/session.ts): 会话状态枚举已定义。
- Session schemas (packages/shared/src/schemas/session.ts): CRUD 消息类型已定义。
- `MessageEnvelope` (packages/shared/src/schemas/envelope.ts): IPC 协议可复用此消息封装格式。

### Established Patterns
- ESM + TypeScript (`"type": "module"`) 全项目统一
- tsup 构建 + vitest 测试
- 包间严格单向依赖：shared 无依赖，proxy 依赖 shared
- zod schema -> infer TypeScript 类型的模式

### Integration Points
- `apps/proxy/src/index.ts` — 重构为客户端入口：检测/拉起服务、连接 IPC、创建 PTY 会话
- `apps/proxy/package.json` — 添加 nanoid 依赖，移除 Agent SDK（不再需要）
- 新增服务入口（如 `apps/proxy/src/serve.ts`）：SessionManager、Unix socket listener
- Phase 4 relay 将连接服务进程的 SessionManager 进行远程会话管理

</code_context>

<specifics>
## Specific Ideas

- cc-connect 验证了 `claude --stream-json` 是与 Claude Code 程序化交互的成熟方案，无需 Agent SDK
- cc-connect 的 SessionManager 用 JSON 文件持久化会话数据，重启后可恢复，值得参考
- cc-connect 用 `--resume <sessionID>` 恢复已有会话，`--continue --fork-session` 续接最近会话，这些 flag 在我们的 JSON 会话模式中同样适用
- Phase 2 的 PtyManager 中 `child.onExit` 直接调用 `process.exit()`，多会话模式下需要改为回调/事件模式，不能一个会话退出就杀掉整个进程
- stream-json 输出中 `session_id` 在 system init 事件中返回，可存储用于后续 `--resume`

</specifics>

<deferred>
## Deferred Ideas

- Relay 连接和消息桥接 — Phase 4 (RELAY-01)
- 断线重连和消息队列缓存 — Phase 5 (RELAY-02)
- 飞书小程序 UI 和远程创建 JSON 会话 — Phase 6 (FEISHU-01, FEISHU-03)
- 远程 tool approval 审批流程 — Phase 7 (FEISHU-02)
- 终端和手机双表面同步 — Phase 7 (PROXY-04)
- JSON 会话的空闲超时自动清理 — 可在 Phase 6 或 Phase 10 实现

### Reviewed Todos (not folded)
None — the only matching todo was folded into scope.

</deferred>

---

*Phase: 03-local-proxy-agent-sdk-multi-session*
*Context gathered: 2026-04-04 (revised from 2026-04-03 auto-generated version)*
