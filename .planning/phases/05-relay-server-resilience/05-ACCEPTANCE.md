# Phase 5: Relay Resilience 验收文档

## 前置条件

- Relay server 运行中（`pnpm --filter @cc-anywhere/relay dev`）
- Proxy 已连接 relay（`pnpm --filter @cc-anywhere/proxy dev`）
- Client（飞书小程序或 WebSocket 调试工具）已连接 relay `/client` 端点

---

## 一、Proxy 连接生命周期

### 1.1 Proxy 正常注册

| 项目 | 内容 |
|------|------|
| **触发** | Proxy 启动，连接 relay `/proxy` 端点 |
| **操作** | Proxy 发送 `{ type: "proxy_register", proxyId: "xxx" }` |
| **预期** | Relay 日志输出 `Proxy registered` + `status: "new"`；`/status` 端点 proxyCount +1 |

### 1.2 Proxy 异常断线 → 自动重连

| 项目 | 内容 |
|------|------|
| **触发** | 杀掉 relay 进程，或断开 proxy 的网络 |
| **预期 — proxy 侧** | 日志输出 `Relay connection closed unexpectedly`；emit `disconnected` 事件；开始指数退避重连（1s → 2s → 4s → ... → 30s cap，带 jitter） |
| **预期 — relay 侧**（重启后） | Proxy 自动连上，发送 `proxy_register`；relay 日志 `status: "reconnected"`（如果是同一 relay 实例）或 `status: "new"`（relay 重启后） |
| **验证** | Proxy 日志中可看到 `Scheduling reconnect { attempt: N, backoffMs: M }`；重连成功后 attempt 归零 |

### 1.3 Proxy 异常断线 → 宽限期

| 项目 | 内容 |
|------|------|
| **触发** | Proxy WebSocket 连接意外关闭（杀 proxy 进程 / 网络断开） |
| **预期 — relay 侧** | 广播 `proxy_offline` 给所有绑定 client；启动 30 分钟宽限期；`/status` 端点 proxyCount 不变（proxy 仍在 registry 中）；`isProxyOnline` 返回 false |
| **验证** | Client 收到 `{ type: "proxy_offline", proxyId: "xxx" }` |

### 1.4 宽限期内 Proxy 重连

| 项目 | 内容 |
|------|------|
| **触发** | 1.3 发生后，proxy 在 30 分钟内重连 |
| **预期** | Relay 取消宽限期定时器；`registerProxy` 返回 `"reconnected"`；广播 `proxy_online` 给所有绑定 client；`isProxyOnline` 恢复 true |
| **验证** | Client 收到 `{ type: "proxy_online", proxyId: "xxx" }` |

### 1.5 宽限期超时（30 分钟无重连）

| 项目 | 内容 |
|------|------|
| **触发** | 1.3 发生后，proxy 30 分钟内未重连 |
| **预期** | `cleanupProxy` 执行：删除 proxy 注册、所有 session buffer（内存+磁盘）、所有 client binding；`/status` 端点 proxyCount -1、sessionCount 归零 |
| **验证** | Client 发送任何消息收到 `relay_error NOT_BOUND` |

### 1.6 Proxy 主动退出

| 项目 | 内容 |
|------|------|
| **触发** | 用户在电脑上关闭 CC Anywhere CLI（proxy `close()` 调用） |
| **预期 — proxy 侧** | 发送 `proxy_disconnect` 消息；关闭 WebSocket；不触发自动重连 |
| **预期 — relay 侧** | 广播 `proxy_offline` 给所有绑定 client；`unregisterProxy` 立即清理一切（不启动宽限期）；磁盘 NDJSON 文件删除 |
| **验证** | Client 收到 `proxy_offline`；`/status` 端点 proxyCount -1；后续 close 事件不再触发宽限期（proxyId 已清空） |

---

## 二、Client 连接生命周期

### 2.1 Client 首次连接 + proxy_select

| 项目 | 内容 |
|------|------|
| **触发** | Client WebSocket 连接 relay `/client` 端点 |
| **操作** | 发送 `proxy_list_request` → 收到 proxy 列表 → 发送 `proxy_select { proxyId }` |
| **预期** | 绑定成功；后续 proxy 的消息会转发给此 client |
| **验证** | Proxy 发送一条 MessageEnvelope，client 能收到 |

### 2.2 proxy_select 绑定不存在的 proxy

| 项目 | 内容 |
|------|------|
| **触发** | Client 发送 `proxy_select { proxyId: "nonexistent" }` |
| **预期** | 收到 `relay_error { code: "PROXY_NOT_FOUND" }` |

### 2.3 proxy_select 绑定宽限期中的 proxy

