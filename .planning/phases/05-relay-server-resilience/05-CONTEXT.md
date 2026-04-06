# Phase 5: Relay Server - Resilience - Context

**Gathered:** 2026-04-07
**Status:** Ready for planning

<domain>
## Phase Boundary

让 relay 在真实网络不稳定场景下不丢消息、不断会话。实现 proxy 自动重连（指数退避）、relay per-session 消息缓冲与压缩、client 断线重连后增量同步、seq gap 检测与补发。不包含认证流程、飞书小程序 UI 实现、或 proxy 侧 worker 事件持久化。

</domain>

<decisions>
## Implementation Decisions

### Proxy 重连策略
- **D-01:** 指数退避 + 随机抖动，无限重试（无最大次数上限）。初始 1s、倍增、上限 30s。到达上限后固定 30s 持续重试，给 relay 服务器运维时间。
- **D-02:** Relay WebSocket 断线期间，service 侧用内存队列缓冲出站消息，重连后按序 flush。
- **D-03:** 缓冲逻辑收拢到 MessageQueue 类（enqueue/drain/size），Phase 5 用内存实现。接口设计预留持久化扩展——后续替换为 NDJSON 文件实现即可，调用方代码不变。
- **D-04:** 重连后用原 proxyId 重新发送 proxy_register，relay 识别为重连并恢复状态。

### Relay 消息缓冲
- **D-05:** 缓冲区 per-session，不是 per-proxy。每个 session 独立缓冲、独立压缩、独立清理。Proxy 注册表维护 proxyId -> sessionId 集合的映射。
- **D-06:** 内存队列存储。v1 单实例 relay，不引入 Redis 等外部依赖（2GB 服务器内存有限）。
- **D-07:** 条数上限 1000 条 per-session。
- **D-08:** PTY 会话压缩：收到 snapshot 事件后丢弃该 session 缓冲区中 snapshot 之前的所有消息。只保留最近 snapshot + 后续增量。
- **D-09:** JSON 会话压缩：收到 result 事件（turn 结束）后丢弃该 turn 的所有中间 streaming delta 和 stream_event。只保留 user 消息 + result 事件 + 未决的 control_request。
- **D-10:** Relay 需要解析 MessageEnvelope 的 sessionId 和消息类型来做分组缓冲和压缩。Phase 5 的 relay 不再是 Phase 4 的完全无状态透传层，这是从"核心传输"到"韧性"的自然演进。

### Proxy 断线宽限期
- **D-11:** Proxy 断线后保留注册信息和缓冲区 30 分钟。宽限期内重连即恢复，超时才清除一切。
- **D-12:** Proxy 在线期间，其 session 的缓冲消息一直保留（受条数上限和压缩策略约束），不设 TTL。只有 proxy 断线后才启动 30 分钟倒计时。

### Client 重连与消息回放
- **D-13:** Client（飞书小程序）首次启动时生成 nanoid clientId，持久化到 tt.setStorageSync。后续所有重连复用同一 clientId。
- **D-14:** Client 重连协议：发送 client_register(clientId, lastSeq)。Relay 响应三种状态：restored（绑定恢复+proxy在线）、proxy_offline（绑定恢复+proxy离线）、new（无绑定或已过期）。
- **D-15:** Relay 自动恢复 client 的 proxy 绑定，client 不需要重新发送 proxy_select。
- **D-16:** Client 没有 TTL 概念。缓冲区生命周期绑定在 proxy 连接上，不绑定 client。Client 任何时候连入，只要 proxy 在线（或在宽限期内），都能从 per-session 缓冲区拿到 lastSeq 之后的完整消息。
- **D-17:** 冷启动时先从 storage 渲染缓存消息（用户零等待），同时后台连 relay 拉增量。
- **D-18:** Proxy 离线时 relay 发送 proxy_offline 事件，小程序展示"电脑已离线"状态。

### Seq gap 检测与补发
- **D-19:** 接收端（proxy 和 client）各自跟踪收到的 seq，发现空洞时发送 replay_request(fromSeq, toSeq)。
- **D-20:** Relay 从 per-session 缓冲区查找请求范围内的消息并重发。缓冲区没有则返回 gap_unrecoverable，接收端跳过并记录日志。
- **D-21:** 无 ACK 机制。缓冲区按 proxy 生命周期 + 压缩策略自然淘汰，不等待接收端确认。

### 会话控制原则
- **D-22:** PTY 会话只能从电脑端终止，手机端不允许终止 PTY 会话。JSON 会话可以从手机端终止。
- **D-23:** 会话终止权限在 proxy 侧拦截（proxy 收到终止请求后检查 session mode），relay 保持不解析业务语义的原则。

### Claude's Discretion
- 指数退避的具体 jitter 算法
- MessageQueue 类的内部实现细节
- Relay 缓冲区内部数据结构选择
- replay_request 的超时参数
- 新增控制消息的具体 zod schema 设计
- Relay 压缩触发的具体实现方式

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Protocol & Message Schemas
- `packages/shared/src/schemas/envelope.ts` -- MessageEnvelope schema，缓冲和 seq 跟踪的基础
- `packages/shared/src/schemas/system.ts` -- Heartbeat、Error、Auth schema，需要扩展 relay 控制消息
- `packages/shared/src/constants/session.ts` -- SessionState 枚举

