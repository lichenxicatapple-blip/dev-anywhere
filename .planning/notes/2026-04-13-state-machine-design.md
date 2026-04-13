---
date: "2026-04-13 15:30"
promoted: false
---

# CC Anywhere 状态机设计

## 设计原则

1. **所有核心模块使用显式状态机**，状态转换通过 transition 函数驱动，拒绝非法转换
2. **绑定路径唯一**：`proxy_select` 是唯一的绑定协议消息，带 ACK
3. **离线不等于清理**：proxy 离线保留全部状态，只在主动 disconnect 时清理
4. **恢复靠协商不靠持久化**：relay 重启后通过 proxy 重连 + session_sync 恢复映射

---

## 一、协议精简

### 移除

| 消息 | 原因 |
|------|------|
| `bind_by_session` / `bind_by_session_response` | 查找逻辑移到 client 端。client 通过 proxy_list（含 sessions）自行匹配，再发 proxy_select |

### 修改

| 消息 | 变更 |
|------|------|
| `proxy_select` | 新增响应消息 `proxy_select_response`，包含 `{ success, proxyId, error? }` |
| `proxy_list_response` | 扩展 ProxyInfo，增加 `sessions: string[]` 字段，client 可据此匹配 sessionId → proxyId |

### 新增

| 消息 | 用途 |
|------|------|
| `proxy_select_response` | relay 对 proxy_select 的 ACK：`{ success: true, proxyId }` 或 `{ success: false, error }` |

精简后绑定流程统一为：
```
Client 知道 proxyId（Storage / 用户选择）:
  → proxy_select(proxyId) → 等 proxy_select_response

Client 只知道 sessionId（URL）:
  → proxy_list_request → 收到 proxy_list_response（含 sessions）
  → 在本地匹配 sessionId → proxyId
  → proxy_select(proxyId) → 等 proxy_select_response
```

---

## 二、Proxy 状态机

### 2.1 RelayConnection

```
DISCONNECTED ──connect()──→ CONNECTING ──ws.open──→ REGISTERING ──register_response──→ SYNCED
     ↑                          |                       |                                |
     |                     ws.error/close           ws.error/close                  ws.close
     |                          |                       |                                |
     |                          v                       v                                v
     └──────────────────── WAITING_RECONNECT ←──────────────────────────────────────────┘

SYNCED ──close()──→ CLOSED（终态）
WAITING_RECONNECT ──close()──→ CLOSED（终态）
```

| 状态 | 含义 | 可发送消息 | 队列行为 |
|------|------|-----------|---------|
| DISCONNECTED | 初始状态，未连接 | 否 | 入队 |
| CONNECTING | WebSocket 正在建立 | 否 | 入队 |
| REGISTERING | ws 已连接，已发 proxy_register，等待响应 | 否 | 入队 |
| SYNCED | 注册完成，队列已 flush | 是 | 直发 |
| WAITING_RECONNECT | 断开，等待退避计时器触发重连 | 否 | 入队 |
| CLOSED | 主动关闭，不再重连 | 否 | 丢弃 |

**队列上限**：设定最大条目数（如 10000），超过后丢弃最旧消息并记日志。

### 2.2 Terminal 进程

```
INIT ──ensureService()──→ CONNECTING_SERVICE ──connected──→ CREATING_SESSION
                                |                               |
                           max retries                    create_response
                                |                               |
                                v                               v
                            FATAL_ERROR                    RUNNING ←──reconnect success──┐
                                                             |                           |
                                                        socket.close                     |
                                                             |                           |
                                                             v                           |
                                                        RECONNECTING ───────────────────┘
                                                             |
                                                        max retries
                                                             |
                                                             v
                            RUNNING ──pty.exit──→ EXITED（终态）
```

**关键约束**：
- CREATING_SESSION 必须等到 `session_create_response` 后才能转到 RUNNING
- RUNNING 中 `pty_register` 在收到 create_response 之后发送（不是同时）
- RECONNECTING 重连成功后重新走 CREATING_SESSION → RUNNING（不跳过）

### 2.3 Session（SessionManager）

保留现有状态枚举，补充转换守卫：

```
IDLE ←→ WORKING ←→ WAITING_APPROVAL
  \       |           /
   \      v          /
    └──→ ERROR ───→ TERMINATED（终态）
```

