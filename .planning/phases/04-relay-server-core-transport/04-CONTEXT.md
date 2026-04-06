# Phase 4: Relay Server - Core Transport - Context

**Gathered:** 2026-04-06
**Status:** Ready for planning

<domain>
## Phase Boundary

实现 WebSocket 中转服务器，桥接本地 proxy service 和 remote client（飞书小程序）。proxy 通过出站 WebSocket 连接 relay，relay 将消息路由给已连接的 remote client，反之亦然。消息使用 shared 包的 MessageEnvelope 格式，序列号保证有序传递。不包含断线重连、消息队列缓存、认证流程或飞书小程序 UI。

**术语约定：**
- **CLI client** — Phase 3 的本地瘦客户端进程，通过 Unix socket 连接 proxy service，承载 PTY 终端会话
- **Proxy (service)** — 本地 cc-anywhere 常驻服务进程，管理所有会话，通过出站 WebSocket 连接 relay
- **Remote client** — 飞书小程序或其他远程 WebSocket 连接者，通过出站 WebSocket 连接 relay
- **Relay** — 公网中转服务器，接受 proxy 和 remote client 的连接，双向转发消息

</domain>

<decisions>
## Implementation Decisions

### Taro spike 验证（Plan 01）
- **D-01:** Phase 4 的第一个 plan 是用 Taro 搭最简飞书小程序，验证 `tt.connectSocket` 能连上 ws server 并收发 JSON。采用 TDD 方式。
- **D-02:** 验收标准为最小范围：连接成功、发送 JSON、接收 JSON。不验证断线重连、header token、MessageEnvelope 格式等。
- **D-03:** spike 连接目标为本地 echo ws server，不需要公网部署。验证通过后再正式搭 relay。

### 认证
- **D-04:** Phase 4 不实现认证。Relay 接受任何 WebSocket 连接，开放路由。认证（配对码+长期 token）推迟到后续阶段，在飞书小程序上线前实现。

### 消息路由
- **D-05:** Relay 支持多个 proxy 同时连接（对应用户的多台电脑）。每个 proxy 首次运行时生成唯一的 `proxyId`（nanoid），存到本地配置文件，连接 relay 时发送 proxyId 注册。
- **D-06:** Remote client 连接 relay 后，先获取当前在线的 proxy 列表，选择一个 proxyId 进行交互。后续消息按选定的 proxyId 路由到对应的 proxy。Remote client 可以随时切换到另一个 proxy。
- **D-07:** Relay 维护 proxy 注册表（proxyId → proxy WebSocket）和 remote client 的当前选择（remote client WebSocket → 选定的 proxyId），基于此做双向转发，不解析消息内容本身。
- **D-08:** Relay 使用 shared 包的 MessageEnvelopeSchema 做消息校验，格式不合法的消息丢弃并记录日志。

### 序列号
- **D-09:** 双端各自分配序列号，不由 relay 中心化分配。proxy→remote client 方向由 proxy 分配 seq，remote client→proxy 方向由 remote client 分配 seq。每个方向独立的 seq 空间。
- **D-10:** Relay 不维护 seq 状态，只透传。MessageEnvelope 的 `source` 字段（"proxy" | "client"）天然区分两个 seq 空间。
- **D-11:** Phase 4 只填充 seq 字段（自增计数器），不实现 gap 检测或重发逻辑。Gap 检测和重发是 Phase 5 的范围。

### 部署
- **D-12:** Relay 部署到用户的 CentOS 云服务器，从零搭建基础设施。
- **D-13:** 使用 Docker 容器化 relay server，docker-compose 编排 relay + Nginx（TLS 终结，WSS 反向代理）。
- **D-14:** 提供 deploy.sh 脚本，通过 SSH 部署到云服务器。包含 Docker 和 Nginx 的安装步骤。
- **D-15:** 部署脚本和 Dockerfile 放在 `apps/relay/` 目录下。

### Claude's Discretion
- Express vs Fastify 选择（HTTP server for health check）
- WebSocket 连接管理的具体实现（心跳间隔、超时参数）
- Nginx 配置细节（SSL 证书管理方式）
- Docker 镜像的基础镜像和构建优化