### Relay Server（需要增强）
- `apps/relay/src/server.ts` -- Relay server 主体，需要集成缓冲管理
- `apps/relay/src/registry.ts` -- RelayRegistry，需要增加宽限期、per-session 缓冲区、client binding 持久化
- `apps/relay/src/router.ts` -- 消息路由，需要改为写入缓冲区而非直接转发
- `apps/relay/src/handlers/proxy.ts` -- Proxy 连接处理，需要支持重连识别和缓冲区恢复
- `apps/relay/src/handlers/client.ts` -- Client 连接处理，需要支持 client_register 协议和 lastSeq 增量推送

### Proxy 侧（需要增强）
- `apps/proxy/src/relay-connection.ts` -- 当前只有基础 connect/close，需要添加自动重连、内存队列、指数退避
- `apps/proxy/src/serve.ts` -- Service 入口，relay 连接集成点
- `apps/proxy/src/event-store.ts` -- 二进制事件存储，snapshot 压缩策略的参考实现
- `apps/proxy/src/session-worker.ts` -- Worker 进程，sendToServe 在 socket 断开时静默丢弃事件（deferred: 后续添加本地缓冲）

### Architecture & Pitfalls
- `.planning/research/PITFALLS.md` -- WebSocket 重连、消息排序陷阱
- `.planning/REQUIREMENTS.md` -- RELAY-02（自动重连+消息队列）、RELAY-04（小程序后台缓存+回放）

### Phase 4 Context（前序决定）
- `.planning/phases/04-relay-server-core-transport/04-CONTEXT.md` -- 核心传输决定，特别是 D-09~D-11（seq 双端分配、relay 透传、gap 检测留给 Phase 5）

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `EventStore` (apps/proxy/src/event-store.ts) -- 二进制事件持久化 + snapshot + 归档压缩，per-session 缓冲和 snapshot 压缩策略的参考模式
- `TerminalTracker` (apps/proxy/src/terminal-tracker.ts) -- 3 秒空闲触发快照，proxy 侧 snapshot 事件的来源
- `RelayRegistry` (apps/relay/src/registry.ts) -- 现有注册表，需要扩展为支持宽限期和 per-session 缓冲
- `parseMessage` (apps/relay/src/router.ts) -- 现有消息解析，已区分 control / envelope / invalid
- `LineBuffer` (apps/proxy/src/line-buffer.ts) -- 流式数据行缓冲模式

### Established Patterns
- ESM + TypeScript 全项目统一
- tsup 构建 + vitest 测试
- pino 结构化 JSON 日志
- zod schema 校验 + discriminatedUnion 消息类型
- detached worker 进程 + Unix socket IPC
- Phase 4 已有的 relay control message schema (RelayControlSchema)

### Integration Points
- `apps/relay/src/server.ts` -- 缓冲管理需要集成到 server 的连接生命周期中
- `apps/relay/src/handlers/proxy.ts` -- proxy 断线时启动宽限期计时器，重连时恢复
- `apps/relay/src/handlers/client.ts` -- 新增 client_register 处理和增量推送
- `apps/proxy/src/relay-connection.ts` -- 重连逻辑和 MessageQueue 的主要实现点
- `packages/shared/src/schemas/` -- 新增 relay 控制消息 schema（client_register, replay_request, gap_detected 等）

</code_context>

<specifics>
## Specific Ideas

- MessageQueue 类设计为可替换底层实现：内存版用 array，持久化版用 NDJSON 文件 appendFileSync/readFileSync/unlinkSync，接口一致（enqueue/drain/size）
- JSON 会话的 result 事件等价于 PTY 的 snapshot——都是"turn/状态完成"的信号，触发同样的压缩逻辑
- Client 三种恢复场景（热恢复/温恢复/冷启动）走同一个 relay 协议（client_register + clientId + lastSeq），区别只在客户端内部状态管理
- Proxy 不感知 client 存在与否，有消息就往 relay 推。缓冲是 relay 的职责
- 同一时刻只需考虑一个 client 的场景（个人工具），snapshot/result 压缩丢弃前序消息可接受

</specifics>

<deferred>
## Deferred Ideas

- **JSON worker 本地事件缓冲** -- session-worker.ts 的 sendToServe 在 serveSocket 为 null 时静默丢弃事件。后续应添加本地 MessageQueue（NDJSON 持久化版），service 重连后 drain 补发。复用 Phase 5 的 MessageQueue 抽象。
- **Proxy 侧 EventStore 回放到 relay** -- Client 离线超过 30 分钟（relay 缓冲区已清除）时，通过 relay 向 proxy 发 replay_request，proxy 从 EventStore 读取历史回放。完整的端到端消息不丢失方案。
- **认证流程（配对码 + 长期 token）** -- Phase 6 之前实现
- **小程序本地消息缓存快照清理策略** -- 已记录为 todo，Phase 6/8 实现

</deferred>

---

*Phase: 05-relay-server-resilience*
*Context gathered: 2026-04-07*
