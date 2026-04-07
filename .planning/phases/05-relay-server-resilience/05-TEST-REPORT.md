# Phase 5: Relay Resilience 测试报告

测试文件：`apps/relay/src/__tests__/relay-resilience.test.ts`
测试方式：进程级 E2E（spawn 真实 relay 子进程，真实 TCP WebSocket 连接，SIGKILL/SIGTERM 信号）
执行结果：**38/38 PASS**，耗时 ~33s

---

## proxy lifecycle（对应验收文档第一节）

### Proxy 正常注册 → proxy_register_response(new) + /status proxyCount

**测试步骤：**
1. spawn relay 子进程，等待 /health 返回 200
2. WebSocket 连接 `/proxy` 端点
3. 发送 `{ type: "proxy_register", proxyId: "p1-1" }`
4. 读取 relay 返回的消息
5. GET `/status` 端点

**预期：** relay 回复 `proxy_register_response { status: "new" }`，sessions 字段不存在；`/status` 的 proxyCount >= 1

**实际：** response.type = "proxy_register_response"，response.status = "new"，response.sessions = undefined；/status proxyCount = 1。耗时 59ms。

---

### Proxy 异常断线 → proxy_offline 广播 + 状态保留

**测试步骤：**
1. proxy 注册到 relay
2. client 通过 WebSocket 连接 `/client`，发送 `proxy_select` 绑定到该 proxy
3. 调用 `proxy.terminate()` 强制关闭 proxy 的 TCP 连接（无 close frame）
4. 读取 client 收到的消息
5. GET `/status` 检查 proxyCount

**预期：** client 收到 `{ type: "proxy_offline", proxyId: "..." }`；proxyCount 不减少（状态保留等待重连）

**实际：** client 收到 proxy_offline 消息，proxyId 匹配。/status proxyCount 不变。耗时 260ms。

---

### Proxy 重连恢复 → reconnected + sessions seq map + proxy_online

**测试步骤：**
1. proxy1 注册，发送 3 条消息到 2 个 session（s-a: seq 1,5；s-b: seq 3）
2. client 绑定到 proxy，消耗转发的 3 条消息
3. proxy1.terminate() 断线，client 收到 proxy_offline
4. 新建 proxy2 WebSocket，用相同 proxyId 发送 proxy_register
5. 读取 proxy2 收到的 register response 和 client 收到的消息

**预期：** proxy2 收到 `proxy_register_response { status: "reconnected", sessions: { "s-a": 5, "s-b": 3 } }`；client 收到 `{ type: "proxy_online", proxyId: "..." }`

**实际：** response.status = "reconnected"，sessions["s-a"] = 5，sessions["s-b"] = 3。client 收到 proxy_online。耗时 1363ms。

---

### Proxy 主动退出 → proxy_offline + 资源清理 + proxyCount 减少

**测试步骤：**
1. proxy 注册，发送消息产生 session buffer
2. client 绑定到 proxy
3. 记录当前 /status 的 proxyCount
4. proxy 发送 `{ type: "proxy_disconnect", proxyId: "..." }`
5. 读取 client 消息，再次 GET /status

**预期：** client 收到 proxy_offline；proxyCount 减少 1

**实际：** client 收到 proxy_offline。beforeStatus.proxyCount - afterStatus.proxyCount = 1。耗时 1369ms。

---

### Proxy 未注册就发 envelope → NOT_REGISTERED

**测试步骤：**
1. WebSocket 连接 `/proxy`，不发 proxy_register
2. 直接发送一个 MessageEnvelope

**预期：** 收到 `relay_error { code: "NOT_REGISTERED" }`

**实际：** response.type = "relay_error"，code = "NOT_REGISTERED"。耗时 55ms。

---

### Proxy 重连 → 旧连接被 terminate

**测试步骤：**
1. proxy1 连接并注册 proxyId="xxx"
2. proxy2 连接，用同一个 proxyId 注册
3. 监听 proxy1 的 close 事件