</decisions>

<specifics>
## Specific Ideas

- 飞书小程序的 `tt.connectSocket` 支持 `header` 参数（官方文档确认），不存在 header 限制的顾虑
- Phase 4 成功标准提到"WebSocket test client"，Taro spike 完成后可直接作为端到端验证用的 remote client
- Relay 的无状态设计使其天然适合水平扩展，但 v1 单实例即可

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Protocol & Message Schemas
- `packages/shared/src/schemas/envelope.ts` -- MessageEnvelope schema，relay 消息校验和路由的核心
- `packages/shared/src/schemas/system.ts` -- Heartbeat、Error、Auth、SyncRequest/Response schema
- `packages/shared/src/constants/session.ts` -- SessionState 枚举
- `packages/shared/src/builders/index.ts` -- 消息构造器函数

### Proxy Service（relay 的对接端）
- `apps/proxy/src/serve.ts` -- 服务入口，Phase 4 需要在此添加 relay 出站连接
- `apps/proxy/src/ipc-protocol.ts` -- IPC 协议和 Worker 协议，理解 proxy 内部消息流
- `apps/proxy/src/session-manager.ts` -- SessionManager，relay 需要转发会话管理消息

### Relay Stub
- `apps/relay/src/index.ts` -- 当前只有占位注释，Phase 4 在此实现

### Architecture & Pitfalls
- `.planning/research/ARCHITECTURE.md` -- 三层架构设计，relay 层职责
- `.planning/research/PITFALLS.md` -- WebSocket 消息排序、UTF-8 截断、重连等陷阱
- `.planning/research/STACK.md` -- ws 库版本、技术选型依据

### Project Context
- `.planning/REQUIREMENTS.md` -- RELAY-01（WebSocket 桥接）、RELAY-03（序列号有序传递）
- `CLAUDE.md` -- 技术栈约束：ws ^8.20.0, express/fastify, pino 日志

### Feishu WebSocket API（Taro spike 参考）
- [Lark connectSocket 官方文档](https://open.larksuite.com/document/client-docs/gadget/-web-app-api/network/websocket/connectsocket) -- 参数：url, header(object, optional), protocols(string[], optional)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `MessageEnvelopeSchema` (packages/shared) -- relay 消息校验直接使用
- `serializeIpc` / `createIpcReader` (apps/proxy/src/ipc-protocol.ts) -- NDJSON 读写模式可参考，但 relay 使用 WebSocket frame 不需要行分割
- `LineBuffer` (apps/proxy/src/line-buffer.ts) -- proxy 连接 relay 时可能需要做消息缓冲
- `SessionManager` (apps/proxy/src/session-manager.ts) -- relay 不需要自己的 session 管理，但需要理解 proxy 侧的会话模型

### Established Patterns
- ESM + TypeScript (`"type": "module"`) 全项目统一
- tsup 构建 + vitest 测试
- pino 结构化 JSON 日志（proxy serve.ts 已使用）
- zod schema 校验 + discriminatedUnion 消息类型

### Integration Points
- `apps/proxy/src/serve.ts` -- 需要添加 relay 出站 WebSocket 连接，将 worker 事件和 PTY tap 数据转发到 relay
- `apps/relay/src/index.ts` -- relay server 主入口
- `apps/relay/package.json` -- 需要添加 ws、express/fastify、pino 等依赖

</code_context>

<deferred>
## Deferred Ideas

- 认证流程（配对码 + 长期 token） -- Phase 5 之后、Phase 6 之前实现
- 断线重连和消息队列缓存 -- Phase 5 (RELAY-02)
- 重连后消息回放和 seq gap 补发 -- Phase 5 (RELAY-04)
- 飞书小程序完整 UI -- Phase 6 (FEISHU-01, FEISHU-03)
- 远程 tool approval -- Phase 7 (FEISHU-02)
- Relay 水平扩展 -- v2 或更后

</deferred>

---

*Phase: 04-relay-server-core-transport*
*Context gathered: 2026-04-06*
