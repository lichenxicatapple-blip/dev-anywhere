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
| **预期** | Relay 回复 `proxy_register_response { status: "new" }`；日志输出 `Proxy registered`；`/status` 端点 proxyCount +1 |

### 1.2 Proxy 异常断线 → 自动重连

| 项目 | 内容 |
|------|------|
| **触发** | 杀掉 relay 进程，或断开 proxy 的网络 |
| **预期 — proxy 侧** | 日志输出 `Relay connection closed unexpectedly`；emit `disconnected` 事件；开始指数退避重连（1s → 2s → 4s → ... → 30s cap，带 jitter） |
| **预期 — relay 侧**（重启后） | Proxy 自动连上，发送 `proxy_register`；relay 回复 `proxy_register_response { status: "reconnected" | "new" }` |
| **验证** | Proxy 日志中可看到 `Scheduling reconnect { attempt: N, backoffMs: M }`；重连成功后 attempt 归零 |

### 1.3 Proxy 异常断线 → 状态保留

| 项目 | 内容 |
|------|------|
| **触发** | Proxy WebSocket 连接意外关闭（杀 proxy 进程 / 网络断开） |
| **预期 — relay 侧** | 广播 `proxy_offline` 给所有绑定 client；标记 proxy 离线（`markProxyOffline`）；状态永久保留（无定时清理）；`/status` 端点 proxyCount 不变；`isProxyOnline` 返回 false |
| **验证** | Client 收到 `{ type: "proxy_offline", proxyId: "xxx" }` |

### 1.4 Proxy 重连恢复

| 项目 | 内容 |
|------|------|
| **触发** | 1.3 发生后，proxy 任意时间后重连（无时间限制） |
| **预期** | `registerProxy` 返回 `"reconnected"`；回复 `proxy_register_response { status: "reconnected", sessions: { s1: lastSeq } }`；广播 `proxy_online` 给所有绑定 client；`isProxyOnline` 恢复 true |
| **验证** | Client 收到 `{ type: "proxy_online", proxyId: "xxx" }`；proxy 收到 response 中的 sessions seq map |

### 1.5 Proxy 重连 → EventStore 对账回放

| 项目 | 内容 |
|------|------|
| **触发** | 1.4 发生后，proxy 收到 `proxy_register_response` |
| **预期** | Proxy 遍历活跃 JSON session 的 EventStore，对比 relay 的 per-session lastSeq，回放 relay 缺失的消息（seq > lastSeq） |
| **验证** | Relay 的 session buffer 补全了断线期间 TCP 缓冲区吞掉的消息（窗口 A）；relay 日志显示 `EventStore replay complete` |

### 1.6 Proxy 主动退出

| 项目 | 内容 |
|------|------|
| **触发** | 用户在电脑上关闭 CC Anywhere CLI（proxy `close()` 调用） |
| **预期 — proxy 侧** | 发送 `proxy_disconnect` 消息；关闭 WebSocket；不触发自动重连 |
| **预期 — relay 侧** | 广播 `proxy_offline` 给所有绑定 client；`unregisterProxy` 立即清理一切（注册、session buffer、client binding、磁盘 NDJSON） |
| **验证** | Client 收到 `proxy_offline`；`/status` 端点 proxyCount -1；后续 close 事件不再触发标记离线（proxyId 已清空） |

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

### 2.3 proxy_select 绑定离线的 proxy

| 项目 | 内容 |
|------|------|
| **触发** | Proxy 断线后（已标记离线），新 client 尝试 `proxy_select` |
| **预期** | 收到 `relay_error { code: "PROXY_NOT_FOUND" }`；不允许绑定到离线 proxy |

### 2.4 Client 断线 → 重连（proxy 在线）

| 项目 | 内容 |
|------|------|
| **触发** | Client WebSocket 关闭（手机切后台/锁屏/网络切换），proxy 保持在线 |
| **操作** | Client 重新连接，发送 `client_register { clientId: "c1", lastSeq: N }` |
| **预期** | 收到 `client_register_response { status: "restored", proxyId: "xxx" }`；随后逐条收到 seq > N 的所有缓冲消息（每条独立帧，非数组） |
| **验证** | 消息 seq per-session 连续递增，无遗漏，无重复 |

### 2.5 Client 断线 → 重连（proxy 离线中）

| 项目 | 内容 |
|------|------|
| **触发** | Proxy 和 client 都断线，proxy 离线中，client 先重连 |
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
| **预期** | Relay 将消息缓冲到对应 session 的 buffer；同步写入磁盘 NDJSON（如配置 dataDir）；转发给在线 client |
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
| **触发** | Proxy 发送任何 JSON 模式消息 |
| **预期** | Buffer 不做任何压缩，所有消息完整保留，支持 client 获取完整对话历史 |