**预期：** proxy1 被 terminate（收到 close 事件）；proxy2 收到 reconnected response

**实际：** proxy1 close 事件触发，readyState 不再是 OPEN。proxy2 正常收到 response。耗时 55ms。

---

### 多个 client 绑定同一 proxy，proxy 断线 → 所有 client 收到 proxy_offline

**测试步骤：**
1. proxy 注册
2. client1 和 client2 分别通过 proxy_select 绑定到同一 proxy
3. proxy.terminate() 断线
4. 分别读取两个 client 的消息

**预期：** client1 和 client2 都收到 `{ type: "proxy_offline" }`

**实际：** 两个 client 都收到 proxy_offline，proxyId 一致。耗时 257ms。

---

### Proxy 多次断连重连循环 → 状态始终一致

**测试步骤：**
1. 循环 3 轮：每轮用同一 proxyId 注册 → 发送一条消息（seq=轮次号）→ close 断线 → 等 200ms
2. 第 4 次注册，检查 response

**预期：** 第 1 轮 status="new"，第 2-3 轮 status="reconnected"；第 4 次 sessions 的 lastSeq=3

**实际：** 第 1 轮 status="new"，第 2-3 轮 status="reconnected"，均符合预期。第 4 次 status="reconnected"，sessions lastSeq=3，符合预期。4 次全部通过。耗时 965ms。

---

## client lifecycle（对应验收文档第二节）

### Client 首次连接 + proxy_select → 消息双向路由

**测试步骤：**
1. proxy 注册
2. client 发 proxy_list_request → 收到 proxy_list_response
3. client 发 proxy_select 绑定
4. proxy 发 MessageEnvelope → 验证 client 收到
5. client 发 MessageEnvelope → 验证 proxy 收到

**预期：** proxy_list_response 包含已注册 proxy；双向消息均正确转发

**实际：** proxy_list_response.proxies 包含目标 proxyId。proxy→client 收到 assistant_message。client→proxy 收到 user_input。耗时 261ms。

---

### proxy_select 不存在的 proxy → PROXY_NOT_FOUND

**测试步骤：**
1. client 连接，发送 `proxy_select { proxyId: "ghost" }`

**预期：** `relay_error { code: "PROXY_NOT_FOUND" }`

**实际：** 符合预期。耗时 53ms。

---

### proxy_select 离线 proxy → PROXY_NOT_FOUND

**测试步骤：**
1. proxy 注册后 close 断线，等 200ms 确认状态变为离线
2. client 发 proxy_select 绑定到该 proxyId

**预期：** `relay_error { code: "PROXY_NOT_FOUND" }`（不允许绑定到离线 proxy）

**实际：** 符合预期。耗时 356ms。

---

### Client 断线重连（proxy 在线）→ restored + 增量回放

**测试步骤：**
1. proxy 注册，client1 通过 client_register（clientId="c-3"）+ proxy_select 绑定
2. proxy 发 3 条消息（seq 1,2,3），client1 在线收到
3. client1 close 断开
4. client2 连接，发 `client_register { clientId: "c-3", sessions: { "s1": 1 } }`（表示 s1 session 已收到到 seq 1）
5. 读取 client2 收到的所有消息

**预期：** 第一条为 `client_register_response { status: "restored", proxyId }`；后续按 session 独立回放 seq > 1 的消息（seq 2, seq 3）

**实际：** 收到 3 条消息：1 条控制消息（client_register_response status="restored"）+ 2 条回放数据（seq=2, seq=3）。seq=1 未回放，符合 sessions.s1=1 的语义。耗时 364ms。

---

### Client 断线重连（proxy 离线）→ proxy_offline + 等 proxy_online

**测试步骤：**
1. proxy 注册，client1 通过 client_register + proxy_select 绑定
2. client1 和 proxy 都断开
3. client2 用同一 clientId 重连，发 client_register
4. 读取 response
5. 新 proxy2 用同一 proxyId 注册
6. 读取 client2 消息