| 项目 | 内容 |
|------|------|
| **触发** | Proxy 断线进入宽限期后，新 client 尝试 `proxy_select` |
| **预期** | 收到 `relay_error { code: "PROXY_NOT_FOUND" }`；不允许绑定到离线 proxy |

### 2.4 Client 断线 → 重连（proxy 在线）

| 项目 | 内容 |
|------|------|
| **触发** | Client WebSocket 关闭（手机切后台/锁屏/网络切换），proxy 保持在线 |
| **操作** | Client 重新连接，发送 `client_register { clientId: "c1", lastSeq: N }` |
| **预期** | 收到 `client_register_response { status: "restored", proxyId: "xxx" }`；随后逐条收到 seq > N 的所有缓冲消息（每条独立帧，非数组） |
| **验证** | 消息 seq 连续递增，无遗漏，无重复 |

### 2.5 Client 断线 → 重连（proxy 在宽限期）

| 项目 | 内容 |
|------|------|
| **触发** | Proxy 和 client 都断线，proxy 在宽限期中，client 先重连 |
| **操作** | Client 发送 `client_register { clientId: "c1", lastSeq: N }` |
| **预期** | 收到 `client_register_response { status: "proxy_offline", proxyId: "xxx" }`；绑定保留，等待 proxy 重连后收到 `proxy_online` |

### 2.6 Client 首次使用 client_register（无历史绑定）

| 项目 | 内容 |
|------|------|
| **触发** | 全新 clientId 首次发送 `client_register` |
| **预期** | 收到 `client_register_response { status: "new" }`；需走 `proxy_select` 流程绑定 proxy |

### 2.7 Client 在 proxy 离线期间发消息

| 项目 | 内容 |
|------|------|
| **触发** | Proxy 断线后，已绑定 client 发送 MessageEnvelope |
| **预期** | 收到 `relay_error { code: "PROXY_OFFLINE" }` |

### 2.8 未绑定 client 发消息

| 项目 | 内容 |
|------|------|
| **触发** | Client 未执行 proxy_select / client_register restored，直接发 MessageEnvelope |
| **预期** | 收到 `relay_error { code: "NOT_BOUND" }` |

---

## 三、消息缓冲与回放

### 3.1 Proxy 消息缓冲到 per-session buffer

| 项目 | 内容 |
|------|------|
| **触发** | Proxy 发送 MessageEnvelope（任何 sessionId） |
| **预期** | Relay 将消息缓冲到对应 session 的 buffer；同步写入磁盘 NDJSON；转发给在线 client |
| **验证** | `/status` 端点 `buffers.totalBuffered` 递增 |

### 3.2 PTY 快照压缩

| 项目 | 内容 |
|------|------|
| **触发** | Proxy 发送 `type: "session_status"` 消息（PTY snapshot） |
| **预期** | Buffer 中 snapshot 之前的所有消息被丢弃；磁盘 NDJSON 文件被重写（变小） |
| **验证** | `/status` 端点 `buffers.totalBuffered` 下降 |

### 3.3 JSON 模式不压缩

| 项目 | 内容 |
|------|------|
| **触发** | Proxy 发送 `type: "tool_result"` 消息 |
| **预期** | Buffer 不做任何压缩，所有消息完整保留 |
| **验证** | Buffer size 持续增长，不因 tool_result 而减少 |

### 3.4 replay_request 成功回放

| 项目 | 内容 |
|------|------|
| **触发** | Client 发送 `replay_request { sessionId, fromSeq: 2, toSeq: 5 }` |
| **预期** | 逐条收到 seq 2, 3, 4, 5 的原始 MessageEnvelope（独立帧） |

### 3.5 replay_request 部分可用

| 项目 | 内容 |
|------|------|
| **触发** | Buffer 中只有 seq 3-5，client 请求 fromSeq=1, toSeq=5 |
| **预期** | 收到 seq 3, 4, 5 的消息 + `gap_unrecoverable { fromSeq: 1, toSeq: 2 }` |

### 3.6 replay_request 完全不可用

| 项目 | 内容 |
|------|------|
| **触发** | Buffer 中无请求范围内的消息，或 sessionId 不存在 |
| **预期** | 收到 `gap_unrecoverable { sessionId, fromSeq, toSeq }` |

### 3.7 replay_request 无效范围

| 项目 | 内容 |
|------|------|
| **触发** | Client 发送 `replay_request { fromSeq: 10, toSeq: 5 }` |
| **预期** | 收到 `relay_error { code: "INVALID_RANGE" }` |

---

## 四、Proxy 出站消息队列

### 4.1 断线期间消息入队