### 3.4 SessionBuffer seq 去重

| 项目 | 内容 |
|------|------|
| **触发** | EventStore 回放发送已存在的 seq 到 relay |
| **预期** | `append()` 检测到 seq <= 已有最大 seq，静默跳过，不产生重复消息 |

### 3.5 replay_request 成功回放

| 项目 | 内容 |
|------|------|
| **触发** | Client 发送 `replay_request { sessionId, fromSeq: 2, toSeq: 5 }` |
| **预期** | 逐条收到 seq 2, 3, 4, 5 的原始 MessageEnvelope（独立帧） |

### 3.6 replay_request 部分可用

| 项目 | 内容 |
|------|------|
| **触发** | Buffer 中只有 seq 3-5，client 请求 fromSeq=1, toSeq=5 |
| **预期** | 收到 seq 3, 4, 5 的消息 + `gap_unrecoverable { fromSeq: 1, toSeq: 2 }` |

### 3.7 replay_request 完全不可用

| 项目 | 内容 |
|------|------|
| **触发** | Buffer 中无请求范围内的消息，或 sessionId 不存在 |
| **预期** | 收到 `gap_unrecoverable { sessionId, fromSeq, toSeq }` |

### 3.8 replay_request 无效范围

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
| **触发** | 4.1 之后 proxy 重连成功，收到 `proxy_register_response` |
| **预期** | 先执行 EventStore 对账回放（sync），再 flush 队列中所有消息，保证顺序正确 |
| **验证** | Client 收到的消息 seq per-session 连续递增 |

---

## 五、Seq 编号体系

### 5.1 Per-session seq 统一

| 项目 | 内容 |
|------|------|
| **规则** | 每个 session 独立 seq 计数器，EventStore.seq = MessageEnvelope.seq |
| **验证** | JSON worker 写入 EventStore 返回 seq N → IPC 传给 serve.ts → buildMessage(seq=N) → relay buffer 存 seq N |

### 5.2 重连对账基于统一 seq

| 项目 | 内容 |
|------|------|
| **触发** | Proxy 重连，收到 `proxy_register_response { sessions: { "s1": 42 } }` |
| **预期** | Proxy 查 EventStore readEvents(afterSeq=42)，回放 seq>42 的事件给 relay |
| **验证** | Relay session buffer 补全断线期间丢失的消息；seq 空间一致，直接可比较 |

---

## 六、持久化与 Relay 重启

### 6.1 Session buffer 磁盘持久化

| 项目 | 内容 |
|------|------|
| **触发** | Proxy 发送消息，relay 配置了 `dataDir` |
| **预期** | `dataDir/{sessionId}.ndjson` 文件逐行追加 |
| **验证** | 文件内容为有效 NDJSON，每行一个 BufferedMessage JSON |

### 6.2 PTY 压缩后磁盘同步

| 项目 | 内容 |
|------|------|
| **触发** | PTY snapshot 触发 `compressOnSnapshot` |
| **预期** | NDJSON 文件被重写，只保留 snapshot 及后续消息 |

### 6.3 Proxy 主动退出后磁盘清理

| 项目 | 内容 |
|------|------|
| **触发** | Proxy 主动退出（`proxy_disconnect`） |
| **预期** | 该 proxy 所有 session 的 NDJSON 文件被删除 |

### 6.4 Relay 重启恢复

| 项目 | 内容 |
|------|------|
| **触发** | Relay 进程重启，`dataDir` 中有之前的 NDJSON 文件 |
| **预期** | Registry 构造时从磁盘加载所有 session buffer；`/status` 端点反映加载的数据 |
| **验证** | Client 重连后通过 `replay_request` 可获取 relay 重启前缓冲的消息 |

### 6.5 Relay 重启后的已知限制

| 项目 | 内容 |
|------|------|
| **现象** | Proxy-session 映射和 client 绑定丢失（仅内存，未持久化） |
| **影响** | `client_register` 返回 `new`（非 `restored`）；client 需重新 `proxy_select` |
| **恢复** | Proxy 重连收到 `status: "new"` → EventStore 全量回放重建 relay buffer；client `proxy_select` 后 `replay_request` 补历史 |

---

## 七、心跳检测

### 7.1 正常心跳