**预期：** client_register_response { status: "proxy_offline", proxyId }；proxy 重连后 client2 收到 proxy_online

**实际：** response.status = "proxy_offline"。proxy2 注册后 client2 收到 proxy_online。耗时 560ms。

---

### 全新 clientId → new

**测试步骤：**
1. client 发 `client_register { clientId: "fresh-1" }`（无 sessions 字段，全新客户端）

**预期：** `client_register_response { status: "new" }`，无 proxyId

**实际：** status="new"，proxyId=undefined。耗时 53ms。

---

### Proxy 离线期间 client 发消息 → PROXY_OFFLINE

**测试步骤：**
1. proxy 注册，client 绑定
2. proxy close 断线，等 200ms
3. client 发 MessageEnvelope

**预期：** `relay_error { code: "PROXY_OFFLINE" }`

**实际：** 符合预期。耗时 460ms。

---

### 未绑定 client 发消息 → NOT_BOUND

**测试步骤：**
1. client 连接，不做任何绑定操作
2. 直接发 MessageEnvelope

**预期：** `relay_error { code: "NOT_BOUND" }`

**实际：** 符合预期。耗时 53ms。

---

### Client 发不支持的控制消息 → UNSUPPORTED

**测试步骤：**
1. client 发送 `{ type: "proxy_register", proxyId: "x" }`（这是 proxy 端的控制消息，client 不应发送）

**预期：** `relay_error { code: "UNSUPPORTED" }`

**实际：** 符合预期。耗时 53ms。

---

### Client 断线重连恢复后继续收新消息

**测试步骤：**
1. proxy 注册，client1 绑定并在线收到 seq 1,2
2. client1 断开，proxy 继续发 seq 3
3. client2 用同一 clientId 重连，`sessions: { "s1": 2 }` → 收到 restored + 回放 seq 3
4. proxy 再发 seq 4
5. 读取 client2 是否收到 seq 4

**预期：** client2 恢复后不仅能收回放消息，还能继续收到新消息

**实际：** 回放收到 seq=3，新消息收到 seq=4，type="assistant_message"。耗时 462ms。

---

### client_register_response 带 per-session 最新 seq（进度感知）

**测试步骤：**
1. proxy 注册，发送多 session 消息（progress-a: seq 1,2,5；progress-b: seq 1,3）
2. client1 通过 client_register + proxy_select 绑定
3. client1 断开
4. client2 用同一 clientId 重连，`sessions: { "progress-a": 2 }`

**预期：** `client_register_response` 带 `sessions` 字段，包含各 session 的最新 seq（progress-a: 5, progress-b: 3），client 可据此计算回放进度

**实际：** resp.sessions["progress-a"] = 5，resp.sessions["progress-b"] = 3。符合预期。

---

## message buffering and replay（对应验收文档第三节）

### 消息缓冲到 per-session buffer + /status totalBuffered

**测试步骤：**
1. proxy 注册，记录 /status 的 totalBuffered 基准值
2. 发送 3 条消息到 2 个不同 session
3. GET /status 对比

**预期：** totalBuffered 增加 3

**实际：** afterStatus.totalBuffered = beforeStatus.totalBuffered + 3。耗时 260ms。

---

### PTY 快照压缩 → buffer 缩小

**测试步骤：**
1. proxy 发送 3 条 assistant_message（seq 1,2,3）到同一 session
2. 记录 /status totalBuffered（基准 + 3）
3. 发送 1 条 `pty_snapshot` 类型消息（seq 4，base64 编码的终端快照数据）
4. 对比 /status

**预期：** `pty_snapshot` 触发 compressOnSnapshot，丢弃 seq 1,2,3，只保留 snapshot 自身。totalBuffered 从基准+3 变为基准+1

**实际：** 压缩后 totalBuffered = beforeStatus + 1。耗时 361ms。

---

### JSON 模式不压缩 → 所有消息完整保留