**修复**：
- 从磁盘恢复时 WAITING_APPROVAL → 强制重置为 IDLE
- JSON session 收到 worker_event 时转为 WORKING
- TERMINATED 后立即清理关联资源（frameCache、pendingToolApprovals、workerSocket）

### 2.4 FramePusher

```
STOPPED ──start()──→ PUSHING（start 时立即发一个 full frame）
                        |
PUSHING ──stop()──→ STOPPED                          每 200ms push
```

FramePusher 的 start() 已经会重置 lastGrid=null 并发送 full frame 作为首帧，这个行为保持不变。

### 2.5 FrameCache

```
EMPTY ──apply(full)──→ HAS_BASE ──apply(delta)──→ HAS_BASE
                                                      |
  HAS_BASE ──remove()──→ EMPTY
```

IPC 是有序传输，FramePusher 保证首帧是 full，所以不存在 delta 先于 full 到达的问题。

**真正要修的问题**：
- **冷启动空缓存**：serve 重启后 frameCache 为空，client 请求 terminal_frame_request 时应返回明确的"帧未就绪"响应（而非静默返回 null），client 可据此显示加载状态
- **内存泄漏**：session 终止时调用 frameCache.remove(sessionId) 清理

---

## 三、Relay 状态机

### 3.1 Proxy 连接

```
[不存在] ──proxy_register──→ ONLINE ──ws.close──→ OFFLINE ──proxy_register──→ ONLINE
                                                     |
                                                proxy_disconnect
                                                     |
                                                     v
                              ONLINE ──proxy_disconnect──→ [清理删除]
```

| 状态 | ws | sessions | 对 client 可见 |
|------|-----|----------|---------------|
| ONLINE | 活跃连接 | 有 | online: true |
| OFFLINE | null | 保留 | online: false |

**不设超时**。OFFLINE 状态无限保持，直到 proxy 重连或主动 disconnect。

### 3.2 Client 连接

```
[ws连接] ──client_register──→ REGISTERED ──proxy_select──→ BOUND
                                  |            ↑               |
                                  |       proxy_select         |
                                  |       (换绑)               |
                             ws.close                      ws.close
                                  |                            |
                                  v                            v
                            [ws=null,                    [ws=null,
                             binding 保留]                binding 保留]
                                  |                            |
                             client_register              client_register
                             (同 clientId)                (同 clientId)
                                  |                            |
                                  v                            v
                            REGISTERED                     BOUND (restored)
```

| 状态 | 含义 | 可发送 control | 可发送 envelope |
|------|------|---------------|----------------|
| 已连接未注册 | ws 打开但没发 client_register | proxy_list_request | 否 |
| REGISTERED | 已注册但未绑定 proxy | proxy_list_request, proxy_select | 否 |
| BOUND | 已绑定 proxy | 全部 | 是 |

**proxy_select 响应**：
- 成功：`{ type: "proxy_select_response", success: true, proxyId }`
- proxy 不存在：`{ type: "proxy_select_response", success: false, error: "..." }`

### 3.3 Session Buffer

```
[不存在] ──首条 envelope / session_sync──→ ACTIVE ──proxy disconnect──→ [清理删除]
                                             |
                                        proxy offline
                                             |
                                             v
                                         ORPHANED ──proxy reconnect + session_sync──→ ACTIVE
```

不变，只是明确状态名称。ORPHANED 期间 buffer 仍可被 client replay。

---

## 四、Client 状态机

### 4.1 App 状态机

```
CONNECTING ──ws.open──→ REGISTERING ──register_response──→ PROXY_SELECTING
                                                               |
                                                    proxy_select_response(ok)
                                                               |
                                                               v
                                                ┌─── SESSION_BROWSING ←── back ─── CHATTING
                                                │          |                           |
                                                │     enter session                    |
                                                │          |                           |
                                                │          └──→ CHATTING ──────────────┘
                                                │
     CONNECTING ←── timeout(10s) ── RECONNECTING ←── ws.close ── (任意非 CONNECTING 状态)
                                         |
                                    ws.open + proxy_select_response(ok)
                                         |
                                         v
                                    恢复到断开前的状态
```