| 项目 | 内容 |
|------|------|
| **触发** | 连接正常，双方持续响应 |
| **预期** | 每 30s relay 发 ping，对方回 pong，`isAlive` 保持 true |

### 7.2 心跳超时 — Proxy

| 项目 | 内容 |
|------|------|
| **触发** | Proxy 进程崩溃（不发 close frame）或网络静默断开 |
| **预期** | 最多 30-60s 后 relay 检测到 `isAlive = false`；`terminate()` 关闭连接；触发 close 事件 → 广播 `proxy_offline` → 标记离线（状态永久保留） |

### 7.3 心跳超时 — Client

| 项目 | 内容 |
|------|------|
| **触发** | Client 进程崩溃或网络断开 |
| **预期** | 最多 30-60s 后 relay 检测到；`terminate()` → close 事件 → `unbindClientById(ws=null)`，绑定保留 |

---

## 八、端到端场景：电缆断裂恢复

### 8.1 电缆断裂 → 任意时间后恢复

| 项目 | 内容 |
|------|------|
| **触发** | Proxy 和 relay 之间网络完全中断，任意时间后恢复 |
| **预期 — 检测阶段（0~60s）** | Relay 心跳检测到死连接 → terminate → 广播 proxy_offline → markProxyOffline（状态保留）。Proxy 侧 TCP 超时后开始重连 + 新消息进 MemoryMessageQueue |
| **预期 — 断线期间** | Relay buffer 永久保留（无定时清理）。Proxy 持续重试连接。 |
| **预期 — 恢复后** | Proxy 重连成功 → 收到 `proxy_register_response { status: "reconnected", sessions }` → 从 EventStore 回放窗口 A 缺失消息 → flush 队列（窗口 B 消息）→ 广播 proxy_online 给 client |
| **数据完整性** | 窗口 A（TCP 缓冲区吞掉的）通过 EventStore 回放补回 ✓；窗口 B（断线后新消息）通过队列 flush 补回 ✓；断线前历史通过 relay buffer 保留 ✓ |

---

## 九、错误码速查

| code | 场景 | client 应如何处理 |
|------|------|-----------------|
| `PROXY_NOT_FOUND` | proxy_select 目标不存在或离线 | 提示用户选择其他 proxy 或等待 |
| `PROXY_OFFLINE` | 发消息时 proxy 不可达 | 禁用输入，展示离线状态，等 `proxy_online` |
| `NOT_BOUND` | 未绑定 proxy 就发消息 | 先执行 proxy_select 或 client_register |
| `NOT_REGISTERED` | proxy 未注册就发消息 | proxy 内部错误，不应出现在 client |
| `UNSUPPORTED` | 发了不支持的控制消息类型 | client 代码 bug，检查消息类型 |
| `INVALID_RANGE` | replay_request fromSeq > toSeq | client 代码 bug，检查参数 |

---

## 十、状态通知速查

| 消息类型 | 方向 | 含义 | client 处理 |
|---------|------|------|------------|
| `proxy_offline` | relay → client | proxy 断线或主动退出 | 禁用输入，展示"电脑已离线" |
| `proxy_online` | relay → client | proxy 重连成功 | 恢复输入，展示正常状态 |
| `proxy_register_response` | relay → proxy | 注册结果 + per-session seq 水位 | proxy 据此做 EventStore 对账回放 |
| `gap_unrecoverable` | relay → client | 消息空洞无法补发 | 跳过空洞，继续处理后续消息 |
| `client_register_response` | relay → client | 注册结果 | 根据 status 走不同恢复路径 |

---

## 十一、控制消息完整清单

| 消息类型 | 方向 | 用途 |
|---------|------|------|
| `proxy_register` | proxy → relay | 注册/重连 |
| `proxy_register_response` | relay → proxy | 注册结果 + session seq map |
| `proxy_disconnect` | proxy → relay | 主动退出，relay 立即清理 |
| `proxy_offline` | relay → client | proxy 不可达通知 |
| `proxy_online` | relay → client | proxy 恢复通知 |
| `proxy_list_request` | client → relay | 查询 proxy 列表 |
| `proxy_list_response` | relay → client | proxy 列表 |
| `proxy_select` | client → relay | 绑定到 proxy |
| `client_register` | client → relay | 重连注册 |
| `client_register_response` | relay → client | 注册结果 |
| `replay_request` | client → relay | 请求 seq 范围回放 |
| `replay_response` | relay → client | 回放结果（预留，当前逐帧发送） |
| `gap_unrecoverable` | relay → client | 不可恢复的 seq 空洞 |
| `relay_error` | relay → client/proxy | 错误响应 |