**测试步骤：**
1. proxy 发送 10 条 assistant_message（seq 1-10）
2. client 通过 replay_request { fromSeq: 1, toSeq: 10 } 验证

**预期：** 10 条消息全部保留，replay 返回 10 条

**实际：** replay 返回 10 条，seq 1-10 连续。耗时 256ms。

---

### seq 去重 → 重复 seq 不入 buffer

**测试步骤：**
1. proxy 发送 seq 1,2,3
2. 再发送 seq 2 和 seq 1（重复）
3. client 通过 replay_request 查询

**预期：** buffer 中只有 3 条（seq 1,2,3），重复的被静默跳过

**实际：** replay 返回 3 条，seq=[1,2,3]。耗时 258ms。

---

### replay_request 成功回放

**测试步骤：**
1. proxy 发送 seq 1-5
2. client 发 replay_request { fromSeq: 2, toSeq: 4 }

**预期：** 逐条返回 seq 2, 3, 4

**实际：** 收到 3 条，seq 分别为 2, 3, 4。耗时 255ms。

---

### replay_request 部分可用 → 消息 + gap_unrecoverable

**测试步骤：**
1. proxy 只发送 seq 3,4,5（buffer 中没有 1,2）
2. client 发 replay_request { fromSeq: 1, toSeq: 5 }

**预期：** 先返回 seq 3,4,5 的消息，再返回 `gap_unrecoverable { fromSeq: 1, toSeq: 2 }`

**实际：** 收到 4 条。前 3 条 seq=3,4,5。第 4 条 type="gap_unrecoverable"，fromSeq=1，toSeq=2。耗时 257ms。

---

### replay_request 完全不可用 → gap_unrecoverable

**测试步骤：**
1. client 发 replay_request { sessionId: "nonexistent-xyz", fromSeq: 1, toSeq: 10 }

**预期：** `gap_unrecoverable`

**实际：** type="gap_unrecoverable"。耗时 54ms。

---

### replay_request 无效范围 → INVALID_RANGE

**测试步骤：**
1. client 发 replay_request { fromSeq: 10, toSeq: 5 }

**预期：** `relay_error { code: "INVALID_RANGE" }`

**实际：** 符合预期。耗时 53ms。

---

## per-session seq numbering（对应验收文档第五节）

### Per-session seq 独立

**测试步骤：**
1. proxy 发送 seq-a session 的 seq 1,2,3 和 seq-b session 的 seq 1,2
2. client 分别 replay 两个 session

**预期：** 两个 session 各自独立编号，互不影响

**实际：** seq-a replay 返回 3 条，seq-b replay 返回 2 条。耗时 258ms。

---

### 重连对账 → sessions 返回 per-session lastSeq

**测试步骤：**
1. proxy1 注册，发送 recon-a session seq 10,20 和 recon-b session seq 5
2. proxy1 close 断线
3. proxy2 用同一 proxyId 注册

**预期：** `proxy_register_response { sessions: { "recon-a": 20, "recon-b": 5 } }`

**实际：** sessions = { "recon-a": 20, "recon-b": 5 }。耗时 459ms。

---

## disk persistence and relay restart（对应验收文档第六节）

### 磁盘持久化 → NDJSON 文件逐行追加

**测试步骤：**
1. spawn relay 子进程，dataDir 指向临时目录
2. proxy 注册，发送 seq 1,2 到 session "disk-1"
3. 读取 dataDir/disk-1.ndjson 文件

**预期：** 文件存在，2 行 NDJSON，每行解析后 seq 分别为 1 和 2

**实际：** 文件存在，2 行。JSON.parse(lines[0]).seq = 1，JSON.parse(lines[1]).seq = 2。耗时 775ms。

---

### PTY 压缩后磁盘同步 → NDJSON 被重写

**测试步骤：**
1. proxy 发送 seq 1,2,3 → 文件 3 行
2. 发送 `pty_snapshot`（seq 4，base64 编码终端快照）
3. 重新读取文件