**与现有的区别**：
- 去掉 `proxy_lost` 状态：proxy 离线不做页面跳转，只更新 `proxyOnline` 标记，UI 显示 "Proxy offline" 提示即可。proxy 回来自动恢复。当前的 1.5 秒超时跳转 proxy-select 太激进。
- 新增 `REGISTERING` 状态：ws 连接后到收到 register_response 之间的过渡态，避免在这个窗口期发消息。
- 去掉 cold start 特殊逻辑：统一为 PROXY_SELECTING 状态下检查 Storage，有 proxyId 就自动 proxy_select，和手动选择走同一条路。

### 4.2 绑定统一收口

```typescript
// 单一绑定函数，所有场景调用这个
async function ensureBinding(relay: RelayClient, context: {
  proxyId?: string;     // 来自 Storage 或用户选择
  sessionId?: string;   // 来自 URL
}): Promise<{ proxyId: string } | { error: string }> {
  
  // 已绑定且 proxyId 匹配
  if (relay.getBoundProxyId() === context.proxyId) {
    return { proxyId: context.proxyId };
  }

  let targetProxyId = context.proxyId;

  // 只有 sessionId 没有 proxyId：查 proxy list 匹配
  if (!targetProxyId && context.sessionId) {
    relay.listProxies();
    const response = await waitForMessage(relay, "proxy_list_response");
    const proxy = response.proxies.find(p => 
      p.sessions?.includes(context.sessionId)
    );
    if (!proxy) return { error: "Session not found on any proxy" };
    targetProxyId = proxy.proxyId;
  }

  if (!targetProxyId) return { error: "No proxy specified" };

  // 统一走 proxy_select
  relay.selectProxy(targetProxyId);
  const ack = await waitForMessage(relay, "proxy_select_response");
  if (!ack.success) return { error: ack.error };
  return { proxyId: targetProxyId };
}
```

**调用场景**：
- proxy-select 页面用户点击 → `ensureBinding({ proxyId })`
- cold start 从 Storage 恢复 → `ensureBinding({ proxyId: cc_proxyId })`
- chat 页面从 URL 打开 → `ensureBinding({ sessionId: router.params.sessionId })`
- WebSocket 重连恢复 → `ensureBinding({ proxyId: state.selectedProxyId })`

4 个场景，1 个函数，1 条协议路径。

### 4.3 Storage 精简

| Key | 写入时机 | 读取时机 | 清除时机 |
|-----|---------|---------|---------|
| `cc_clientId` | 首次启动 | 每次启动 | 不清除 |
| `cc_proxyId` | proxy_select_response 成功后 | PROXY_SELECTING 状态进入时 | 用户切换 proxy 时 |
| `cc_sessionId` | 进入 chat 页面时 | PROXY_SELECTING 状态进入时（cold start） | 退出 chat 页面时 |
| `cc_sessionMode` | 进入 chat 页面时 | 同上 | 同上 |

**规则**：Storage 写入只在 proxy_select_response ACK 成功之后，不做乐观写入。

### 4.4 页面不再修正 phase

去掉所有 `useDidShow` 里的 phase 修正逻辑。phase 只由状态机驱动，页面只读 phase 做 UI 渲染。如果 phase 和当前页面不匹配，由状态机触发导航，不是页面自己改 phase。

---

## 五、资源清理

| 资源 | 清理时机 | 负责方 |
|------|---------|--------|
| frameCache[sessionId] | session 终止 / pty_deregister | serve.ts |
| pendingToolApprovals | worker socket 关闭时清理该 worker 的所有 pending | serve.ts |
| workerSocket | worker_exit / session terminate | serve.ts |
| terminalSocket | pty_deregister / socket close | serve.ts |
| SessionBuffer（relay） | proxy_disconnect 时清理该 proxy 全部 buffer | relay registry |
| ClientBinding（relay） | proxy_disconnect 时解绑该 proxy 的全部 client | relay registry |

**审批超时**：worker 的 tool approval 设 30 秒超时，超时自动 deny。防止 relay 不可达时 Claude 永远卡住。

---

## 六、实施路径

建议按依赖关系分步：

1. **协议变更**：shared 包加 `proxy_select_response`，扩展 `ProxyInfo` 含 sessions，移除 `bind_by_session`
2. **Relay 状态机**：显式化 proxy/client/session 状态，加 proxy_select ACK
3. **Proxy 状态机**：RelayConnection 显式状态，terminal 显式状态，修复 critical bugs（frameCache 泄漏、approval 泄漏、delta 无基底）
4. **Client 状态机**：统一 ensureBinding，去掉 useDidShow phase 修正，去掉 cold start 特殊路径
