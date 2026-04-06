# Phase 5: Relay Server - Resilience - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-07
**Phase:** 05-relay-server-resilience
**Areas discussed:** Proxy 重连策略, Relay 消息缓存, Client 重连与消息回放, Seq gap 检测与补发协议

---

## Proxy 重连策略

### 退避策略

| Option | Description | Selected |
|--------|-------------|----------|
| 指数退避 + 随机抖动 | 初始 1s、倍增、上限 30s、加 jitter | |
| 固定间隔重试 | 每 5s 重试 | |

**User's choice:** 指数退避 + 无限重试（用户明确要求无最大次数上限，给 relay 运维时间）

### 断线期间消息处理

| Option | Description | Selected |
|--------|-------------|----------|
| Service 内存队列缓存 | 断线时存内存，重连后 flush | |
| 丢弃 + 依赖 relay 侧重发 | proxy 侧不缓冲，依赖 relay | |
| 复用 EventStore 持久化 | 用已有的二进制格式持久化到磁盘 | |

**User's choice:** Service 内存队列，但要求设计可复用的 MessageQueue 抽象，后续可换 NDJSON 持久化实现
**Notes:** 用户详细讨论了 proxy service 与 worker/claude 进程的关系。Worker 是 detached 进程，service 死后 worker 存活但事件被 sendToServe 静默丢弃。用户认为持久化设计会影响整体健壮性，要求提前想好抽象，但同意 Phase 5 先用内存实现。

### 重连后恢复

| Option | Description | Selected |
|--------|-------------|----------|
| 重新注册 proxyId + 拉取缓存消息 | Proxy 用原 proxyId 重新 register | |
| Relay 主动推送缓存 | Relay 自动下发 | |

**User's choice:** 重新注册 proxyId + relay 推送缓存

---

## Relay 消息缓存

### 存储方式

| Option | Description | Selected |
|--------|-------------|----------|
| 内存队列 | Per-session 内存队列 | |
| Redis / 外部存储 | 持久化但增加部署复杂度 | |

**User's choice:** 内存队列（2GB 服务器加 Redis 太紧张，个人工具不需要）

### 缓冲区架构

**用户纠正：** 缓冲区应该是 per-session 而非 per-proxy。每个 session 独立缓冲、独立压缩、独立清理。

### 压缩策略

**用户提出：** 不同会话类型用不同压缩策略
- PTY: snapshot 到达后丢弃前序消息
- JSON: result 事件到达后丢弃 turn 内的 streaming delta

### 缓冲生命周期

**用户核心架构决定：** 缓冲区生命周期绑定在 proxy 连接上，不绑定 client。
- Proxy 在线 → 消息一直保留（受条数上限和压缩约束）
- Proxy 断线 → 30 分钟宽限期后清除
- Client 没有 TTL 概念，任何时候接入都能拿到完整消息

**User's rationale:** "proxy应该不感知client的，proxy有消息就往relay推送就是" + "由于消息一直留在relay中，所以client无论什么时候接入都能看到完整消息"

---

## Client 重连与消息回放

### Client 身份识别

| Option | Description | Selected |
|--------|-------------|----------|
| Client 生成 clientId | nanoid 存 tt.setStorageSync | |
| Relay 分配 clientId | 首次连接时分配 | |

**User's choice:** Client 生成 clientId（用户确认 setStorageSync 持久化可靠）

### 回放方式

**User's correction:** 即使 relay 自动推送缓存也需要 lastSeq 来避免重复（WebSocket 关闭瞬间的竞态）
**Final design:** 混合方案 — relay 缓冲 + client 发 lastSeq + relay 按 seq 过滤后推送

### 重连协议

Relay 响应三种状态：restored / proxy_offline / new

### 启动顺序

**User's choice:** 先从 storage 渲染再连 relay（零等待体验）

---

## Seq gap 检测与补发

### 检测方

| Option | Description | Selected |
|--------|-------------|----------|
| 接收端检测 | proxy 和 client 各自跟踪 seq | |
| Relay 居中检测 | relay 跟踪 seq 状态 | |

**User's choice:** 接收端检测（符合 Phase 4 D-09 双端独立 seq）

### 恢复方式

| Option | Description | Selected |
|--------|-------------|----------|
| 请求重发 + 超时跳过 | replay_request + gap_unrecoverable | |
| 仅记录日志 | 不尝试恢复 | |

**User's choice:** 请求重发 + 超时跳过

### ACK 机制

**User's choice:** 无 ACK。缓冲按 proxy 生命周期自然淘汰。
**TTL 讨论：** 用户最初关心 30 分钟 TTL 是否太短（开车场景），最终确认缓冲区绑定 proxy 生命周期而非固定 TTL，解决了这个问题。

---

## 会话控制原则

**User's proposal:** PTY 会话只能从电脑端终止，JSON 会话可以从手机端终止。
**Rationale:** 电脑上的 claude 是主工作面，手机是辅助面，手机不应干扰本地终端体验。
**Enforcement:** Proxy 侧拦截，relay 不解析业务语义。

---

## Claude's Discretion

- 指数退避 jitter 算法
- MessageQueue 内部实现
- Relay 缓冲区数据结构
- replay_request 超时参数
- 新增 zod schema 设计
- 压缩触发实现方式

## Deferred Ideas

- JSON worker 本地事件缓冲（sendToServe 静默丢弃问题）
- Proxy EventStore 回放到 relay（超 30 分钟离线场景）
- 认证流程
- 小程序消息缓存快照清理策略（已记录 todo）