**预期：** 文件被重写，只剩 1 行（snapshot 自身），seq=4

**实际：** 压缩前 3 行，压缩后 1 行，JSON.parse(afterLines[0]).seq = 4。耗时 876ms。

---

### Proxy 主动退出 → NDJSON 文件被删除

**测试步骤：**
1. proxy 发送消息到 session "disk-del-a" 和 "disk-del-b"
2. 确认两个 .ndjson 文件存在
3. proxy 发送 proxy_disconnect
4. 检查文件

**预期：** 两个 NDJSON 文件都被删除

**实际：** disk-del-a.ndjson 和 disk-del-b.ndjson 都不存在。耗时 874ms。

---

### SIGKILL 崩溃 → 磁盘数据存活 → 新进程加载恢复 → replay 可用

**测试步骤：**
1. spawn relay1 子进程（带 dataDir），proxy 发送 seq 1,2,3
2. 确认 .ndjson 文件有 3 行
3. `kill -9` 杀掉 relay1 整个进程组（SIGKILL，不执行任何 cleanup 代码）
4. 等待进程退出
5. 确认 .ndjson 文件仍存在
6. spawn relay2 子进程（同一端口、同一 dataDir）
7. GET /status 检查 buffer 状态
8. client 通过 replay_request 获取数据

**预期：** relay2 启动后从磁盘加载 buffer，totalBuffered=3；client replay 返回 seq 1,2,3

**实际：** /status totalBuffered=3。replay 返回 3 条，seq 分别 1,2,3。耗时 6354ms。

---

### Relay 重启已知限制 → proxy-session 映射丢失 → status=new

**测试步骤：**
1. relay1 运行中 proxy 注册并发消息
2. SIGKILL 杀 relay1
3. spawn relay2（同 dataDir）
4. proxy 用同一 proxyId 注册

**预期：** `proxy_register_response { status: "new" }`（proxy-session 映射仅内存态，未持久化）；但磁盘 buffer 数据仍可通过 replay 获取

**实际：** status="new"，sessions=undefined。replay_request 返回 1 条消息。耗时 6356ms。

---

### SIGTERM 优雅关闭 → 进程正常退出（exit code 0）

**测试步骤：**
1. spawn relay，proxy 注册
2. `kill -15`（SIGTERM）发送给整个进程组
3. 等待进程退出，检查 exit code

**预期：** relay 执行 shutdown handler，exit code = 0

**实际：** exitCode = 0。耗时 580ms。

---

## heartbeat dead connection detection（对应验收文档第七节）

### Proxy 心跳超时 → terminate → proxy_offline

**测试步骤：**
1. spawn relay（heartbeatInterval=500ms）
2. proxy 注册，client 绑定
3. 覆写 proxy 的 pong 方法为空函数（模拟死连接，不响应 ping）
4. 等待 client 收到消息

**预期：** relay 在 1-2 个心跳周期后检测到 proxy 无 pong 响应，terminate 连接，触发 close handler 广播 proxy_offline

**实际：** client 收到 proxy_offline，proxyId 匹配。耗时 953ms（约 2 个 500ms 心跳周期）。

---

### Client 心跳超时 → terminate → 绑定保留

**测试步骤：**
1. proxy 注册，client 通过 client_register + proxy_select 绑定
2. 覆写 client 的 pong 为空函数
3. 等待 client 的 close 事件
4. 用同一 clientId 新建 client2 发 client_register

**预期：** client 被 terminate；client2 收到 `client_register_response { status: "restored", proxyId }`（绑定关系保留，ws 设为 null，clientId 仍绑定到 proxyId）

**实际：** client close 事件触发。client2 response.status="restored"，proxyId="hb-c"。耗时 1004ms。

---

## end-to-end: network interruption recovery and multi-session（对应验收文档第八节）

### 网络中断 → 检测 → 状态保留 → 重连 → 恢复 → 消息路由正常