| 项目 | 内容 |
|------|------|
| **触发** | Relay 断线，proxy 调用 `send(envelope)` |
| **预期** | 消息进入 `MemoryMessageQueue`，不丢弃；日志输出 `Message queued during disconnect` |

### 4.2 重连后队列 flush

| 项目 | 内容 |
|------|------|
| **触发** | 4.1 之后 proxy 重连成功 |
| **预期** | `proxy_register` 发送后，队列中所有消息按入队顺序逐条发送；队列清空 |
| **验证** | Client 收到的消息 seq 顺序正确，无遗漏 |

---

## 五、持久化与 Relay 重启

### 5.1 Session buffer 磁盘持久化

| 项目 | 内容 |
|------|------|
| **触发** | Proxy 发送消息，relay 配置了 `dataDir` |
| **预期** | `dataDir/{sessionId}.ndjson` 文件逐行追加 |
| **验证** | 文件内容为有效 NDJSON，每行一个 BufferedMessage JSON |

### 5.2 PTY 压缩后磁盘同步

| 项目 | 内容 |
|------|------|
| **触发** | PTY snapshot 触发 `compressOnSnapshot` |
| **预期** | NDJSON 文件被重写，只保留 snapshot 及后续消息 |

### 5.3 Proxy 退出后磁盘清理

| 项目 | 内容 |
|------|------|
| **触发** | Proxy 主动退出（`proxy_disconnect`）或宽限期超时 |
| **预期** | 该 proxy 所有 session 的 NDJSON 文件被删除 |

### 5.4 Relay 重启恢复

| 项目 | 内容 |
|------|------|
| **触发** | Relay 进程重启，`dataDir` 中有之前的 NDJSON 文件 |
| **预期** | Registry 构造时从磁盘加载所有 session buffer；`/status` 端点 sessionCount 和 totalBuffered 反映加载的数据 |
| **验证** | Client 重连后通过 `replay_request` 可获取 relay 重启前缓冲的消息 |

### 5.5 Relay 重启后的已知限制

| 项目 | 内容 |
|------|------|
| **现象** | Proxy-session 映射和 client 绑定丢失（仅内存，未持久化） |
| **影响** | `client_register` 返回 `new`（非 `restored`）；client 需重新 `proxy_select` |
| **恢复** | Proxy 重连后发消息 → `addSessionToProxy` 重建映射；client `proxy_select` 后 `replay_request` 补历史 |

---

## 六、心跳检测

### 6.1 正常心跳

| 项目 | 内容 |
|------|------|
| **触发** | 连接正常，双方持续响应 |
| **预期** | 每 30s relay 发 ping，对方回 pong，`isAlive` 保持 true |

### 6.2 心跳超时 — Proxy

| 项目 | 内容 |
|------|------|
| **触发** | Proxy 进程崩溃（不发 close frame）或网络静默断开 |
| **预期** | 最多 30-60s 后 relay 检测到 `isAlive = false`；`terminate()` 关闭连接；触发 close 事件 → 广播 `proxy_offline` → 启动宽限期 |

### 6.3 心跳超时 — Client

| 项目 | 内容 |
|------|------|
| **触发** | Client 进程崩溃或网络断开 |
| **预期** | 最多 30-60s 后 relay 检测到；`terminate()` → close 事件 → `unbindClientById(ws=null)`，绑定保留 |

---

## 七、错误码速查

| code | 场景 | client 应如何处理 |
|------|------|-----------------|
| `PROXY_NOT_FOUND` | proxy_select 目标不存在或离线 | 提示用户选择其他 proxy 或等待 |
| `PROXY_OFFLINE` | 发消息时 proxy 不可达 | 禁用输入，展示离线状态，等 `proxy_online` |
| `NOT_BOUND` | 未绑定 proxy 就发消息 | 先执行 proxy_select 或 client_register |
| `NOT_REGISTERED` | proxy 未注册就发消息 | proxy 内部错误，不应出现在 client |
| `UNSUPPORTED` | 发了不支持的控制消息类型 | client 代码 bug，检查消息类型 |
| `INVALID_RANGE` | replay_request fromSeq > toSeq | client 代码 bug，检查参数 |

---

## 八、状态通知速查

| 消息类型 | 方向 | 含义 | client 处理 |
|---------|------|------|------------|
| `proxy_offline` | relay → client | proxy 断线或主动退出 | 禁用输入，展示"电脑已离线" |
| `proxy_online` | relay → client | proxy 重连成功 | 恢复输入，展示正常状态 |
| `gap_unrecoverable` | relay → client | 消息空洞无法补发 | 跳过空洞，继续处理后续消息 |
| `client_register_response` | relay → client | 注册结果 | 根据 status 走不同恢复路径 |