**测试步骤：**

*阶段 1 - 正常工作：*
1. spawn relay（heartbeatInterval=500ms，带 dataDir）
2. proxy 注册，client 绑定
3. proxy 发 3 条消息（seq 1,2,3 到 cable-s session），client 在线收到

*阶段 2 - 网络中断：*
4. 覆写 proxy 的 pong 为空函数（模拟网络断开）
5. 等待 client 收到 proxy_offline

*阶段 3 - 断线期间状态保留：*
6. 检查磁盘文件 cable-s.ndjson 存在
7. GET /status 确认 totalBuffered >= 3

*阶段 4 - 恢复：*
8. proxy2 用同一 proxyId 注册
9. 读取 proxy2 的 register response 和 client 的消息

*阶段 5 - 恢复后验证：*
10. proxy2 发 seq 4，验证 client 收到

**预期：** 全流程数据完整性不丢失，client 无缝感知离线→恢复

**实际：**
- 阶段 2：client 收到 proxy_offline
- 阶段 3：cable-s.ndjson 存在，totalBuffered >= 3
- 阶段 4：proxy2 收到 status="reconnected"，sessions={"cable-s":3}；client 收到 proxy_online
- 阶段 5：client 收到 seq=4 的 assistant_message
- 耗时 1504ms

---

### Proxy 管理多 session → client 收到所有 session + 断线恢复各 session 独立回放

**测试步骤：**

*阶段 1 - 多 session 实时转发：*
1. proxy 注册，client 绑定
2. proxy 交替发送 3 个 session 的消息：sa(seq1), sb(seq1), sa(seq2), sc(seq1), sa(seq3), sb(seq2)
3. client 收到 6 条实时消息

*阶段 2 - client 断线后 proxy 继续发：*
4. client 断开
5. proxy 发 sa(seq4), sb(seq3)

*阶段 3 - client 重连全量回放：*
6. client2 用同一 clientId 发 `client_register { sessions: {} }`（无历史，全量回放）
7. 收集所有回放消息

*阶段 4 - 各 session 独立 replay：*
8. client2 发 replay_request { sessionId: "sa", fromSeq: 1, toSeq: 4 }
9. client2 发 replay_request { sessionId: "sc", fromSeq: 1, toSeq: 1 }

*阶段 5 - proxy 断线重连：*
10. proxy close，proxy2 注册同一 proxyId
11. 检查磁盘文件

**预期：**
- 阶段 3：回放包含所有 session 的全量消息（sa:4条, sb:3条, sc:1条）
- 阶段 4：各 session 可独立 replay
- 阶段 5：sessions map = { sa:4, sb:3, sc:1 }；3 个 .ndjson 文件都存在

**实际：**
- 阶段 1：收到 6 条实时消息
- 阶段 3：restored response + 8 条回放。sa seq=[1,2,3,4]，sb seq=[1,2,3]，sc seq=[1]
- 阶段 4：sa replay 返回 4 条，sc replay 返回 1 条
- 阶段 5：sessions = { sa:4, sb:3, sc:1 }。sa.ndjson, sb.ndjson, sc.ndjson 都存在
- 耗时 1194ms

---

## 未覆盖项说明

| 验收项 | 原因 |
|--------|------|
| 1.2 Proxy 自动重连退避 | proxy 侧 RelayConnection 行为，由 `relay-connection.test.ts` 的 11 个测试覆盖 |
| 1.5 EventStore 对账回放 | proxy 侧 serve.ts + EventStore 逻辑，由 `event-store.test.ts` 的单元测试覆盖 |
| 第四节 Proxy 出站消息队列 | proxy 侧 MemoryMessageQueue 行为，由 `message-queue.test.ts` + `relay-connection.test.ts` 覆盖 |
| 7.1 正常心跳 | 隐式验证：所有使用 heartbeatInterval=500ms 的测试中连接均保持正常，说明心跳机制工作 |
